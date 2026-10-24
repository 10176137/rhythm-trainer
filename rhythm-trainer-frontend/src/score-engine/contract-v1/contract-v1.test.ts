import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  validatePlanFingerprintPayloadV1,
} from './plan-fingerprint';

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);
const GOLDEN = JSON.parse(readFileSync(
  new URL('../../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json', import.meta.url),
  'utf8',
)) as {
  vectors: Record<string, { payload: unknown; expectedCanonical: string; expectedFingerprint: string }>;
};
const fixture = (name: string) => readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');

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
});

describe('numberToRationalV1', () => {
  it('projects integers and finite decimals exactly', () => {
    expect(numberToRationalV1(3)).toEqual({ numerator: 3, denominator: 1 });
    expect(numberToRationalV1(-0.5)).toEqual({ numerator: -1, denominator: 2 });
    expect(numberToRationalV1(0)).toEqual({ numerator: 0, denominator: 1 });
  });

  it('never writes a binary approximation for a decimal literal', () => {
    expect(numberToRationalV1(0.1)).toEqual({ numerator: 1, denominator: 10 });
    expect(numberToRationalV1(2.75)).toEqual({ numerator: 11, denominator: 4 });
  });

  it('handles scientific notation exactly', () => {
    expect(numberToRationalV1(1e-7)).toEqual({ numerator: 1, denominator: 10_000_000 });
    expect(numberToRationalV1(-1.5e-3)).toEqual({ numerator: -3, denominator: 2000 });
    expect(numberToRationalV1(2.5e3)).toEqual({ numerator: 2500, denominator: 1 });
  });

  it('rejects non-finite and out-of-range values', () => {
    expect(() => numberToRationalV1(NaN)).toThrowError(/not a finite number/);
    expect(() => numberToRationalV1(Infinity)).toThrowError(/not a finite number/);
    expect(() => numberToRationalV1(1e17)).toThrowError(/exceeds safe range/);
  });

  it('rationalV1 rejects zero denominators and reduces input', () => {
    expect(() => rationalV1(1, 0)).toThrowError(/denominator must be > 0/);
    expect(rationalV1(2, 4)).toEqual({ numerator: 1, denominator: 2 });
  });
});

describe('beatToMicroseconds (time-conversion-v1, BigInt exact)', () => {
  it('is exact at whole beats and converts thirds without accumulation', () => {
    const bpm = { numerator: 60, denominator: 1 };
    expect(beatToMicroseconds({ numerator: 0, denominator: 1 }, bpm)).toBe(0);
    expect(beatToMicroseconds({ numerator: 1, denominator: 1 }, bpm)).toBe(1_000_000);
    expect(beatToMicroseconds({ numerator: 1, denominator: 3 }, bpm)).toBe(333_333);
    expect(beatToMicroseconds({ numerator: 2, denominator: 3 }, bpm)).toBe(666_667);
  });

  it('rounds exact halves up and stays exact beyond 2^53 intermediates', () => {
    expect(beatToMicroseconds({ numerator: 1, denominator: 128 }, { numerator: 100, denominator: 1 })).toBe(4688);
    expect(beatToMicroseconds({ numerator: 1, denominator: 64 }, { numerator: 100, denominator: 1 })).toBe(9375);
    // Intermediate product 444444447 * 60_000_000 exceeds 2^53; the exact
    // result must not depend on float rounding.
    expect(beatToMicroseconds({ numerator: 444_444_447, denominator: 1 }, { numerator: 60, denominator: 1 }))
      .toBe(444_444_447_000_000);
  });

  it('rejects negative beats, non-positive BPM and unreduced rationals', () => {
    expect(() => beatToMicroseconds({ numerator: -1, denominator: 1 }, { numerator: 60, denominator: 1 })).toThrowError(/non-negative/);
    expect(() => beatToMicroseconds({ numerator: 1, denominator: 1 }, { numerator: 0, denominator: 1 })).toThrowError(/bpm must be positive/);
    expect(() => beatToMicroseconds({ numerator: 2, denominator: 4 } as never, { numerator: 60, denominator: 1 })).toThrowError(/not a reduced RationalV1/);
  });
});

