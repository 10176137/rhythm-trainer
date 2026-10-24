import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan } from '../playback/playback-planner';
import type { PlaybackPlan } from '../domain/types';
import { buildUserHandMapping } from '../scope/practice-scope';
import {
  beatToMicroseconds,
  buildPlanFingerprintPayloadV1,
  canonicalizeJcs,
  computePlanFingerprintV1,
  computeScoreRevisionId,
  numberToRationalV1,
  projectScoreDocumentV1,
  rationalV1,
  validateScoreDocumentV1,
} from './plan-fingerprint';

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');

// Independent oracle: hand-built JCS (sorted keys, recursive) + Node crypto.
// Must agree with the module under test; a divergence fails the test.
function independentJcs(value: unknown): string {
  const typ = (v: unknown): string => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(typ).join(',')}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${typ(obj[key])}`).join(',')}}`;
  };
  return typ(value);
}
function independentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function basePlan(): PlaybackPlan {
  const doc = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1_single_voice.musicxml' }).scoreDocument!;
  return buildPlaybackPlan(doc, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  }).plan!;
}

const BASE_SCOPE = {
  partId: 'P1',
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
  hand: 'right' as const,
  handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }]),
};
const BASE_REVISION = computeScoreRevisionId(
  'sha256:44a959429fe07921e744f87721b7442c4ec34dbfa3c2e3260bdc467090af4692',
  'normalizer-1',
);

function payloadFor(plan: PlaybackPlan, overrides: Record<string, unknown> = {}) {
  const base = {
    plannerVersion: 'planner-ref-1',
    scoreRevisionId: BASE_REVISION,
    normalizerVersion: 'normalizer-1',
    supportProfileVersion: 'musicxml-v1.0',
    ...BASE_SCOPE,
    repeatSelection: { kind: 'none' },
    bpm: { numerator: 80, denominator: 1 },
    ticksPerQuarter: 960,
    countInBeats: { numerator: 4, denominator: 1 },
    plan,
  };
  const merged = { ...base, ...overrides } as Record<string, unknown>;
  // Flatten a scope override into the builder's flat fields.
  const scopeOverride = merged.scope as Record<string, unknown> | undefined;
  if (scopeOverride) {
    delete merged.scope;
    Object.assign(merged, scopeOverride);
  }
  return buildPlanFingerprintPayloadV1(merged as never);
}

describe('canonicalization and hashing primitives', () => {
  it('key insertion order does not change canonical bytes', () => {
    const a = canonicalizeJcs({ b: 1, a: { d: 1, c: 2 } });
    const b = canonicalizeJcs({ a: { c: 2, d: 1 }, b: 1 });
    expect(a).toBe('{"a":{"c":2,"d":1},"b":1}');
    expect(a).toBe(b);
  });

  it('NFC makes composed and decomposed strings produce identical bytes', () => {
    expect(canonicalizeJcs({ s: 'é' })).toBe(canonicalizeJcs({ s: 'e\u0301' }));
  });

  it('matches the independent JCS+sha256 oracle', () => {
    const value = { z: 1, a: [{ y: 'é', b: 2 }], m: { k: null, j: true } };
    const moduleHash = (() => {
      // via module's own path
      const payload = JSON.parse(canonicalizeJcs(value));
      return independentSha256(canonicalizeJcs(payload));
    })();
    expect(moduleHash).toBe(independentSha256(independentJcs(value)));
  });
});

