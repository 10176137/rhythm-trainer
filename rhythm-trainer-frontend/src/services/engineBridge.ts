// WebSocket bridge to the local engine service. The service hosts the Rust
// core; this client never scores anything itself. All times are session-
// relative milliseconds (performance.now() anchored at session start).

import type {
  EngineClientMessage,
  EngineProfile,
  EngineReportMessage,
  EngineScoringConfig,
  EngineServerMessage,
  EngineAtom,
  EngineJudgment,
  EngineNoteFeedback,
  EngineTarget,
  DurationEvaluationPolicy,
  EngineIngestMidiPacket,
  EngineScoreEvent,
  FollowEventMessage,
  FollowReportMessage,
  FollowStartRequest,
  FollowStartedMessage,
  PersistRetryResultMessage,
} from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { TeachingPrescription } from '../types/teaching';
import type { PlanMode, RustPlanResponse } from '../score-engine/plan/rust-plan';
import { bindPlanResponse } from '../score-engine/plan/rust-plan';

export interface PlannerStatus {
  authority: 'rts' | 'rust';
  plannerVersion: string;
  supportedModes: PlanMode[];
}

export interface PlanRequestInput {
  document: unknown;
  report: unknown;
  config: unknown;
  mode: PlanMode;
  /** Fingerprint this request is bound to (the score it was planned for). */
  scoreFingerprint: string;
  timeoutMs?: number;
}

const DEFAULT_PLAN_TIMEOUT_MS = 15000;

export interface EngineStartTiming {
  /** First note onset from the backend schedule, relative to the session origin. */
  firstTargetAtMs: number | null;
  countInMs: number;
}

export interface EngineHandlers {
  onStarted: (targets: EngineTarget[], bpm: number, profile: EngineProfile, captureEpoch?: number, scoringConfig?: EngineScoringConfig, timing?: EngineStartTiming) => void;
  onJudgments: (items: EngineJudgment[]) => void;
  onNoteFeedback?: (items: EngineNoteFeedback[]) => void;
  onPaused: () => void;
  onResumed: (deltaMs: number) => void;
  onReport: (message: EngineReportMessage) => void;
  onFollowStarted?: (message: FollowStartedMessage) => void;
  onFollowEvent?: (message: FollowEventMessage) => void;
  onFollowReport?: (message: FollowReportMessage) => void;
  onPersistRetryResult?: (message: PersistRetryResultMessage) => void;
  onError: (message: string) => void;
  onDisconnected: () => void;
}

