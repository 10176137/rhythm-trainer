import type { KeySelection, PitchRange } from './reading-keys.mjs';
export type ReadingComplexity = 'basic' | 'intermediate' | 'advanced';
/** Which staff (hand) the generated notes are written on. */
export type ReadingStaffPreference = 'auto' | 'treble' | 'bass';

export interface ReadingConfig {
  mode: 'free' | 'rhythm';
  ranges: PitchRange[];
  notesPerEvent: 1 | 2 | 3 | 4;
  seed: number;
  task?: 'practice' | 'test';
  /** null/undefined = chromatic (不限调); otherwise pool = key's diatonic scale. */
  key?: KeySelection | null;
  /** Staff/hand placement: auto by pitch, or fixed treble (right) / bass (left). */
  staffPreference?: ReadingStaffPreference;
  /** free only */
  questionCount?: 10 | 20 | 40;
  /** rhythm only */
  timeSignature?: [2 | 3 | 4, 4];
  bpm?: number;
  complexity?: ReadingComplexity;
  measures?: 2 | 4 | 8;
  countInMeasures?: 1 | 2;
}

export interface GeneratedReadingQuestion {
  midiNotes: number[];
}

export interface GeneratedRhythmScore {
  xml: string;
  contentFingerprint: string;
  summary: {
    measureCount: number;
    eventCount: number;
    noteCount: number;
    restCount: number;
    beatsPerBar: number;
  };
}

export type GeneratedReadingExercise =
  | { schemaVersion: 1; generatorVersion: string; mode: 'free'; questions: GeneratedReadingQuestion[] }
  | { schemaVersion: 1; generatorVersion: string; mode: 'rhythm'; score: GeneratedRhythmScore };
