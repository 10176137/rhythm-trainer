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
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
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

/** Octaves are disjoint, including the partial octaves at the keyboard ends. */
export const READING_OCTAVES = Array.from({ length: 8 }, (_, index) => {
  const octave = index + 1;
  const startMidi = Math.max(READING_KEY_LOW, (octave + 1) * 12);
  const endMidi = Math.min(READING_KEY_HIGH, (octave + 2) * 12 - 1);
  return { id: String(octave), range: { startMidi, endMidi }, label: startMidi === endMidi ? midiLabel(startMidi) : `${midiLabel(startMidi)}–${midiLabel(endMidi)}` };
});

// ---- Key selection (user-requested: "C 大调 / b 小调 这样的选项") ----

export type KeyRoot = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type KeyMode = 'major' | 'minor';

export interface KeySelection {
  root: KeyRoot;
  mode: KeyMode;
}

const MAJOR_FIFTHS: Record<KeyRoot, number> = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };
const MINOR_FIFTHS: Record<KeyRoot, number> = { A: 0, B: 2, C: -3, D: -1, E: 1, F: -4, G: 2 };
const KEY_ROOT_PC: Record<KeyRoot, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Key signature fifths for root+mode (natural minor = relative major). */
export function keyFifths(key: KeySelection): number {
  return key.mode === 'major' ? MAJOR_FIFTHS[key.root] : MINOR_FIFTHS[key.root];
}

/** MIDI pitch classes of the key's diatonic scale. */
export function keyScalePitchClasses(key: KeySelection): number[] {
  const intervals = key.mode === 'major'
    ? [0, 2, 4, 5, 7, 9, 11]
    : [0, 2, 3, 5, 7, 8, 10];
  const tonic = KEY_ROOT_PC[key.root];
  return intervals.map((interval) => (tonic + interval) % 12);
}

export function keyLabel(key: KeySelection): string {
  return `${key.root}${key.mode === 'major' ? ' 大调' : ' 小调'}`;
}

const NATURAL_BY_PC: Record<number, { step: string; octaveShift: number }> = {
  0: { step: 'C', octaveShift: 0 },
  2: { step: 'D', octaveShift: 0 },
  4: { step: 'E', octaveShift: 0 },
  5: { step: 'F', octaveShift: 0 },
  7: { step: 'G', octaveShift: 0 },
  9: { step: 'A', octaveShift: 0 },
  11: { step: 'B', octaveShift: 0 },
};

/**
 * Spells one MIDI note for the given key signature. Natural pitches always
 * keep their natural letter; the five accidental pitch classes follow the
 * key's accidental side (sharp keys: C♯…, flat keys: D♭…) — so flat keys
 * produce 降调 spellings instead of unconditional sharps.
 */
export function spellMidi(midi: number, fifths: number): { step: string; alter: number; octave: number } {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const natural = NATURAL_BY_PC[pc];
  if (natural) return { step: natural.step, alter: 0, octave };
  const useSharp = fifths >= 0;
  switch (pc) {
    case 1: return useSharp ? { step: 'C', alter: 1, octave } : { step: 'D', alter: -1, octave };
    case 3: return useSharp ? { step: 'D', alter: 1, octave } : { step: 'E', alter: -1, octave };
    case 6: return useSharp ? { step: 'F', alter: 1, octave } : { step: 'G', alter: -1, octave };
    case 8: return useSharp ? { step: 'G', alter: 1, octave } : { step: 'A', alter: -1, octave };
    case 10: return useSharp ? { step: 'A', alter: 1, octave } : { step: 'B', alter: -1, octave };
    default: throw new Error(`spellMidi: unexpected pitch class ${pc}`);
  }
}

/**
 * Pitch pool for a reading session: union of the selected ranges, optionally
 * filtered to the selected key's diatonic scale (sorted, deduped).
 */
export function readingPool(ranges: readonly PitchRange[], key: KeySelection | null): number[] {
  const pool = poolFromRanges(ranges);
  if (!key) return pool;
  const scale = new Set(keyScalePitchClasses(key));
  return pool.filter((midi) => scale.has(((midi % 12) + 12) % 12));
}
