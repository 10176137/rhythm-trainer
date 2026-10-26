#!/usr/bin/env node
'use strict';

// Deterministic generator for the Stage 3 alignment benchmark dataset.
//
// Each case has TWO files: a raw trace (score targets + performed events +
// quality signals) and an independent label file (expected pairing / misses /
// extras / unassessable evidence). The runner never passes labels to the
// algorithm; labels only score its output.
//
// Synthetic only: no personal data, no third-party score. Regenerating writes
// byte-identical files (except the manifest timestamp).

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASE_DIR = path.join(__dirname, 'cases');
const LABEL_DIR = path.join(__dirname, 'labels');
const DATASET_VERSION = 'alignment-bench-v1';
const BPM = 80;
const COUNT_IN_MS = 3000;
const BEAT_MS = 60_000 / BPM;
const CREATED_AT = '2026-10-26T00:00:00.000Z';

mkdirSync(CASE_DIR, { recursive: true });
mkdirSync(LABEL_DIR, { recursive: true });

const sha = (value) => createHash('sha256').update(value).digest('hex');
const round = (value) => Math.round(value * 1000) / 1000;
const onset = (beat) => round(COUNT_IN_MS + beat * BEAT_MS);

const BASE_PITCHES = [60, 62, 64, 65, 67, 69, 71, 72];

function event(id, measure, beat, pitch, durationMs = BEAT_MS, partId = 'P1') {
  return {
    scoreEventId: id,
    measure,
    beatPosition: round(beat),
    pitch,
    targetOnsetMs: onset(beat),
    targetDurationMs: round(durationMs),
    partId,
    parseConfidence: 1,
  };
}

function baseEvents() {
  return BASE_PITCHES.map((pitch, index) => event(
    `s${index + 1}`,
    index < 4 ? 1 : 2,
    index,
    pitch,
  ));
}

function configFor(scoreEvents) {
  const scoreFingerprint = `benchmark:score:${sha(JSON.stringify(scoreEvents)).slice(0, 32)}`;
  const planFingerprint = `plan-v1:sha256:${sha(`plan:${scoreFingerprint}:${BPM}:3000000`)}`;
  return {
    bpm: BPM,
    countInMs: COUNT_IN_MS,
    countInUs: COUNT_IN_MS * 1000,
    ticksPerQuarter: 960,
    hand: 'both',
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
    repeatSelection: { kind: 'none' },
    plannerVersion: 'benchmark-planner-1',
    scoreFingerprint,
    planFingerprint,
  };
}

function performedFor(scoreEvents, options = {}) {
  const skip = new Set(options.skip ?? []);
  const shiftPitch = options.shiftPitch ?? {};
  const offsets = options.offsets ?? {};
  const missingRelease = new Set(options.missingRelease ?? []);
  const performed = scoreEvents
    .filter((scoreEvent) => !skip.has(scoreEvent.scoreEventId))
    .map((scoreEvent) => {
      const offset = offsets[scoreEvent.scoreEventId] ?? 0;
      const start = round(scoreEvent.targetOnsetMs + offset);
      return {
        performedNoteId: `p-${scoreEvent.scoreEventId}`,
        pitch: scoreEvent.pitch + (shiftPitch[scoreEvent.scoreEventId] ?? 0),
        onsetMs: start,
        releaseMs: missingRelease.has(scoreEvent.scoreEventId)
          ? null
          : round(start + scoreEvent.targetDurationMs),
        pairingStatus: missingRelease.has(scoreEvent.scoreEventId)
          ? 'missing-release'
          : 'complete',
      };
    });
  for (const extra of options.extras ?? []) performed.push(extra);
  return performed;
}

function labelsFor(scoreEvents, performed, options = {}) {
  const unassessable = new Set(options.unassessable ?? []);
  const byScore = new Map(scoreEvents.map((scoreEvent) => [scoreEvent.scoreEventId, scoreEvent]));
  const byPerformed = new Map(performed.map((note) => [note.performedNoteId, note]));
  const pairs = [];
  const missed = [];
  for (const scoreEvent of scoreEvents) {
    if (unassessable.has(scoreEvent.scoreEventId)) continue;
    const note = byPerformed.get(`p-${scoreEvent.scoreEventId}`);
    if (!note) {
      missed.push(scoreEvent.scoreEventId);
      continue;
    }
    pairs.push({
      scoreEventId: scoreEvent.scoreEventId,
      performedNoteId: note.performedNoteId,
      pitchMatched: note.pitch === scoreEvent.pitch,
      onsetErrorMs: round(note.onsetMs - scoreEvent.targetOnsetMs),
    });
  }
  const pairedPerformed = new Set(pairs.map((pair) => pair.performedNoteId));
  const extraPerformedIds = performed
    .filter((note) => !pairedPerformed.has(note.performedNoteId))
    .map((note) => note.performedNoteId);
  void byScore;
  return {
    pairs,
    missedScoreEventIds: missed,
    extraPerformedIds,
    unassessableScoreEventIds: [...unassessable],
  };
}

