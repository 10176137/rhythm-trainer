// Centralized practice-session state machine wired to the engine service.
//
// Status transitions (guarded, single owner — see DESIGN.md §6):
//   idle -> countdown -> running <-> paused -> processing -> completed
// Any active state can go back to idle via reset(). The hook never derives
// truth from scattered booleans; components read `status`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineBridge } from '../../services/engineBridge';
import type { PlanRequestInput, PlannerStatus } from '../../services/engineBridge';
import type { RustPlanResponse } from '../../score-engine/plan/rust-plan';
import type { EngineNoteFeedback, DurationEvaluationPolicy, EngineAtom, EngineCaptureDiagnostics, EngineDurationReport, EngineIngestMidiPacket, EngineProfile, EngineJudgment, EngineReport, EngineScoringConfig, EngineScoreEvent, EngineSessionScoreReport, EngineScoreStatus, EngineTarget, EngineTimingAnalysis, FollowEventMessage, FollowReportMessage, FollowStartRequest, FollowStartedMessage, PersistRetryResultMessage } from '../../types/engine';
import type { HandSelection, SessionStatus } from '../../types/practice';
import type { RetryComparison, TeachingPrescription } from '../../types/teaching';
import { Metronome, buildBeatClicks } from './metronome';
import { toSessionMs } from './sessionTime';

export interface PracticeTarget extends EngineTarget {
  /** Display/audible time, shifted by pause deltas (core shifts the same set). */
  displayAtMs: number;
}

export interface SessionLiveStats {
  total: number;
  resolved: number;
  matched: number;
  perfect: number;
  good: number;
  miss: number;
  extra: number;
}

export interface BeginRequest {
  modeId: string;
  bpm: number;
  profile: EngineProfile;
  countInBeats: number;
  /** The single authoritative count-in value in microseconds (defaults to 3s). */
  countInUs?: number;
  ticksPerQuarter: number;
  atoms: EngineAtom[];
  /** Per-note final-score events from the same PlaybackPlan. */
  scoreEvents?: EngineScoreEvent[];
  /** False disables click scheduling without changing the engine timeline. */
  metronomeEnabled?: boolean;
  /** Quarter-note beats per bar, used for the metronome accent. */
  beatsPerBar?: number;
  /** True when live cues/feedback assist the attempt (recorded in history). */
  assisted?: boolean;
  /** v0.3 key-down duration evaluation policy. */
  durationPolicy?: DurationEvaluationPolicy;
  scoreFingerprint?: string;
  playbackPlanId?: string;
  /** R2-3i/domain: server-trusted plan context and record context. */
  planRequestId?: string;
  scoreId?: string;
  configSnapshot?: Record<string, unknown>;
  /** R2-3i: provenance of the plan that produced this Take. */
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
}

export interface UsePracticeSessionOptions {
  onJudgment?: (judgment: EngineJudgment) => void;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
  /** Fired when the engine has fixed the session origin and target list. */
  onStarted?: (info: {
    originPerfMs: number;
    targets: PracticeTarget[];
    bpm: number;
    countInBeats: number;
  }) => void;
  /** Client-side lookup for the expected pitch of a target (hint only). */
  expectedNotesFor?: (targetIndex: number) => { midiNote: number; noteName: string }[] | null;
  /** Server-authoritative Follow events; the UI only renders them. */
  onFollowStarted?: (message: FollowStartedMessage) => void;
  onFollowEvent?: (message: FollowEventMessage) => void;
  onFollowReport?: (message: FollowReportMessage) => void;
  /** The engine connection dropped while a Follow Take was live. */
  onFollowAborted?: (message: string) => void;
  /** R2-3h-R1: the engine socket closed — any cached planner authority is
   * stale and must be discarded by the caller. */
  onEngineDisconnected?: () => void;
}

const TICK_INTERVAL_MS = 50;

