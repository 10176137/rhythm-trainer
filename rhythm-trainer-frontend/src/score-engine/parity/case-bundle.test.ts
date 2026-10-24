import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import bundleSchema from '../../../../audit-r1/contracts/parity-case-bundle-v1.schema.json';
import reportSchema from '../../../../audit-r1/contracts/parity-diff-report-v1.schema.json';
import { configFingerprint, findRepoRoot, goldenToExpected, parseBundle, parseSpelling } from './case-bundle';

const ROOT = findRepoRoot();

function validBundle(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    caseId: 'X-test',
    description: 'schema fixture',
    ruleVersions: { timeConversion: 'time-conversion-v1', fingerprintSchemaVersion: 1, parityGateDoc: 'doc@sha' },
    fixture: { path: 'audit-r1/fixtures/g1_single_voice.musicxml', sha256: 'a'.repeat(64) },
    config: {
      partId: 'P1',
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' },
      hand: 'both',
      handMapping: {
        schemaVersion: 1,
        mappingVersion: 'hand-mapping-1',
        source: 'user',
        parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }] }],
      },
      bpm: { numerator: 80, denominator: 1 },
      ticksPerQuarter: 960,
      countInUs: 3_000_000,
      unsupportedNotationPolicy: 'reject-strict',
      plannerVersion: 'parity-harness-1',
    },
    expected: { source: 'golden-fixture', ref: 'audit-r1/fixtures/golden/g1.expected.json' },
    expectedOutcome: { planStatus: 'strict' },
    acceptanceTags: ['L1', 'L2', 'L3'],
  };
}

