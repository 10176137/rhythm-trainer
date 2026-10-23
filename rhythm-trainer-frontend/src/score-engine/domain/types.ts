import type { RationalBeat } from './rational';

export const SCORE_ENGINE_VERSION = '1.0.0';
export const IMPORT_SCHEMA_VERSION = 1;
export const SUPPORT_PROFILE_VERSION = 'musicxml-v1.0';

export type ImportStatus = 'READY' | 'READY_WITH_WARNINGS' | 'DISPLAY_ONLY' | 'REJECTED';
export type ImportSeverity = 'error' | 'warning' | 'info';

/** Stable machine codes; user-facing Chinese text is intentionally separate. */
export type ImportIssueCode =
  | 'invalid_xml'
  | 'unsupported_root'
  | 'unsupported_score_timewise'
  | 'missing_parts'
  | 'missing_measures'
  | 'missing_divisions'
  | 'invalid_divisions'
  | 'invalid_duration'
  | 'missing_note_duration'
  | 'duration_out_of_measure'
  | 'invalid_measure_cursor'
  | 'invalid_chord_anchor'
  | 'orphan_tie_start'
  | 'orphan_tie_stop'
  | 'tied_notation_without_sound_tie'
  | 'unsupported_repeat_structure'
  | 'unsupported_tempo_curve'
  | 'unsupported_clef'
  | 'unsupported_transpose'
  | 'unsupported_grace'
  | 'unsupported_cue'
  | 'unrepresentable_pitch'
  | 'multiple_parts'
  | 'duplicate_xml_id'
  | 'mid_measure_attributes'
  | 'measure_underfull'
  | 'xml_external_entity_disabled'
  | 'xml_internal_subset_disabled'
  | 'file_too_large'
  | 'unsupported_extension'
  | 'unsupported_compressed_musicxml'
  | 'no_playable_notes'
  | 'fixed_bpm_overrides_score_tempo'
  | 'score_not_strict_ready'
  | 'tick_grid_rounding';

export interface ImportIssue {
  code: ImportIssueCode;
  severity: ImportSeverity;
  message: string;
  /** True means a strict timed attempt must not be produced from this score. */
  blocksStrict: boolean;
  measureOrdinal?: number;
  eventId?: string;
  xmlId?: string;
}

export interface ScoreSourceRef {
  partId: string;
  /** 1-based internal ordinal; printed measure numbers are separate. */
  measureOrdinal: number;
  printedMeasureNumber?: string;
  voiceId?: string;
  staffNumber: number;
  xmlId?: string;
  /** Order of this <note> in the source measure, including rests/chords. */
  sourceOrdinal: number;
}

export interface Pitch {
  step: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** MusicXML semitone alteration. Fractional values are preserved for display. */
  alter: number;
  octave: number;
  /** Null when the written pitch cannot be represented by the MIDI model. */
  midiNote: number | null;
  /** Written spelling, e.g. F#4 or Gb4 (never enharmonically rewritten). */
  spelling: string;
}

export interface TimeSignature {
  beats: number;
  beatType: number;
}

export interface KeySignature {
  fifths: number;
  mode: string;
}

export interface ClefInstruction {
  staffNumber: number;
  sign: string;
  line: number;
}

export interface MeasureAttributes {
  divisions: number;
  time: TimeSignature;
  key: KeySignature;
  staves: number;
  clefs: readonly ClefInstruction[];
}

export type ScoreEventKind = 'note' | 'rest';

export interface ScoreEvent {
  /** Deterministic within scoreFingerprint; independent of playback occurrences. */
  id: string;
  kind: ScoreEventKind;
  source: ScoreSourceRef;
  onsetBeat: RationalBeat;
  durationBeat: RationalBeat;
  notatedType?: string;
  dots: number;
  pitch?: Pitch;
  /** Notes sharing one <chord/> anchor share this ID. */
  chordGroupId?: string;
  tieStart: boolean;
  tieStop: boolean;
  /** Notation-only tie marks from <tied>, kept separate from <tie>. */
  tiedStart: boolean;
  tiedStop: boolean;
  isGrace: boolean;
  isCue: boolean;
  lyricText?: string;
  articulations: readonly string[];
  capabilities: readonly string[];
  timeModification?: { actualNotes: number; normalNotes: number };
  /** Set after tie resolution; the first event in the span is the onset event. */
  tieSpanId?: string;
}

export interface BarlineInfo {
  location?: string;
  barStyle?: string;
  repeat?: {
    direction: 'forward' | 'backward';
    times?: number;
    afterJump?: boolean;
  };
  ending?: {
    number?: string;
    type: 'start' | 'stop' | 'discontinue';
  };
}

export interface TempoMark {
  measureOrdinal: number;
  beat: RationalBeat;
  bpm: number;
  kind: 'metronome' | 'sound';
}

export interface ScoreMeasure {
  /** 1-based internal ordinal, not a parsed measure-number string. */
  ordinal: number;
  printedNumber?: string;
  implicit: boolean;
  /** Global quarter-beat origin of this measure in its part. */
  startBeat: RationalBeat;
  /** Effective measure duration used to advance the part timeline. */
  durationBeat: RationalBeat;
  attributes: MeasureAttributes;
  events: readonly ScoreEvent[];
  barlines: readonly BarlineInfo[];
  tempoMarks: readonly TempoMark[];
  capabilities: readonly string[];
}