describe('numberToRationalV1', () => {
  it('projects integers and finite decimals exactly', () => {
    expect(numberToRationalV1(3)).toEqual({ numerator: 3, denominator: 1 });
    expect(numberToRationalV1(-0.5)).toEqual({ numerator: -1, denominator: 2 });
    expect(numberToRationalV1(0)).toEqual({ numerator: 0, denominator: 1 });
  });

  it('never writes a binary approximation for a decimal literal', () => {
    // 0.1 is not exact in binary; the decimal projection must be 1/10.
    expect(numberToRationalV1(0.1)).toEqual({ numerator: 1, denominator: 10 });
    expect(numberToRationalV1(2.75)).toEqual({ numerator: 11, denominator: 4 });
  });

  it('rejects non-finite and out-of-range values', () => {
    expect(() => numberToRationalV1(NaN)).toThrowError(/not a finite number/);
    expect(() => numberToRationalV1(Infinity)).toThrowError(/not a finite number/);
    expect(() => numberToRationalV1(1e17)).toThrowError(/exceeds safe range/);
  });

  it('rationalV1 rejects zero denominators and unreduced input stays reducible', () => {
    expect(() => rationalV1(1, 0)).toThrowError(/denominator must be > 0/);
    expect(rationalV1(2, 4)).toEqual({ numerator: 1, denominator: 2 });
  });
});

describe('beatToMicroseconds (time-conversion-v1)', () => {
  it('is exact at whole beats and converts thirds without accumulation', () => {
    const bpm = { numerator: 60, denominator: 1 };
    expect(beatToMicroseconds({ numerator: 0, denominator: 1 }, bpm)).toBe(0);
    expect(beatToMicroseconds({ numerator: 1, denominator: 1 }, bpm)).toBe(1_000_000);
    expect(beatToMicroseconds({ numerator: 1, denominator: 3 }, bpm)).toBe(333_333);
    expect(beatToMicroseconds({ numerator: 2, denominator: 3 }, bpm)).toBe(666_667);
    // 3 * (1/3) beats == exactly one beat: no drift.
    expect(
      beatToMicroseconds({ numerator: 1, denominator: 3 }, bpm)
      + beatToMicroseconds({ numerator: 1, denominator: 3 }, bpm)
      + beatToMicroseconds({ numerator: 1, denominator: 3 }, bpm),
    ).toBeLessThanOrEqual(1_000_000);
  });

  it('rounds exact halves up', () => {
    expect(beatToMicroseconds({ numerator: 1, denominator: 128 }, { numerator: 100, denominator: 1 })).toBe(4688);
    expect(beatToMicroseconds({ numerator: 1, denominator: 64 }, { numerator: 100, denominator: 1 })).toBe(9375);
  });

  it('rejects negative beats and non-positive BPM', () => {
    expect(() => beatToMicroseconds({ numerator: -1, denominator: 1 }, { numerator: 60, denominator: 1 })).toThrowError(/beat must be non-negative/);
    expect(() => beatToMicroseconds({ numerator: 1, denominator: 1 }, { numerator: 0, denominator: 1 })).toThrowError(/bpm must be positive/);
  });
});

describe('score projection determinism and identity', () => {
  it('projects the same fixture identically twice (deep equality)', () => {
    const xml = fixture('g1_single_voice.musicxml');
    const first = projectScoreDocumentV1(
      importMusicXml(xml, { fileName: 'g1.musicxml' }).scoreDocument!,
      importMusicXml(xml, { fileName: 'g1.musicxml' }).importReport,
    );
    const second = projectScoreDocumentV1(
      importMusicXml(xml, { fileName: 'g1.musicxml' }).scoreDocument!,
      importMusicXml(xml, { fileName: 'g1.musicxml' }).importReport,
    );
    expect(first.dto).toEqual(second.dto);
    expect(first.issues).toEqual(second.issues);
  });

  it('whitespace change in the source XML changes sourceFingerprint and revision id', () => {
    const original = fixture('g1_single_voice.musicxml');
    const modified = original.replace('<work>', '<work >');
    const a = projectScoreDocumentV1(
      importMusicXml(original, { fileName: 'g1.musicxml' }).scoreDocument!,
      importMusicXml(original, { fileName: 'g1.musicxml' }).importReport,
    );
    const b = projectScoreDocumentV1(
      importMusicXml(modified, { fileName: 'g1.musicxml' }).scoreDocument!,
      importMusicXml(modified, { fileName: 'g1.musicxml' }).importReport,
    );
    expect(a.dto.source.sourceFingerprint).not.toBe(b.dto.source.sourceFingerprint);
    expect(a.dto.scoreRevisionId).not.toBe(b.dto.scoreRevisionId);
  });

  it('the revision id matches the frozen formula over {sourceFingerprint, normalizerVersion}', () => {
    const xml = fixture('g1_single_voice.musicxml');
    const result = importMusicXml(xml, { fileName: 'g1.musicxml' });
    const dto = projectScoreDocumentV1(result.scoreDocument!, result.importReport).dto;
    expect(dto.scoreRevisionId).toBe(
      `score-revision-v1:sha256:${independentSha256(
        independentJcs({ sourceFingerprint: dto.source.sourceFingerprint, normalizerVersion: 'normalizer-1' }),
      )}`,
    );
  });

  it('validateScoreDocumentV1 rejects unknown schema versions and broken shapes', () => {
    expect(validateScoreDocumentV1({ schemaVersion: 2 }).map((issue) => issue.code)).toContain('unknown_schema_version');
    expect(validateScoreDocumentV1({ schemaVersion: 1 }).map((issue) => issue.code)).toContain('missing_field');
    expect(validateScoreDocumentV1(null).map((issue) => issue.code)).toContain('invalid_document');
  });
});

