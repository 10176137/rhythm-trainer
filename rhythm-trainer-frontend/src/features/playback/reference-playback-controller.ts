import type { PlaybackAudioEngine } from './audioEngineAdapter';
import { AudioPlaybackClock, type MappingQuality, type PlaybackClock } from './playbackClock';
import { ReferencePlaybackScheduler, type SchedulerUnderrun } from './reference-playback-scheduler';
import type { ReferencePlaybackPlan } from '../../score-engine/playback/reference-playback-plan';
import { validateReferencePlanAgainstTargets } from '../../score-engine/playback/reference-playback-plan';

export type ReferencePlaybackStatus =
  | 'IDLE'
  | 'PREPARING'
  | 'COUNT_IN'
  | 'PLAYING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'STOPPED'
  | 'FAILED';

export type PlaybackHealth = 'HEALTHY' | 'DEGRADED' | 'INVALID' | 'UNKNOWN';

export interface PlaybackDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  playbackRunId: string;
  referenceTimeMs?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface PlaybackSnapshot {
  playbackRunId: string;
  status: ReferencePlaybackStatus;
  health: PlaybackHealth;
  positionMs: number;
  positionBeat: number;
  measureIndex: number;
  referenceTimeMs: number;
  scheduledThroughTimeMs: number;
  clockId: string;
  mappingVersion: string;
  mappingQuality: MappingQuality;
  currentOccurrenceId?: string;
  activeScoreEventIds: string[];
  errorCode?: string;
}

export interface ReferencePlaybackStartOptions {
  startAtMs?: number;
  /** performance.now() at the engine session origin (target atMs = 0). */
  originPerfMs?: number;
  /** Optional engine targets used to verify the shared timeline contract. */
  engineTargets?: readonly { atMs: number; bar: number | null }[];
}

export interface ReferencePlaybackControllerOptions {
  audio: PlaybackAudioEngine;
  onDiagnostic?: (diagnostic: PlaybackDiagnostic) => void;
  /** Called after the controller pauses itself because the AudioContext stopped. */
  onAudioSuspended?: () => void;
  schedulerOptions?: {
    lookAheadMs?: number;
    lateToleranceMs?: number;
  };
}

const TICK_MS = 25;
const SNAPSHOT_THROTTLE_MS = 50;

let runSeq = 0;

/**
 * Owns one reference-playback run. It is deliberately independent of React
 * and of the Rust Take: the app feeds it the shared ReferencePlaybackPlan, and
 * it publishes snapshots/diagnostics. Audio time is the only note clock.
 */
export class ReferencePlaybackController {
  private readonly audio: PlaybackAudioEngine;
  private readonly onDiagnostic?: (diagnostic: PlaybackDiagnostic) => void;
  private readonly onAudioSuspended?: () => void;
  private readonly schedulerOptions: ReferencePlaybackControllerOptions['schedulerOptions'];
  private plan: ReferencePlaybackPlan | null = null;
  private clock: PlaybackClock | null = null;
  private scheduler: ReferencePlaybackScheduler | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runId = '';
  private status: ReferencePlaybackStatus = 'IDLE';
  private health: PlaybackHealth = 'UNKNOWN';
  private positionMs = 0;
  private errorCode: string | undefined;
  private diagnostics: PlaybackDiagnostic[] = [];
  private listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private diagnosticListeners = new Set<(diagnostic: PlaybackDiagnostic) => void>();
  private lastSnapshot: PlaybackSnapshot | null = null;
  private lastEmitAt = 0;
  private warnedCodes = new Set<string>();

  constructor(options: ReferencePlaybackControllerOptions) {
    this.audio = options.audio;
    this.onDiagnostic = options.onDiagnostic;
    this.onAudioSuspended = options.onAudioSuspended;
    this.schedulerOptions = options.schedulerOptions;
  }

  get active(): boolean {
    return this.status === 'PREPARING' || this.status === 'COUNT_IN' || this.status === 'PLAYING' || this.status === 'PAUSED';
  }