export interface ScorePart {
  id: string;
  name: string;
  staves: number;
  measures: readonly ScoreMeasure[];
}

export interface TieSpan {
  id: string;
  pitchKey: string;
  /** Onset event first, then each tied continuation in order. */
  eventIds: readonly string[];
  startBeat: RationalBeat;
  endBeat: RationalBeat;
}

export interface ScoreSourceInfo {
  format: 'musicxml-partwise';
  xmlVersion?: string;
  doctypePresent: boolean;
}

export interface ScoreDocument {
  schemaVersion: number;
  parserVersion: string;
  supportProfileVersion: string;
  fingerprint: string;
  workTitle: string;
  composer: string;
  source: ScoreSourceInfo;
  parts: readonly ScorePart[];
  tieSpans: readonly TieSpan[];
  tempoMarks: readonly TempoMark[];
  capabilities: readonly string[];
  strictAllowed: boolean;
}

export interface ImportCounts {
  partCount: number;
  measureCount: number;
  noteCount: number;
  restCount: number;
  chordNoteCount: number;
  tieSpanCount: number;
  graceCount: number;
  cueCount: number;
  warningCount: number;
  errorCount: number;
}

export interface ImportReport {
  schemaVersion: number;
  parserVersion: string;
  supportProfileVersion: string;
  fingerprint: string;
  status: ImportStatus;
  strictAllowed: boolean;
  sourceFileName: string;
  sourceFormat: 'musicxml-partwise' | 'unsupported';
  formatVersion?: string;
  counts: ImportCounts;
  issues: readonly ImportIssue[];
  capabilities: readonly string[];
}

export interface ImportOptions {
  fileName?: string;
  maxBytes?: number;
}

export interface ImportMusicXmlResult {
  scoreDocument?: ScoreDocument;
  importReport: ImportReport;
}

export interface PlaybackRange {
  startMeasureOrdinal: number;
  endMeasureOrdinal: number;
}

export type RepeatSelection =
  | { kind: 'none' }
  | { kind: 'range-loop'; count: number };

export interface PlaybackPlanRequest {
  range: PlaybackRange;
  repeatSelection: RepeatSelection;
  /** Strict measurement must be rejected if unsupported notation is active. */
  unsupportedNotationPolicy: 'reject-strict' | 'allow-display-only';
}

export interface PlaybackOccurrence {
  occurrenceId: string;
  scoreEventId: string;
  playbackIndex: number;
  passIndex: number;
  measureOrdinal: number;
  /** Beat relative to the selected range origin, including pass offset. */
  playbackBeat: RationalBeat;
  /** Beat within the event's own measure. */
  beatInMeasure: RationalBeat;
  bar: number;
  staffNumber: number;
  voiceId?: string;
  pitch?: Pitch;
  durationBeat: RationalBeat;
  chordGroupId?: string;
  isTieOnset: boolean;
}

export interface PlaybackGroup {
  groupId: string;
  /** Beat relative to the selected range origin, including pass offset. */
  playbackBeat: RationalBeat;
  occurrenceIds: readonly string[];
  scoreEventIds: readonly string[];
  pitches: readonly Pitch[];
  bar: number;
  beatInMeasure: RationalBeat;
  staffNumbers: readonly number[];
  voiceIds: readonly string[];
  durationBeat: RationalBeat;
}

export interface PlaybackPlan {
  planId: string;
  scoreFingerprint: string;
  range: PlaybackRange;
  repeatSelection: RepeatSelection;
  occurrences: readonly PlaybackOccurrence[];
  groups: readonly PlaybackGroup[];
  strictAllowed: boolean;
  issues: readonly ImportIssue[];
  rangeStartBeat: RationalBeat;
  rangeDurationBeat: RationalBeat;
}

export interface TempoConfiguration {
  bpm: number;
  /** Explicit origin; target milliseconds are relative to this origin. */
  timeOrigin: 'playback-start';
}

export interface TempoMap {
  bpm: number;
  ticksPerQuarter: number;
  origin: 'playback-start';
  beatToMs(beat: RationalBeat): number;
  beatToTicks(beat: RationalBeat): number | null;
}

export interface ScoreOccurrence {
  targetId: string;
  occurrenceIds: readonly string[];
  scoreEventIds: readonly string[];
  pitches: readonly Pitch[];
  beat: RationalBeat;
  atMs: number;
  durationMs: number;
  bar: number;
  staffNumbers: readonly number[];
  voiceIds: readonly string[];
  chordGroupIds: readonly string[];
  capabilities: readonly string[];
}

export interface ScoreOccurrenceResult {
  occurrences: readonly ScoreOccurrence[];
  issues: readonly ImportIssue[];
}

export interface PlaybackPlanResult {
  plan?: PlaybackPlan;
  issues: readonly ImportIssue[];
  strictAllowed: boolean;
}

export interface EngineAtomLike {
  startTick: number;
  durationTicks: number;
  kind: 'note';
  bar: number;
  beat: number;
}
