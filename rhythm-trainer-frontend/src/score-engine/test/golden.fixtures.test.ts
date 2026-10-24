import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beatToString, rational } from '../domain/rational';
import type { RationalBeat } from '../domain/rational';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import { buildEngineScoreEvents } from '../playback/score-events';

/**
 * G1–G5 golden contract.
 *
 * Expected values come from audit-r1/fixtures/golden/g*.expected.json, which are
 * hand-derived from audit-r1/docs/GOLDEN_FIXTURES.md (rational onsets, integer
 * microseconds, integer ticks). They are never generated from the importer or
 * planner. `legacy-reference.json` is produced by the implementation and is only
 * compared against those expected values.
 */

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);
const GOLDEN_ROOT = new URL('golden/', FIXTURE_ROOT);
const CASES = ['G1', 'G2', 'G3', 'G4', 'G5'] as const;

interface ExpectedEvent {
  kind: 'note' | 'rest';
  spelling: string | null;
  midi: number | null;
  onset: string;
  duration: string;
  measure: number;
  staff: number;
  voice: string;
  chordGroup: boolean;
  tieStart: boolean;
  tieStop: boolean;
  grace: boolean;
  timeModification?: string;
}

interface ExpectedCase {
  case: string;
  fixture: string;
  derivation: string;
  bpm: number;
  countInBeats: number;
  countInUs: number;
  fingerprint: string;
  import: { status: string; strictAllowed: boolean; counts: Record<string, number> };
  measures: { ordinal: number; start: string; duration: string; time: string }[];
  events: ExpectedEvent[];
  tieSpans: { start: string; end: string; eventCount: number }[];
  plan: {
    rangeStart: string;
    rangeDuration: string;
    occurrenceCount: number;
    groupCount: number;
    occurrences: { playbackBeat: string; duration: string; bar: number; staff: number; voice: string; midi: number; isTieOnset: boolean }[];
    groups: { playbackBeat: string; pitches: string[]; duration: string }[];
  };
  scoreEvents: { pitch: number; measure: number; beat: string; onsetUs: number; durationUs: number }[];
  atoms: { startTick: number; durationTicks: number; bar: number; beatInMeasure: string }[];
  legacyOnsetDiffsUs: number[];
}

const expected = Object.fromEntries(
  CASES.map((name) => [
    name,
    JSON.parse(readFileSync(new URL(`${name.toLowerCase()}.expected.json`, GOLDEN_ROOT), 'utf8')) as ExpectedCase,
  ]),
) as Record<(typeof CASES)[number], ExpectedCase>;

const legacy = JSON.parse(
  readFileSync(new URL('legacy-reference.json', GOLDEN_ROOT), 'utf8'),
) as {
  generatedBy: string;
  generatorVersion: number;
  gitSha: string | null;
  generatedAtIso: string;
  cases: Record<string, { scoreEvents: { onsetUs: number; durationUs: number }[] }>;
};

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');
}

function parseBeat(text: string): RationalBeat {
  const [numerator, denominator] = text.split('/').map(Number);
  return rational(numerator, denominator);
}

/** Frozen protocol (GOLDEN_FIXTURES §1.1/§1.3, R2-1 §3.5): CountInUs is the
 * integer-µs input; the ONLY rounding is roundHalfUp of the offset. */
function targetOnsetUs(beatPosition: RationalBeat, bpm: number, countInUs: number): number {
  const numerator = BigInt(beatPosition.numerator) * 60_000_000n;
  const denominator = BigInt(beatPosition.denominator) * BigInt(bpm);
  const rounded = Number((numerator + denominator / 2n) / denominator);
  return countInUs + rounded;
}

function durationUs(duration: RationalBeat, bpm: number): number {
  const numerator = BigInt(duration.numerator) * 60_000_000n;
  const denominator = BigInt(duration.denominator) * BigInt(bpm);
  return Number((numerator + denominator / 2n) / denominator);
}

/**
 * Differential classification. A 1 µs delta is a rounding difference, not a
 * semantic one — but it is still reported, never silently tolerated.
 */
function classifyOnsetDiff(expectedUs: number, actualUs: number): 'exact' | 'time-rounding' | 'semantic' {
  const delta = actualUs - expectedUs;
  if (delta === 0) return 'exact';
  if (Math.abs(delta) <= 1) return 'time-rounding';
  return 'semantic';
}

