// 81-key note-reading training: authoritative key range and pitch pools.
//
// The task spec forbids guessing the 81-key range; the project had no
// authoritative definition (the old keyboard visualization was C2–B5). This
// module is the SINGLE source of truth. Proposed range: E1 (MIDI 28) to
// C8 (MIDI 108) = exactly 81 keys — keeps the whole top of the piano for
// high ledger-line reading, trims only the extreme low end. Changing the
// range is a one-constant edit; nothing else may hardcode boundaries.

export const READING_KEY_LOW = 28; // E1 — proposed 81-key lower bound (pending user confirmation)
export const READING_KEY_HIGH = 108; // C8
export const READING_KEY_COUNT = READING_KEY_HIGH - READING_KEY_LOW + 1; // 81

export const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export interface PitchRange {
  startMidi: number;
  endMidi: number;
}

export function clampReadingRange(range: PitchRange): PitchRange | null {
  const start = Math.max(READING_KEY_LOW, Math.round(range.startMidi));
  const end = Math.min(READING_KEY_HIGH, Math.round(range.endMidi));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { startMidi: start, endMidi: end };
}

/** Union of ranges, deduped and sorted; overlapping ranges merge naturally. */
export function poolFromRanges(ranges: readonly PitchRange[]): number[] {
  const pool = new Set<number>();
  for (const raw of ranges) {
    const range = clampReadingRange(raw);
    if (!range) continue;
    for (let midi = range.startMidi; midi <= range.endMidi; midi += 1) pool.add(midi);
  }
  return [...pool].sort((a, b) => a - b);
}

export function midiLabel(midi: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function rangeLabel(range: PitchRange): string {
  return `${midiLabel(range.startMidi)}–${midiLabel(range.endMidi)}`;
}

export interface RangePreset {
  id: string;
  label: string;
  ranges: PitchRange[];
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: 'treble-core', label: '入门 · C4–C5', ranges: [{ startMidi: 60, endMidi: 72 }] },
  { id: 'bass-staff', label: '低音谱表 · C2–C4', ranges: [{ startMidi: 36, endMidi: 60 }] },
  { id: 'grand-staff', label: '大谱表 · C2–C6', ranges: [{ startMidi: 36, endMidi: 84 }] },
  { id: 'extended', label: '扩展 · E1–C7', ranges: [{ startMidi: READING_KEY_LOW, endMidi: 96 }] },
  { id: 'all-81', label: '全部 81 键 · E1–C8', ranges: [{ startMidi: READING_KEY_LOW, endMidi: READING_KEY_HIGH }] },
];