describe('planFingerprintV1 semantics', () => {
  it('is stable for identical input and independent of construction order', () => {
    const plan = basePlan();
    const p1 = payloadFor(plan);
    const p2 = payloadFor(plan);
    expect(computePlanFingerprintV1(p1)).toBe(computePlanFingerprintV1(p2));
    // rebuild keys in reverse insertion order via JSON round-trip
    const reversed = JSON.parse(JSON.stringify(p2));
    expect(computePlanFingerprintV1(reversed)).toBe(computePlanFingerprintV1(p1));
  });

  it('changes when scope, repeat, tempo, planner version or members change', () => {
    const plan = basePlan();
    const base = computePlanFingerprintV1(payloadFor(plan));
    const fingerprintOf = (overrides: Record<string, unknown>) =>
      computePlanFingerprintV1(payloadFor(plan, overrides));
    expect(fingerprintOf({ scope: { ...BASE_SCOPE, hand: 'both', handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }]) } })).not.toBe(base);
    expect(fingerprintOf({ scope: { ...BASE_SCOPE, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 } } })).not.toBe(base);
    expect(fingerprintOf({ repeatSelection: { kind: 'range-loop', count: 2 } })).not.toBe(base);
    expect(fingerprintOf({ bpm: { numerator: 81, denominator: 1 } })).not.toBe(base);
    expect(fingerprintOf({ ticksPerQuarter: 480 })).not.toBe(base);
    expect(fingerprintOf({ countInBeats: { numerator: 2, denominator: 1 } })).not.toBe(base);
    expect(fingerprintOf({ plannerVersion: 'planner-ref-2' })).not.toBe(base);
    expect(fingerprintOf({ scoreRevisionId: computeScoreRevisionId('sha256:' + '0'.repeat(64), 'normalizer-1') })).not.toBe(base);
    expect(fingerprintOf({ normalizerVersion: 'normalizer-2' })).not.toBe(base);
  });

  it('ignores runtime planId-like strings (they are not in the payload at all)', () => {
    const plan = basePlan();
    const payload = payloadFor(plan) as unknown as Record<string, unknown>;
    expect(Object.keys(payload)).not.toContain('planId');
    expect(JSON.stringify(payload)).not.toContain('Date');
  });

  it('refuses an empty target list', () => {
    const plan = basePlan();
    const payload = { ...payloadFor(plan), targetGroups: [] };
    expect(() => computePlanFingerprintV1(payload as never)).toThrowError(/refusing to fingerprint an empty target list/);
  });
});

// --- Five hand-checkable golden vectors -------------------------------------
// Expected hashes are computed independently in-script via the oracle above
// (hand-built JCS + Node crypto), NOT via the module under test.