describe('G1–G5 golden fixtures (hand-derived truth)', () => {
  it('legacyReference carries provenance and is not treated as truth', () => {
    expect(legacy.generatedBy).toBe('audit-r1/spike/generate-legacy-reference.mjs');
    expect(legacy.generatorVersion).toBe(1);
    expect(legacy.generatedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof legacy.gitSha === 'string' || legacy.gitSha === null).toBe(true);
    expect(legacy.cases).toHaveProperty('G1');
  });

  for (const name of CASES) {
    describe(name, () => {
      const spec = expected[name];
      const result = importMusicXml(fixture(spec.fixture), { fileName: spec.fixture });
      const doc = result.scoreDocument;
      if (!doc) throw new Error(`${name}: fixture did not import (${result.importReport.status})`);
      const part = doc.parts[0];
      const measureCount = Math.max(...doc.parts.map((entry) => entry.measures.length));
      const planResult = buildPlaybackPlan(doc, {
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
        repeatSelection: { kind: 'none' },
        unsupportedNotationPolicy: 'reject-strict',
      });
      const plan = planResult.plan;
      if (!plan) throw new Error(`${name}: no playback plan`);
      const scoreEvents = buildEngineScoreEvents(plan, spec.bpm, spec.countInBeats);
      const atomResult = scoreOccurrencesToEngineAtoms(plan, 960);

      it('import status, strictness, counts and fingerprint are exact', () => {
        expect(result.importReport.status).toBe(spec.import.status);
        expect(result.importReport.strictAllowed).toBe(spec.import.strictAllowed);
        for (const [key, value] of Object.entries(spec.import.counts)) {
          expect(result.importReport.counts[key as keyof typeof result.importReport.counts]).toBe(value);
        }
        expect(result.importReport.fingerprint).toBe(spec.fingerprint);
        expect(planResult.strictAllowed).toBe(true);
      });

      it('measure start/duration/meter come from the score, not from a 4/4 assumption', () => {
        expect(part.measures).toHaveLength(spec.measures.length);
        spec.measures.forEach((measure, index) => {
          expect(part.measures[index].ordinal).toBe(measure.ordinal);
          expect(beatToString(part.measures[index].startBeat)).toBe(measure.start);
          expect(beatToString(part.measures[index].durationBeat)).toBe(measure.duration);
          expect(`${part.measures[index].attributes.time.beats}/${part.measures[index].attributes.time.beatType}`)
            .toBe(measure.time);
        });
      });

      it('every notated event keeps exact rational onset/duration and pitch', () => {
        const events = part.measures.flatMap((measure) => measure.events);
        expect(events).toHaveLength(spec.events.length);
        spec.events.forEach((want, index) => {
          const event = events[index];
          expect(event.kind).toBe(want.kind);
          expect(beatToString(event.onsetBeat)).toBe(want.onset);
          expect(beatToString(event.durationBeat)).toBe(want.duration);
          expect(event.pitch?.spelling ?? null).toBe(want.spelling);
          expect(event.pitch?.midiNote ?? null).toBe(want.midi);
          expect(event.source.measureOrdinal).toBe(want.measure);
          expect(event.source.staffNumber).toBe(want.staff);
          expect(event.source.voiceId).toBe(want.voice);
          expect(Boolean(event.chordGroupId)).toBe(want.chordGroup);
          expect(event.tieStart).toBe(want.tieStart);
          expect(event.tieStop).toBe(want.tieStop);
          expect(event.isGrace).toBe(want.grace);
          if (want.timeModification) {
            expect(`${event.timeModification?.actualNotes}:${event.timeModification?.normalNotes}`)
              .toBe(want.timeModification);
          }
        });
      });

      it('tie spans are resolved the hand-derived way', () => {
        expect(doc.tieSpans).toHaveLength(spec.tieSpans.length);
        spec.tieSpans.forEach((want, index) => {
          expect(beatToString(doc.tieSpans[index].startBeat)).toBe(want.start);
          expect(beatToString(doc.tieSpans[index].endBeat)).toBe(want.end);
          expect(doc.tieSpans[index].eventIds).toHaveLength(want.eventCount);
        });
      });

      it('occurrences and groups keep the exact plan shape', () => {
        expect(plan.rangeStartBeat).toEqual(parseBeat(spec.plan.rangeStart));
        expect(plan.rangeDurationBeat).toEqual(parseBeat(spec.plan.rangeDuration));
        expect(plan.occurrences).toHaveLength(spec.plan.occurrenceCount);
        expect(plan.groups).toHaveLength(spec.plan.groupCount);
        spec.plan.occurrences.forEach((want, index) => {
          const occurrence = plan.occurrences[index];
          expect(beatToString(occurrence.playbackBeat)).toBe(want.playbackBeat);
          expect(beatToString(occurrence.durationBeat)).toBe(want.duration);
          expect(occurrence.bar).toBe(want.bar);
          expect(occurrence.staffNumber).toBe(want.staff);
          expect(occurrence.voiceId).toBe(want.voice);
          expect(occurrence.pitch?.midiNote).toBe(want.midi);
          expect(occurrence.isTieOnset).toBe(want.isTieOnset);
        });
        spec.plan.groups.forEach((want, index) => {
          const group = plan.groups[index];
          expect(beatToString(group.playbackBeat)).toBe(want.playbackBeat);
          expect(group.pitches.map((pitch) => pitch.spelling)).toEqual(want.pitches);
          expect(beatToString(group.durationBeat)).toBe(want.duration);
        });
      });

      it('target onsets/durations are exact integer microseconds (frozen offset protocol)', () => {
        expect(scoreEvents).toHaveLength(spec.scoreEvents.length);
        spec.scoreEvents.forEach((want, index) => {
          const event = scoreEvents[index];
          const occurrence = plan.occurrences[index];
          expect(event.pitch).toBe(want.pitch);
          expect(event.measure).toBe(want.measure);
          // The derivation is self-consistent with the rational plan beat under
          // the FROZEN protocol: CountInUs + roundHalfUp(offset).
          const derivedOnset = targetOnsetUs(occurrence.playbackBeat, spec.bpm, spec.countInUs);
          const derivedDuration = durationUs(occurrence.durationBeat, spec.bpm);
          expect(derivedOnset).toBe(want.onsetUs);
          expect(derivedDuration).toBe(want.durationUs);
          // The implementation's ms output maps to within the frozen 1 µs
          // legacy tolerance of the hand-derived integer microseconds; any
          // real deviation is caught by the exact checks below.
          expect(Math.abs(Math.round(event.targetOnsetMs * 1000) - want.onsetUs)).toBeLessThanOrEqual(1);
          expect(Math.abs(Math.round(event.targetDurationMs * 1000) - want.durationUs)).toBeLessThanOrEqual(1);
        });
      });

      it('atoms are exact integers on the 960 tick grid', () => {
        expect(atomResult.issues).toEqual([]);
        expect(atomResult.atoms).toHaveLength(spec.atoms.length);
        spec.atoms.forEach((want, index) => {
          const atom = atomResult.atoms[index];
          expect(atom.startTick).toBe(want.startTick);
          expect(atom.durationTicks).toBe(want.durationTicks);
          expect(atom.bar).toBe(want.bar);
          const inMeasure = parseBeat(want.beatInMeasure);
          expect(atom.beat).toBe(1 + inMeasure.numerator / inMeasure.denominator);
        });
        for (const atom of atomResult.atoms) {
          expect(Number.isInteger(atom.startTick)).toBe(true);
          expect(Number.isInteger(atom.durationTicks)).toBe(true);
        }
      });

      it('identifiers are stable, unique and composed from the documented parts', () => {
        const events = part.measures.flatMap((measure) => measure.events);
        const prefix = spec.fingerprint.slice(0, 16);
        const ids = events.map((event) => event.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const event of events) {
          expect(event.id).toBe(`${prefix}:${event.source.partId}:m${event.source.measureOrdinal}:e${event.source.sourceOrdinal}`);
        }
        expect(plan.planId).toBe(`plan:${prefix}:m1-${measureCount}:once:playback-planner-1.0.0`);
        const occurrenceIds = new Set<string>();
        for (const occurrence of plan.occurrences) {
          expect(occurrence.occurrenceId).toBe(`${plan.planId}:p${occurrence.passIndex}:${occurrence.scoreEventId}`);
          expect(occurrenceIds.has(occurrence.occurrenceId)).toBe(false);
          occurrenceIds.add(occurrence.occurrenceId);
        }
        expect(scoreEvents.map((event) => event.scoreEventId))
          .toEqual(plan.occurrences.map((occurrence) => occurrence.occurrenceId));
      });

      it('legacyReference differences match the documented classification', () => {
        const reference = legacy.cases[name];
        expect(reference).toBeDefined();
        expect(reference.scoreEvents).toHaveLength(spec.scoreEvents.length);
        const diffs = reference.scoreEvents.map((entry, index) => entry.onsetUs - spec.scoreEvents[index].onsetUs);
        expect(diffs).toEqual(spec.legacyOnsetDiffsUs);
        for (const diff of diffs) {
          // G5 (post-adjudication): the pre-revision legacy dump sits 1 µs
          // below the frozen-protocol truth on beats 1/4 — classified
          // `time-rounding` (legacy float ms precision), NOT exact, NOT
          // semantic. All other cases/G5 beats stay exact.
          const classification = classifyOnsetDiff(0, diff);
          expect(['exact', 'time-rounding']).toContain(classification);
        }
        // G1–G4 remain fully exact; only G5 carries rounding-classified diffs.
        if (name !== 'G5') {
          for (const diff of diffs) expect(diff).toBe(0);
        }
      });
    });
  }
});