describe('score projection determinism and identity', () => {
  const imported = () => importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1.musicxml' });

  it('projects the same fixture identically twice (deep equality)', () => {
    const first = imported();
    const second = imported();
    const a = projectScoreDocumentV1(first.scoreDocument!, first.importReport);
    const b = projectScoreDocumentV1(second.scoreDocument!, second.importReport);
    expect(a.dto).toEqual(b.dto);
    expect(a.issues).toEqual(b.issues);
  });

  it('rejects a document/report fingerprint mismatch instead of stamping A with B identity', () => {
    const a = imported();
    const other = importMusicXml(fixture('g5_three_four.musicxml'), { fileName: 'g5.musicxml' });
    expect(() => projectScoreDocumentV1(a.scoreDocument!, other.importReport)).toThrowError(/fingerprint/);
  });

  it('whitespace change in the source XML changes sourceFingerprint and revision id', () => {
    const original = fixture('g1_single_voice.musicxml');
    const modified = original.replace('<work>', '<work >');
    const first = importMusicXml(original, { fileName: 'g1.musicxml' });
    const second = importMusicXml(modified, { fileName: 'g1.musicxml' });
    const a = projectScoreDocumentV1(first.scoreDocument!, first.importReport);
    const b = projectScoreDocumentV1(second.scoreDocument!, second.importReport);
    expect(a.dto.source.sourceFingerprint).not.toBe(b.dto.source.sourceFingerprint);
    expect(a.dto.scoreRevisionId).not.toBe(b.dto.scoreRevisionId);
  });

  it('the revision id matches the frozen formula over sorted keys', () => {
    const result = imported();
    const dto = projectScoreDocumentV1(result.scoreDocument!, result.importReport).dto;
    // JCS sorts keys: normalizerVersion before sourceFingerprint.
    const manual = `{"normalizerVersion":"normalizer-1","sourceFingerprint":"${dto.source.sourceFingerprint}"}`;
    expect(dto.scoreRevisionId).toBe(
      `score-revision-v1:sha256:${createHash('sha256').update(manual, 'utf8').digest('hex')}`,
    );
  });
});

describe('validateScoreDocumentV1 (full closed validation)', () => {
  it('accepts the g1 projection with zero issues', () => {
    const result = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1.musicxml' });
    const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    expect(validateScoreDocumentV1(projected.dto)).toEqual([]);
  });

  it('rejects unknown schema versions, missing and unexpected fields', () => {
    expect(validateScoreDocumentV1({ schemaVersion: 2 }).map((issue) => issue.code)).toContain('unknown_schema_version');
    expect(validateScoreDocumentV1({ schemaVersion: 1 }).map((issue) => issue.code)).toContain('missing_field');
    expect(validateScoreDocumentV1({ schemaVersion: 1, extra: true }).map((issue) => issue.code)).toContain('unexpected_field');
  });

  it('schema violations surface as schema_violation (AJV against the committed schema)', () => {
    const result = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1.musicxml' });
    const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    // Nested unexpected field.
    const nestedExtra = JSON.parse(JSON.stringify(projected.dto));
    (nestedExtra.parts as Array<Record<string, unknown>>)[0].oops = 1;
    expect(validateScoreDocumentV1(nestedExtra).map((issue) => issue.code)).toContain('schema_violation');
    // Wrong type deep in the tree.
    const wrongType = JSON.parse(JSON.stringify(projected.dto));
    const parts = wrongType.parts as Array<{ measures: Array<{ ordinal: unknown }> }>;
    parts[0].measures[0].ordinal = 'one';
    expect(validateScoreDocumentV1(wrongType).map((issue) => issue.code)).toContain('schema_violation');
    // Enum violation (measure capability outside chords|tuplets).
    const badEnum = JSON.parse(JSON.stringify(projected.dto));
    const parts2 = badEnum.parts as Array<{ measures: Array<{ capabilities: string[] }> }>;
    parts2[0].measures[0].capabilities = ['grace'];
    expect(validateScoreDocumentV1(badEnum).map((issue) => issue.code)).toContain('schema_violation');
  });

  it('projection throws fail-closed on duplicate partId and unknown capability', () => {
    const result = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1.musicxml' });
    const withUnknownCapability = {
      ...result.scoreDocument!,
      capabilities: [...result.scoreDocument!.capabilities, 'some_future_capability'],
    };
    expect(() => projectScoreDocumentV1(withUnknownCapability, result.importReport))
      .toThrowError(/not in frozen enum/);
    const withDuplicatePart = JSON.parse(JSON.stringify(result.scoreDocument!));
    (withDuplicatePart.parts as unknown[]).push(
      JSON.parse(JSON.stringify((withDuplicatePart.parts as unknown[])[0])),
    );
    expect(() => projectScoreDocumentV1(withDuplicatePart, result.importReport))
      .toThrowError(/partId duplicated/);
  });

  it('rejects unreduced rationals and duplicate identities deep in the tree', () => {
    const result = importMusicXml(fixture('g1_single_voice.musicxml'), { fileName: 'g1.musicxml' });
    const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    const dto = JSON.parse(JSON.stringify(projected.dto));
    const parts = dto.parts as Array<{ measures: Array<Record<string, unknown>> }>;
    parts[0].measures[0].startBeat = { numerator: 2, denominator: 4 };
    expect(validateScoreDocumentV1(dto).map((issue) => issue.code)).toContain('invalid_rational');

    const dto2 = JSON.parse(JSON.stringify(projected.dto));
    const parts2 = dto2.parts as Array<{ measures: Array<{ events: Array<Record<string, unknown>> }> }>;
    parts2[0].measures[0].events[1].eventId = parts2[0].measures[0].events[0].eventId;
    expect(validateScoreDocumentV1(dto2).map((issue) => issue.code)).toContain('duplicate_event_id');
  });

  it('rejects dangling tieSpan references', () => {
    const result = importMusicXml(fixture('g3_tie_across_bar.musicxml'), { fileName: 'g3.musicxml' });
    const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    const dto = JSON.parse(JSON.stringify(projected.dto));
    (dto.tieSpans as Array<Record<string, unknown>>)[0].eventIds = ['nonexistent-1', 'nonexistent-2'];
    expect(validateScoreDocumentV1(dto).map((issue) => issue.code)).toContain('dangling_reference');
  });
});

