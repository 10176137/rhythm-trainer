import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { importMusicXml } from '../import/musicxml-importer';
import { OsmdScoreViewAdapter, mappingSummary } from '../view/score-view-adapter';
import { buildPlaybackPlan } from '../playback/playback-planner';

import singleMelody from '../test/fixtures/single-melody-quarter-eighth.musicxml?raw';
import pianoTwoStaff from '../test/fixtures/piano-two-staff-basic.musicxml?raw';
import triadChord from '../test/fixtures/triad-chord.musicxml?raw';
import multiVoice from '../test/fixtures/multi-voice-backup-forward.musicxml?raw';
import tieAcrossMeasure from '../test/fixtures/tie-across-measure.musicxml?raw';
import cMajorPractice from '../test/fixtures/c-major-practice.musicxml?raw';
import crossSystemLayout from '../test/fixtures/cross-system-layout.musicxml?raw';

interface SpikeResult {
  fixture: string;
  importStatus: string;
  strictAllowed: boolean;
  noteEvents: number;
  mapped: number;
  unmapped: number;
  duplicates: number;
  mappingWarnings: string[];
  debugSample?: { sourceKeys: string[]; eventKeys: string[] };
  planGroups: number | null;
  firstHighlighted: string | null;
}

declare global {
  interface Window {
    __OSMD_SPIKE__?: { complete: boolean; results: SpikeResult[]; error?: string };
  }
}

const fixtures = [
  { name: 'single-melody-quarter-eighth.musicxml', xml: singleMelody },
  { name: 'piano-two-staff-basic.musicxml', xml: pianoTwoStaff },
  { name: 'triad-chord.musicxml', xml: triadChord },
  { name: 'multi-voice-backup-forward.musicxml', xml: multiVoice },
  { name: 'tie-across-measure.musicxml', xml: tieAcrossMeasure },
  { name: 'c-major-practice.musicxml', xml: cMajorPractice },
  { name: 'cross-system-layout.musicxml', xml: crossSystemLayout },
];

async function main(): Promise<void> {
  const scoresContainer = document.getElementById('scores');
  const status = document.getElementById('status');
  if (!scoresContainer || !status) throw new Error('Spike DOM missing');
  const results: SpikeResult[] = [];

  for (const fixture of fixtures) {
    const label = document.createElement('div');
    label.className = 'spike-label';
    label.textContent = fixture.name;
    const container = document.createElement('div');
    container.className = 'spike-score';
    scoresContainer.append(label, container);

    const imported = importMusicXml(fixture.xml, { fileName: fixture.name });
    const doc = imported.scoreDocument;
    const osmd = new OpenSheetMusicDisplay(container, {
      autoResize: false,
      drawCredits: false,
      drawTitle: false,
      drawComposer: false,
      drawMeasureNumbers: false,
      drawPartNames: false,
    });
    try {
      await osmd.load(fixture.xml);
      osmd.Zoom = 0.8;
      osmd.render();
    } catch (error) {
      results.push({
        fixture: fixture.name,
        importStatus: imported.importReport.status,
        strictAllowed: imported.importReport.strictAllowed,
        noteEvents: 0,
        mapped: 0,
        unmapped: 0,
        duplicates: 0,
        mappingWarnings: [],
        planGroups: null,
        firstHighlighted: null,
      });
      label.textContent = `${fixture.name}: OSMD render failed — ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    if (!doc) {
      results.push({
        fixture: fixture.name,
        importStatus: imported.importReport.status,
        strictAllowed: false,
        noteEvents: 0,
        mapped: 0,
        unmapped: 0,
        duplicates: 0,
        mappingWarnings: [],
        planGroups: null,
        firstHighlighted: null,
      });
      continue;
    }

    const adapter = new OsmdScoreViewAdapter(osmd);
    const mapping = adapter.buildMapping(doc);
    const summary = mappingSummary(mapping);
    let planGroups: number | null = null;
    try {
      const plan = buildPlaybackPlan(doc, {
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: Math.max(1, doc.parts[0]?.measures.length ?? 1) },
        repeatSelection: { kind: 'none' },
        unsupportedNotationPolicy: 'reject-strict',
      });
      planGroups = plan.plan?.groups.length ?? 0;
    } catch {
      planGroups = null;
    }

    const firstNote = doc.parts[0]?.measures[0]?.events.find((event) => event.kind === 'note');
    if (firstNote) adapter.highlightScoreEvent(firstNote.id, 'current');
    const pass = summary.mappedEventCount === summary.noteEventCount && summary.duplicates === 0;
    label.textContent = `${fixture.name}: ${pass ? 'PASS' : 'FAIL'} — mapped ${summary.mappedEventCount}/${summary.noteEventCount}, duplicates ${summary.duplicates}, groups ${planGroups ?? 'n/a'}`;
    label.className = `spike-label ${pass ? 'ok' : 'bad'}`;
    results.push({
      fixture: fixture.name,
      importStatus: imported.importReport.status,
      strictAllowed: imported.importReport.strictAllowed,
      noteEvents: summary.noteEventCount,
      mapped: summary.mappedEventCount,
      unmapped: summary.unmapped,
      duplicates: summary.duplicates,
      mappingWarnings: [...summary.warnings],
      debugSample: mapping.debugSample,
      planGroups,
      firstHighlighted: firstNote?.id ?? null,
    });
  }

  const allPass = results.length === fixtures.length && results.every((result) => result.noteEvents > 0 && result.mapped === result.noteEvents && result.duplicates === 0);
  status.textContent = allPass ? 'All OSMD mapping fixtures passed.' : 'Some OSMD mapping fixtures failed; see results.';
  status.className = allPass ? 'ok' : 'bad';
  window.__OSMD_SPIKE__ = { complete: true, results };
  document.body.dataset.spike = 'complete';
}

main().catch((error) => {
  window.__OSMD_SPIKE__ = { complete: true, results: [], error: error instanceof Error ? error.message : String(error) };
  document.body.dataset.spike = 'error';
  const status = document.getElementById('status');
  if (status) status.textContent = `Spike error: ${error instanceof Error ? error.message : String(error)}`;
});