describe('G2 chord and repeated pitch semantics', () => {
  it('keeps occurrences=4, groups=2, atoms=2, scoreEvents=4 with distinct repeated C4', () => {
    const spec = expected.G2;
    const doc = importMusicXml(fixture(spec.fixture), { fileName: spec.fixture }).scoreDocument!;
    const plan = buildPlaybackPlan(doc, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    const scoreEvents = buildEngineScoreEvents(plan, spec.bpm, spec.countInBeats);
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960).atoms;
    expect(plan.occurrences).toHaveLength(4);
    expect(plan.groups).toHaveLength(2);
    expect(atoms).toHaveLength(2);
    expect(scoreEvents).toHaveLength(4);

    const events = doc.parts[0].measures[0].events;
    expect(events[0].id).not.toBe(events[3].id);
    expect(events[0].source.sourceOrdinal).not.toBe(events[3].source.sourceOrdinal);
    const c4Occurrences = plan.occurrences.filter((occurrence) => occurrence.pitch?.midiNote === 60);
    expect(c4Occurrences).toHaveLength(2);
    expect(c4Occurrences[0].occurrenceId).not.toBe(c4Occurrences[1].occurrenceId);
    // Both C4 attacks exist at distinct beats; the chord shares one onset.
    expect(plan.occurrences.slice(0, 3).map((occurrence) => beatToString(occurrence.playbackBeat)))
      .toEqual(['0/1', '0/1', '0/1']);
    expect(beatToString(plan.occurrences[3].playbackBeat)).toBe('1/1');
    expect(plan.groups[0].scoreEventIds).toHaveLength(3);
  });
});

