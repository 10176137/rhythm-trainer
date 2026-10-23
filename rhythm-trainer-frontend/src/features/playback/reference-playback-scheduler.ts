import type { PlaybackAudioEngine } from './audioEngineAdapter';
import type { PlaybackClock } from './playbackClock';
import type { ReferencePlaybackPlan } from '../../score-engine/playback/reference-playback-plan';

export interface SchedulerUnderrun {
  /** Notes that were started late but still had audible time left. */
  lateCount: number;
  /** Notes whose whole duration was already in the past. */
  skippedCount: number;
  atPositionMs: number;
  lateNoteIds: string[];
  skippedNoteIds: string[];
}

export interface ReferencePlaybackSchedulerOptions {
  lookAheadMs?: number;
  lateToleranceMs?: number;
  onUnderrun?: (event: SchedulerUnderrun) => void;
  onError?: (code: string, message: string) => void;
}

/**
 * Look-ahead scheduler. The tick only fills a future audio window; note times
 * themselves are always AudioContext times. A note that has already passed is
 * never silently dropped: partially audible notes are started late and fully
 * past notes are reported through onUnderrun so the controller can degrade.
 */
export class ReferencePlaybackScheduler {
  private nextIndex = 0;
  private failed = false;
  private readonly lookAheadMs: number;
  private readonly lateToleranceMs: number;
  private readonly onUnderrun?: (event: SchedulerUnderrun) => void;
  private readonly onError?: (code: string, message: string) => void;
  private scheduledThroughMs = 0;

  constructor(
    private readonly plan: ReferencePlaybackPlan,
    private readonly clock: PlaybackClock,
    private readonly audio: PlaybackAudioEngine,
    options: ReferencePlaybackSchedulerOptions = {},
  ) {
    this.lookAheadMs = options.lookAheadMs ?? 150;
    this.lateToleranceMs = options.lateToleranceMs ?? 30;
    this.onUnderrun = options.onUnderrun;
    this.onError = options.onError;
  }

  begin(startAtMs: number): void {
    const index = startAtMs <= 0
      ? 0
      : this.plan.notes.findIndex((note) => note.atMs > startAtMs + 0.5);
    this.nextIndex = index < 0 ? this.plan.notes.length : index;
    this.scheduledThroughMs = Math.max(0, startAtMs);
    this.failed = false;
    this.pump();
  }

  get scheduledThrough(): number {
    return this.scheduledThroughMs;
  }

  get scheduledIndex(): number {
    return this.nextIndex;
  }

  get didFail(): boolean {
    return this.failed;
  }

  pump(): void {
    if (this.failed) return;
    const nowSessionMs = this.clock.currentPositionMs();
    const nowAudioTime = this.clock.audioTimeForPosition(nowSessionMs);
    const lateNoteIds: string[] = [];
    const skippedNoteIds: string[] = [];
    let lateCount = 0;
    let skippedCount = 0;

    while (this.nextIndex < this.plan.notes.length) {
      const note = this.plan.notes[this.nextIndex];
      const intendedOnAudio = this.clock.audioTimeForPosition(note.atMs);
      if (intendedOnAudio > nowAudioTime + this.lookAheadMs / 1000) break;

      const lateMs = nowSessionMs - note.atMs;
      const isLate = lateMs > this.lateToleranceMs;
      const onAudio = isLate ? nowAudioTime + 0.005 : intendedOnAudio;
      let scheduledVoice = false;
      let skippedVoice = false;

      try {
        for (const voice of note.voices) {
          // Each voice keeps its own written duration. A short bass note in a
          // chord with a long sustained note must not inherit the group max.
          const intendedOffAudio = this.clock.audioTimeForPosition(note.atMs + voice.durationMs);
          if (intendedOffAudio <= nowAudioTime + 0.02) {
            skippedVoice = true;
            continue;
          }
          const offAudio = isLate
            ? onAudio + Math.max(0.02, intendedOffAudio - (nowAudioTime + 0.005))
            : intendedOffAudio;
          this.audio.scheduleNoteOn({
            voiceId: voice.voiceId,
            midiNote: voice.midiNote,
            velocity: voice.velocity,
          }, onAudio);
          this.audio.scheduleNoteOff(voice.voiceId, offAudio);
          scheduledVoice = true;
        }
      } catch (error) {
        this.failed = true;
        this.onError?.(
          'audio_schedule_failed',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      if (!scheduledVoice && skippedVoice) {
        skippedCount += 1;
        if (skippedNoteIds.length < 5) skippedNoteIds.push(note.eventId);
      } else if (isLate && scheduledVoice) {
        lateCount += 1;
        if (lateNoteIds.length < 5) lateNoteIds.push(note.eventId);
      }
      if (scheduledVoice) {
        this.scheduledThroughMs = Math.max(this.scheduledThroughMs, note.atMs + note.durationMs);
      }
      this.nextIndex += 1;
    }

    if (lateCount > 0 || skippedCount > 0) {
      this.onUnderrun?.({
        lateCount,
        skippedCount,
        atPositionMs: nowSessionMs,
        lateNoteIds,
        skippedNoteIds,
      });
    }
  }
}