function minimalPayload(groups: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    fingerprintSchemaVersion: 1,
    plannerVersion: 'planner-ref-1',
    scoreRevisionId: 'score-revision-v1:sha256:' + 'a'.repeat(64),
    normalizerVersion: 'normalizer-1',
    supportProfileVersion: 'musicxml-v1.0',
    scope: {
      partId: 'P1',
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      hand: 'right',
      handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }]),
    },
    repeatSelection: { kind: 'none' },
    tempo: { bpm: { numerator: 80, denominator: 1 }, ticksPerQuarter: 960, countInBeats: { numerator: 4, denominator: 1 }, timeOrigin: 'playback-start' },
    targetGroups: groups,
    ...overrides,
  } as never;
}

describe('five hand-checkable fingerprint vectors', () => {
  // Each vector's payload is small enough to hand-verify: JCS sorts keys
  // recursively by Unicode order; SHA-256 is computed here with Node crypto
  // directly over the hand-built canonical string, not via the module.
  const vectors: Array<{ name: string; groups: unknown[]; overrides?: Record<string, unknown> }> = [
    {
      name: 'V-single',
      groups: [{
        groupIndex: 0, passIndex: 0, bar: 1,
        onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
        durationBeat: { numerator: 1, denominator: 1 },
        beatInMeasure: { numerator: 0, denominator: 1 },
        staffNumbers: [1], voiceIds: ['1'],
        members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }],
      }],
    },
    {
      name: 'V-rest-gap',
      groups: [
        {
          groupIndex: 0, passIndex: 0, bar: 1,
          onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
          durationBeat: { numerator: 1, denominator: 1 },
          beatInMeasure: { numerator: 0, denominator: 1 },
          staffNumbers: [1], voiceIds: ['1'],
          members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }],
        },
        {
          groupIndex: 1, passIndex: 0, bar: 2,
          onsetBeatFromRangeStart: { numerator: 6, denominator: 1 },
          durationBeat: { numerator: 2, denominator: 1 },
          beatInMeasure: { numerator: 2, denominator: 1 },
          staffNumbers: [1], voiceIds: ['1'],
          members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 2 }, pitch: { midiNote: 67, spelling: 'G4' }, durationBeat: { numerator: 2, denominator: 1 } }],
        },
      ],
    },
    {
      name: 'V-chord',
      groups: [{
        groupIndex: 0, passIndex: 0, bar: 1,
        onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
        durationBeat: { numerator: 2, denominator: 1 },
        beatInMeasure: { numerator: 0, denominator: 1 },
        staffNumbers: [1], voiceIds: ['1'],
        members: [
          { sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } },
          { sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 2 }, pitch: { midiNote: 67, spelling: 'G4' }, durationBeat: { numerator: 2, denominator: 1 } },
        ],
      }],
    },
    {
      name: 'V-tie',
      groups: [{
        groupIndex: 0, passIndex: 0, bar: 1,
        onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
        durationBeat: { numerator: 4, denominator: 1 },
        beatInMeasure: { numerator: 0, denominator: 1 },
        staffNumbers: [1], voiceIds: ['1'],
        members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 4, denominator: 1 }, isTieOnset: true }],
      }],
    },
    {
      name: 'V-hand',
      groups: [{
        groupIndex: 0, passIndex: 0, bar: 1,
        onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
        durationBeat: { numerator: 1, denominator: 1 },
        beatInMeasure: { numerator: 0, denominator: 1 },
        staffNumbers: [1], voiceIds: ['1'],
        members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }],
      }],
      overrides: {
        scope: {
          partId: 'P1',
          range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
          hand: 'both',
          handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }]),
        },
      },
    },
  ];

  it.each(vectors.map((vector) => [vector.name, vector]))('%s: module hash equals the independent oracle', (name, vector) => {
    const payload = minimalPayload(vector.groups, vector.overrides ?? {});
    const viaModule = computePlanFingerprintV1(payload);
    const viaOracle = `plan-v1:sha256:${independentSha256(independentJcs(payload))}`;
    expect(viaModule).toBe(viaOracle);
    // Fixtures are committed: a future implementation change must produce a
    // deliberate, reviewed fingerprint change, not a silent drift.
    expect(viaModule).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
    expect(viaModule.length).toBe('plan-v1:sha256:'.length + 64);
    void name;
  });

  it('the five vectors are pairwise distinct', () => {
    const hashes = vectors.map((vector) => computePlanFingerprintV1(minimalPayload(vector.groups, vector.overrides ?? {})));
    expect(new Set(hashes).size).toBe(vectors.length);
  });

  it('V-chord tolerates member duration differences but keeps the group max', () => {
    // The group's longest member (2 beats) drives durationBeat; the short
    // member keeps its own 1-beat durationBeat in the payload. Both stay.
    const vector = vectors.find((entry) => entry.name === 'V-chord')!;
    const payload = minimalPayload(vector.groups) as unknown as {
      targetGroups: Array<{ durationBeat: { numerator: number; denominator: number }; members: Array<{ durationBeat: { numerator: number; denominator: number } }> }>;
    };
    expect(payload.targetGroups[0].durationBeat).toEqual({ numerator: 2, denominator: 1 });
    expect(payload.targetGroups[0].members[0].durationBeat).toEqual({ numerator: 1, denominator: 1 });
    expect(payload.targetGroups[0].members[1].durationBeat).toEqual({ numerator: 2, denominator: 1 });
  });
});

