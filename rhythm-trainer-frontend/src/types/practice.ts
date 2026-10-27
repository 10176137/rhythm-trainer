export type PracticeModeId = 'rhythm' | 'score' | 'hands' | 'loop' | 'free' | 'fixed-line' | 'reading-free' | 'reading-rhythm';
export type HandSelection = 'both' | 'right' | 'left';
export type FeedbackMode = 'live' | 'after';
/** Centralized session machine: idle → countdown → running ↔ paused → processing → completed. */
export type SessionStatus = 'idle' | 'countdown' | 'running' | 'paused' | 'processing' | 'completed';
export type JudgmentProfile = 'strict' | 'standard' | 'relaxed';
/** v0.3: how (and whether) key-down durations are judged. */
export type DurationEvaluationPolicy = 'strict-keydown' | 'disabled';
/** Fixed-clock test vs self-paced score-following (cursor waits for input). */
export type ScoreAdvanceMode = 'timeline' | 'follow';

export interface PracticeConfig {
  modeId: PracticeModeId;
  tempo: number;
  timeSignature: [number, number];
  hand: HandSelection;
  feedback: FeedbackMode;
  /** When true, the selected bar range is the practice range. */
  loopEnabled: boolean;
  loopStartBar: number;
  loopEndBar: number;
  profile: JudgmentProfile;
  durationPolicy: DurationEvaluationPolicy;
  advanceMode: ScoreAdvanceMode;
}

export interface MidiPerformanceEvent {
  type: 'note-on' | 'note-off';
  midiNote: number;
  velocity: number;
  /**
   * Legacy timestamp: for device events this is MIDIMessageEvent.timeStamp
   * (browser performance timeline). Simulator events use performance.now().
   */
  timestampMs: number;
  source: 'device' | 'simulator';
  /** MIDI channel 0–15 (device events only; display as channel+1). */
  channel?: number;
  /** Web MIDI input port id — never a hard-coded device name. */
  sourceId?: string;
  /** MIDIMessageEvent.timeStamp, kept alongside the legacy field. */
  eventTimestampPerformanceMs?: number;
  /** performance.now() at handler entry — dispatch-delay diagnostic only. */
  handlerNowPerformanceMs?: number;
  /** handlerNow − event.timeStamp; diagnostics, never a score compensation. */
  dispatchDelayMs?: number;
}

export type FeedbackTone = 'success' | 'warning' | 'neutral';
export interface FeedbackMessage {
  id: string;
  title: string;
  detail: string;
  tone: FeedbackTone;
  timestampMs: number;
}
