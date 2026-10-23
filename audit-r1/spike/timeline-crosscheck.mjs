// Cross-checks the two target timelines on the real score:
//   A: TS buildEngineScoreEvents  (final-scoring targets)
//   B: Rust buildSchedule         (live targets, via the built NAPI addon)
// The server accepts A only if every A onset is within 0.5 ms of some B onset.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { importMusicXml } from 'D:/123/rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/playback-planner.ts';
import { buildEngineScoreEvents } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/score-events.ts';

const require = createRequire('D:/123/rhythm-trainer-core-v0.2/bindings/node/index.js');
const addon = require('D:/123/rhythm-trainer-core-v0.2/bindings/node/index.js');

const BPM = 80;
const COUNT_IN_BEATS = 4;
const xml = readFileSync('D:/123/score-latest.musicxml', 'utf8');
const imported = importMusicXml(xml, { fileName: 'score-latest.musicxml' });
const doc = imported.scoreDocument;
const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
const plan = buildPlaybackPlan(doc, {
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
  repeatSelection: { kind: 'none' },
  unsupportedNotationPolicy: 'reject-strict',
}).plan;

const BPMS = [40, 60, 70, 80, 90, 100, 120, 133, 177];
const RESULTS = [];

for (const BPM of BPMS) {
  for (const countInSpec of [{ kind: 'beats', beats: 4 }, { kind: 'threeSeconds', ms: 3000 }]) {
    const countInBeats = countInSpec.kind === 'beats' ? countInSpec.beats : countInSpec.ms / (60_000 / BPM);
    const countInMs = countInBeats * (60_000 / BPM);
    const scoreEvents = buildEngineScoreEvents(plan, BPM, countInBeats);
    const atoms = scoreOccurrencesToEngineAtoms(plan, 960).atoms;
    const targets = addon.buildSchedule(
      { id: 'real-score-check', ticksPerQuarter: 960, atoms: atoms.map((atom) => ({ ...atom })) },
      BPM,
      countInMs,
      'strict',
    );
    const targetOnsets = targets.map((target) => Number(target.atMs));
    let offPlan = 0;
    let maxGap = 0;
    for (const event of scoreEvents) {
      let best = Infinity;
      for (const atMs of targetOnsets) best = Math.min(best, Math.abs(atMs - event.targetOnsetMs));
      if (best > 0.5) offPlan += 1;
      maxGap = Math.max(maxGap, best);
    }
    RESULTS.push({
      bpm: BPM,
      countIn: countInSpec.kind,
      countInBeats,
      rustTargets: targets.length,
      tsScoreEvents: scoreEvents.length,
      offPlan,
      maxGapMs: maxGap,
    });
  }
}

console.log(JSON.stringify({ atoms: scoreOccurrencesToEngineAtoms(plan, 960).atoms.length, results: RESULTS }, null, 1));
