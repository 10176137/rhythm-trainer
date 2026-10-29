import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan, buildScoreOccurrences } from '../playback/playback-planner';
import { buildTempoMap } from '../playback/tempo-map';
import { OsmdScoreViewAdapter, mappingSummary } from '../view/score-view-adapter';

const xml = readFileSync(new URL('./fixtures/triad-chord.musicxml', import.meta.url), 'utf8');

function fakeRenderer() {
  const colors: string[] = [];
  // OSMD 2.2.1 halfTone is one octave below MIDI (C4=48), and VoiceEntry
  // Timestamp is a measure-relative whole-note fraction: beat b => b/4.
  const makeVoiceEntry = (beat: number, halfTones: number[]) => {
    const voiceEntry: {
      ParentVoice: { VoiceId: number };
      Timestamp: { Numerator: number; Denominator: number };
      Notes: { halfTone: number; isRest: () => boolean; ParentVoiceEntry?: unknown }[];
    } = {
      ParentVoice: { VoiceId: 1 },
      Timestamp: { Numerator: beat, Denominator: 4 },
      Notes: [],
    };
    voiceEntry.Notes = halfTones.map((halfTone) => ({
      halfTone,
      isRest: () => false,
      ParentVoiceEntry: voiceEntry,
    }));
    return voiceEntry;
  };
  // Fixture order: chord C4/E4/G4 at beat 0, D4 at beat 1, E4 at beat 2.
  const containers = [
    { StaffEntries: [{ VoiceEntries: [makeVoiceEntry(0, [48, 52, 55])] }] },
    { StaffEntries: [{ VoiceEntries: [makeVoiceEntry(1, [50])] }] },
    { StaffEntries: [{ VoiceEntries: [makeVoiceEntry(2, [52])] }] },
  ];
  const sourceNotes = containers.flatMap((container) =>
    container.StaffEntries.flatMap((staffEntry) => staffEntry.VoiceEntries.flatMap((voiceEntry) => voiceEntry.Notes)));
  const graphical = sourceNotes.map((note) => ({
    sourceNote: note,
    setColor: (color: string) => colors.push(color),
    setVisible: vi.fn(),
  }));
  const renderer = {
    Sheet: {
      SourceMeasures: [{
        VerticalSourceStaffEntryContainers: containers,
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
    expect(summary.conflicts).toBe(0);
    expect(summary.anchorStatus).toBe('COMPLETE');
    expect(summary.mappingVersion).toBe('osmd-structural-2');
    expect(summary.ok).toBe(true);
    expect(adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'current')).toBe(true);
    expect(colors.at(-1)).toBe('#2f6fdb');
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'hit');
    expect(colors.at(-1)).toBe('#1d9b72');
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'system');
    expect(colors).toContain('#c34b58');
    adapter.highlightScoreEvent(doc.parts[0].measures[0].events[0].id, 'user');
    expect(colors.at(-1)).toBe('#1d9b72');
    adapter.clearHighlights();
    expect(colors).toContain('#20252d');
    const after = JSON.stringify(buildScoreOccurrences(plan, tempo));
    expect(after).toBe(before);
  });
});
