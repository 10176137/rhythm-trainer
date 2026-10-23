// Generates the legacyReference artifact for the G1–G5 golden fixtures.
// The output is produced by the CURRENT TypeScript implementation and is only
// ever used as a differential object — never as a source of truth. The hand
// derived expectations live in audit-r1/fixtures/golden/g*.expected.json.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importMusicXml } from 'D:/123/rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/playback-planner.ts';
import { buildEngineScoreEvents } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/score-events.ts';

const REPO = 'D:/123';
const FIXTURES = join(REPO, 'audit-r1/fixtures');
const OUT = join(REPO, 'audit-r1/fixtures/golden/legacy-reference.json');

const CASES = [
  { case: 'G1', file: 'g1_single_voice.musicxml', bpm: 80, countInBeats: 4 },
  { case: 'G2', file: 'g2_chord.musicxml', bpm: 100, countInBeats: 4 },
  { case: 'G3', file: 'g3_tie_across_bar.musicxml', bpm: 120, countInBeats: 4 },
  { case: 'G4', file: 'g4_triplet.musicxml', bpm: 60, countInBeats: 4 },
  { case: 'G5', file: 'g5_three_four.musicxml', bpm: 90, countInBeats: 4 },
];

const toUs = (ms) => Math.round(ms * 1000);
const beat = (value) => `${value.numerator}/${value.denominator}`;

const cases = {};
for (const testCase of CASES) {
  const xml = readFileSync(join(FIXTURES, testCase.file), 'utf8');
  const imported = importMusicXml(xml, { fileName: testCase.file });
  if (!imported.scoreDocument) throw new Error(`${testCase.file} did not import`);
  const doc = imported.scoreDocument;
  const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
  const plan = buildPlaybackPlan(doc, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  }).plan;
  const scoreEvents = buildEngineScoreEvents(plan, testCase.bpm, testCase.countInBeats);
  const atomResult = scoreOccurrencesToEngineAtoms(plan);
  cases[testCase.case] = {
    fixture: testCase.file,
    scoreEvents: scoreEvents.map((event) => ({
      pitch: event.pitch,
      onsetUs: toUs(event.targetOnsetMs),
      durationUs: toUs(event.targetDurationMs),
    })),
    occurrenceCount: plan.occurrences.length,
    groupCount: plan.groups.length,
    atomCount: atomResult.atoms.length,
    atoms: atomResult.atoms.map((atom) => ({
      startTick: atom.startTick,
      durationTicks: atom.durationTicks,
      bar: atom.bar,
      beat: atom.beat,
    })),
    occurrenceBeats: plan.occurrences.map((occurrence) => beat(occurrence.playbackBeat)),
  };
}

let gitSha = null;
try {
  gitSha = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();
} catch {
  gitSha = null;
}

writeFileSync(OUT, `${JSON.stringify({
  generatedBy: 'audit-r1/spike/generate-legacy-reference.mjs',
  generatorVersion: 1,
  gitSha,
  generatedAtIso: new Date().toISOString(),
  note: 'Produced by the TypeScript implementation at the commit above. Differential object only; never a source of truth. Compare against audit-r1/fixtures/golden/g*.expected.json.',
  cases,
}, null, 2)}\n`);
console.log(`wrote ${OUT}`);