describe('parity-case-bundle-v1 schema (AJV, schema-first)', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(bundleSchema);

  it('accepts a well-formed bundle', () => {
    expect(validate(validBundle()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a clef-heuristic hand mapping (strict practice source rule)', () => {
    const bundle = validBundle() as { config: { handMapping: { source: string } } };
    bundle.config.handMapping.source = 'clef-heuristic';
    expect(validate(bundle)).toBe(false);
  });

  it('rejects non-positive BPM, negative count-in and missing plannerVersion', () => {
    const zeroBpm = validBundle() as { config: { bpm: { numerator: number } } };
    zeroBpm.config.bpm.numerator = 0;
    expect(validate(zeroBpm)).toBe(false);

    const negativeCountIn = validBundle() as { config: { countInUs: number } };
    negativeCountIn.config.countInUs = -1;
    expect(validate(negativeCountIn)).toBe(false);

    const noPlanner = validBundle() as { config: { plannerVersion?: string } };
    delete noPlanner.config.plannerVersion;
    expect(validate(noPlanner)).toBe(false);
  });

  it('rejects a loop count above the 32-pass ceiling', () => {
    const bundle = validBundle() as { config: { repeatSelection: { kind: string; count: number } } };
    bundle.config.repeatSelection = { kind: 'range-loop', count: 33 };
    expect(validate(bundle)).toBe(false);
  });

  it('parseBundle surfaces schema violations with the origin', () => {
    const broken = validBundle() as { caseId?: string };
    delete broken.caseId;
    expect(() => parseBundle(broken, 'origin.json')).toThrow(/bundle schema violation in origin\.json/);
  });
});

describe('parity-diff-report-v1 schema validates a produced report', () => {
  it('accepts the report shape emitted by the runner (spot fields)', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(reportSchema);
    const report = {
      schemaVersion: 1,
      caseId: 'X',
      fixture: { path: 'p', sha256: 'b'.repeat(64) },
      configSha256: 'c'.repeat(64),
      sides: {
        expected: { kind: 'expected', source: 'ref' },
        candidate: { kind: 'ts-legacy-reference', gitSha: null, plannerVersion: 'parity-harness-1', engineVersion: '1.0.0' },
      },
      rustSide: 'not-implemented / not-run',
      l1: { status: 'pass', fingerprint: 'f', fingerprintErrorCode: null, stableAcrossRuns: true, note: 'n' },
      l2: { status: 'pass', occurrenceCount: 1, groupCount: 1, diffCount: 0 },
      l3: {
        status: 'pass', atomCount: 1, scoreEventCount: 1, wireCompatibility: 'pass',
        p1_3Invariants: [{ check: 'c', status: 'pass' }],
      },
      summary: {
        status: 'pass',
        categories: {
          'identity-mapping': 0, 'serialization-only': 0, 'time-rounding': 0,
          'semantic-defect': 0, 'unsupported-behavior': 0, unclassified: 0,
        },
        pass: true,
      },
      diffs: [],
      meta: {
        generatedAt: '2026-10-24T00:00:00.000Z', gitSha: null, command: 'cmd',
        timeConversionVersion: 'time-conversion-v1', fingerprintSchemaVersion: 1, parityGateDoc: 'doc',
      },
    };
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('parseSpelling (golden → canonical pitch bridge)', () => {
  it('parses naturals, sharps, flats and double accidentals with exact midi', () => {
    expect(parseSpelling('C4')).toMatchObject({ step: 'C', alter: 0, octave: 4, midi: 60 });
    expect(parseSpelling('F#4')).toMatchObject({ step: 'F', alter: 1, octave: 4, midi: 66 });
    expect(parseSpelling('Gb4')).toMatchObject({ step: 'G', alter: -1, octave: 4, midi: 66 });
    expect(parseSpelling('F##4')).toMatchObject({ step: 'F', alter: 2, octave: 4, midi: 67 });
    expect(parseSpelling('Bb3')).toMatchObject({ step: 'B', alter: -1, octave: 3, midi: 58 });
    expect(() => parseSpelling('H4')).toThrow();
  });
});

describe('goldenToExpected (no second copy of the hand truth)', () => {
  const golden = JSON.parse(
    readFileSync(`${ROOT}/audit-r1/fixtures/golden/g1.expected.json`, 'utf8'),
  );

  it('converts the committed G1 golden into canonical shape with derived locators', () => {
    const expected = goldenToExpected(golden);
    expect(expected.kind).toBe('expected');
    expect(expected.occurrences).toHaveLength(5);
    expect(expected.groups).toHaveLength(5);
    expect(expected.scoreEvents).toHaveLength(5);
    expect(expected.atoms).toHaveLength(5);
    // Locators derive from the golden event order (G4 in m2 is e1, the rest is e2).
    expect(expected.occurrences[4].locator).toEqual({ partId: 'P1', measureOrdinal: 2, sourceOrdinal: 1, voiceId: '1' });
    expect(expected.occurrences[0].playbackBeat).toBe('0/1');
    expect(expected.occurrences[0].pitch?.midiNote).toBe(60);
    expect(expected.scoreEvents[0].targetOnsetUs).toBe(3_000_000);
    expect(expected.atoms[4]).toMatchObject({ startTick: 3840, durationTicks: 1920, bar: 2, beat: 1 });
  });

  it('keeps group bars and in-measure beats (m2 starts at 4/1)', () => {
    const expected = goldenToExpected(golden);
    expect(expected.groups[4].bar).toBe(2);
    expect(expected.groups[4].beatInMeasure).toBe('0/1');
  });

  it('configFingerprint is order-stable across key permutations', () => {
    const config = validBundle().config as Record<string, unknown>;
    const permuted = Object.fromEntries(Object.keys(config).reverse().map((key) => [key, config[key]]));
    // Recursive sorted-key serialization makes the hash key-order-proof at
    // every depth, not just the top level.
    expect(configFingerprint(permuted as never)).toBe(configFingerprint(config as never));
  });

  it('configFingerprint binds nested fields: range/bpm/loop/handMapping changes all move the hash', () => {
    const base = validBundle().config as Record<string, unknown>;
    const baseHash = configFingerprint(base as never);

    const rangeShifted = structuredClone(base) as typeof base;
    (rangeShifted.range as { endMeasureOrdinal: number }).endMeasureOrdinal = 3;
    expect(configFingerprint(rangeShifted as never)).not.toBe(baseHash);

    const bpmShifted = structuredClone(base) as typeof base;
    (bpmShifted.bpm as { numerator: number }).numerator = 81;
    expect(configFingerprint(bpmShifted as never)).not.toBe(baseHash);

    const loopShifted = structuredClone(base) as typeof base;
    loopShifted.repeatSelection = { kind: 'range-loop', count: 2 };
    expect(configFingerprint(loopShifted as never)).not.toBe(baseHash);

    const handShifted = structuredClone(base) as typeof base;
    ((handShifted.handMapping as { parts: Array<{ staves: Array<{ hand: string }> }> })
      .parts[0].staves[0] as { hand: string }).hand = 'left';
    expect(configFingerprint(handShifted as never)).not.toBe(baseHash);
  });
});