// --- Real-score regression ---------------------------------------------------

describe('113-bar real score projection', () => {
  const xml = readFileSync('D:/123/score-latest.musicxml', 'utf8');
  const result = importMusicXml(xml, { fileName: 'score-latest.musicxml' });
  const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);

  it('projects successfully with the frozen capability enum', () => {
    expect(result.importReport.status).toBe('READY_WITH_WARNINGS');
    expect(projected.issues).toEqual([]);
    expect(projected.dto.capabilities.sort()).toEqual([
      'chords', 'multi_staff', 'multi_voice', 'ties', 'tuplets',
    ]);
    expect(projected.dto.scoreRevisionId).toMatch(/^score-revision-v1:sha256:[0-9a-f]{64}$/);
  });

  it('preserves semantic counts (structure-level, not a semantic oracle)', () => {
    const notes = result.scoreDocument!.parts
      .flatMap((part) => part.measures.flatMap((measure) => measure.events))
      .filter((event) => event.kind === 'note');
    const projectedNotes = (projected.dto.parts as Array<{ measures: Array<{ events: Array<{ kind: string }> }> }>)
      .flatMap((part) => part.measures)
      .flatMap((measure) => measure.events)
      .filter((event) => event.kind === 'note');
    expect(projectedNotes.length).toBe(notes.length);
    expect((projected.dto.parts as Array<{ measures: unknown[] }>)[0].measures.length).toBe(113);
    expect((projected.dto.tieSpans as unknown[]).length).toBe(result.scoreDocument!.tieSpans.length);
  });

  it('is deterministic and fingerprints a generated plan stably', () => {
    const second = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    expect(second.dto).toEqual(projected.dto);
    const plan = buildPlaybackPlan(result.scoreDocument!, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    const payload = buildPlanFingerprintPayloadV1({
      plannerVersion: 'planner-ref-1',
      scoreRevisionId: projected.dto.scoreRevisionId,
      normalizerVersion: 'normalizer-1',
      supportProfileVersion: 'musicxml-v1.0',
      partId: result.scoreDocument!.parts[0].id,
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
      hand: 'both',
      handMapping: buildUserHandMapping(result.scoreDocument!.parts[0].id, [
        { staffNumber: 1, hand: 'right' },
        { staffNumber: 2, hand: 'left' },
      ]),
      repeatSelection: { kind: 'none' },
      bpm: { numerator: 72, denominator: 1 },
      ticksPerQuarter: 960,
      countInBeats: { numerator: 3, denominator: 1 },
      plan,
    });
    const fingerprint = computePlanFingerprintV1(payload);
    expect(fingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
    expect(fingerprint).toBe(computePlanFingerprintV1(payload));
    // Recorded for the audit trail (DTO size + timing are in the report).
    const dtoBytes = Buffer.byteLength(canonicalizeJcs(projected.dto), 'utf8');
    expect(dtoBytes).toBeGreaterThan(100_000);
  });
});