  get playbackRunId(): string {
    return this.runId;
  }

  getPlan(): ReferencePlaybackPlan | null {
    return this.plan;
  }

  getDiagnostics(): readonly PlaybackDiagnostic[] {
    return this.diagnostics;
  }

  getSnapshot(): PlaybackSnapshot {
    return this.lastSnapshot ?? this.buildSnapshot();
  }

  /** Mute/unmute reference audio without touching the playback timeline. */
  setGain(value: number): void {
    this.audio.setGain(value);
  }

  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDiagnostics(listener: (diagnostic: PlaybackDiagnostic) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  async start(plan: ReferencePlaybackPlan, options: ReferencePlaybackStartOptions = {}): Promise<void> {
    if (this.active) this.stop('replaced');
    this.plan = plan;
    this.runId = `playback-${Date.now()}-${++runSeq}`;
    const runId = this.runId;
    this.status = 'PREPARING';
    this.health = 'HEALTHY';
    this.errorCode = undefined;
    this.diagnostics = [];
    this.warnedCodes.clear();
    this.positionMs = Math.max(0, options.startAtMs ?? 0);
    this.lastSnapshot = null;
    this.emitDiagnostic('reference_playback.prepare_started', 'info', '准备参考播放');
    this.emitSnapshot(true);

    if (!plan.strictAllowed) {
      this.fail('reference_playback.plan_blocked', '参考播放计划被阻断：' + (plan.issues[0]?.message ?? '未知原因'));
      return;
    }
    if (options.engineTargets) {
      const mismatch = validateReferencePlanAgainstTargets(plan, options.engineTargets);
      if (mismatch.length) {
        this.fail(
          'reference_playback.target_plan_mismatch',
          `参考播放与评分目标不一致：${mismatch.join('；')}`,
          { mismatch },
        );
        return;
      }
    }

    try {
      await this.audio.prepare();
    } catch (error) {
      this.fail(
        'reference_playback.instrument_load_failed',
        `音频引擎/音色准备失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.runId !== runId || this.status !== 'PREPARING') return;
    this.emitDiagnostic('reference_playback.prepare_completed', 'info', '音频引擎准备完成');

    this.clock = new AudioPlaybackClock(this.audio, this.positionMs);
    const preparedAtPerfMs = performance.now();
    const preparedAudioTime = this.audio.currentTime();
    const originPerfMs = options.originPerfMs;
    const audioAtOrigin = originPerfMs != null && Number.isFinite(originPerfMs)
      ? preparedAudioTime - (preparedAtPerfMs - originPerfMs) / 1000
      : preparedAudioTime;
    this.clock.resetAt(this.positionMs, audioAtOrigin + this.positionMs / 1000);
    this.scheduler = new ReferencePlaybackScheduler(plan, this.clock, this.audio, {
      ...this.schedulerOptions,
      onUnderrun: (event) => this.handleUnderrun(event),
      onError: (code, message) => this.fail(code, message),
    });
    this.scheduler.begin(this.positionMs);
    this.status = this.positionMs < plan.countInMs - 0.5 ? 'COUNT_IN' : 'PLAYING';
    this.startTicker();
    this.emitDiagnostic('reference_playback.started', 'info', '参考播放开始', {
      startAtMs: this.positionMs,
      targetCount: plan.notes.length,
      hand: plan.hand,
    });
    this.emitSnapshot(true);
    this.checkCompletion();
  }

  pause(reason = 'user'): void {
    if (this.status !== 'PLAYING' && this.status !== 'COUNT_IN') return;
    if (this.clock) this.positionMs = this.clock.currentPositionMs();
    this.stopTicker();
    this.audio.allNotesOff(`pause:${reason}`);
    this.status = 'PAUSED';
    this.emitDiagnostic('reference_playback.paused', 'info', '参考播放已暂停', { reason, positionMs: this.positionMs });
    this.emitDiagnostic('reference_playback.all_notes_off', 'info', '暂停时清除所有发声音符', { reason });
    this.emitSnapshot(true);
  }

  async resume(): Promise<void> {
    if (this.status !== 'PAUSED' || !this.plan) return;
    try {
      await this.audio.prepare();
    } catch (error) {
      this.fail(
        'reference_playback.instrument_load_failed',
        `恢复参考播放失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.status !== 'PAUSED' || !this.plan) return;
    this.errorCode = undefined;
    this.clock = new AudioPlaybackClock(this.audio, this.positionMs);
    this.scheduler = new ReferencePlaybackScheduler(this.plan, this.clock, this.audio, {
      ...this.schedulerOptions,
      onUnderrun: (event) => this.handleUnderrun(event),
      onError: (code, message) => this.fail(code, message),
    });
    this.scheduler.begin(this.positionMs);
    this.status = this.positionMs < this.plan.countInMs - 0.5 ? 'COUNT_IN' : 'PLAYING';
    this.startTicker();
    this.emitDiagnostic('reference_playback.resumed', 'info', '参考播放已继续', { positionMs: this.positionMs });
    this.emitSnapshot(true);
  }

  stop(reason = 'user'): void {
    if (this.status === 'IDLE' || this.status === 'STOPPED') return;
    if (this.clock && (this.status === 'PLAYING' || this.status === 'COUNT_IN')) {
      this.positionMs = this.clock.currentPositionMs();
    }
    this.stopTicker();
    this.audio.allNotesOff(`stop:${reason}`);
    this.status = 'STOPPED';
    this.emitDiagnostic('reference_playback.stopped', 'info', '参考播放已停止', { reason, positionMs: this.positionMs });
    this.emitDiagnostic('reference_playback.all_notes_off', 'info', '停止时清除所有发声音符', { reason });
    this.emitSnapshot(true);
  }

  complete(): void {
    if (this.status === 'COMPLETED' || this.status === 'STOPPED' || this.status === 'FAILED') return;
    this.stopTicker();
    this.audio.allNotesOff('completed');
    this.status = 'COMPLETED';
    this.emitDiagnostic('reference_playback.completed', 'info', '参考播放完成', { positionMs: this.positionMs });
    this.emitDiagnostic('reference_playback.all_notes_off', 'info', '完成时清除所有发声音符', { reason: 'completed' });
    this.emitSnapshot(true);
  }

  dispose(): void {
    this.stop('dispose');
    this.audio.dispose();
    this.listeners.clear();
    this.diagnosticListeners.clear();
    this.status = 'IDLE';
  }

  private startTicker(): void {
    this.stopTicker();
    const runId = this.runId;
    this.timer = setInterval(() => this.tick(runId), TICK_MS);
  }

  private stopTicker(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(runId: string): void {
    if (runId !== this.runId) return;
    if (this.status !== 'PLAYING' && this.status !== 'COUNT_IN') return;
    if (!this.clock || !this.scheduler || !this.plan) return;

    if (this.clock.audioState() !== 'running') {
      this.errorCode = 'AUDIO_CONTEXT_SUSPENDED';
      this.health = 'DEGRADED';
      this.emitDiagnosticOnce(
        'reference_playback.clock_mapping_degraded',
        'warning',
        '音频时钟已挂起；播放停在可恢复位置。',
        { state: this.clock.audioState() },
      );
      this.pause('audio-context-suspended');
      this.onAudioSuspended?.();
      return;
    }

    this.scheduler.pump();
    if ((this.status as ReferencePlaybackStatus) === 'FAILED') return;
    this.positionMs = this.clock.currentPositionMs();
    if (this.status === 'COUNT_IN' && this.positionMs >= this.plan.countInMs - 0.5) {
      this.status = 'PLAYING';
      this.emitSnapshot(true);
    }
    const quality = this.clock.quality();
    if (quality === 'UNSTABLE') {
      this.health = this.health === 'INVALID' ? this.health : 'DEGRADED';
      this.emitDiagnosticOnce(
        'reference_playback.clock_mapping_degraded',
        'warning',
        '播放时钟质量不稳定；同步评分应降级。',
        { quality, clockId: this.clock.id },
      );
    }
    this.checkCompletion();
    this.emitSnapshot(false);
  }

  private checkCompletion(): void {
    if (!this.plan || !this.scheduler) return;
    if (this.status !== 'PLAYING' && this.status !== 'COUNT_IN') return;
    if (this.positionMs < this.plan.lastEndMs - 0.5) return;
    if (this.scheduler.scheduledIndex < this.plan.notes.length) return;
    this.complete();
  }

  private handleUnderrun(event: SchedulerUnderrun): void {
    this.health = this.health === 'INVALID' ? this.health : 'DEGRADED';
    this.emitDiagnostic(
      'reference_playback.scheduler_underrun',
      'warning',
      `调度欠载：${event.lateCount} 个音晚起，${event.skippedCount} 个音已完全错过。`,
      {
        lateCount: event.lateCount,
        skippedCount: event.skippedCount,
        atPositionMs: event.atPositionMs,
        lateNoteIds: event.lateNoteIds,
        skippedNoteIds: event.skippedNoteIds,
      },
    );
  }

  private fail(code: string, message: string, details?: Record<string, unknown>): void {
    this.stopTicker();
    this.audio.allNotesOff('failed');
    this.status = 'FAILED';
    this.health = 'INVALID';
    this.errorCode = code;
    this.emitDiagnostic(code, 'error', message, details);
    this.emitSnapshot(true);
  }

  private emitDiagnostic(
    code: string,
    severity: PlaybackDiagnostic['severity'],
    message: string,
    details?: Record<string, unknown>,
  ): void {
    const diagnostic: PlaybackDiagnostic = {
      code,
      severity,
      playbackRunId: this.runId,
      referenceTimeMs: this.positionMs,
      message,
      ...(details ? { details } : {}),
    };
    this.diagnostics = [...this.diagnostics.slice(-99), diagnostic];
    this.onDiagnostic?.(diagnostic);
    for (const listener of this.diagnosticListeners) listener(diagnostic);
  }

  private emitDiagnosticOnce(
    code: string,
    severity: PlaybackDiagnostic['severity'],
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (this.warnedCodes.has(code)) return;
    this.warnedCodes.add(code);
    this.emitDiagnostic(code, severity, message, details);
  }

  private buildSnapshot(): PlaybackSnapshot {
    const quality = this.clock?.quality() ?? 'UNKNOWN';
    const note = this.findCurrentNote(this.positionMs);
    return {
      playbackRunId: this.runId,
      status: this.status,
      health: this.health,
      positionMs: this.positionMs,
      positionBeat: this.positionBeat(this.positionMs),
      measureIndex: note?.bar ?? 0,
      referenceTimeMs: this.positionMs,
      scheduledThroughTimeMs: this.scheduler?.scheduledThrough ?? this.positionMs,
      clockId: this.clock?.id ?? 'none',
      mappingVersion: this.clock?.mappingVersion ?? 'none',
      mappingQuality: quality,
      ...(note?.occurrenceIds[0] ? { currentOccurrenceId: note.occurrenceIds[0] } : {}),
      activeScoreEventIds: note ? [...note.activeScoreEventIds] : [],
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    };
  }

  private emitSnapshot(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastEmitAt < SNAPSHOT_THROTTLE_MS) return;
    this.lastEmitAt = now;
    this.lastSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.lastSnapshot);
  }

  private findCurrentNote(positionMs: number) {
    if (!this.plan || this.plan.notes.length === 0) return null;
    let low = 0;
    let high = this.plan.notes.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.plan.notes[mid].atMs <= positionMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found < 0 ? null : this.plan.notes[found];
  }

  private positionBeat(positionMs: number): number {
    if (!this.plan) return 0;
    const played = positionMs - this.plan.countInMs;
    return Math.max(0, played / (60_000 / this.plan.bpm));
  }
}
