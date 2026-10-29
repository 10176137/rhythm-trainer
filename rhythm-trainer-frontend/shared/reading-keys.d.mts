export declare const READING_KEY_LOW = 28;
export declare const READING_KEY_HIGH = 108;
export declare const READING_KEY_COUNT: number;
export declare const BLACK_PITCH_CLASSES: Set<number>;
export interface PitchRange {
    startMidi: number;
    endMidi: number;
}
export declare function clampReadingRange(range: PitchRange): PitchRange | null;
/** Union of ranges, deduped and sorted; overlapping ranges merge naturally. */
export declare function poolFromRanges(ranges: readonly PitchRange[]): number[];
export declare function midiLabel(midi: number): string;
export declare function rangeLabel(range: PitchRange): string;
export interface RangePreset {
    id: string;
    label: string;
    ranges: PitchRange[];
}
export declare const RANGE_PRESETS: readonly RangePreset[];
/** Octaves are disjoint, including the partial octaves at the keyboard ends. */
export declare const READING_OCTAVES: {
    id: string;
    range: {
        startMidi: number;
        endMidi: number;
    };
    label: string;
}[];
export type KeyRoot = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type KeyMode = 'major' | 'minor';
export interface KeySelection {
    root: KeyRoot;
    mode: KeyMode;
}
/** Key signature fifths for root+mode (natural minor = relative major). */
export declare function keyFifths(key: KeySelection): number;
/** MIDI pitch classes of the key's diatonic scale. */
export declare function keyScalePitchClasses(key: KeySelection): number[];
export declare function keyLabel(key: KeySelection): string;
/**
 * Spells one MIDI note for the given key signature. Natural pitches always
 * keep their natural letter; the five accidental pitch classes follow the
 * key's accidental side (sharp keys: C♯…, flat keys: D♭…) — so flat keys
 * produce 降调 spellings instead of unconditional sharps.
 */
export declare function spellMidi(midi: number, fifths: number): {
    step: string;
    alter: number;
    octave: number;
};
/**
 * Display name matching the generated score's spelling (same spellMidi call
 * that feeds the MusicXML). Feedback text must use this — never the fixed
 * chromatic midiLabel — so the note on the staff and the note in the answer
 * text are always the same name (G♯4 in sharp keys is not "A♭4").
 */
export declare function spelledLabel(midi: number, fifths: number): string;
/**
 * Pitch pool for a reading session: union of the selected ranges, optionally
 * filtered to the selected key's diatonic scale (sorted, deduped).
 */
export declare function readingPool(ranges: readonly PitchRange[], key: KeySelection | null): number[];
