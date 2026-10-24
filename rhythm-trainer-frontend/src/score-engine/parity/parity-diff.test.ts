import { describe, expect, it } from 'vitest';
import {
  canonicalRationalText,
  diffCandidates,
  categorize,
  reportPasses,
  rationalsEqual,
} from './parity-diff';
import type { CanonicalOccurrence, ParityCandidate } from './parity-diff';

function occurrence(overrides: Partial<CanonicalOccurrence> = {}): CanonicalOccurrence {
  return {
    locator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1, voiceId: '1' },
    passIndex: 0,
    playbackBeat: '0/1',
    durationBeat: '1/1',
    measureOrdinal: 1,
    bar: 1,
    beatInMeasure: '0/1',
    staffNumber: 1,
    voiceId: '1',
    pitch: { step: 'C', alter: 0, octave: 4, midiNote: 60, spelling: 'C4' },
    isTieOnset: false,
    playbackIndex: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<ParityCandidate> = {}): ParityCandidate {
  const first = occurrence();
  return {
    side: 'expected',
    kind: 'expected',
    occurrences: [first],
    groups: [{
      passIndex: 0,
      playbackBeat: '0/1',
      members: [{ partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1, voiceId: '1' }],
      pitches: ['C4'],
      bar: 1,
      beatInMeasure: '0/1',
      staffNumbers: [1],
      voiceIds: ['1'],
      durationBeat: '1/1',
    }],
    atoms: [{ startTick: 0, durationTicks: 960, bar: 1, beat: 1 }],
    scoreEvents: [{
      locator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1, voiceId: '1' },
      passIndex: 0,
      measure: 1,
      pitch: 60,
      targetOnsetUs: 3_000_000,
      targetDurationUs: 750_000,
      partId: 'staff-1:voice-1',
      parseConfidence: 1,
    }],
    ...overrides,
  };
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('rational text helpers', () => {
  it('reduces rationals to canonical form', () => {
    expect(canonicalRationalText('4/2')).toBe('2/1');
    expect(canonicalRationalText('0/5')).toBe('0/1');
    expect(canonicalRationalText('6/4')).toBe('3/2');
  });

  it('compares exactly across unreduced spellings', () => {
    expect(rationalsEqual('1/3', '2/6')).toBe(true);
    expect(rationalsEqual('2/3', '7/10')).toBe(false);
  });
});

