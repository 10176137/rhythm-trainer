import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan, buildScoreOccurrences } from '../playback/playback-planner';
import { buildTempoMap } from '../playback/tempo-map';
import { OsmdScoreViewAdapter, mappingSummary } from '../view/score-view-adapter';

const xml = readFileSync(new URL('./fixtures/triad-chord.musicxml', import.meta.url), 'utf8');

function fakeRenderer() {
  const colors: string[] = [];
  // OSMD 2.2.1 halfTone is one octave below MIDI (C4=48), like the real
  // source objects observed in the mapping spike.
  const sourceNotes = [
    { halfTone: 48, isRest: () => false },
    { halfTone: 52, isRest: () => false },
    { halfTone: 55, isRest: () => false },
    { halfTone: 50, isRest: () => false },
    { halfTone: 52, isRest: () => false },
  ];
  const graphical = sourceNotes.map((note) => ({
    sourceNote: note,
    setColor: (color: string) => colors.push(color),
    setVisible: vi.fn(),
  }));
  const renderer = {
    Sheet: {
      SourceMeasures: [{
        VerticalSourceStaffEntryContainers: [{
          StaffEntries: [{
            VoiceEntries: [{
              ParentVoice: { VoiceId: 1 },
              Notes: sourceNotes,
            }],
          }],
        }],
      }],
    },
    rules: {
      GNote: (note: unknown) => graphical[sourceNotes.indexOf(note as typeof sourceNotes[number])],
    },
  };
  return { renderer, colors };
}

describe('ScoreViewAdapter mapping', () => {
  it('maps note events by public OSMD source structure and never changes the timeline', () => {
    const doc = importMusicXml(xml, { fileName: 'triad-chord.musicxml' }).scoreDocument!;
    const request = {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 },
      repeatSelection: { kind: 'none' as const },
      unsupportedNotationPolicy: 'reject-strict' as const,
    };
    const plan = buildPlaybackPlan(doc, request).plan!;
    const tempo = buildTempoMap({ bpm: 80, timeOrigin: 'playback-start' });
    const before = JSON.stringify(buildScoreOccurrences(plan, tempo));
    const { renderer, colors } = fakeRenderer();
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.noteEventCount).toBe(5);
    expect(summary.mappedEventCount).toBe(5);
    expect(summary.unmapped).toBe(0);
    expect(summary.duplicates).toBe(0);
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'current');
    expect(colors).toContain('#1d9b72');
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'system');
    expect(colors).toContain('#c34b58');
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'user');
    expect(colors).toContain('#2f6fdb');
    adapter.clearHighlights();
    expect(colors).toContain('#20252d');
    const after = JSON.stringify(buildScoreOccurrences(plan, tempo));
    expect(after).toBe(before);
  });
});
