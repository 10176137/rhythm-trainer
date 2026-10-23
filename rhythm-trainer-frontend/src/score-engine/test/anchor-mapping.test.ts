import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import type { ScoreDocument } from '../domain/types';
import { OsmdScoreViewAdapter, mappingSummary } from '../view/score-view-adapter';

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');
}

function docOf(xml: string, fileName: string): ScoreDocument {
  const result = importMusicXml(xml, { fileName });
  if (!result.scoreDocument) throw new Error(`${fileName} did not import`);
  return result.scoreDocument;
}

interface FakeNoteSpec {
  /** OSMD VoiceEntry.Timestamp: measure-relative whole-note fraction. */
  whole: [number, number] | null;
  /** MIDI pitch; OSMD stores halfTone = midi - 12. */
  midi: number;
  rest?: boolean;
}

/**
 * Minimal fake of the public OSMD object model. It deliberately has no DOM, no
 * VexFlow ids and no geometry, so a passing mapping cannot rely on any of them.
 */
function fakeRenderer(measures: FakeNoteSpec[][]) {
  const colors: string[] = [];
  const graphicalFor = new Map<object, { setColor: (color: string) => void }>();
  const sourceMeasures = measures.map((notes) => {
    const groups = new Map<string, FakeNoteSpec[]>();
    for (const note of notes) {
      const key = note.whole ? `${note.whole[0]}/${note.whole[1]}` : 'none';
      groups.set(key, [...(groups.get(key) ?? []), note]);
    }
    const containers = [...groups.entries()].map(([key, groupNotes]) => {
      const voiceEntry: Record<string, unknown> = {
        ParentVoice: { VoiceId: 1 },
        Notes: [],
      };
      if (key !== 'none') {
        const [numerator, denominator] = key.split('/').map(Number);
        voiceEntry.Timestamp = { Numerator: numerator, Denominator: denominator };
      }
      voiceEntry.Notes = groupNotes.map((spec) => {
        const note = {
          halfTone: spec.midi - 12,
          isRest: () => Boolean(spec.rest),
          ParentVoiceEntry: voiceEntry,
        };
        graphicalFor.set(note, { setColor: (color: string) => colors.push(color) });
        return note;
      });
      return { StaffEntries: [{ VoiceEntries: [voiceEntry] }] };
    });
    return { VerticalSourceStaffEntryContainers: containers };
  });
  const renderer = {
    Sheet: { SourceMeasures: sourceMeasures },
    rules: { GNote: (note: object) => graphicalFor.get(note) },
  };
  return { renderer, colors };
}

/** G1 note layout, expressed as OSMD measure-relative whole-note fractions. */
const G1_SHAPE: FakeNoteSpec[][] = [
  [
    { whole: [0, 4], midi: 60 },
    { whole: [1, 4], midi: 62 },
    { whole: [2, 4], midi: 64 },
    { whole: [3, 4], midi: 65 },
  ],
  [
    { whole: [0, 4], midi: 67 },
    { whole: [2, 4], midi: 12, rest: true },
  ],
];

