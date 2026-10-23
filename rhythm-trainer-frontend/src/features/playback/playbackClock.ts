export type MappingQuality = 'GOOD' | 'ESTIMATED' | 'UNSTABLE' | 'UNKNOWN';

export interface AudioClockSource {
  currentTime(): number;
  state(): AudioContextState | 'unknown';
}

/**
 * A playback clock maps session-relative milliseconds to AudioContext time.
 * It is deliberately not a wall-clock timer: position comes from the audio
 * clock, and UI rendering only samples it.
 */
export interface PlaybackClock {
  readonly id: string;
  readonly mappingVersion: string;
  /** Re-anchor at an explicit session position (start/resume). */
  reset(positionMs: number): void;
  /** Re-anchor at an explicit audio time, used to align with the engine origin. */
  resetAt(positionMs: number, audioTime: number): void;
  currentPositionMs(): number;
  audioTimeForPosition(positionMs: number): number;
  quality(): MappingQuality;
  audioState(): AudioContextState | 'unknown';
}

let clockSeq = 0;

export class AudioPlaybackClock implements PlaybackClock {
  readonly id = `audio-clock-${++clockSeq}`;
  readonly mappingVersion = 'audio-context-performance-1';
  private audioAnchor = 0;
  private positionAnchor = 0;

  constructor(private readonly source: AudioClockSource, positionMs = 0) {
    this.reset(positionMs);
  }

  reset(positionMs: number): void {
    this.resetAt(positionMs, this.source.currentTime());
  }

  resetAt(positionMs: number, audioTime: number): void {
    this.audioAnchor = audioTime;
    this.positionAnchor = Math.max(0, positionMs);
  }

  currentPositionMs(): number {
    return Math.max(0, this.positionAnchor + (this.source.currentTime() - this.audioAnchor) * 1000);
  }

  audioTimeForPosition(positionMs: number): number {
    return this.audioAnchor + (positionMs - this.positionAnchor) / 1000;
  }

  quality(): MappingQuality {
    // The position and the sound both come from the same AudioContext. The
    // only mapping failure this layer can prove is that the context is no
    // longer running; wall-clock drift estimates are diagnostics, not a
    // reason to claim the audio clock itself is inaccurate.
    return this.source.state() === 'running' ? 'GOOD' : 'UNSTABLE';
  }

  audioState(): AudioContextState | 'unknown' {
    return this.source.state();
  }
}