describe('diffCandidates classification (frozen categories)', () => {
  it('identical candidates produce zero diffs and pass', () => {
    const diffs = diffCandidates(candidate(), clone(candidate()));
    expect(diffs).toEqual([]);
    expect(reportPasses(categorize(diffs))).toBe(true);
  });

  it('a one-semitone pitch change is a semantic-defect at the exact field path', () => {
    const expected = candidate();
    const mutated = clone(candidate());
    mutated.occurrences[0].pitch!.midiNote = 61;
    const diffs = diffCandidates(expected, mutated);
    // Meta-proof for B-class: if the comparator ignored this path, this
    // assertion would fail (task card §6/B).
    const hit = diffs.find((d) => d.path === 'occurrences[P1:m1:e1:v1:p0].pitch.midiNote');
    expect(hit?.category).toBe('semantic-defect');
    expect(reportPasses(categorize(diffs))).toBe(false);
  });

  it('a missing occurrence and an extra occurrence are both semantic-defects', () => {
    const expected = candidate();
    const dropped = clone(candidate());
    dropped.occurrences = [];
    expect(diffCandidates(expected, dropped).some((d) => d.path === 'occurrences[P1:m1:e1:v1:p0].presence'))
      .toBe(true);

    const extra = clone(candidate());
    extra.occurrences.push(occurrence({
      locator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 1, voiceId: '1' },
      playbackBeat: '4/1', bar: 2, measureOrdinal: 2, beatInMeasure: '0/1', playbackIndex: 1,
    }));
    expect(diffCandidates(expected, extra).some((d) => d.path === 'occurrences[P1:m2:e1:v1:p0].presence'))
      .toBe(true);
  });

  it('a group losing a member is a semantic-defect (voice-split detection)', () => {
    const expected = candidate();
    expected.groups[0].members.push({ partId: 'P1', measureOrdinal: 1, sourceOrdinal: 2, voiceId: '2' });
    expected.groups[0].pitches.push('E4');
    expected.groups[0].voiceIds.push('2');
    const split = clone(candidate());
    const diffs = diffCandidates(expected, split);
    expect(diffs.some((d) => d.path === 'groups[p0@0/1].members.length' && d.category === 'semantic-defect'))
      .toBe(true);
    expect(diffs.some((d) => d.path === 'groups[p0@0/1].pitches' && d.category === 'semantic-defect'))
      .toBe(true);
  });

  it('atom duration changes are semantic-defects; the display beat is serialization-only', () => {
    const expected = candidate();
    const mutated = clone(candidate());
    mutated.atoms[0].durationTicks = 1920;
    mutated.atoms[0].beat = 1.0000001;
    const diffs = diffCandidates(expected, mutated);
    expect(diffs.some((d) => d.path === 'atoms[tick=0].durationTicks' && d.category === 'semantic-defect'))
      .toBe(true);
    const display = diffs.find((d) => d.path === 'atoms[tick=0].beat');
    expect(display?.category).toBe('serialization-only');
    // serialization-only entries never fail a report on their own
    expect(reportPasses(categorize(diffs))).toBe(false); // duration semantic-defect present
  });

  it('canonical µs have zero tolerance: +1 µs on a canonical field is a semantic-defect', () => {
    const expected = candidate();
    const mutated = clone(candidate());
    mutated.scoreEvents[0].targetOnsetUs += 1;
    const diffs = diffCandidates(expected, mutated);
    expect(diffs.some((d) => d.path === 'scoreEvents[P1:m1:e1:v1:p0].targetOnsetUs' && d.category === 'semantic-defect'))
      .toBe(true);
  });

  it('legacy ms within 1 µs is time-rounding WITH attribution; beyond 1 µs fails', () => {
    const expected = candidate();
    const withWire = clone(candidate());
    withWire.kind = 'candidate';
    // Runtime ids must satisfy the frozen pattern (planId:p{pass}:{eventId}).
    const occId = 'plan-x:p0:P1:m1:e1';
    withWire.scoreEvents[0].runtimeOccurrenceId = occId;
    withWire.runtimeIds = { planId: 'plan-x', occurrenceIds: [occId], groupIds: ['plan-x:g0:0/1'] };
    withWire.wireMs = [{ scoreEventId: occId, beatPosition: 0, targetOnsetMs: 3000.0006, targetDurationMs: 750 }];

    let diffs = diffCandidates(expected, withWire);
    let rounding = diffs.find((d) => d.path === `wireMs[${occId}].targetOnsetMs`);
    expect(rounding?.category).toBe('time-rounding');
    expect(rounding?.attribution).toMatch(/µs/);
    expect(reportPasses(categorize(diffs))).toBe(true);

    withWire.wireMs[0].targetOnsetMs = 3000.003; // 3 µs off
    diffs = diffCandidates(expected, withWire);
    expect(diffs.some((d) => d.path === `wireMs[${occId}].targetOnsetMs` && d.category === 'semantic-defect'))
      .toBe(true);
    expect(reportPasses(categorize(diffs))).toBe(false);
  });

  it('duplicate runtime occurrenceIds are semantic-defects (uniqueness rule)', () => {
    const expected = candidate();
    const bad = clone(candidate());
    bad.kind = 'candidate';
    const second = occurrence({ playbackIndex: 1 });
    bad.occurrences.push(second);
    bad.runtimeIds = { planId: 'plan-x', occurrenceIds: ['plan-x:p0:a', 'plan-x:p0:a'], groupIds: ['g1', 'g2'] };
    const diffs = diffCandidates(expected, bad);
    expect(diffs.some((d) => d.path === 'runtimeIds.occurrenceIds.uniqueness' && d.category === 'semantic-defect'))
      .toBe(true);
  });

  it('unknown fields on canonical objects are unclassified and fail (fail-closed)', () => {
    const expected = candidate();
    const mutated = clone(candidate()) as unknown as ParityCandidate & { occurrences: Array<Record<string, unknown>> };
    mutated.kind = 'candidate';
    mutated.occurrences[0].experimentalField = 'oops';
    const diffs = diffCandidates(expected, mutated);
    const hit = diffs.find((d) => d.category === 'unclassified');
    expect(hit?.path).toBe('candidate.occurrences[0].{experimentalField}');
    expect(reportPasses(categorize(diffs))).toBe(false);
  });
});