export class EngineBridge {
  private socket: WebSocket | null = null;
  private handlers: EngineHandlers;
  private clockPingSeq = 0;
  /** In-flight plan requests keyed by requestId. */
  private pendingPlans = new Map<string, {
    resolve: (response: RustPlanResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    scoreFingerprint: string;
  }>();
  /** Requests that already settled (timeout/superseded): a late response for
   * one of these must never be delivered. */
  private settledPlans = new Set<string>();
  private pendingStatus: Array<{
    resolve: (status: PlannerStatus) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private pendingFollowStart: {
    resolve: (message: FollowStartedMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** In-flight persistence retries keyed by takeId. */
  private pendingRetries = new Map<string, {
    resolve: (message: PersistRetryResultMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private requestSeq = 0;

  constructor(handlers: EngineHandlers) {
    this.handlers = handlers;
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.startClockSync(this.socket);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        settled = true;
        this.socket = socket;
        this.startClockSync(socket);
        resolve();
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('无法连接本地引擎服务。请先运行 npm run server,再刷新页面。'));
        }
      };
      socket.onclose = () => {
        this.socket = null;
        this.rejectPendingPlans('PLANNER_UNAVAILABLE: 引擎服务已断开，计划请求失败');
        for (const [takeId, waiter] of this.pendingRetries) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('ENGINE_UNAVAILABLE: 引擎服务已断开，保存重试失败'));
          this.pendingRetries.delete(takeId);
        }
        this.handlers.onDisconnected();
      };
      socket.onmessage = (event) => {
        let message: EngineServerMessage;
        try {
          message = JSON.parse(event.data) as EngineServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'started':
            this.handlers.onStarted(
              message.targets,
              message.bpm,
              message.profile,
              message.captureEpoch,
              message.scoringConfig,
              {
                firstTargetAtMs: typeof message.firstTargetAtMs === 'number' && Number.isFinite(message.firstTargetAtMs)
                  ? message.firstTargetAtMs
                  : null,
                countInMs: Number.isFinite(message.countInMs) ? message.countInMs : 0,
              },
            );
            break;
          case 'judgments':
            this.handlers.onJudgments(message.items);
            if (message.noteFeedback?.length) this.handlers.onNoteFeedback?.(message.noteFeedback);
            break;
          case 'paused':
            this.handlers.onPaused();
            break;
          case 'resumed':
            this.handlers.onResumed(message.deltaMs);
            break;
          case 'clock-pong':
            this.send({ protocolVersion: 1, type: 'clock-sample', id: message.id, clientReceivePerfMs: performance.now() });
            break;
          case 'report':
            this.handlers.onReport(message);
            break;
          case 'follow-started': {
            const waiter = this.pendingFollowStart;
            this.pendingFollowStart = null;
            if (waiter) {
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            }
            this.handlers.onFollowStarted?.(message);
            break;
          }
          case 'follow-event':
            this.handlers.onFollowEvent?.(message);
            break;
          case 'follow-report':
            this.handlers.onFollowReport?.(message);
            break;
          case 'persist-retry-result': {
            const waiter = this.pendingRetries.get(message.takeId);
            if (waiter) {
              this.pendingRetries.delete(message.takeId);
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            }
            this.handlers.onPersistRetryResult?.(message);
            break;
          }
          case 'error': {
            // A failed follow-start has no dedicated error frame; reject the
            // pending start so the launch path can surface one message and
            // clear its optimistic UI. Other errors stay in the normal
            // onError channel.
            const waiter = this.pendingFollowStart;
            if (waiter) {
              this.pendingFollowStart = null;
              clearTimeout(waiter.timer);
              waiter.reject(new Error(message.message));
              break;
            }
            this.handlers.onError(message.message);
            break;
          }
          case 'planner-status': {
            const waiter = this.pendingStatus.shift();
            if (waiter) {
              clearTimeout(waiter.timer);
              waiter.resolve({
                authority: message.authority,
                plannerVersion: message.plannerVersion,
                supportedModes: message.supportedModes,
              });
            }
            break;
          }
          case 'plan-response': {
            this.handlePlanResponse(message);
            break;
          }
          default:
            break;
        }
      };
    });
  }

  private rejectPendingPlans(message: string) {
    for (const [requestId, pending] of this.pendingPlans) {
      clearTimeout(pending.timer);
      this.settledPlans.add(requestId);
      pending.reject(new Error(message));
    }
    this.pendingPlans.clear();
    for (const waiter of this.pendingStatus) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.pendingStatus = [];
    if (this.pendingFollowStart) {
      clearTimeout(this.pendingFollowStart.timer);
      this.pendingFollowStart.reject(new Error(message));
      this.pendingFollowStart = null;
    }
  }

  /** Routes a plan-response strictly by requestId; anything unknown or
   * already-settled (timeout/superseded) is DROPPED, so a late response can
   * never overwrite a newer request's result. The accept/reject rule itself
   * is the pure `bindPlanResponse` shared with the tests. */
  private handlePlanResponse(message: {
    requestId: string | null;
    ok: boolean;
    scoreFingerprint?: string;
    error?: { code?: string; message?: string };
  } & Record<string, unknown>) {
    const requestId = typeof message.requestId === 'string' ? message.requestId : null;
    const pending = requestId ? this.pendingPlans.get(requestId) ?? null : null;
    const decision = bindPlanResponse(message, pending
      ? { scoreFingerprint: pending.scoreFingerprint }
      : null);
    if (decision.action === 'drop') {
      if (requestId) this.settledPlans.add(requestId);
      return;
    }
    if (!pending || !requestId) return;
    this.pendingPlans.delete(requestId);
    this.settledPlans.add(requestId);
    clearTimeout(pending.timer);
    if (decision.action === 'reject') {
      pending.reject(new Error(`${decision.code}: ${decision.message}`));
      return;
    }
    pending.resolve(decision.response);
  }

  /** Asks the server which planner authority is actually active. The browser
   * keeps NO second switch — this answer is the single source of truth. */
  requestPlannerStatus(timeoutMs = 4000): Promise<PlannerStatus> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('PLANNER_STATUS_UNAVAILABLE: 引擎服务未连接'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingStatus = this.pendingStatus.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`PLANNER_STATUS_TIMEOUT: ${timeoutMs}ms 内未收到规划权威状态`));
      }, timeoutMs);
      this.pendingStatus.push({ resolve, reject, timer });
      this.send({ protocolVersion: 1, type: 'planner-status' } as never);
    });
  }

  /** Sends a plan request bound to one score fingerprint and one mode.
   * Rejections are coded (PLAN_TIMEOUT / PLAN_RESPONSE_MISMATCH / the
   * server's own frozen code) — the caller must fail the launch, never fall
   * back to another planner. */
  requestPlan(input: PlanRequestInput): Promise<RustPlanResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('PLANNER_UNAVAILABLE: 引擎服务未连接，无法请求 Rust 计划'));
        return;
      }
      this.requestSeq += 1;
      const requestId = `plan-${this.requestSeq}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = input.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (this.pendingPlans.delete(requestId)) {
          this.settledPlans.add(requestId); // a late answer for this id is dropped
          reject(new Error(`PLAN_TIMEOUT: 计划请求超时（${timeoutMs}ms）`));
        }
      }, timeoutMs);
      this.pendingPlans.set(requestId, { resolve, reject, timer, scoreFingerprint: input.scoreFingerprint });
      this.send({
        protocolVersion: 1,
        type: 'plan-request',
        requestId,
        mode: input.mode,
        document: input.document,
        report: input.report,
        config: input.config,
      } as never);
    });
  }

  /**
   * Starts the server-authoritative Follow runtime. The plan context may be a
   * server-issued Rust plan (`planRequestId`) or the validated default-rts
   * projection (`groups`); the server decides and records which one it used.
   * Resolves only on `follow-started`, so a rejected start never leaves the
   * UI believing a session exists.
   */
  startFollow(input: Omit<FollowStartRequest, 'type'>, timeoutMs = 10000): Promise<FollowStartedMessage> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ENGINE_UNAVAILABLE: 引擎服务未连接，无法开始跟手练习'));
        return;
      }
      if (this.pendingFollowStart) {
        const previous = this.pendingFollowStart;
        this.pendingFollowStart = null;
        clearTimeout(previous.timer);
        previous.reject(new Error('FOLLOW_START_SUPERSEDED: 新的跟手启动取代了上一次'));
      }
      const timer = setTimeout(() => {
        if (this.pendingFollowStart?.timer === timer) {
          this.pendingFollowStart = null;
          reject(new Error(`FOLLOW_START_TIMEOUT: ${timeoutMs}ms 内未收到跟手启动确认`));
        }
      }, timeoutMs);
      this.pendingFollowStart = { resolve, reject, timer };
      this.send({ ...input, type: 'follow-start', protocolVersion: 1 } as never);
    });
  }

  followNote(note: number, atMs: number) {
    this.send({ type: 'follow-note', note, atMs });
  }

  followPause(atMs?: number) {
    this.send({ type: 'follow-pause', ...(atMs != null ? { atMs } : {}) });
  }

  followResume(atMs?: number) {
    this.send({ type: 'follow-resume', ...(atMs != null ? { atMs } : {}) });
  }

  followFinish() {
    this.send({ type: 'follow-finish' });
  }

  followAbandon() {
    this.send({ type: 'follow-abandon' });
  }

  /**
   * Retries persistence of a frozen but unsaved Take draft. The server keeps
   * the same takeId and idempotent write semantics, so this can be called after
   * a failure or from a reconnected socket.
   */
  retryPersist(takeId: string, timeoutMs = 5000): Promise<PersistRetryResultMessage> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('ENGINE_UNAVAILABLE: 引擎服务未连接，无法重试保存'));
        return;
      }
      const existing = this.pendingRetries.get(takeId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error('RETRY_SUPERSEDED: 新的重试请求取代了上一次'));
        this.pendingRetries.delete(takeId);
      }
      const timer = setTimeout(() => {
        if (this.pendingRetries.get(takeId)?.timer === timer) {
          this.pendingRetries.delete(takeId);
          reject(new Error(`RETRY_TIMEOUT: ${timeoutMs}ms 内未收到保存结果`));
        }
      }, timeoutMs);
      this.pendingRetries.set(takeId, { resolve, reject, timer });
      this.send({ type: 'persist-retry', takeId });
    });
  }

  /** 10 lightweight four-timestamp samples; the server keeps the low-RTT one. */
  private startClockSync(socket: WebSocket) {    for (let index = 0; index < 10; index += 1) {
      window.setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        this.clockPingSeq += 1;
        const id = `clock-${this.clockPingSeq}-${Math.random().toString(36).slice(2, 8)}`;
        socket.send(JSON.stringify({ protocolVersion: 1, type: 'clock-ping', id, clientSendPerfMs: performance.now() }));
      }, index * 12);
    }
  }

  /** Browser performance time at session 0, used to map Node MIDI capture time. */
  sessionOrigin(clientPerfMs: number) {
    this.send({ protocolVersion: 1, type: 'session-origin', clientPerfMs });
  }

  private send(message: EngineClientMessage) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  start(request: {
    modeId: string;
    bpm: number;
    profile: EngineProfile;
    countInBeats: number;
    ticksPerQuarter: number;
    atoms: EngineAtom[];
    scoreEvents?: EngineScoreEvent[];
    assisted?: boolean;
    durationPolicy?: DurationEvaluationPolicy;
    scoreFingerprint?: string;
    playbackPlanId?: string;
    planRequestId?: string;
    scoreId?: string;
    configSnapshot?: Record<string, unknown>;
    plannerAuthority?: 'rts' | 'rust';
    plannerVersion?: string;
    planFingerprint?: string;
    scoreImportStatus?: string;
    hand?: HandSelection;
    scoreBarCount?: number;
    sourceReportId?: string;
    sourceTakeId?: string;
    prescriptionId?: string;
    prescription?: TeachingPrescription;
    takeTemplateId?: string;
  }) {
    // Preserve the selected feedback mode from the same frozen launch config.
    // Without this field the server defaults to live, even for a baseline test.
    const feedback = request.configSnapshot?.feedback;
    this.send({ type: 'start', ...request, ...(['live', 'after'].includes(String(feedback)) ? { feedback: feedback as 'live' | 'after' } : {}) });
  }

  hit(seq: number, atMs: number, notes: number[]) {
    this.send({ type: 'hit', seq, atMs, notes });
  }

  /** v0.3 raw note event for key-down duration pairing (never scored live). */
  /** v0.6 authoritative input: raw packet + clock mapping (decoded in Rust). */
  sendRawMidi(ingest: EngineIngestMidiPacket) {
    this.send({ type: 'raw-midi', ingest });
  }

  /** v0.3 legacy path — superseded by sendRawMidi; kept for old clients. */
  noteEvent(seq: number, atMs: number, kind: 'note-on' | 'note-off', pitch: number, velocity?: number) {
    if (kind === 'note-on') {
      this.send({ type: 'note-on', seq, atMs, pitch, velocity });
    } else {
      this.send({ type: 'note-off', seq, atMs, pitch });
    }
  }

  tick(nowMs: number) {
    this.send({ type: 'tick', nowMs });
  }

  pause(nowMs: number, atSourceMs?: number) {
    this.send({ type: 'pause', nowMs, ...(atSourceMs != null ? { atSourceMs } : {}) });
  }

  resume(nowMs: number, atSourceMs?: number) {
    this.send({ type: 'resume', nowMs, ...(atSourceMs != null ? { atSourceMs } : {}) });
  }

  finish() {
    this.send({ type: 'finish' });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}