describe('validatePlanFingerprintPayloadV1 (full closed validation)', () => {
  const golden = GOLDEN.vectors['V-single'].payload as Record<string, never>;

  it('accepts the golden single-note payload', () => {
    expect(validatePlanFingerprintPayloadV1(golden)).toEqual([]);
  });

  it('rejects missing scope, clef-heuristic mappings, unreduced rationals and unknown fields', () => {
    const missingScope = JSON.parse(JSON.stringify(golden));
    delete missingScope.scope;
    expect(validatePlanFingerprintPayloadV1(missingScope).map((issue) => issue.code)).toContain('missing_field');

    const heuristic = JSON.parse(JSON.stringify(golden));
    heuristic.scope.handMapping.source = 'clef-heuristic';
    expect(validatePlanFingerprintPayloadV1(heuristic).map((issue) => issue.code)).toContain('invalid_scope');

    const unreduced = JSON.parse(JSON.stringify(golden));
    unreduced.tempo.bpm = { numerator: 160, denominator: 2 };
    expect(validatePlanFingerprintPayloadV1(unreduced).map((issue) => issue.code)).toContain('invalid_rational');

    const unexpected = JSON.parse(JSON.stringify(golden));
    unexpected.planId = 'plan:runtime-id';
    expect(validatePlanFingerprintPayloadV1(unexpected).map((issue) => issue.code)).toContain('unexpected_field');

    const empty = JSON.parse(JSON.stringify(golden));
    empty.targetGroups = [];
    expect(validatePlanFingerprintPayloadV1(empty).map((issue) => issue.code)).toContain('empty_plan');
  });

  it('rejects out-of-sequence groupIndex, group-duration != max member, duplicate member locator', () => {
    const renumbered = JSON.parse(JSON.stringify(golden));
    renumbered.targetGroups[0].groupIndex = 7;
    const codes = validatePlanFingerprintPayloadV1(renumbered).map((issue) => issue.code);
    expect(codes).toContain('group_index_out_of_sequence');

    const chordVector = GOLDEN.vectors['V-chord'].payload as Record<string, never>;
    const tamperedDuration = JSON.parse(JSON.stringify(chordVector));
    // Group max is 2/1 (the G4); claim 3/1 instead.
    tamperedDuration.targetGroups[0].durationBeat = { numerator: 3, denominator: 1 };
    expect(validatePlanFingerprintPayloadV1(tamperedDuration).map((issue) => issue.code))
      .toContain('group_duration_mismatch');

    const duplicatedMember = JSON.parse(JSON.stringify(chordVector));
    duplicatedMember.targetGroups[0].members[1].sourceLocator.sourceOrdinal =
      duplicatedMember.targetGroups[0].members[0].sourceLocator.sourceOrdinal;
    expect(validatePlanFingerprintPayloadV1(duplicatedMember).map((issue) => issue.code))
      .toContain('duplicate_member_locator');
  });

  it('schema violations surface as schema_violation (AJV against the committed schema)', () => {
    const badHand = JSON.parse(JSON.stringify(golden));
    badHand.scope.hand = 'left';
    badHand.ticksPerQuarter = '960';
    const codes = validatePlanFingerprintPayloadV1(badHand).map((issue) => issue.code);
    expect(codes).toContain('schema_violation');
  });
});

