// P1-4 regression on the real 113-bar score: an explicit mapping must pass
// assessPracticeScope and yield the same target counts as before P1-4.
import { readFileSync } from 'node:fs';
import { importMusicXml } from 'D:/123/rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts';
import { buildPlaybackPlan } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/playback-planner.ts';
import { assessPracticeScope, buildUserHandMapping, handByScoreEventIdFromMapping } from 'D:/123/rhythm-trainer-frontend/src/score-engine/scope/practice-scope.ts';

const xml = readFileSync('D:/123/score-latest.musicxml', 'utf8');
const imported = importMusicXml(xml, { fileName: 'score-latest.musicxml' });
const doc = imported.scoreDocument;
const partId = doc.parts[0].id;
const mapping = buildUserHandMapping(partId, [
  { staffNumber: 1, hand: 'right' },
  { staffNumber: 2, hand: 'left' },
]);
const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
const scopeV = {
  schemaVersion: 1,
  partId,
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
  hand: 'both',
  handMapping: mapping,
};
const assessment = assessPracticeScope(doc, scopeV);
const plan = buildPlaybackPlan(doc, {
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
  repeatSelection: { kind: 'none' },
  unsupportedNotationPolicy: 'reject-strict',
}).plan;
const handMap = handByScoreEventIdFromMapping(doc, scopeV);
const notes = doc.parts[0].measures.flatMap((measure) => measure.events).filter((event) => event.kind === 'note' && !event.isGrace && !event.isCue);
// staff1=right, staff2=left: every target must be classified.
const classified = notes.filter((event) => handMap.has(event.id)).length;
console.log(JSON.stringify({
  assessmentOk: assessment.ok,
  codes: assessment.codes,
  occurrenceCount: plan.occurrences.length,
  groupCount: plan.groups.length,
  noteTargets: notes.length,
  classified,
}, null, 1));