function timelineCase({ id, scenario, tags, scoreEvents = baseEvents(), performed, quality, labels, notes }) {
  const config = configFor(scoreEvents);
  const trace = {
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    caseId: id,
    mode: 'timeline',
    scenario,
    config,
    scoreEvents,
    performed,
    qualitySignals: {
      noteOnMissing: 0,
      noteOffMissing: 0,
      duplicates: 0,
      outOfOrder: 0,
      clockQuality: 'good',
      deviceDisconnected: false,
      queueOverflow: false,
      performedCount: performed.length,
      ...quality,
    },
    derivation: 'synthetic exact-answer trace; labels are authored separately',
  };
  const labelFile = {
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    caseId: id,
    mode: 'timeline',
    source: 'synthetic',
    license: 'internal-test-only',
    expected: {
      inputQuality: 'healthy',
      assessable: ['pitch', 'onset', 'duration'],
      ...labels,
      notes,
    },
  };
  return { trace, labelFile, manifest: { caseId: id, mode: 'timeline', scenario, tags, source: 'synthetic', license: 'internal-test-only' } };
}

function followCase({ id, scenario, tags, groups, inputs, pauseAtMs = null, expected, notes }) {
  const trace = {
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    caseId: id,
    mode: 'follow',
    scenario,
    config: {
      bpm: 60,
      timingToleranceMs: 60,
      chordSpreadToleranceMs: 50,
      plannerVersion: 'benchmark-follow-1',
      scoreFingerprint: `benchmark:follow:${sha(JSON.stringify(groups)).slice(0, 32)}`,
      planFingerprint: `plan-v1:sha256:${sha(`follow:${id}:${JSON.stringify(groups)}`)}`,
    },
    groups,
    inputs,
    pauseAtMs,
    qualitySignals: {
      clockQuality: 'not-applicable',
      deviceDisconnected: false,
      performedCount: inputs.length,
    },
    derivation: 'synthetic self-paced trace; expected kinds are authored separately',
  };
  const labelFile = {
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    caseId: id,
    mode: 'follow',
    source: 'synthetic',
    license: 'internal-test-only',
    expected: { inputQuality: 'healthy', ...expected, notes },
  };
  return { trace, labelFile, manifest: { caseId: id, mode: 'follow', scenario, tags, source: 'synthetic', license: 'internal-test-only' } };
}

// ---------------------------------------------------------------------------
// Timeline cases

const cases = [];
const base = baseEvents();

cases.push(timelineCase({
  id: 'tl-clean-exact',
  scenario: 'clean, exact performance',
  tags: ['clean', 'baseline'],
  performed: performedFor(base),
  labels: labelsFor(base, performedFor(base)),
  notes: 'Every target played exactly once at its notated onset.',
}));

const lateGlobal = performedFor(base, { offsets: Object.fromEntries(base.map((e) => [e.scoreEventId, 50])) });
cases.push(timelineCase({
  id: 'tl-late-global',
  scenario: 'whole performance 50 ms late',
  tags: ['timing', 'systematic-offset'],
  performed: lateGlobal,
  labels: labelsFor(base, lateGlobal),
  notes: 'All notes remain the same intended target; original onset error must be preserved.',
}));

const localOffsets = { s1: 0, s2: 30, s3: -40, s4: 0, s5: 60, s6: -20, s7: 0, s8: 10 };
const local = performedFor(base, { offsets: localOffsets });
cases.push(timelineCase({
  id: 'tl-local-deviations',
  scenario: 'local timing deviations within the band',
  tags: ['timing', 'local'],
  performed: local,
  labels: labelsFor(base, local),
  notes: 'Alternating early/late errors; identity must not shift.',
}));

