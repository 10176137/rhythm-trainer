export type NoteStep = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type ScoreStaff = 'treble' | 'bass';
export type ScoreHand = 'left' | 'right';
export type ScoreNoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th';

/**
 * One score event. Pitch preserves MusicXML's sounding step/alter/octave and
 * MIDI value, never a screen coordinate. Professional engraving reads written
 * octave shifts (8va/8vb) from sourceXml; display hints cannot move targets.
 */
export interface ScoreNote {
  id: string;
  midiNote: number;
  noteName: string;
  step: NoteStep;
  alter: number;
  octave: number;
  hand: ScoreHand;
  staff: ScoreStaff;
  voice: number;
  /** Absolute quarter-note beats from the start of the excerpt. */
  beat: number;
  bar: number;
  durationBeats: number;
  noteType: ScoreNoteType;
  /** True for a tie continuation; display only, never a new practice onset. */
  isTieContinuation?: boolean;
  isGrace?: boolean;
  isCue?: boolean;
  tieSpanId?: string;
}

export interface ScoreMeasureMeta {
  /** 1-based measure ordinal. */
  bar: number;
  /** Global quarter-note beat where this measure starts. */
  startBeat: number;
  /** Effective measure length in quarter-note beats (6/8 → 3). */
  durationBeats: number;
  /** Notated time signature numerator/denominator for this measure. */
  beats: number;
  beatType: number;
  /** Key signature fifths for this measure (negative = flats). */
  keyFifths?: number;
  implicit?: boolean;
}

export interface ScoreMeta {
  title: string;
  composer: string;
  timeSignature: readonly [number, number];
  /** Quarter-note beats per bar (4/4 → 4, 3/4 → 3, 6/8 → 3). */
  beatsPerBar: number;
  keySignature: string;
  barCount: number;
  staves: 1 | 2;
  clefs: { staff1: ScoreStaff; staff2?: ScoreStaff };
  /** Per-measure timeline from MusicXML; layout must not assume 4/4. */
  measures?: ScoreMeasureMeta[];
  sourceFile: string;
  integration: 'fixture' | 'imported';
  integrationNote: string;
}

export interface ScoreDocument {
  notes: ScoreNote[];
  meta: ScoreMeta;
  warnings: string[];
  /** New semantic engine document used by the playback planner. */
  engine?: import('../score-engine/domain/types').ScoreDocument;
  /** Import/strict-support report from the semantic importer. */
  importReport?: import('../score-engine/domain/types').ImportReport;
  /** Original MusicXML, used by the professional OSMD engraver. */
  sourceXml?: string;
}

export const sampleScoreMeta: ScoreMeta = {
  title: '线间音符识谱练习',
  composer: 'Rhythm Trainer Educational Example',
  timeSignature: [4, 4],
  beatsPerBar: 4,
  keySignature: 'C 大调',
  barCount: 2,
  staves: 2,
  clefs: { staff1: 'treble', staff2: 'bass' },
  measures: [
    { bar: 1, startBeat: 0, durationBeats: 4, beats: 4, beatType: 4, keyFifths: 0 },
    { bar: 2, startBeat: 4, durationBeats: 4, beats: 4, beatType: 4, keyFifths: 0 },
  ],
  sourceFile: 'src/features/score/fixtures/rhythm-trainer-score-reading-example-v2.musicxml',
  /** Default fixture is transcribed by hand; imported files use musicXmlParser. */
  integration: 'fixture',
  integrationNote: '按 MusicXML 示例手工转录的默认 fixture；导入 MusicXML 时使用浏览器端简单解析器。',
};

/**
 * Fixture transcription of
 * src/features/score/fixtures/rhythm-trainer-score-reading-example-v2.musicxml.
 *
 * Right hand: C4–D4–E4–F4 | G4–A4–B4–C5 (quarter notes, treble staff).
 * Left hand:  C3 | G2 (whole notes, bass staff).
 * The XML file is the source of truth; scoreFixture.test.ts reads it and fails
 * if this table drifts from the notation.
 */
export const sampleScore: ScoreNote[] = [
  { id: 'r1', midiNote: 60, noteName: 'C4', step: 'C', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 0, bar: 1, durationBeats: 1, noteType: 'quarter' },
  { id: 'r2', midiNote: 62, noteName: 'D4', step: 'D', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 1, bar: 1, durationBeats: 1, noteType: 'quarter' },
  { id: 'r3', midiNote: 64, noteName: 'E4', step: 'E', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 2, bar: 1, durationBeats: 1, noteType: 'quarter' },
  { id: 'r4', midiNote: 65, noteName: 'F4', step: 'F', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 3, bar: 1, durationBeats: 1, noteType: 'quarter' },
  { id: 'r5', midiNote: 67, noteName: 'G4', step: 'G', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 4, bar: 2, durationBeats: 1, noteType: 'quarter' },
  { id: 'r6', midiNote: 69, noteName: 'A4', step: 'A', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 5, bar: 2, durationBeats: 1, noteType: 'quarter' },
  { id: 'r7', midiNote: 71, noteName: 'B4', step: 'B', alter: 0, octave: 4, hand: 'right', staff: 'treble', voice: 1, beat: 6, bar: 2, durationBeats: 1, noteType: 'quarter' },
  { id: 'r8', midiNote: 72, noteName: 'C5', step: 'C', alter: 0, octave: 5, hand: 'right', staff: 'treble', voice: 1, beat: 7, bar: 2, durationBeats: 1, noteType: 'quarter' },
  { id: 'l1', midiNote: 48, noteName: 'C3', step: 'C', alter: 0, octave: 3, hand: 'left', staff: 'bass', voice: 2, beat: 0, bar: 1, durationBeats: 4, noteType: 'whole' },
  { id: 'l2', midiNote: 43, noteName: 'G2', step: 'G', alter: 0, octave: 2, hand: 'left', staff: 'bass', voice: 2, beat: 4, bar: 2, durationBeats: 4, noteType: 'whole' },
];

export const totalBeats = 8;

export const defaultScoreDocument: ScoreDocument = {
  notes: sampleScore,
  meta: sampleScoreMeta,
  warnings: [],
};