describe('anchor mapping: structural identity with fail-closed conflicts', () => {
  it('maps a repeated pitch at a different onset instead of colliding (g2 regression)', () => {
    const doc = docOf(fixture('g2_chord.musicxml'), 'g2_chord.musicxml');
    // C4/E4/G4 at beat 0, then C4 again at beat 1.
    const { renderer } = fakeRenderer([[
      { whole: [0, 4], midi: 60 },
      { whole: [0, 4], midi: 64 },
      { whole: [0, 4], midi: 67 },
      { whole: [1, 4], midi: 60 },
    ]]);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.noteEventCount).toBe(4);
    expect(summary.mappedEventCount).toBe(4);
    expect(summary.unmapped).toBe(0);
    expect(summary.conflicts).toBe(0);
    expect(summary.anchorStatus).toBe('COMPLETE');
    expect(summary.ok).toBe(true);

    const c4 = doc.parts[0].measures[0].events.filter((event) => event.pitch?.midiNote === 60);
    expect(c4).toHaveLength(2);
    expect(mapping.byEventId.get(c4[0].id)?.anchorKey)
      .not.toBe(mapping.byEventId.get(c4[1].id)?.anchorKey);
  });

  it('exposes chord glyphs as chord-precision highlights', () => {
    const doc = docOf(fixture('g2_chord.musicxml'), 'g2_chord.musicxml');
    const { renderer } = fakeRenderer([[
      { whole: [0, 4], midi: 60 },
      { whole: [0, 4], midi: 64 },
      { whole: [0, 4], midi: 67 },
      { whole: [1, 4], midi: 60 },
    ]]);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const chordEvents = doc.parts[0].measures[0].events.filter((event) => event.chordGroupId);
    expect(chordEvents).toHaveLength(3);
    for (const event of chordEvents) {
      expect(mapping.byEventId.get(event.id)?.highlightPrecision).toBe('chord');
    }
    const repeated = doc.parts[0].measures[0].events.find((event) => !event.chordGroupId && event.kind === 'note')!;
    expect(mapping.byEventId.get(repeated.id)?.highlightPrecision).toBe('note');
  });

  it('fails closed when two notes share the same onset and pitch (grace + principal)', () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><grace/><pitch><step>C</step><octave>4</octave></pitch><type>eighth</type></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
    const doc = docOf(xml, 'grace-same-pitch.musicxml');
    const { renderer, colors } = fakeRenderer([[
      { whole: [0, 4], midi: 60 },
      { whole: [0, 4], midi: 60 },
    ]]);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.noteEventCount).toBe(2);
    expect(summary.mappedEventCount).toBe(0);
    expect(summary.conflicts).toBe(2);
    expect(summary.anchorStatus).toBe('UNAVAILABLE');
    expect(summary.ok).toBe(false);
    expect(mapping.conflicts.every((conflict) => conflict.reason === 'duplicate-osmd-note')).toBe(true);
    const eventIds = doc.parts[0].measures[0].events.map((event) => event.id);
    for (const id of eventIds) {
      expect(adapter.highlightScoreEvent(id, 'current')).toBe(false);
    }
    expect(colors).toHaveLength(0);
  });

  it('never puts a rest into the pitched buckets', () => {
    const doc = docOf(fixture('g1_single_voice.musicxml'), 'g1_single_voice.musicxml');
    const { renderer } = fakeRenderer(G1_SHAPE);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.noteEventCount).toBe(5);
    expect(summary.mappedEventCount).toBe(5);
    expect(summary.conflicts).toBe(0);
    expect(summary.anchorStatus).toBe('COMPLETE');
    // The rest is not a domain event and must not leave an unused anchor behind.
    expect(summary.warnings.filter((warning) => warning.includes('没有对应领域事件'))).toHaveLength(0);
  });

  it('maps both notes of a tie chain at their written onsets', () => {
    const doc = docOf(fixture('g3_tie_across_bar.musicxml'), 'g3_tie_across_bar.musicxml');
    const { renderer } = fakeRenderer([
      [{ whole: [0, 4], midi: 60 }],
      [{ whole: [0, 4], midi: 60 }],
    ]);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    expect(mapping.mappedEventCount).toBe(2);
    expect(mapping.conflicts).toHaveLength(0);
    expect(mapping.anchorStatus).toBe('COMPLETE');
  });

  it('reports an unmapped event when OSMD is missing a note', () => {
    const doc = docOf(fixture('g1_single_voice.musicxml'), 'g1_single_voice.musicxml');
    const shape = G1_SHAPE.map((measure) => [...measure]);
    shape[1] = [shape[1][0]]; // drop the rest, keep only G4
    const { renderer } = fakeRenderer(shape);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.mappedEventCount).toBe(5);
    expect(summary.ok).toBe(true);

    // Now drop one real note: the mapping must degrade, not guess.
    const missing = G1_SHAPE.map((measure) => [...measure]);
    missing[0] = missing[0].slice(0, 3); // remove F4
    const second = fakeRenderer(missing);
    const adapter2 = new OsmdScoreViewAdapter(second.renderer as never);
    const mapping2 = adapter2.buildMapping(doc, second.renderer as never);
    const summary2 = mappingSummary(mapping2);
    expect(summary2.mappedEventCount).toBe(4);
    expect(summary2.unmapped).toBe(1);
    expect(summary2.anchorStatus).toBe('PARTIAL');
    expect(summary2.ok).toBe(false);
  });

  it('does not fall back when OSMD provides no onset', () => {
    const doc = docOf(fixture('g1_single_voice.musicxml'), 'g1_single_voice.musicxml');
    const shape = G1_SHAPE.map((measure) => measure.map((note) => ({ ...note })));
    shape[0][0] = { whole: null, midi: 60 };
    const { renderer } = fakeRenderer(shape);
    const adapter = new OsmdScoreViewAdapter(renderer as never);
    const mapping = adapter.buildMapping(doc, renderer as never);
    const summary = mappingSummary(mapping);
    expect(summary.mappedEventCount).toBe(4);
    expect(summary.unmapped).toBe(1);
    expect(summary.anchorStatus).toBe('PARTIAL');
    expect(summary.warnings.some((warning) => warning.includes('缺少可用的 onset'))).toBe(true);
  });
});