const driftOffsets = { s1: 0, s2: 20, s3: 50, s4: 90, s5: 140, s6: 200, s7: 270, s8: 350 };
const drift = performedFor(base, { offsets: driftOffsets });
cases.push(timelineCase({
  id: 'tl-tempo-drift',
  scenario: 'accelerando / tempo drift',
  tags: ['timing', 'tempo-drift', 'hard'],
  performed: drift,
  labels: labelsFor(base, drift),
  notes: 'Identity labels stay fixed; no DTW warp may replace the original onset error.',
}));

const oneMiss = performedFor(base, { skip: ['s4'] });
cases.push(timelineCase({
  id: 'tl-one-miss',
  scenario: 'one missing target',
  tags: ['missing', 'hard'],
  performed: oneMiss,
  labels: labelsFor(base, oneMiss),
  notes: 's4 has no performed note; following targets must not shift.',
}));

const consecutiveMiss = performedFor(base, { skip: ['s3', 's4', 's5'] });
cases.push(timelineCase({
  id: 'tl-consecutive-miss',
  scenario: 'three consecutive missing targets',
  tags: ['missing', 'consecutive', 'hard'],
  performed: consecutiveMiss,
  labels: labelsFor(base, consecutiveMiss),
  notes: 'Greedy matching is most likely to drift here.',
}));

const wrongPitch = performedFor(base, { shiftPitch: { s4: 1 } });
cases.push(timelineCase({
  id: 'tl-wrong-pitch',
  scenario: 'one wrong pitch at the correct time',
  tags: ['pitch', 'hard'],
  performed: wrongPitch,
  labels: labelsFor(base, wrongPitch),
  notes: 'The pair should be identified but classified wrong-pitch, not as a correct hit.',
}));

const extraPerformed = performedFor(base, {
  extras: [{ performedNoteId: 'p-extra-1', pitch: 70, onsetMs: 5230, releaseMs: 5600, pairingStatus: 'complete' }],
});
cases.push(timelineCase({
  id: 'tl-extra-note',
  scenario: 'one inserted note between targets',
  tags: ['extra', 'hard'],
  performed: extraPerformed,
  labels: labelsFor(base, extraPerformed),
  notes: 'The inserted note must be reported as extra, not consumed as a target.',
}));

const mixedPerformed = performedFor(base, {
  skip: ['s3'],
  shiftPitch: { s6: 1 },
  extras: [{ performedNoteId: 'p-extra-mixed', pitch: 74, onsetMs: 7000, releaseMs: 7200, pairingStatus: 'complete' }],
});
cases.push(timelineCase({
  id: 'tl-mixed-errors',
  scenario: 'missing + wrong pitch + extra interleaved',
  tags: ['missing', 'pitch', 'extra', 'hard'],
  performed: mixedPerformed,
  labels: labelsFor(base, mixedPerformed),
  notes: 'Combined error sources; each label is independent of the algorithm.',
}));

const chordScore = [
  event('s1', 1, 0, 60),
  event('s2', 1, 0, 64),
  event('s3', 1, 0, 67),
  event('s4', 1, 1, 62),
];
const chordPerformed = [
  { performedNoteId: 'p-s3', pitch: 67, onsetMs: round(onset(0) + 5), releaseMs: round(onset(0) + 755), pairingStatus: 'complete' },
  { performedNoteId: 'p-s2', pitch: 64, onsetMs: round(onset(0) + 8), releaseMs: round(onset(0) + 758), pairingStatus: 'complete' },
  { performedNoteId: 'p-s1', pitch: 60, onsetMs: round(onset(0) + 10), releaseMs: round(onset(0) + 760), pairingStatus: 'complete' },
  { performedNoteId: 'p-s4', pitch: 62, onsetMs: onset(1), releaseMs: round(onset(1) + BEAT_MS), pairingStatus: 'complete' },
];
cases.push(timelineCase({
  id: 'tl-chord-arrival-order',
  scenario: 'same-onset chord arrives in reverse pitch order',
  tags: ['chord', 'arrival-order'],
  scoreEvents: chordScore,
  performed: chordPerformed,
  labels: labelsFor(chordScore, chordPerformed),
  notes: 'All chord members share one onset; arrival order must not create misses/extras.',
}));