export function usePracticeSession(options: UsePracticeSessionOptions = {}) {
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [targets, setTargets] = useState<PracticeTarget[]>([]);
  /** Backend-authoritative first-note time for the countdown overlay. */
  const [firstTargetAtMs, setFirstTargetAtMs] = useState<number | null>(null);
  const [countInMs, setCountInMs] = useState<number | null>(null);
  const [noteFeedback, setNoteFeedback] = useState<EngineNoteFeedback[]>([]);
  const [judgments, setJudgments] = useState<EngineJudgment[]>([]);
  const [report, setReport] = useState<EngineReport | null>(null);
  const [analysis, setAnalysis] = useState<EngineTimingAnalysis | { error: string } | null>(null);
  const [durations, setDurations] = useState<EngineDurationReport | { error: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [takeId, setTakeId] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [scoreFingerprint, setScoreFingerprint] = useState<string | null>(null);
  const [hand, setHand] = useState<HandSelection | null>(null);
  const [scoreBarCount, setScoreBarCount] = useState<number | null>(null);
  const [sourceReportId, setSourceReportId] = useState<string | null>(null);
  const [sourceTakeId, setSourceTakeId] = useState<string | null>(null);
  const [prescriptionId, setPrescriptionId] = useState<string | null>(null);
  const [prescription, setPrescription] = useState<TeachingPrescription | null>(null);
  const [takeTemplateId, setTakeTemplateId] = useState<string | null>(null);
  const [takeTemplateName, setTakeTemplateName] = useState<string | null>(null);
  const [retryComparison, setRetryComparison] = useState<RetryComparison | null>(null);
  const [scoringConfig, setScoringConfig] = useState<EngineScoringConfig | null>(null);
  const [captureDiagnostics, setCaptureDiagnostics] = useState<EngineCaptureDiagnostics | null>(null);
  const [reportPersisted, setReportPersisted] = useState<boolean | null>(null);
  const [reportPersistenceError, setReportPersistenceError] = useState<string | null>(null);
  const [scoreV1, setScoreV1] = useState<EngineSessionScoreReport | { error: string } | null>(null);
  const [scoreStatus, setScoreStatus] = useState<EngineScoreStatus | null>(null);
  const [scoreConfigVersion, setScoreConfigVersion] = useState<string | null>(null);
  const [scoreAlgorithmVersion, setScoreAlgorithmVersion] = useState<string | null>(null);
  const [scoreInputNoteCount, setScoreInputNoteCount] = useState(0);
  const [scoreUnmappedNoteCount, setScoreUnmappedNoteCount] = useState(0);
  const [pauseAdjusted, setPauseAdjusted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bridgeRef = useRef<EngineBridge | null>(null);
  const metronomeRef = useRef<Metronome | null>(null);
  const originRef = useRef<number | null>(null);
  const captureEpochRef = useRef<number | null>(null);
  /** A server-side Follow Take is live (start accepted, report not yet seen). */
  const followActiveRef = useRef(false);
  const seqRef = useRef(0);
  const targetsRef = useRef<PracticeTarget[]>([]);
  const tickTimerRef = useRef<number | null>(null);
  const statusRef = useRef<SessionStatus>('idle');
  const takeIdRef = useRef<string | null>(null);  const engineActiveRef = useRef(false);
  const bpmRef = useRef(80);
  const metronomeEnabledRef = useRef(true);
  const barBeatsRef = useRef(4);
  const countInBeatsRef = useRef(4);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  statusRef.current = status;

  const active = status === 'countdown' || status === 'running' || status === 'paused' || status === 'processing';

  const stopTickTimer = () => {
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  };

  const startTickTimer = useCallback((bridge: EngineBridge) => {
    stopTickTimer();
    tickTimerRef.current = window.setInterval(() => {
      if (originRef.current === null) return;
      if (statusRef.current === 'paused' || statusRef.current === 'processing' || statusRef.current === 'idle') return;
      const nowMs = performance.now() - originRef.current;
      bridge.tick(nowMs);
      const list = targetsRef.current;
      // Count-in ends when the first target's time arrives. Without this
      // the UI stays on "countdown" for the whole session (the engine
      // timeline advances independently), so feedback copy and status
      // pill never switch to running.
      if (statusRef.current === 'countdown' && list[0] && nowMs >= list[0].displayAtMs) {
        statusRef.current = 'running';
        setStatus('running');
      }
      // Do not auto-finalize after the last target. A player may start late,
      // pause, or need time to finish; only the explicit finish button (or a
      // disconnect finalization) closes the Take.
    }, TICK_INTERVAL_MS);
  }, []);

  const rescheduleMetronome = useCallback(() => {
    metronomeRef.current?.stopAll();
    const list = targetsRef.current;
    if (!metronomeEnabledRef.current || !metronomeRef.current || list.length === 0) return;
    const origin = originRef.current;
    if (origin === null) return;
    const nowMs = performance.now() - origin;
    const quarterMs = Math.max(60, 60_000 / bpmRef.current);
    const clicks = buildBeatClicks(
      list[0].displayAtMs,
      list[list.length - 1].displayAtMs,
      quarterMs,
      countInBeatsRef.current,
      barBeatsRef.current,
    ).filter((click) => click.atMs > nowMs);
    metronomeRef.current.schedule(clicks, origin);
  }, []);

  const ensureBridge = useCallback(() => {
    if (bridgeRef.current) return bridgeRef.current;
    const bridge = new EngineBridge({
      onStarted: (engineTargets, _bpm, _profile, captureEpoch, resolvedConfig, timing) => {
        originRef.current = performance.now();
        setScoringConfig(resolvedConfig ?? null);
        bridge.sessionOrigin(originRef.current);
        captureEpochRef.current = typeof captureEpoch === 'number' && Number.isFinite(captureEpoch)
          ? captureEpoch
          : null;
        seqRef.current = 0;
        engineActiveRef.current = true;
        const decorated: PracticeTarget[] = engineTargets.map((target) => ({ ...target, displayAtMs: target.atMs }));
        targetsRef.current = decorated;
        setTargets(decorated);
        setFirstTargetAtMs(timing?.firstTargetAtMs ?? decorated[0]?.atMs ?? null);
        setCountInMs(timing?.countInMs ?? null);
        setJudgments([]);
        setNoteFeedback([]);
        setReport(null);
        setSessionId(null);
        setTakeId(null);
        takeIdRef.current = null;
        setTraceId(null);
        setCaptureDiagnostics(null);
        setReportPersisted(null);
        setReportPersistenceError(null);
        setScoreV1(null);
        setScoreStatus(null);
        setScoreConfigVersion(null);
        setScoreAlgorithmVersion(null);
        setScoreInputNoteCount(0);
        setScoreUnmappedNoteCount(0);
        setPauseAdjusted(false);
        setScoreFingerprint(null);
        setHand(null);
        setScoreBarCount(null);
        setSourceReportId(null);
        setSourceTakeId(null);
        setPrescriptionId(null);
        setPrescription(null);
        setTakeTemplateId(null);
        setTakeTemplateName(null);
        setRetryComparison(null);
        setAnalysis(null);
        setDurations(null);
        setError(null);
        setStatus('countdown');
        metronomeRef.current?.stopAll();
        rescheduleMetronome();
        const startedOrigin = originRef.current;
        if (startedOrigin !== null) {
          optionsRef.current.onStarted?.({
            originPerfMs: startedOrigin,
            targets: decorated,
            bpm: bpmRef.current,
            countInBeats: countInBeatsRef.current,
          });
        }
        startTickTimer(bridge);
      },
      onNoteFeedback: (items) => {
        setNoteFeedback((previous) => {
          const merged = new Map(previous.map((item) => [item.scoreEventId, item]));
          for (const item of items) merged.set(item.scoreEventId, item);
          return [...merged.values()];
        });
      },
      onJudgments: (items) => {
        if (items.length === 0) return;
        setJudgments((prev) => [...prev, ...items]);
        for (const item of items) optionsRef.current.onJudgment?.(item);
      },
      onPaused: () => {
        stopTickTimer();
        metronomeRef.current?.stopAll();
        setStatus('paused');
      },
      onResumed: (deltaMs) => {
        // The core shifts unresolved targets by deltaMs; mirror that here so
        // display times and metronome stay aligned with the engine.
        targetsRef.current = targetsRef.current.map((target) => ({ ...target, displayAtMs: target.displayAtMs + deltaMs }));
        setTargets(targetsRef.current);
        setFirstTargetAtMs((previous) => previous === null ? null : previous + deltaMs);
        setStatus(targetsRef.current[0] && performance.now() - (originRef.current ?? 0) < targetsRef.current[0].displayAtMs
          ? 'countdown' : 'running');
        rescheduleMetronome();
        if (bridgeRef.current) startTickTimer(bridgeRef.current);
      },
      onReport: (message) => {
        stopTickTimer();
        metronomeRef.current?.stopAll();
        engineActiveRef.current = false;
        captureEpochRef.current = null;
        setReport(message.report);
        setAnalysis(message.analysis);
        setDurations(message.durations ?? null);
        setSessionId(message.sessionId ?? null);
        setTakeId(message.takeId ?? null);
        takeIdRef.current = message.takeId ?? null;
        setTraceId(message.traceId ?? null);
        setScoringConfig(message.scoringConfig ?? null);
        setCaptureDiagnostics(message.captureDiagnostics ?? null);
        setReportPersisted(message.persisted ?? null);
        setReportPersistenceError(message.persistenceError ?? null);
        setScoreV1(message.scoreV1 ?? null);
        setScoreStatus(message.scoreStatus ?? null);
        setScoreConfigVersion(message.scoreConfigVersion ?? null);
        setScoreAlgorithmVersion(message.scoreAlgorithmVersion ?? null);
        setScoreInputNoteCount(message.scoreInputNoteCount ?? 0);
        setScoreUnmappedNoteCount(message.scoreUnmappedNoteCount ?? 0);
        setPauseAdjusted(message.pauseAdjusted ?? false);
        setScoreFingerprint(message.scoreFingerprint ?? null);
        setHand(message.hand ?? null);
        setScoreBarCount(message.scoreBarCount ?? null);
        setSourceReportId(message.sourceReportId ?? null);
        setSourceTakeId(message.sourceTakeId ?? null);
        setPrescriptionId(message.prescriptionId ?? null);
        setPrescription(message.prescription ?? null);
        setTakeTemplateId(message.takeTemplateId ?? null);
        setTakeTemplateName(message.takeTemplateName ?? null);
        setRetryComparison(message.retryComparison ?? null);
        setStatus('completed');
      },
      onFollowStarted: (message) => {
        followActiveRef.current = true;
        optionsRef.current.onFollowStarted?.(message);
      },
      onFollowEvent: (message) => {
        optionsRef.current.onFollowEvent?.(message);
      },
      onFollowReport: (message) => {
        followActiveRef.current = false;
        optionsRef.current.onFollowReport?.(message);
      },
      onError: (message) => {
        stopTickTimer();
        setError(message);
        optionsRef.current.onError?.(message);
      },
      onDisconnected: () => {
        if (followActiveRef.current) {
          followActiveRef.current = false;
          optionsRef.current.onFollowAborted?.('与引擎服务的连接已断开，跟手练习已终止。');
        }
        if (originRef.current !== null && statusRef.current !== 'completed') {
          setStatus('idle');
          stopTickTimer();
          optionsRef.current.onError?.('与引擎服务的连接已断开,本次会话终止。');
        }
        originRef.current = null;
        captureEpochRef.current = null;
        // R2-3h-R1: the cached planner authority belonged to that connection.
        optionsRef.current.onEngineDisconnected?.();
      },
    });
    bridgeRef.current = bridge;
    return bridge;
  }, [rescheduleMetronome, startTickTimer]);

  const begin = useCallback(async (request: BeginRequest) => {
    if (active || followActiveRef.current) return;
    setError(null);
    bpmRef.current = request.bpm;
    metronomeEnabledRef.current = request.metronomeEnabled !== false;
    barBeatsRef.current = Math.max(1, request.beatsPerBar ?? 4);
    countInBeatsRef.current = Math.max(0, request.countInBeats);
    // AudioContext must already have been created/resumed inside the user
    // gesture by the caller. This ensure() is a best effort for retries.
    metronomeRef.current = metronomeRef.current ?? new Metronome();
    try {
      if (metronomeEnabledRef.current) metronomeRef.current.ensure();
      const bridge = ensureBridge();
      await bridge.connect();
      bridge.start({
        modeId: request.modeId,
        bpm: request.bpm,
        profile: request.profile,
        countInBeats: request.countInBeats,
        ...(request.countInUs !== undefined ? { countInUs: request.countInUs } : {}),
        ticksPerQuarter: request.ticksPerQuarter,
        atoms: request.atoms,
        scoreEvents: request.scoreEvents,
        durationPolicy: request.durationPolicy,
        assisted: request.assisted,
        scoreFingerprint: request.scoreFingerprint,
        playbackPlanId: request.playbackPlanId,
        planRequestId: request.planRequestId,
        scoreId: request.scoreId,
        configSnapshot: request.configSnapshot,
        plannerAuthority: request.plannerAuthority,
        plannerVersion: request.plannerVersion,
        planFingerprint: request.planFingerprint,
        scoreImportStatus: request.scoreImportStatus,
        hand: request.hand,
        scoreBarCount: request.scoreBarCount,
        sourceReportId: request.sourceReportId,
        sourceTakeId: request.sourceTakeId,
        prescriptionId: request.prescriptionId,
        prescription: request.prescription,
        takeTemplateId: request.takeTemplateId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动练习失败。';
      setError(message);
      optionsRef.current.onError?.(message);
    }
  }, [active, ensureBridge]);

  const pause = useCallback(() => {
    if (status !== 'countdown' && status !== 'running') return;
    if (originRef.current === null) return;
    stopTickTimer();
    metronomeRef.current?.stopAll();
    const sourceNow = performance.now();
    bridgeRef.current?.pause(sourceNow - originRef.current, sourceNow);
    setStatus('paused');
  }, [status]);

  const resume = useCallback(() => {
    if (status !== 'paused') return;
    if (originRef.current === null) return;
    const sourceNow = performance.now();
    bridgeRef.current?.resume(sourceNow - originRef.current, sourceNow);
    // status/positions update in onResumed
  }, [status]);

  const finish = useCallback(() => {
    if (status !== 'countdown' && status !== 'running' && status !== 'paused') return;
    setStatus('processing');
    stopTickTimer();
    metronomeRef.current?.stopAll();
    bridgeRef.current?.finish();
  }, [status]);

  const reset = useCallback(() => {
    stopTickTimer();
    metronomeRef.current?.stopAll();
    if (followActiveRef.current) {
      followActiveRef.current = false;
      bridgeRef.current?.followAbandon();
    }
    if (originRef.current !== null) {
      bridgeRef.current?.finish(); // archive whatever the session collected
    }
    originRef.current = null;
    captureEpochRef.current = null;
    engineActiveRef.current = false;
    targetsRef.current = [];
    setTargets([]);
    setFirstTargetAtMs(null);
    setCountInMs(null);
    setJudgments([]);
    setNoteFeedback([]);
    setReport(null);
    setSessionId(null);
    setTakeId(null);
    takeIdRef.current = null;
    setTraceId(null);
    setScoringConfig(null);
    setCaptureDiagnostics(null);
    setReportPersisted(null);
    setReportPersistenceError(null);
    setScoreV1(null);
    setScoreStatus(null);
    setScoreConfigVersion(null);
    setScoreAlgorithmVersion(null);
    setScoreInputNoteCount(0);
    setScoreUnmappedNoteCount(0);
    setPauseAdjusted(false);
    setScoreFingerprint(null);
    setHand(null);
    setScoreBarCount(null);
    setSourceReportId(null);
    setSourceTakeId(null);
    setPrescriptionId(null);
    setPrescription(null);
    setTakeTemplateId(null);
    setTakeTemplateName(null);
    setRetryComparison(null);
    setAnalysis(null);
    setDurations(null);
    setError(null);
    setStatus('idle');
  }, []);

  /** R2-3h: planner authority + plan requests go through the same bridge the
   * session uses. The browser never keeps its own switch. */
  const getPlannerStatus = useCallback(async (): Promise<PlannerStatus> => {
    const bridge = ensureBridge();
    await bridge.connect();
    return bridge.requestPlannerStatus();
  }, [ensureBridge]);

  const requestPlannerPlan = useCallback(async (
    input: Omit<PlanRequestInput, 'timeoutMs'> & { timeoutMs?: number },
  ): Promise<RustPlanResponse> => {
    const bridge = ensureBridge();
    await bridge.connect();
    return bridge.requestPlan(input);
  }, [ensureBridge]);

  /**
   * Follow's authoritative runtime lives on the engine service (Rust
   * NativeFollowRuntime). The browser sends the plan projection/context and
   * only renders the returned events and report.
   */
  const startFollow = useCallback(async (request: Omit<FollowStartRequest, 'type'>): Promise<FollowStartedMessage> => {
    if (active) throw new Error('已有进行中的时间线练习，无法开始跟手练习');
    const bridge = ensureBridge();
    await bridge.connect();
    followActiveRef.current = true;
    try {
      return await bridge.startFollow(request);
    } catch (error) {
      followActiveRef.current = false;
      throw error;
    }
  }, [active, ensureBridge]);

  const sendFollowNote = useCallback((note: number, atMs: number): boolean => {
    if (!followActiveRef.current) return false;
    if (!Number.isInteger(note) || note < 0 || note > 127) return false;
    if (!Number.isFinite(atMs) || atMs < 0) return false;
    bridgeRef.current?.followNote(note, atMs);
    return true;
  }, []);

  const pauseFollow = useCallback((atMs?: number) => {
    if (!followActiveRef.current) return;
    bridgeRef.current?.followPause(atMs);
  }, []);

  const resumeFollow = useCallback((atMs?: number) => {
    if (!followActiveRef.current) return;
    bridgeRef.current?.followResume(atMs);
  }, []);

  const finishFollow = useCallback(() => {
    if (!followActiveRef.current) return;
    bridgeRef.current?.followFinish();
  }, []);

  const abandonFollow = useCallback(() => {
    if (!followActiveRef.current) return;
    followActiveRef.current = false;
    bridgeRef.current?.followAbandon();
  }, []);

  /**
   * Retries persistence of a frozen, unsaved Take. The server keeps the same
   * takeId and only advances persistence state; the frozen report never changes.
   */
  const retryPersist = useCallback(async (targetTakeId: string): Promise<PersistRetryResultMessage> => {
    const bridge = bridgeRef.current;
    if (!bridge) throw new Error('引擎服务未连接，无法重试保存');
    const result = await bridge.retryPersist(targetTakeId);
    if (takeIdRef.current === targetTakeId) {
      setReportPersisted(result.persisted);
      setReportPersistenceError(result.persistenceError);
    }
    return result;
  }, []);

  /** Free play: a local recording session with no engine targets and no scoring. */
  const beginFreePlay = useCallback(() => {
    if (active) return;
    stopTickTimer();
    originRef.current = performance.now();
    captureEpochRef.current = null;
    seqRef.current = 0;
    engineActiveRef.current = false;
    targetsRef.current = [];
    setTargets([]);
    setFirstTargetAtMs(null);
    setCountInMs(null);
    setJudgments([]);
    setNoteFeedback([]);
    setReport(null);
    setSessionId(null);
    setTakeId(null);
    takeIdRef.current = null;
    setTraceId(null);
    setScoringConfig(null);
    setCaptureDiagnostics(null);
    setReportPersisted(null);
    setReportPersistenceError(null);
    setScoreV1(null);
    setScoreStatus(null);
    setScoreConfigVersion(null);
    setScoreAlgorithmVersion(null);
    setScoreInputNoteCount(0);
    setScoreUnmappedNoteCount(0);
    setPauseAdjusted(false);
    setScoreFingerprint(null);
    setHand(null);
    setScoreBarCount(null);
    setSourceReportId(null);
    setSourceTakeId(null);
    setPrescriptionId(null);
    setPrescription(null);
    setTakeTemplateId(null);
    setTakeTemplateName(null);
    setRetryComparison(null);
    setAnalysis(null);
    setDurations(null);
    setError(null);
    setStatus('running');
  }, [active]);

  const finishFreePlay = useCallback(() => {
    if (statusRef.current !== 'running') return;
    stopTickTimer();
    originRef.current = null;
    captureEpochRef.current = null;
    setStatus('completed');
  }, []);

  /**
   * v0.6 authoritative input: forwards a RawMidiPacket (with the session
   * clock mapping) to the engine service. The Rust core decodes and tracks;
   * the browser never decodes for scoring. Returns the mapped session time,
   * or null when the session is not accepting input.
   */
  const ingestPacket = useCallback((packet: EngineIngestMidiPacket['packet']): number | null => {
    if (status !== 'countdown' && status !== 'running') return null;
    if (originRef.current === null) return null;
    if (!engineActiveRef.current) return packet.capturedAtMs - originRef.current; // free play: local only
    const sessionTimeMs = toSessionMs(packet.capturedAtMs, originRef.current, packet.clockDomainId);
    if (sessionTimeMs === null) return null;
    const ingest: EngineIngestMidiPacket = {
      packet: { ...packet },
      sessionTimeMs,
      clockMappingId: 'web-performance-same-timeline',
      clockUncertaintyMs: 0,
      clockQuality: 'good',
    };
    bridgeRef.current?.sendRawMidi(ingest);
    return sessionTimeMs;
  }, [status]);

  useEffect(() => () => {
    stopTickTimer();
    metronomeRef.current?.close();
    bridgeRef.current?.close();
  }, []);

  const nextUnmatchedIndex = useMemo(() => {
    let next = 0;
    for (const judgment of judgments) {
      if (judgment.targetIndex !== null && judgment.targetIndex >= next) {
        next = judgment.targetIndex + 1;
      }
    }
    return next;
  }, [judgments]);

  const liveStats: SessionLiveStats = useMemo(() => {
    const stats: SessionLiveStats = { total: targets.length, resolved: 0, matched: 0, perfect: 0, good: 0, miss: 0, extra: 0 };
    for (const judgment of judgments) {
      if (judgment.targetIndex === null) {
        stats.extra += 1;
        continue;
      }
      stats.resolved += 1;
      if (judgment.grade === 'perfect') { stats.perfect += 1; stats.matched += 1; }
      else if (judgment.grade === 'good') { stats.good += 1; stats.matched += 1; }
      else if (judgment.grade === 'miss') stats.miss += 1;
    }
    return stats;
  }, [judgments, targets.length]);

  /** Client-side pitch hint only; the engine owns all scoring. */
  const getExpectedNote = useCallback(() => {
    return optionsRef.current.expectedNotesFor?.(nextUnmatchedIndex) ?? null;
  }, [nextUnmatchedIndex]);

  /** Read by the MIDI adapter at callback time to stamp the active take. */
  const getCaptureEpoch = useCallback(() => captureEpochRef.current, []);

  return {
    status, active, targets, firstTargetAtMs, countInMs, judgments, noteFeedback, report, analysis, sessionId, takeId, traceId, scoringConfig, durations, captureDiagnostics, reportPersisted, reportPersistenceError,
    scoreV1, scoreStatus, scoreConfigVersion, scoreAlgorithmVersion, scoreInputNoteCount, scoreUnmappedNoteCount, pauseAdjusted,
    scoreFingerprint, hand, scoreBarCount, sourceReportId, sourceTakeId, prescriptionId, prescription,
    takeTemplateId, takeTemplateName, retryComparison,
    error, liveStats, nextUnmatchedIndex,
    begin, pause, resume, finish, reset, beginFreePlay, finishFreePlay, ingestPacket, getExpectedNote, getCaptureEpoch,
    getPlannerStatus, requestPlannerPlan,
    startFollow, sendFollowNote, pauseFollow, resumeFollow, finishFollow, abandonFollow, retryPersist,
    originPerfMs: originRef.current,
  };
}
