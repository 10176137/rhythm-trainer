import { describe, expect, it } from 'vitest';
import { sampleScore, type ScoreNote } from '../../core/sampleScore';
import {
  getStaffPlacement,
  getUnsupportedNotes,
  getUnsupportedReason,
  keySignatureGlyphs,
  midiNoteFor,
  midiToPitchName,
} from './staffMapping';

describe('staff mapping', () => {
  it('places C4–C5 on the correct treble lines and spaces', () => {
    const cases = [
      { pitch: ['C', 4] as const, midi: 60, y: 154, line: true, kind: 'ledger-below', label: '加线下' },
      { pitch: ['D', 4] as const, midi: 62, y: 147, line: false, kind: 'below-staff', label: '谱表下' },
      { pitch: ['E', 4] as const, midi: 64, y: 140, line: true, kind: 'line', label: '线上' },
      { pitch: ['F', 4] as const, midi: 65, y: 133, line: false, kind: 'space', label: '间上' },
      { pitch: ['G', 4] as const, midi: 67, y: 126, line: true, kind: 'line', label: '线上' },
      { pitch: ['A', 4] as const, midi: 69, y: 119, line: false, kind: 'space', label: '间上' },
      { pitch: ['B', 4] as const, midi: 71, y: 112, line: true, kind: 'line', label: '线上' },
      { pitch: ['C', 5] as const, midi: 72, y: 105, line: false, kind: 'space', label: '间上' },
    ];

    for (const expected of cases) {
      const placement = getStaffPlacement('treble', expected.pitch[0], 0, expected.pitch[1]);
      expect(placement, `${expected.pitch[0]}${expected.pitch[1]}`).not.toBeNull();
      expect(placement?.y, `${expected.pitch[0]}${expected.pitch[1]} y`).toBe(expected.y);
      expect(placement?.line, `${expected.pitch[0]}${expected.pitch[1]} line`).toBe(expected.line);
      expect(placement?.kind, `${expected.pitch[0]}${expected.pitch[1]} kind`).toBe(expected.kind);
      expect(placement?.positionLabel, `${expected.pitch[0]}${expected.pitch[1]} label`).toBe(expected.label);
      expect(midiNoteFor(expected.pitch[0], 0, expected.pitch[1])).toBe(expected.midi);
    }
  });

  it('maps the same relative staff position to different pitches in treble and bass clefs', () => {
    const trebleG4 = getStaffPlacement('treble', 'G', 0, 4);
    const bassB2 = getStaffPlacement('bass', 'B', 0, 2);
    expect(trebleG4?.offsetFromBottomLine).toBe(2);
    expect(bassB2?.offsetFromBottomLine).toBe(2);
    expect((trebleG4?.y ?? 0) - 140).toBe((bassB2?.y ?? 0) - 308);
    expect(midiNoteFor('G', 0, 4)).toBe(67);
    expect(midiNoteFor('B', 0, 2)).toBe(47);
    expect(trebleG4?.positionLabel).toBe('线上');
    expect(bassB2?.positionLabel).toBe('线上');
  });

  it('keeps the left-hand C3 and G2 inside the bass staff', () => {
    const c3 = getStaffPlacement('bass', 'C', 0, 3);
    const g2 = getStaffPlacement('bass', 'G', 0, 2);
    expect(c3?.kind).toBe('space');
    expect(c3?.y).toBe(287);
    expect(g2?.kind).toBe('line');
    expect(g2?.y).toBe(308);
  });

  it('marks C4 above the bass staff as a ledger line', () => {
    const c4 = getStaffPlacement('bass', 'C', 0, 4);
    expect(c4?.kind).toBe('ledger-above');
    expect(c4?.ledgerLineYs).toEqual([238]);
    expect(c4?.positionLabel).toBe('加线上');
  });

  it('supports written accidentals but refuses triple accidentals and extreme ledger ranges', () => {
    expect(getStaffPlacement('treble', 'C', 0, 3)).toBeNull();
    expect(getStaffPlacement('bass', 'G', 1, 2)).not.toBeNull();
    expect(getStaffPlacement('bass', 'G', 3, 2)).toBeNull();
  });

  it('places notes above the staff with the right number of ledger lines', () => {
    const g5 = getStaffPlacement('treble', 'G', 0, 5);
    const a5 = getStaffPlacement('treble', 'A', 0, 5);
    const c6 = getStaffPlacement('treble', 'C', 0, 6);
    expect(g5).toMatchObject({ y: 77, kind: 'above-staff', positionLabel: '谱表上' });
    expect(g5?.ledgerLineYs).toEqual([]);
    expect(a5).toMatchObject({ y: 70, kind: 'ledger-above', positionLabel: '加线上' });
    expect(a5?.ledgerLineYs).toEqual([70]);
    expect(c6?.ledgerLineYs).toEqual([70, 56]);
  });

  it('labels ledger-line notes separately from ledger-space notes', () => {
    expect(getStaffPlacement('treble', 'A', 0, 5)?.positionLabel).toBe('加线上');
    expect(getStaffPlacement('treble', 'B', 0, 5)?.positionLabel).toBe('加线间上');
    expect(getStaffPlacement('treble', 'A', 0, 3)?.positionLabel).toBe('加线下');
    expect(getStaffPlacement('treble', 'B', 0, 3)?.positionLabel).toBe('加线间下');
  });

  it('places multi-ledger notes below the staff', () => {
    const a3 = getStaffPlacement('treble', 'A', 0, 3);
    const f3 = getStaffPlacement('treble', 'F', 0, 3);
    expect(a3?.kind).toBe('ledger-below');
    expect(a3?.ledgerLineYs).toEqual([154, 168]);
    expect(f3?.kind).toBe('ledger-below');
    expect(f3?.ledgerLineYs).toEqual([154, 168, 182]);
  });

  it('reports unsupported notes with a reason instead of drawing them', () => {
    expect(getUnsupportedNotes(sampleScore)).toEqual([]);
    const outside: ScoreNote = {
      ...sampleScore[0],
      step: 'C',
      octave: 3,
      noteName: 'C3',
      midiNote: 48,
    };
    expect(getUnsupportedReason(outside)).toContain('超出当前支持范围');
    const wrongBar: ScoreNote = { ...sampleScore[0], bar: 3 };
    expect(getUnsupportedNotes([wrongBar], 2)[0]?.reason).toBe('小节号超出当前谱面范围');
  });

  it('formats scientific pitch names consistently', () => {
    expect(midiToPitchName(60)).toBe('C4');
    expect(midiToPitchName(43)).toBe('G2');
    expect(midiToPitchName(61)).toBe('C♯4');
  });
});


describe('key signature glyphs', () => {
  it('places flat and sharp order on the correct staff positions', () => {
    const flats = keySignatureGlyphs(-2, 'treble');
    expect(flats.map((entry) => entry.glyph)).toEqual(['♭', '♭']);
    expect(flats.map((entry) => [entry.step, entry.octave, entry.y])).toEqual([
      ['B', 4, 112],
      ['E', 5, 91],
    ]);
    const sharps = keySignatureGlyphs(3, 'bass');
    expect(sharps.map((entry) => entry.glyph)).toEqual(['♯', '♯', '♯']);
    expect(sharps.map((entry) => entry.step)).toEqual(['F', 'C', 'G']);
    expect(keySignatureGlyphs(0, 'treble')).toEqual([]);
  });
});