const unisonScore = [
  { ...event('s1', 1, 0, 60), partId: 'P1-staff1' },
  { ...event('s2', 1, 0, 60), partId: 'P1-staff2' },
  event('s3', 1, 1, 62),
];
const unisonPerformed = [
  { performedNoteId: 'p-s1', pitch: 60, onsetMs: onset(0), releaseMs: round(onset(0) + BEAT_MS), pairingStatus: 'complete' },
  { performedNoteId: 'p-s2', pitch: 60, onsetMs: round(onset(0) + 2), releaseMs: round(onset(0) + BEAT_MS + 2), pairingStatus: 'complete' },
  { performedNoteId: 'p-s3', pitch: 62, onsetMs: onset(1), releaseMs: round(onset(1) + BEAT_MS), pairingStatus: 'complete' },
];
cases.push(timelineCase({
  id: 'tl-cross-hand-unison',
  scenario: 'two staves notate the same MIDI pitch on one onset',
  tags: ['chord', 'unison', 'cross-hand'],
  scoreEvents: unisonScore,
  performed: unisonPerformed,
  labels: labelsFor(unisonScore, unisonPerformed),
  notes: 'Two notated members with the same pitch remain two occurrences.',
}));

const repeatScore = [0, 1, 2, 3].map((index) => event(`s${index + 1}`, 1, index * 0.25, 60, BEAT_MS / 4));
const repeatPerformed = repeatScore.map((scoreEvent, index) => ({
  performedNoteId: `p-${scoreEvent.scoreEventId}`,
  pitch: 60,
  onsetMs: round(scoreEvent.targetOnsetMs + (index % 2 === 0 ? 8 : -8)),
  releaseMs: round(scoreEvent.targetOnsetMs + BEAT_MS / 4),
  pairingStatus: 'complete',
}));
cases.push(timelineCase({
  id: 'tl-fast-repeated-note',
  scenario: 'fast repeated same pitch',
  tags: ['repeated-pitch', 'hard'],
  scoreEvents: repeatScore,
  performed: repeatPerformed,
  labels: labelsFor(repeatScore, repeatPerformed),
  notes: 'A dedupe threshold must not swallow real repeats.',
}));

const tieScore = [
  { ...event('s1', 1, 0, 60, 3000), targetDurationMs: 3000 },
  event('s2', 2, 0, 62),
];
const tiePerformed = [
  { performedNoteId: 'p-s1', pitch: 60, onsetMs: onset(0), releaseMs: round(onset(0) + 3000), pairingStatus: 'complete' },
  { performedNoteId: 'p-s2', pitch: 62, onsetMs: round(onset(0) + 3000), releaseMs: round(onset(0) + 3750), pairingStatus: 'complete' },
];
cases.push(timelineCase({
  id: 'tl-tie-long-note',
  scenario: 'tied long note followed by a short note',
  tags: ['tie', 'duration'],
  scoreEvents: tieScore,
  performed: tiePerformed,
  labels: labelsFor(tieScore, tiePerformed),
  notes: 'Duration evidence is assessed against the full notated span.',
}));

const missingReleasePerformed = performedFor(base, { missingRelease: ['s2'] });
cases.push(timelineCase({
  id: 'tl-missing-note-off',
  scenario: 'Note On without Note Off',
  tags: ['input-evidence', 'missing-release', 'degraded'],
  performed: missingReleasePerformed,
  quality: { noteOffMissing: 1, clockQuality: 'good' },
  labels: {
    ...labelsFor(base, missingReleasePerformed),
    inputQuality: 'degraded',
    assessable: ['pitch', 'onset'],
  },
  notes: 'Onset has evidence; duration must not be invented as zero.',
}));

const duplicatePerformed = performedFor(base, {
  extras: [{ performedNoteId: 'p-s1-duplicate', pitch: 60, onsetMs: onset(0), releaseMs: round(onset(0) + BEAT_MS), pairingStatus: 'complete' }],
});
cases.push(timelineCase({
  id: 'tl-duplicate-packet',
  scenario: 'duplicated MIDI packet for the same key/onset',
  tags: ['input-evidence', 'duplicate', 'degraded'],
  performed: duplicatePerformed,
  quality: { duplicates: 1, clockQuality: 'good' },
  labels: {
    ...labelsFor(base, duplicatePerformed),
    inputQuality: 'degraded',
    assessable: ['pitch', 'onset'],
  },
  notes: 'The duplicate is input evidence degradation plus one extra event.',
}));

const lateHard = performedFor(base, { offsets: { s4: 400 } });
cases.push(timelineCase({
  id: 'tl-one-note-400ms-late',
  scenario: 'one note 400 ms late (outside the normal matching band)',
  tags: ['timing', 'hard', 'out-of-band'],
  performed: lateHard,
  labels: labelsFor(base, lateHard),
  notes: 'Ground truth still pairs s4; the baseline may fail this case.',
}));

