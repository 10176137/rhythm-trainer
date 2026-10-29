import type { NoteStep, ScoreNote, ScoreStaff } from '../../core/sampleScore';
import { MAX_LEDGER_LINES, STAFF_BOTTOM_INDEX, supportsStaffPitch } from '../../../shared/staff-range.mjs';
export { MAX_LEDGER_LINES } from '../../../shared/staff-range.mjs';

export const NATURAL_STEPS: readonly NoteStep[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMITONES: Record<NoteStep, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_CLASS_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const STAFF_GEOMETRY = {
  viewBoxWidth: 920,
  viewBoxHeight: 430,
  /** Staff systems start left of the clef; notes/bar geometry start at staffStartX. */
  staffLineStartX: 34,
  staffStartX: 110,
  staffEndX: 880,
  lineGap: 14,
  beatsPerBar: 4,
  firstBeatInset: 40,
  lastBeatPadding: 24,
  treble: {
    id: 'treble' as const,
    topLineY: 84,
    bottomLineY: 140,
    bottomDiatonicIndex: STAFF_BOTTOM_INDEX.treble,
    label: '高音谱表',
  },
  bass: {
    id: 'bass' as const,
    topLineY: 252,
    bottomLineY: 308,
    bottomDiatonicIndex: STAFF_BOTTOM_INDEX.bass,
    label: '低音谱表',
  },
} as const;

export type StaffPositionKind =
  | 'line'
  | 'space'
  | 'ledger-below'
  | 'ledger-above'
  | 'below-staff'
  | 'above-staff';

export interface StaffPlacement {
  staff: ScoreStaff;
  staffLabel: string;
  /** Diatonic steps above/below the staff's bottom line. */
  offsetFromBottomLine: number;
  y: number;
  line: boolean;
  kind: StaffPositionKind;
  positionLabel: string;
  positionDetail: string;
  ledgerLineYs: number[];
}

const POSITION_LABELS: Record<'line' | 'space' | 'below-staff' | 'above-staff', string> = {
  line: '线上',
  space: '间上',
  'below-staff': '谱表下',
  'above-staff': '谱表上',
};

function positionLabelFor(kind: StaffPositionKind, line: boolean): string {
  if (kind === 'ledger-below') return line ? '加线下' : '加线间下';
  if (kind === 'ledger-above') return line ? '加线上' : '加线间上';
  return POSITION_LABELS[kind];
}

export function diatonicIndex(step: NoteStep, octave: number): number {
  return octave * 7 + NATURAL_STEPS.indexOf(step);
}

export function midiNoteFor(step: NoteStep, alter: number, octave: number): number {
  return (octave + 1) * 12 + STEP_SEMITONES[step] + alter;
}

export function formatPitchName(step: NoteStep, alter: number, octave: number): string {
  const accidental = alter === 0 ? '' : alter > 0 ? '♯'.repeat(alter) : '♭'.repeat(-alter);
  return `${step}${accidental}${octave}`;
}

/** Display-only helper for MIDI input labels (never used for scoring). */
export function midiToPitchName(midiNote: number): string {
  return `${PITCH_CLASS_NAMES[((midiNote % 12) + 12) % 12]}${Math.floor(midiNote / 12) - 1}`;
}

/**
 * Maps a written pitch to a vertical staff position for one clef. The mapping
 * is purely diatonic: bottom-line E4 (treble) / G2 (bass), one line or space
 * per diatonic step. Double accidentals are allowed; extreme ledger counts
 * return null so the caller can refuse to draw a note it cannot place reliably.
 */
export function getStaffPlacement(
  staff: ScoreStaff,
  step: NoteStep,
  alter: number,
  octave: number,
): StaffPlacement | null {
  if (!supportsStaffPitch(staff, step, alter, octave)) return null;

  const geometry = staff === 'treble' ? STAFF_GEOMETRY.treble : STAFF_GEOMETRY.bass;
  const offset = diatonicIndex(step, octave) - geometry.bottomDiatonicIndex;
  const topOffset = (geometry.bottomLineY - geometry.topLineY) / (STAFF_GEOMETRY.lineGap / 2);

  const halfGap = STAFF_GEOMETRY.lineGap / 2;
  const y = geometry.bottomLineY - offset * halfGap;
  const line = offset % 2 === 0;

  const ledgerOffsets: number[] = [];
  if (offset < 0) {
    for (let ledgerOffset = -2; ledgerOffset >= offset; ledgerOffset -= 2) ledgerOffsets.push(ledgerOffset);
  } else if (offset > topOffset) {
    for (let ledgerOffset = topOffset + 2; ledgerOffset <= offset; ledgerOffset += 2) ledgerOffsets.push(ledgerOffset);
  }
  const ledgerLineYs = ledgerOffsets.map((ledgerOffset) => geometry.bottomLineY - ledgerOffset * halfGap);

  let kind: StaffPositionKind;
  if (offset < 0) kind = ledgerOffsets.length > 0 ? 'ledger-below' : 'below-staff';
  else if (offset > topOffset) kind = ledgerOffsets.length > 0 ? 'ledger-above' : 'above-staff';
  else kind = line ? 'line' : 'space';

  return {
    staff,
    staffLabel: geometry.label,
    offsetFromBottomLine: offset,
    y,
    line,
    kind,
    positionLabel: positionLabelFor(kind, line),
    positionDetail: describePosition(geometry.label, offset, topOffset, kind, line),
    ledgerLineYs,
  };
}

function describePosition(
  staffLabel: string,
  offset: number,
  topOffset: number,
  kind: StaffPositionKind,
  line: boolean,
): string {
  if (kind === 'line') return `${staffLabel}第 ${offset / 2 + 1} 线`;
  if (kind === 'space') return `${staffLabel}第 ${(offset + 1) / 2} 间`;
  if (kind === 'below-staff') return `${staffLabel}下方，无加线`;
  if (kind === 'above-staff') return `${staffLabel}上方，无加线`;
  const distance = kind === 'ledger-below' ? -offset : offset - topOffset;
  const ledgerCount = Math.ceil(distance / 2);
  return `${kind === 'ledger-below' ? `${staffLabel}下方` : `${staffLabel}上方`}加线区域（第 ${ledgerCount} 条加线${line ? '' : '间'}）`;
}

export function formatPositionLabel(placement: StaffPlacement): string {
  return placement.positionLabel;
}

/** Returns a user-facing explanation when a note cannot be drawn reliably. */
export function getUnsupportedReason(note: ScoreNote): string | null {
  if (Math.abs(note.alter) > 2) {
    return `${note.noteName} 的变音记号超出当前支持范围（最多双升/双降）`;
  }
  const writtenMidi = midiNoteFor(note.step, note.alter, note.octave);
  if (writtenMidi !== note.midiNote) {
    return `${note.noteName} 的书写音高与 MIDI 音高不一致（应为 ${writtenMidi}，实际 ${note.midiNote}）`;
  }
  if (!getStaffPlacement(note.staff, note.step, note.alter, note.octave)) {
    return `${note.noteName} 超出当前支持范围（最多 ${MAX_LEDGER_LINES} 条加线）`;
  }
  return null;
}

export function accidentalGlyph(alter: number): string {
  if (alter === 2) return '𝄪';
  if (alter === 1) return '♯';
  if (alter === -1) return '♭';
  if (alter === -2) return '𝄫';
  return '';
}

export function getUnsupportedNotes(notes: readonly ScoreNote[], barCount = 2): { note: ScoreNote; reason: string }[] {
  return notes.flatMap((note) => {
    if (note.bar < 1 || note.bar > barCount) {
      return [{ note, reason: '小节号超出当前谱面范围' }];
    }
    const reason = getUnsupportedReason(note);
    return reason ? [{ note, reason }] : [];
  });
}

export interface KeySignatureGlyph {
  step: NoteStep;
  octave: number;
  y: number;
  glyph: '♯' | '♭';
}

const TREBLE_SHARP_STEPS: ReadonlyArray<readonly [NoteStep, number]> = [
  ['F', 5], ['C', 5], ['G', 5], ['D', 5], ['A', 4], ['E', 5], ['B', 4],
];
const TREBLE_FLAT_STEPS: ReadonlyArray<readonly [NoteStep, number]> = [
  ['B', 4], ['E', 5], ['A', 4], ['D', 5], ['G', 4], ['C', 5], ['F', 4],
];
const BASS_SHARP_STEPS: ReadonlyArray<readonly [NoteStep, number]> = [
  ['F', 3], ['C', 3], ['G', 3], ['D', 3], ['A', 2], ['E', 3], ['B', 2],
];
const BASS_FLAT_STEPS: ReadonlyArray<readonly [NoteStep, number]> = [
  ['B', 2], ['E', 3], ['A', 2], ['D', 3], ['G', 3], ['C', 3], ['F', 3],
];

/** Standard key-signature order/positions for the supported G2/F4 clefs. */
export function keySignatureGlyphs(fifths: number, staff: ScoreStaff): KeySignatureGlyph[] {
  const count = Math.min(7, Math.abs(Math.trunc(fifths)));
  if (!count) return [];
  const flat = fifths < 0;
  const steps = staff === 'treble'
    ? (flat ? TREBLE_FLAT_STEPS : TREBLE_SHARP_STEPS)
    : (flat ? BASS_FLAT_STEPS : BASS_SHARP_STEPS);
  const glyph = flat ? '♭' : '♯';
  return steps.slice(0, count)
    .map(([step, octave]) => {
      const placement = getStaffPlacement(staff, step, 0, octave);
      return placement ? { step, octave, y: placement.y, glyph } : null;
    })
    .filter((entry): entry is KeySignatureGlyph => entry !== null);
}
