import { describe, expect, it } from 'vitest';
import { sampleScore } from '../../core/sampleScore';
import {
  beatPositionLabel,
  buildScoreViewModel,
  durationLabel,
  layoutScore,
  layoutScoreSystems,
} from './scoreLayout';

describe('score layout', () => {
  it('positions the fixture with vertically aligned bars and hand onsets', () => {
    const layout = layoutScore(sampleScore, 2);
    expect(layout.notes).toHaveLength(10);
    expect(layout.unsupported).toEqual([]);
    expect(layout.bars.map((bar) => [bar.startX, bar.endX])).toEqual([
      [110, 495],
      [495, 880],
    ]);

    const note = (id: string) => layout.notes.find((item) => item.note.id === id);
    expect(note('r1')?.x).toBeCloseTo(150);
    expect(note('r1')?.y).toBe(154);
    expect(note('r5')?.x).toBeCloseTo(535);
    expect(note('r5')?.y).toBe(126);
    expect(note('l1')?.x).toBeCloseTo(note('r1')?.x ?? 0);
    expect(note('l2')?.x).toBeCloseTo(note('r5')?.x ?? 0);
  });

  it('models quarter notes with filled heads and whole notes without stems', () => {
    const layout = layoutScore(sampleScore, 2);
    const quarter = layout.notes.find((item) => item.note.id === 'r1');
    const whole = layout.notes.find((item) => item.note.id === 'l1');
    expect(quarter?.headFilled).toBe(true);
    expect(quarter?.whole).toBe(false);
    expect(quarter?.stem).not.toBeNull();
    expect(whole?.headFilled).toBe(false);
    expect(whole?.whole).toBe(true);
    expect(whole?.stem).toBeNull();
  });

  it('does not move notes when note-name or line/space hints are toggled', () => {
    const withHints = buildScoreViewModel(sampleScore, { showNoteNames: true, showPositionHints: true });
    const withoutHints = buildScoreViewModel(sampleScore, { showNoteNames: false, showPositionHints: false });
    const geometry = (model: typeof withHints) =>
      model.notes.map((item) => ({
        id: item.note.id,
        x: item.x,
        y: item.y,
        ledgerLineYs: item.ledgerLineYs,
        label: item.label,
        stem: item.stem,
      }));
    expect(geometry(withHints)).toEqual(geometry(withoutHints));
    expect(withHints.notes.every((item) => item.showNoteName && item.showPositionHint)).toBe(true);
    expect(withoutHints.notes.every((item) => !item.showNoteName && !item.showPositionHint)).toBe(true);
  });

  it('labels note values and beat positions from the notation, not the viewport', () => {
    const c4 = sampleScore.find((note) => note.id === 'r1');
    const g4 = sampleScore.find((note) => note.id === 'r5');
    const c3 = sampleScore.find((note) => note.id === 'l1');
    expect(c4 && durationLabel(c4)).toBe('四分音符');
    expect(c4 && beatPositionLabel(c4)).toBe('第 1 小节 · 第 1 拍');
    expect(g4 && beatPositionLabel(g4)).toBe('第 2 小节 · 第 1 拍');
    expect(c3 && durationLabel(c3)).toBe('全音符');
  });
});

describe('score layout window', () => {
  it('lays out only the visible bars as a fresh system while keeping real bar numbers', () => {
    const base = sampleScore[0];
    const notes = [
      { ...base, id: 'w1', bar: 1, beat: 1 },
      { ...base, id: 'w3', bar: 3, beat: 8 },
      { ...base, id: 'w4', bar: 4, beat: 15 },
    ];
    const layout = layoutScore(notes, 6, 4, { startBar: 3, barCount: 2 });
    expect(layout.bars.map((bar) => bar.index)).toEqual([3, 4]);
    expect(layout.bars.map((bar) => [bar.startX, bar.endX])).toEqual([
      [110, 495],
      [495, 880],
    ]);
    expect(layout.notes.map((item) => item.note.id)).toEqual(['w3', 'w4']);
    expect(layout.notes[0].x).toBeCloseTo(150);
    expect(layout.notes[1].x).toBeCloseTo(775.75);
    expect(layout.notes[0].beatInBar).toBe(0);
  });
});


describe('score systems and XML meters', () => {
  it('stacks systems and sizes bars from each measure duration (4/4, 3/4)', () => {
    const base = sampleScore[0];
    const measures = [
      { bar: 1, startBeat: 0, durationBeats: 4, beats: 4, beatType: 4 },
      { bar: 2, startBeat: 4, durationBeats: 3, beats: 3, beatType: 4 },
      { bar: 3, startBeat: 7, durationBeats: 3, beats: 3, beatType: 4 },
    ];
    const notes = [
      { ...base, id: 'm1', bar: 1, beat: 0 },
      { ...base, id: 'm2', bar: 2, beat: 4 },
      { ...base, id: 'm3', bar: 3, beat: 9 },
    ];
    const layout = layoutScoreSystems(notes, 3, 4, { measures, barsPerSystem: 2 });
    expect(layout.systems.map((system) => [system.startBar, system.endBar])).toEqual([[1, 2], [3, 3]]);
    const [bar1, bar2] = layout.systems[0].bars;
    expect((bar2.endX - bar2.startX) / (bar1.endX - bar1.startX)).toBeCloseTo(3 / 4);
    expect(layout.systems[0].bars.map((bar) => [bar.beats, bar.beatType])).toEqual([[4, 4], [3, 4]]);
    expect(layout.systems[0].bars[1].timeSignatureChange).toBe(true);
    const m3 = layout.systems[1].notes.find((item) => item.note.id === 'm3')!;
    expect(m3.x).toBeGreaterThan(110);
    expect(beatPositionLabel(notes[2], 4, measures)).toBe('第 3 小节 · 第 3 拍');
  });

  it('labels compound-meter beats without assuming 4/4', () => {
    const measure = [{ bar: 1, startBeat: 0, durationBeats: 3, beats: 6, beatType: 8 }];
    const note = { ...sampleScore[0], bar: 1, beat: 1.5 };
    expect(beatPositionLabel(note, 3, measure)).toBe('第 1 小节 · 第 2 拍');
  });

  it('uses four bars per system by default, with an optional density budget', () => {
    const base = sampleScore[0];
    const measures = Array.from({ length: 6 }, (_, index) => ({
      bar: index + 1, startBeat: index * 4, durationBeats: 4, beats: 4, beatType: 4,
    }));
    const dense = measures.flatMap((measure) => Array.from({ length: 20 }, (_, index) => ({
      ...base, id: `dense-${measure.bar}-${index}`, bar: measure.bar, beat: measure.startBeat + index * 0.2,
    })));
    expect(layoutScoreSystems(dense, 6, 4, { measures }).systems.map((s) => [s.startBar, s.endBar]))
      .toEqual([[1, 4], [5, 6]]);
    expect(layoutScoreSystems(dense, 6, 4, { measures, notesPerSystem: 24 }).systems.map((s) => [s.startBar, s.endBar]))
      .toEqual([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]);

    const sparse = measures.flatMap((measure) => Array.from({ length: 6 }, (_, index) => ({
      ...base, id: `sparse-${measure.bar}-${index}`, bar: measure.bar, beat: measure.startBeat + index * 0.5,
    })));
    expect(layoutScoreSystems(sparse, 6, 4, { measures }).systems.map((s) => [s.startBar, s.endBar]))
      .toEqual([[1, 4], [5, 6]]);
  });
});