const missingOn = performedFor(base, { skip: ['s3'] });
cases.push(timelineCase({
  id: 'tl-missing-note-on',
  scenario: 'one Note On lost before capture',
  tags: ['input-evidence', 'missing-note-on', 'degraded'],
  performed: missingOn,
  quality: { noteOnMissing: 1, clockQuality: 'good' },
  labels: {
    ...labelsFor(base, missingOn, { unassessable: ['s3'] }),
    unassessableScoreEventIds: ['s3'],
    inputQuality: 'degraded',
    assessable: ['pitch', 'onset'],
  },
  notes: 'Input loss is not the user missing s3; s3 is unassessable.',
}));

const disconnectPerformed = performedFor(base, { skip: ['s5', 's6', 's7', 's8'] });
cases.push(timelineCase({
  id: 'tl-device-disconnect',
  scenario: 'device disconnects after four notes',
  tags: ['input-evidence', 'disconnect', 'degraded'],
  performed: disconnectPerformed,
  quality: { deviceDisconnected: true, clockQuality: 'unknown' },
  labels: {
    ...labelsFor(base, disconnectPerformed, { unassessable: ['s5', 's6', 's7', 's8'] }),
    unassessableScoreEventIds: ['s5', 's6', 's7', 's8'],
    inputQuality: 'degraded',
    assessable: ['pitch', 'onset'],
  },
  notes: 'Missing tail is evidence loss, not four user misses.',
}));

const emptyScore = [event('s1', 1, 0, 60)];
cases.push(timelineCase({
  id: 'tl-empty-input',
  scenario: 'no performed events at all',
  tags: ['input-evidence', 'empty', 'unscorable'],
  scoreEvents: emptyScore,
  performed: [],
  quality: { performedCount: 0, clockQuality: 'unknown' },
  labels: {
    ...labelsFor(emptyScore, [], { unassessable: ['s1'] }),
    inputQuality: 'unscorable',
    assessable: [],
  },
  notes: 'No evidence; no score should be invented.',
}));

// ---------------------------------------------------------------------------
// Follow cases

function group(id, beat, notes) {
  return {
    groupId: id,
    bar: 1,
    playbackBeat: beat,
    pitches: notes.map(([midiNote, spelling]) => ({ midiNote, spelling })),
  };
}

const followGroups = [
  group('g1', 0, [[60, 'C4']]),
  group('g2', 1, [[62, 'D4']]),
  group('g3', 2, [[64, 'E4']]),
];

cases.push(followCase({
  id: 'fw-clean',
  scenario: 'Follow: clean three-target performance',
  tags: ['follow', 'clean'],
  groups: followGroups,
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 62, atMs: 1000 },
    { midiNote: 64, atMs: 2000 },
  ],
  expected: {
    kinds: ['correct', 'correct', 'complete'],
    completedTargets: 3,
    standardTargets: 3,
    wrongNoteCount: 0,
    extraNoteCount: 0,
    duplicateNoteCount: 0,
    pendingTargetId: null,
    intervalJudged: [false, true, true],
  },
  notes: 'Intervals match the notated beats at 60 BPM.',
}));

cases.push(followCase({
  id: 'fw-skip-target',
  scenario: 'Follow: one target skipped, performer continues',
  tags: ['follow', 'missing-target', 'hard'],
  groups: followGroups,
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 64, atMs: 1000 },
  ],
  expected: {
    kinds: ['correct', 'wrong'],
    completedTargets: 1,
    standardTargets: 1,
    wrongNoteCount: 1,
    extraNoteCount: 0,
    duplicateNoteCount: 0,
    pendingTargetId: 'g2',
    intervalJudged: [false],
  },
  notes: 'E4 while waiting on D4 is wrong and must not advance.',
}));

cases.push(followCase({
  id: 'fw-wrong-then-correct',
  scenario: 'Follow: wrong note then recovery',
  tags: ['follow', 'wrong-note'],
  groups: followGroups,
  inputs: [
    { midiNote: 62, atMs: 100 },
    { midiNote: 60, atMs: 200 },
    { midiNote: 62, atMs: 1200 },
    { midiNote: 64, atMs: 2200 },
  ],
  expected: {
    kinds: ['wrong', 'correct', 'correct', 'complete'],
    completedTargets: 3,
    standardTargets: 2,
    wrongNoteCount: 1,
    extraNoteCount: 0,
    duplicateNoteCount: 0,
    pendingTargetId: null,
    intervalJudged: [false, true, true],
  },
  notes: 'The wrong note keeps the first target non-standard; later targets recover.',
}));

