import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ScoreNote } from '../../core/sampleScore';
import { importScoreText } from './scoreImport';
import { getUnsupportedNotes, getUnsupportedReason } from './staffMapping';

const xml = readFileSync(new URL('./fixtures/octave-shifts.musicxml', import.meta.url), 'utf8');

describe('MusicXML octave shifts at practice launch', () => {
  it('admits high and low sounding pitches for OSMD without changing MIDI targets', () => {
    const { doc, report } = importScoreText(xml, 'octave-shifts.musicxml');
    expect(report.strictAllowed).toBe(true);
    expect(report.issues).toEqual([]);
    const before = JSON.stringify(doc!.engine);
    expect(getUnsupportedNotes(doc!.notes, 3, 'osmd')).toEqual([]);
    expect(doc!.notes.map((note) => note.midiNote)).toEqual([92, 24, 89, 24, 87, 36]);
    expect(JSON.stringify(doc!.engine)).toBe(before);
    expect(doc!.sourceXml).toBe(xml);
    // The original SVG mapper still refuses notes it cannot safely position.
    expect(getUnsupportedNotes(doc!.notes, 3)).toHaveLength(4);
  });

  it('keeps pitch integrity and measure bounds enforced for the professional score', () => {
    const note = importScoreText(xml, 'octave-shifts.musicxml').doc!.notes[0];
    expect(getUnsupportedReason({ ...note, midiNote: 80 }, 'osmd')).toContain('不一致');
    for (const midiNote of [-1, 128, NaN, 92.5]) {
      expect(getUnsupportedReason({ ...note, midiNote }, 'osmd')).toContain('MIDI 音高无效');
    }
    expect(getUnsupportedReason({ ...note, alter: 3 }, 'osmd')).toContain('最多双升/双降');
    for (const bar of [0, 4, NaN, 1.5]) {
      expect(getUnsupportedNotes([{ ...note, bar }], 3, 'osmd')[0]?.reason).toBe('小节号超出当前谱面范围');
    }
    // An invalid spelling must not enter the plan through a display bypass.
    expect(getUnsupportedReason({ ...note, step: '?' } as unknown as ScoreNote, 'osmd')).toContain('不一致');
  });
});
