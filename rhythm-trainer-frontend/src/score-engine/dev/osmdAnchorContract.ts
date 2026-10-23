// OSMD anchor contract harness. Runs the real, locked OSMD build and the
// production adapter against the G-fixtures, then POSTs a machine-readable
// result so an OSMD upgrade can be re-verified instead of eyeballed.
//
// Requires: `npm run dev` (Vite, 5173) and `node ../audit-r1/spike/serve.mjs`
// (static fixtures + POST receiver, 8799). See SCORE_ANCHOR_SPIKE_REPORT.md.
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { importMusicXml } from '../import/musicxml-importer';
import { OsmdScoreViewAdapter, mappingSummary } from '../view/score-view-adapter';

const FIXTURES = 'http://127.0.0.1:8799/fixtures/';
const RESULT_ENDPOINT = 'http://127.0.0.1:8799/result?file=anchor-contract.json';

const CASES = [
  { name: 'g1-single-voice', fixture: 'g1_single_voice.musicxml', expect: 'COMPLETE' },
  { name: 'g2-chord-repeat', fixture: 'g2_chord.musicxml', expect: 'COMPLETE' },
  { name: 'g3-tie', fixture: 'g3_tie_across_bar.musicxml', expect: 'COMPLETE' },
  { name: 'g4-triplet', fixture: 'g4_triplet.musicxml', expect: 'COMPLETE' },
  { name: 'g6-unison-two-staves', fixture: 'g6_unison_two_staves.musicxml', expect: 'COMPLETE' },
  { name: 'g7-hidden-grace', fixture: 'g7_hidden_grace.musicxml', expect: 'COMPLETE' },
  { name: 'g8-key-alter', fixture: 'g8_key_alter.musicxml', expect: 'COMPLETE' },
  { name: 'g9-grace-same-pitch', fixture: 'g9_grace_same_pitch.musicxml', expect: 'UNAVAILABLE' },
];

interface CaseResult {
  name: string;
  fixture: string;
  osmdNotes: number;
  noteEventCount: number;
  mappedEventCount: number;
  unmapped: number;
  conflicts: number;
  anchorStatus: string;
  expectedAnchorStatus: string;
  ok: boolean;
  mappingVersion: string;
  conflictReasons: string[];
  conflictSamples: { eventSuffix: string; key: string | null; reason: string; candidates: number }[];
  chordPrecisionEvents: number;
  highlight: { mappedTarget: boolean; conflictedTargetsBlocked: boolean };
  warnings: string[];
}

async function runCase(testCase: { name: string; fixture: string; expect: string }): Promise<CaseResult> {
  const xml = await (await fetch(`${FIXTURES}${testCase.fixture}`)).text();
  const imported = importMusicXml(xml, { fileName: testCase.fixture });
  const doc = imported.scoreDocument;
  if (!doc) throw new Error(`${testCase.name}: import failed (${imported.importReport.status})`);

  const host = document.createElement('div');
  host.style.width = '900px';
  (document.getElementById('cases') ?? document.body).append(host);
  const osmd = new OpenSheetMusicDisplay(host, {
    autoResize: false, drawCredits: false, drawTitle: false, drawComposer: false,
    drawMeasureNumbers: false, drawPartNames: false, backend: 'svg',
  });
  await osmd.load(xml);
  osmd.Zoom = 0.7;
  osmd.render();

  const adapter = new OsmdScoreViewAdapter(osmd);
  const mapping = adapter.buildMapping(doc, osmd);
  const summary = mappingSummary(mapping);

  let osmdNotes = 0;
  for (const measure of osmd.Sheet?.SourceMeasures ?? []) {
    for (const vertical of measure.VerticalSourceStaffEntryContainers ?? []) {
      for (const staffEntry of vertical.StaffEntries ?? []) {
        for (const voiceEntry of staffEntry.VoiceEntries ?? []) {
          osmdNotes += (voiceEntry.Notes ?? []).length;
        }
      }
    }
  }

  const allEvents = doc.parts.flatMap((part) => part.measures.flatMap((measure) => measure.events))
    .filter((event) => event.kind === 'note');
  const conflictIds = new Set(mapping.conflicts.map((conflict) => conflict.scoreEventId));
  const mappedEvent = allEvents.find((event) => mapping.byEventId.has(event.id));
  const mappedTarget = mappedEvent ? adapter.highlightScoreEvent(mappedEvent.id, 'current') : false;
  const conflictedTargetsBlocked = allEvents
    .filter((event) => conflictIds.has(event.id))
    .every((event) => adapter.highlightScoreEvent(event.id, 'current') === false);
  adapter.clearHighlights();

  return {
    name: testCase.name,
    fixture: testCase.fixture,
    osmdNotes,
    noteEventCount: summary.noteEventCount,
    mappedEventCount: summary.mappedEventCount,
    unmapped: summary.unmapped,
    conflicts: summary.conflicts,
    anchorStatus: summary.anchorStatus,
    expectedAnchorStatus: testCase.expect,
    ok: summary.ok,
    mappingVersion: summary.mappingVersion,
    conflictReasons: [...new Set(mapping.conflicts.map((conflict) => conflict.reason))].sort(),
    conflictSamples: mapping.conflicts.slice(0, 4).map((conflict) => ({
      eventSuffix: conflict.scoreEventId.slice(-12),
      key: conflict.anchorKey,
      reason: conflict.reason,
      candidates: conflict.candidateCount,
    })),
    chordPrecisionEvents: [...mapping.byEventId.values()].filter((ref) => ref.highlightPrecision === 'chord').length,
    highlight: { mappedTarget, conflictedTargetsBlocked },
    warnings: [...summary.warnings],
  };
}

async function main() {
  const results: CaseResult[] = [];
  let error: string | null = null;
  try {
    for (const testCase of CASES) results.push(await runCase(testCase));
  } catch (caught) {
    error = String((caught as Error)?.stack ?? caught);
  }
  const payload = {
    complete: true,
    osmdVersionPinnedInPackageJson: '2.2.1',
    mappingVersion: 'osmd-structural-2',
    userAgent: navigator.userAgent,
    cases: results,
    error,
  };
  (window as unknown as { __ANCHOR_CONTRACT__: unknown }).__ANCHOR_CONTRACT__ = payload;
  document.body.dataset.contract = 'complete';
  const status = document.getElementById('status');
  if (status) {
    const failures = results.filter((result) => result.anchorStatus !== result.expectedAnchorStatus);
    status.textContent = failures.length
      ? `FAIL — ${failures.length}/${results.length} cases deviated: ${failures.map((failure) => failure.name).join(', ')}`
      : `PASS — ${results.length}/${results.length} anchor cases matched the expected status`;
    status.className = failures.length ? 'bad' : 'ok';
  }
  try {
    await fetch(RESULT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload, null, 2),
    });
  } catch (postError) {
    (payload as { postError?: string }).postError = String(postError);
  }
}

void main();
