// R2-2d: real-score structural regression under the SAME environment gate as
// the contract suite (RHYTHM_REAL_SCORE_PATH). Not set / file missing ->
// SKIP (never counted as PASS). Assertions are frozen structural invariants
// from the R1/R2 audit runs (1610 notated notes, 1579 occurrences, 1018
// groups, capabilities = the five-value set, stable fingerprint) plus a
// parity-side fingerprint-stability re-run. No absolute personal path is
// committed; the path arrives only via the environment variable.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import { importMusicXml } from '../import/musicxml-importer';
import { planFingerprintV1 } from '../contract-v1/plan-fingerprint';
import type { HandMappingV1 } from '../scope/practice-scope';

const REAL_SCORE_PATH = process.env.RHYTHM_REAL_SCORE_PATH ?? '';
const hasRealScore = REAL_SCORE_PATH.length > 0 && existsSync(REAL_SCORE_PATH);

const FROZEN_COUNTS = {
  measureCount: 113,
  occurrenceCount: 1579,
  groupCount: 1018,
  atomCount: 1018,
  capabilities: ['chords', 'multi_staff', 'multi_voice', 'ties', 'tuplets'],
} as const;

const HAND_MAPPING: HandMappingV1 = {
  schemaVersion: 1,
  mappingVersion: 'hand-mapping-1',
  source: 'user',
  parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] }],
};

const COMMON = {
  plannerVersion: 'parity-harness-1',
  partId: 'P1',
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
  hand: 'both' as const,
  handMapping: HAND_MAPPING,
  bpm: { numerator: 90, denominator: 1 },
  ticksPerQuarter: 960,
  countInBeats: { numerator: 4, denominator: 1 },
  repeatSelection: { kind: 'none' } as const,
};

describe.skipIf(!hasRealScore)('113-bar real score parity invariants (gated)', () => {
  it('structure: counts, capabilities and unique occurrence ids match the frozen audit values', () => {
    const xml = readFileSync(REAL_SCORE_PATH, 'utf8');
    const imported = importMusicXml(xml, { fileName: 'real-score.musicxml' });
    expect(imported.scoreDocument).toBeTruthy();
    const doc = imported.scoreDocument!;
    expect(doc.parts[0].measures).toHaveLength(FROZEN_COUNTS.measureCount);

    const plan = buildPlaybackPlan(doc, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    expect(plan.occurrences).toHaveLength(FROZEN_COUNTS.occurrenceCount);
    expect(plan.groups).toHaveLength(FROZEN_COUNTS.groupCount);
    expect(new Set(plan.occurrences.map((o) => o.occurrenceId)).size).toBe(FROZEN_COUNTS.occurrenceCount);
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960).atoms;
    expect(atoms).toHaveLength(FROZEN_COUNTS.atomCount);
    expect([...imported.importReport.capabilities].sort()).toEqual([...FROZEN_COUNTS.capabilities].sort());
  });

  it('fingerprint: identical across repeated gated runs on the identical input', () => {
    const run = () => {
      const xml = readFileSync(REAL_SCORE_PATH, 'utf8');
      const { scoreDocument, importReport } = importMusicXml(xml, { fileName: 'real-score.musicxml' });
      if (!scoreDocument) throw new Error('real score did not import');
      const plan = buildPlaybackPlan(scoreDocument, {
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
        repeatSelection: { kind: 'none' },
        unsupportedNotationPolicy: 'reject-strict',
      }).plan!;
      return planFingerprintV1({
        document: scoreDocument,
        report: importReport,
        plan,
        ...COMMON,
      });
    };
    const first = run();
    const second = run();
    expect(first).toBe(second);
    expect(first).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
  });
});
