// Ad-hoc check: run the real OMR score through the production importer/planner.
import { readFileSync } from 'node:fs';
import { importMusicXml } from 'D:/123/rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts';
import { buildPlaybackPlan } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/playback-planner.ts';
import { buildEngineScoreEvents } from 'D:/123/rhythm-trainer-frontend/src/score-engine/playback/score-events.ts';

const file = 'D:/123/score-latest.musicxml';
const xml = readFileSync(file, 'utf8');
const started = Date.now();
const result = importMusicXml(xml, { fileName: 'score-latest.musicxml' });
const importMs = Date.now() - started;
const report = result.importReport;
const doc = result.scoreDocument;

const out = {
  importMs,
  status: report.status,
  strictAllowed: report.strictAllowed,
  counts: report.counts,
  capabilityList: report.capabilities,
  issueCodes: [...new Set(report.issues.map((issue) => issue.code))],
  issueCount: report.issues.length,
  blockingIssues: report.issues.filter((issue) => issue.blocksStrict).length,
  issueSamples: report.issues.slice(0, 12).map((issue) => ({ code: issue.code, severity: issue.severity, measureOrdinal: issue.measureOrdinal, blocksStrict: issue.blocksStrict })),
};

if (doc) {
  const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
  out.measureCount = measureCount;
  out.parts = doc.parts.map((part) => ({ id: part.id, staves: part.staves, measures: part.measures.length }));
  const planStarted = Date.now();
  const planResult = buildPlaybackPlan(doc, {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
    repeatSelection: { kind: 'none' },
    unsupportedNotationPolicy: 'reject-strict',
  });
  out.planMs = Date.now() - planStarted;
  out.plan = planResult.plan ? {
    planId: planResult.plan.planId,
    strictAllowed: planResult.plan.strictAllowed,
    occurrenceCount: planResult.plan.occurrences.length,
    groupCount: planResult.plan.groups.length,
    rangeDurationBeat: `${planResult.plan.rangeDurationBeat.numerator}/${planResult.plan.rangeDurationBeat.denominator}`,
  } : null;
  if (planResult.plan) {
    const events = buildEngineScoreEvents(planResult.plan, 80, 4);
    out.scoreEvents = events.length;
    out.firstOnsetMs = events[0]?.targetOnsetMs ?? null;
    out.lastOnsetMs = events[events.length - 1]?.targetOnsetMs ?? null;
    out.uniqueIds = new Set(events.map((event) => event.scoreEventId)).size;
    out.pitchRange = [Math.min(...events.map((e) => e.pitch)), Math.max(...events.map((e) => e.pitch))];
  }
}
console.log(JSON.stringify(out, null, 1));
