// Dumps the real TypeScript score-engine pipeline for the audit fixtures.
// Bundled with esbuild (no repo modification). Output is the `legacyReference`
// differential input for GOLDEN_FIXTURES.md — never a source of truth.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importMusicXml } from 'D:/123/rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/playback-planner.ts';
import { buildEngineScoreEvents } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/score-events.ts';

const dir = 'D:/123/audit-r1/fixtures/';
const cases = [
  { file: 'g1_single_voice.musicxml', bpm: 80, countInBeats: 4 },
  { file: 'g1_single_voice.ids.musicxml', bpm: 80, countInBeats: 4 },
  { file: 'g2_chord.musicxml', bpm: 100, countInBeats: 4 },
  { file: 'g2_chord.ids.musicxml', bpm: 100, countInBeats: 4 },
  { file: 'g3_tie_across_bar.musicxml', bpm: 120, countInBeats: 4 },
  { file: 'g3_tie_across_bar.ids.musicxml', bpm: 120, countInBeats: 4 },
  { file: 'g4_triplet.musicxml', bpm: 60, countInBeats: 4 },
  { file: 'g5_three_four.musicxml', bpm: 90, countInBeats: 4 },
  { file: 'g6_unison_two_staves.musicxml', bpm: 80, countInBeats: 4 },
  { file: 'g8_key_alter.musicxml', bpm: 80, countInBeats: 4 },
];

const beat = (b) => `${b.numerator}/${b.denominator}`;
const out = {};

for (const testCase of cases) {
  const xml = readFileSync(join(dir, testCase.file), 'utf8');
  const result = importMusicXml(xml, { fileName: testCase.file });
  const report = result.importReport;
  const doc = result.scoreDocument;
  const entry = {
    file: testCase.file,
    bpm: testCase.bpm,
    countInBeats: testCase.countInBeats,
    importStatus: report.status,
    strictAllowed: report.strictAllowed,
    counts: report.counts,
    issues: report.issues.map((issue) => ({ code: issue.code, severity: issue.severity, blocksStrict: issue.blocksStrict, measureOrdinal: issue.measureOrdinal, eventId: issue.eventId, xmlId: issue.xmlId })),
    capabilities: report.capabilities,
    fingerprint: report.fingerprint,
  };
  if (!doc) {
    entry.scoreDocument = null;
    out[testCase.file] = entry;
    continue;
  }
  entry.measures = doc.parts.flatMap((part) => part.measures.map((measure) => ({
    part: part.id,
    ordinal: measure.ordinal,
    printedNumber: measure.printedNumber ?? null,
    startBeat: beat(measure.startBeat),
    durationBeat: beat(measure.durationBeat),
    time: measure.attributes.time,
    events: measure.events.map((event) => ({
      id: event.id,
      xmlId: event.source.xmlId ?? null,
      kind: event.kind,
      onset: beat(event.onsetBeat),
      onsetAbsNum: event.onsetBeat.numerator,
      onsetAbsDen: event.onsetBeat.denominator,
      duration: beat(event.durationBeat),
      pitch: event.pitch ? { step: event.pitch.step, alter: event.pitch.alter, octave: event.pitch.octave, midi: event.pitch.midiNote, spelling: event.pitch.spelling } : null,
      staff: event.source.staffNumber,
      voice: event.source.voiceId ?? null,
      sourceOrdinal: event.source.sourceOrdinal,
      chordGroupId: event.chordGroupId ?? null,
      tieStart: event.tieStart,
      tieStop: event.tieStop,
      tieSpanId: event.tieSpanId ?? null,
      isGrace: event.isGrace,
      timeModification: event.timeModification ?? null,
    })),
  })));
  entry.tieSpans = doc.tieSpans.map((span) => ({ id: span.id, eventIds: span.eventIds, startBeat: beat(span.startBeat), endBeat: beat(span.endBeat) }));

  const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
  const planResult = buildPlaybackPlan(doc, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  });
  const plan = planResult.plan;
  entry.plan = plan ? {
    planId: plan.planId,
    strictAllowed: plan.strictAllowed,
    rangeStartBeat: beat(plan.rangeStartBeat),
    rangeDurationBeat: beat(plan.rangeDurationBeat),
    occurrenceCount: plan.occurrences.length,
    groupCount: plan.groups.length,
    occurrences: plan.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      scoreEventId: occurrence.scoreEventId,
      playbackIndex: occurrence.playbackIndex,
      measureOrdinal: occurrence.measureOrdinal,
      playbackBeat: beat(occurrence.playbackBeat),
      beatInMeasure: beat(occurrence.beatInMeasure),
      bar: occurrence.bar,
      staffNumber: occurrence.staffNumber,
      voiceId: occurrence.voiceId ?? null,
      midi: occurrence.pitch?.midiNote ?? null,
      durationBeat: beat(occurrence.durationBeat),
      chordGroupId: occurrence.chordGroupId ?? null,
      isTieOnset: occurrence.isTieOnset,
    })),
    groups: plan.groups.map((group) => ({
      groupId: group.groupId,
      playbackBeat: beat(group.playbackBeat),
      occurrenceIds: group.occurrenceIds,
      scoreEventIds: group.scoreEventIds,
      pitches: group.pitches.map((pitch) => pitch.spelling),
      bar: group.bar,
      staffNumbers: group.staffNumbers,
      voiceIds: group.voiceIds,
      durationBeat: beat(group.durationBeat),
    })),
    issues: planResult.issues.map((issue) => issue.code),
  } : null;

  if (plan) {
    const scoreEvents = buildEngineScoreEvents(plan, testCase.bpm, testCase.countInBeats);
    entry.scoreEvents = scoreEvents.map((event) => ({
      scoreEventId: event.scoreEventId,
      measure: event.measure,
      beatPosition: event.beatPosition,
      pitch: event.pitch,
      targetOnsetMs: event.targetOnsetMs,
      targetDurationMs: event.targetDurationMs,
      partId: event.partId,
    }));
    const atoms = scoreOccurrencesToEngineAtoms(plan);
    entry.atoms = atoms.atoms;
    entry.atomIssues = atoms.issues.map((issue) => issue.code);
  }
  out[testCase.file] = entry;
}

console.log(JSON.stringify(out, null, 2));