const chordGroups = [
  group('g1', 0, [[60, 'C4'], [64, 'E4']]),
  group('g2', 1, [[67, 'G4']]),
];
cases.push(followCase({
  id: 'fw-chord-spread',
  scenario: 'Follow: chord arrives spread beyond tolerance',
  tags: ['follow', 'chord', 'spread'],
  groups: chordGroups,
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 64, atMs: 100 },
    { midiNote: 67, atMs: 1100 },
  ],
  expected: {
    kinds: ['partial', 'correct', 'complete'],
    completedTargets: 2,
    standardTargets: 0,
    wrongNoteCount: 0,
    extraNoteCount: 0,
    duplicateNoteCount: 0,
    pendingTargetId: null,
    intervalJudged: [false, true],
  },
  notes: 'The chord spread (100 ms) and the next interval (1100 ms vs 1000 ms) both exceed tolerance.',
}));

const duplicateGroups = [
  group('g1', 0, [[60, 'C4'], [64, 'E4']]),
  group('g2', 1, [[67, 'G4']]),
];
cases.push(followCase({
  id: 'fw-duplicate-note',
  scenario: 'Follow: repeated key inside an incomplete chord',
  tags: ['follow', 'duplicate'],
  groups: duplicateGroups,
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 60, atMs: 100 },
    { midiNote: 64, atMs: 200 },
    { midiNote: 67, atMs: 1200 },
  ],
  expected: {
    kinds: ['partial', 'duplicate', 'correct', 'complete'],
    completedTargets: 2,
    standardTargets: 0,
    wrongNoteCount: 0,
    extraNoteCount: 0,
    duplicateNoteCount: 1,
    pendingTargetId: null,
    intervalJudged: [false, true],
  },
  notes: 'The second C4 is a duplicate while the chord is incomplete; the spread and next interval are non-standard.',
}));

cases.push(followCase({
  id: 'fw-pause-resume',
  scenario: 'Follow: pause then resume invalidates the next interval',
  tags: ['follow', 'pause', 'resume'],
  groups: followGroups,
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 62, atMs: 2000 },
    { midiNote: 64, atMs: 3000 },
  ],
  pauseAtMs: 1000,
  expected: {
    kinds: ['correct', 'correct', 'complete'],
    completedTargets: 3,
    standardTargets: 3,
    wrongNoteCount: 0,
    extraNoteCount: 0,
    duplicateNoteCount: 0,
    pendingTargetId: null,
    intervalJudged: [false, false, true],
  },
  notes: 'The interval across the pause is not judged; the next one is.',
}));

cases.push(followCase({
  id: 'fw-extra-after-complete',
  scenario: 'Follow: input after the final target',
  tags: ['follow', 'extra'],
  groups: [group('g1', 0, [[60, 'C4']])],
  inputs: [
    { midiNote: 60, atMs: 0 },
    { midiNote: 62, atMs: 100 },
  ],
  expected: {
    kinds: ['complete', 'extra'],
    completedTargets: 1,
    standardTargets: 1,
    wrongNoteCount: 0,
    extraNoteCount: 1,
    duplicateNoteCount: 0,
    pendingTargetId: null,
    intervalJudged: [false],
  },
  notes: 'After completion, further input is extra.',
}));

// ---------------------------------------------------------------------------
// Write files

const manifestCases = [];
for (const item of cases) {
  const traceName = `${item.trace.caseId}.trace.json`;
  const labelName = `${item.labelFile.caseId}.labels.json`;
  writeFileSync(path.join(CASE_DIR, traceName), `${JSON.stringify(item.trace, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(LABEL_DIR, labelName), `${JSON.stringify(item.labelFile, null, 2)}\n`, 'utf8');
  manifestCases.push({
    ...item.manifest,
    trace: `cases/${traceName}`,
    labels: `labels/${labelName}`,
  });
}

const manifest = {
  schemaVersion: 1,
  datasetVersion: DATASET_VERSION,
  createdAt: CREATED_AT,
  description: 'Stage 3 synthetic alignment benchmark (Timeline + Follow). Labels are independent of the implementation.',
  cases: manifestCases,
  counts: {
    timeline: manifestCases.filter((item) => item.mode === 'timeline').length,
    follow: manifestCases.filter((item) => item.mode === 'follow').length,
  },
};
writeFileSync(path.join(__dirname, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`wrote ${manifestCases.length} cases (${manifest.counts.timeline} timeline, ${manifest.counts.follow} follow)`);