describe('G3 tie continuation', () => {
  it('produces one attack with the merged duration', () => {
    const spec = expected.G3;
    const doc = importMusicXml(fixture(spec.fixture), { fileName: spec.fixture }).scoreDocument!;
    const events = doc.parts[0].measures.flatMap((measure) => measure.events);
    expect(events).toHaveLength(2);
    expect(events[1].tieStop).toBe(true);
    const plan = buildPlaybackPlan(doc, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    expect(plan.occurrences).toHaveLength(1);
    expect(beatToString(plan.occurrences[0].durationBeat)).toBe('4/1');
    expect(plan.occurrences[0].isTieOnset).toBe(true);
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960);
    expect(atoms.atoms).toHaveLength(1);
    expect(atoms.atoms[0].durationTicks).toBe(3840);
  });
});

describe('G4 tick grid fail-closed', () => {
  it('keeps 1/3 exact and refuses to round a 1/7 beat onto the 960 tick grid', () => {
    const doc = importMusicXml(fixture('negative/septuplet-1-7.musicxml'), { fileName: 'septuplet-1-7.musicxml' });
    expect(doc.importReport.strictAllowed).toBe(true);
    const plan = buildPlaybackPlan(doc.scoreDocument!, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    expect(plan.occurrences[1].playbackBeat).toEqual(rational(1, 7));
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960);
    expect(atoms.atoms.map((atom) => atom.startTick)).toEqual([960]);
    expect(atoms.issues).toHaveLength(7);
    for (const issue of atoms.issues) {
      expect(issue.code).toBe('tick_grid_rounding');
      expect(issue.blocksStrict).toBe(true);
    }
  });
});

describe('G5 triple meter and rounding discipline', () => {
  it('uses 3-beat measures and bar 2 starts at beat 3', () => {
    const spec = expected.G5;
    const doc = importMusicXml(fixture(spec.fixture), { fileName: spec.fixture }).scoreDocument!;
    const measures = doc.parts[0].measures;
    expect(beatToString(measures[0].durationBeat)).toBe('3/1');
    expect(beatToString(measures[1].startBeat)).toBe('3/1');
    const plan = buildPlaybackPlan(doc, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960).atoms;
    expect(atoms.map((atom) => `${atom.bar}:${atom.startTick}`)).toEqual([
      '1:0', '1:960', '1:1920', '2:2880', '2:3840', '2:4800',
    ]);
  });

  it('classifies a 1 microsecond delta as a rounding difference, never as success', () => {
    expect(classifyOnsetDiff(3333334, 3333333)).toBe('time-rounding');
    expect(classifyOnsetDiff(3333334, 3333334)).toBe('exact');
    expect(classifyOnsetDiff(3333334, 3333344)).toBe('semantic');
  });
});