describe('planFingerprintV1 semantics', () => {
  it('is stable for identical input and independent of construction order', () => {
    const plan = basePlan();
    const p1 = payloadFor(plan);
    const p2 = payloadFor(plan);
    expect(computePlanFingerprintV1(p1)).toBe(computePlanFingerprintV1(p2));
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

  it('refuses an invalid payload before hashing (fail closed)', () => {
    const plan = basePlan();
    const broken = { ...payloadFor(plan) } as Record<string, unknown>;
    delete broken.scope;
    expect(() => computePlanFingerprintV1(broken as never)).toThrowError(/plan fingerprint payload failed V1 validation/);
    const unreduced = JSON.parse(JSON.stringify(payloadFor(plan)));
    unreduced.tempo.bpm = { numerator: 160, denominator: 2 };
    expect(() => computePlanFingerprintV1(unreduced as never)).toThrowError(/plan fingerprint payload failed V1 validation/);
  });

  it('member locators come from semantic source data, not runtime ID parsing', () => {
    const plan = basePlan();
    const payload = payloadFor(plan) as unknown as {
      targetGroups: Array<{ members: Array<{ sourceLocator: { partId: string; measureOrdinal: number; sourceOrdinal: number } }> }>;
    };
    // g1's first member is part P1, measure 1 — semantic facts from the plan's
    // occurrences, never parsed out of a runtime ID string.
    const first = payload.targetGroups[0].members[0].sourceLocator;
    expect(first.partId).toBe('P1');
    expect(first.measureOrdinal).toBe(1);
    expect(first.sourceOrdinal).toBeGreaterThanOrEqual(1);
  });

  it('changing internal ID encodings without changing semantic sources leaves the fingerprint identical', () => {
    const plan = basePlan();
    const original = computePlanFingerprintV1(payloadFor(plan));
    // Re-encode every runtime ID (different prefix/format) while keeping the
    // semantic source fields untouched. The builder looks occurrences up by
    // scoreEventId, so both sides are renamed consistently.
    const renamed = JSON.parse(JSON.stringify(plan)) as typeof plan;
    for (const occurrence of renamed.occurrences) {
      occurrence.occurrenceId = `zz-${occurrence.occurrenceId}`;
      occurrence.scoreEventId = `zz/${occurrence.scoreEventId}`;
    }
    for (const group of renamed.groups) {
      group.groupId = `zz-${group.groupId}`;
      group.occurrenceIds = group.occurrenceIds.map((id) => `zz-${id}`);
      group.scoreEventIds = group.scoreEventIds.map((id) => `zz/${id}`);
    }
    renamed.planId = 'plan:totally-different-encoding';
    const renamedFingerprint = computePlanFingerprintV1(payloadFor(renamed));
    expect(renamedFingerprint).toBe(original);
  });

  it('a real semantic change (pitch) changes the fingerprint', () => {
    const plan = basePlan();
    const original = computePlanFingerprintV1(payloadFor(plan));
    const tampered = JSON.parse(JSON.stringify(plan)) as typeof plan;
    for (const occurrence of tampered.occurrences) {
      if (occurrence.pitch) occurrence.pitch = { ...occurrence.pitch, midiNote: occurrence.pitch.midiNote! + 1 };
    }
    expect(computePlanFingerprintV1(payloadFor(tampered))).not.toBe(original);
  });

  it('hand mapping input order does not change the fingerprint (sets, not lists)', () => {
    const plan = basePlan();
    const sorted = computePlanFingerprintV1(payloadFor(plan, {
      scope: {
        ...BASE_SCOPE,
        hand: 'both',
        handMapping: buildUserHandMapping('P1', [
          { staffNumber: 1, hand: 'right' },
          { staffNumber: 2, hand: 'left' },
        ]),
      },
    }));
    const swapped = computePlanFingerprintV1(payloadFor(plan, {
      scope: {
        ...BASE_SCOPE,
        hand: 'both',
        handMapping: buildUserHandMapping('P1', [
          { staffNumber: 2, hand: 'left' },
          { staffNumber: 1, hand: 'right' },
        ]),
      },
    }));
    expect(swapped).toBe(sorted);
  });
});

describe('committed golden vectors (frozen hashes)', () => {
  const names = Object.keys(GOLDEN.vectors);

  it('fixture carries five vectors with payload, canonical bytes and hash', () => {
    expect(names.length).toBe(5);
    for (const name of names) {
      const vector = GOLDEN.vectors[name];
      expect(vector.payload).toBeTruthy();
      expect(vector.expectedCanonical).toMatch(/^\{/);
      expect(vector.expectedFingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
    }
  });

  it.each(names)('%s: reference implementation equals the committed frozen hash', (name) => {
    const vector = GOLDEN.vectors[name];
    // canonical bytes must round-trip: re-parsing the committed canonical text
    // and re-canonicalizing yields the identical bytes.
    const reparsed = JSON.parse(vector.expectedCanonical);
    expect(canonicalizeJcs(reparsed)).toBe(vector.expectedCanonical);
    // the fingerprint equals the COMMITTED value, not a runtime oracle
    expect(computePlanFingerprintV1(vector.payload as never)).toBe(vector.expectedFingerprint);
    // and sha256 over the committed canonical bytes matches too
    const fromBytes = `plan-v1:sha256:${createHash('sha256').update(vector.expectedCanonical, 'utf8').digest('hex')}`;
    expect(fromBytes).toBe(vector.expectedFingerprint);
  });

  it('the five vectors are pairwise distinct', () => {
    const hashes = names.map((name) => GOLDEN.vectors[name].expectedFingerprint);
    expect(new Set(hashes).size).toBe(5);
  });

  it('V-chord keeps member durations while the group takes the max', () => {
    const chord = GOLDEN.vectors['V-chord'].payload as {
      targetGroups: Array<{ durationBeat: { numerator: number; denominator: number }; members: Array<{ durationBeat: { numerator: number; denominator: number } }> }>;
    };
    expect(chord.targetGroups[0].durationBeat).toEqual({ numerator: 2, denominator: 1 });
    expect(chord.targetGroups[0].members[0].durationBeat).toEqual({ numerator: 1, denominator: 1 });
    expect(chord.targetGroups[0].members[1].durationBeat).toEqual({ numerator: 2, denominator: 1 });
  });
});

// --- Real-score regression (optional local file; skipped when absent) -------

// Optional local regression: set RHYTHM_REAL_SCORE_PATH to a private real
// score to run it. Without the variable the suite stays green in a clean
// clone/CI; a skipped run is NOT a passed run and is never reported as one.
describe('113-bar real score projection (optional local regression)', () => {
  const scorePath = process.env.RHYTHM_REAL_SCORE_PATH ?? '';
  const hasFile = scorePath !== '' && existsSync(scorePath);
  const xml = hasFile ? readFileSync(scorePath, 'utf8') : null;

  it.skipIf(!hasFile)('projects successfully, validates cleanly, and fingerprints a plan stably', () => {
    const result = importMusicXml(xml!, { fileName: 'score-latest.musicxml' });
    const projected = projectScoreDocumentV1(result.scoreDocument!, result.importReport);
    expect(result.importReport.status).toBe('READY_WITH_WARNINGS');
    expect(projected.issues).toEqual([]);
    expect(projected.dto.capabilities.sort()).toEqual([
      'chords', 'multi_staff', 'multi_voice', 'ties', 'tuplets',
    ]);
    expect(validateScoreDocumentV1(projected.dto)).toEqual([]);

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
  });
});
