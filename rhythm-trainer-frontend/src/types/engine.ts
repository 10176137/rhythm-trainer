// Protocol DTOs shared with the local engine service (server/engine-server.mjs).
// The engine service owns all scoring through the Rust core; these types only
// describe the wire contract. Keep field names in sync with the server.

import type { HandSelection } from './practice';
import type { RetryComparison, TeachingPrescription } from './teaching';
import type { FollowNoteResult, FollowReport } from '../score-engine/practice/follow-session';

export type EngineProfile = 'strict' | 'standard' | 'relaxed';

/** One notation atom in ticks. kind 'rest' atoms never create targets. */
export interface EngineAtom {
  startTick: number;
  durationTicks: number;
  kind: 'note' | 'rest';
  bar: number;
  beat: number;
}

export interface EngineScoreEvent {
  /** Stable occurrence ID; repeated/repeat-pass targets must be distinct. */
  scoreEventId: string;
  measure: number;
  /** Quarter-note beat from the playback origin. */
  beatPosition: number;
  pitch: number;
  targetOnsetMs: number;
  targetDurationMs: number;
  partId: string;
  parseConfidence?: number;
}

export interface EngineTarget {
  id: string;
  index: number;
  atMs: number;
  bar: number | null;
  beat: number | null;
  perfectWindowMs: number;
  goodWindowMs: number;
  /** Nominal score duration in ms (duration ticks converted at current tempo). */
  nominalDurationMs: number;
}

/** Server-authoritative live pitch/onset display state, not a duration verdict. */
export interface EngineNoteFeedback {
  scoreEventId: string;
  state: 'pending' | 'hit' | 'wrong' | 'miss';
}

export interface EngineJudgment {
  grade: 'perfect' | 'good' | 'miss' | 'extra';
  targetId: string | null;
  targetIndex: number | null;
  strikeSeq: number | null;
  errorMs: number | null;
  expectedAtMs: number | null;
  actualAtMs: number | null;
  bar: number | null;
  beat: number | null;
}

export interface EngineStats {
  targetCount: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  extraCount: number;
  perfectRate: number;
  targetHitRate: number;
  missRate: number;
  meanSignedMs: number | null;
  meanAbsoluteMs: number | null;
  standardDeviationMs: number | null;
}

export type EngineScoreStatus =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'INSUFFICIENT_DATA'
  | 'UNAVAILABLE'
  | 'INVALID';

export interface EngineScoreAlignmentPair {
  scoreEventId: string;
  performedNoteId: string;
  pitchMatched: boolean;
  onsetErrorMs: number;
  measure: number;
  pairingStatus?: string | null;
}

export interface EngineScoreEventResult {
  result: 'MATCH' | 'WRONG_PITCH' | 'MISSING' | 'EXTRA' | 'AMBIGUOUS';
  scoreEventId?: string | null;
  performedNoteId?: string | null;
  measure?: number | null;
  expectedPitch?: number | null;
  actualPitch?: number | null;
  onsetErrorMs?: number | null;
  pairingStatus?: string | null;
  reason?: string | null;
}

export interface EnginePitchAccuracy {
  targets: number;
  correct: number;
  wrongPitch: number;
  missed: number;
  extra: number;
  recall: number | null;
  precision: number | null;
}

export interface EngineOnsetMetrics {
  matched: number;
  signedMeanMs: number | null;
  signedMedianMs: number | null;
  meanAbsoluteMs: number | null;
  p50AbsoluteMs: number | null;
  p90AbsoluteMs: number | null;
  outOfToleranceCount: number;
  outOfToleranceRatio: number | null;
}

export interface EngineRhythmMetrics {
  intervalSamples: number;
  meanSpeedRatio: number | null;
  jitterRatioMad: number | null;
  driftRatioSlopePerIndex: number | null;
  rhythmCompensationSuspected: boolean;
}

export interface EngineScoreDurationMetrics {
  graded: number;
  meanRatio: number | null;
  tooShortCount: number;
  tooLongCount: number;
}

export interface EngineContinuityMetrics {
  coveredRatio: number | null;
  longestMatchedStreak: number;
  measuresTotal: number;
  measuresWithAnyMatch: number;
}

export interface EngineMeasureReport {
  measure: number;
  matched: number;
  missed: number;
  meanAbsOnsetErrorMs: number | null;
  meanSpeedRatio: number | null;
}

export interface EngineSubScore {
  name: string;
  score: number | null;
  weight: number;
  sampleCount: number;
}

export interface EngineOverallScore {
  score: number | null;
  subscores: EngineSubScore[];
  renormalized: boolean;
}

export interface EngineScoringDiagnostic {
  category: string;
  severity: string;
  measureStart: number | null;
  measureEnd: number | null;
  evidence: string;
  confidence: string;
  suggestedAction: string;
  scoreEventIds: string[];
  performedEventIds: string[];
}

export interface EnginePracticeRange {
  startMeasure: number;
  endMeasure: number;
  reason: string;
  priority: number;
}

export interface EngineSessionScoreReport {
  algorithmVersion: string;
  configVersion: string;
  alignmentPairs: EngineScoreAlignmentPair[];
  missedScoreEventIds: string[];
  extraPerformedIds: string[];
  restWindowExtraIds: string[];
  eventResults: EngineScoreEventResult[];
  pitch: EnginePitchAccuracy;
  onset: EngineOnsetMetrics;
  rhythm: EngineRhythmMetrics;
  duration: EngineScoreDurationMetrics;
  continuity: EngineContinuityMetrics;
  measures: EngineMeasureReport[];
  overall: EngineOverallScore;
  confidence: string;
  dataDegraded: boolean;
  diagnostics: EngineScoringDiagnostic[];
  practiceRanges: EnginePracticeRange[];
}

export interface EngineReport {
  state: 'ready' | 'running' | 'paused' | 'completed' | 'invalid';
  targetCount: number;
  stats: EngineStats;
  trustworthy: boolean;
  diagnostics: Record<string, number>;
}

export interface EngineDiagnostic {
  issue: string;
  severity: 'info' | 'moderate' | 'high';
  confidence: 'low' | 'medium' | 'high';
  evidence: string;
}

export interface EngineTimingAnalysis {
  report: {
    trustworthy: boolean;
    features: Record<string, number | null>;
    diagnostics: EngineDiagnostic[];
  };
  prescription: {
    targetIssue: string;
    exercise: string;
    suggestedBpm: number | null;
    metronomeMode: string;
    loopsPerSet: number;
    requiredConsecutivePasses: number;
    maximumMeanAbsoluteErrorMs: number;
    requireUnassistedTransferTest: boolean;
    rationale: string;
  } | null;
}

// ---------------------------------------------------------------------------
// v0.6 authoritative raw-MIDI contract. Adapters capture packets (bytes +
// source clock metadata) only; the Rust core decodes, pairs and scores.

export type EngineMidiTransport = 'web-midi' | 'node-midi' | 'mock' | 'recording';
export type EngineClockQuality = 'good' | 'estimated' | 'unstable' | 'unknown';

export interface EngineRawMidiPacket {
  /** Connection-instance id (port id for web-midi); not a permanent device id. */
  sourceId: string;
  /** Strictly increasing per sourceId, counting EVERY message. */
  sourceSeq: number;
  /** Clock domain the timestamps belong to (e.g. the page's performance timeline). */
  clockDomainId: string;
  /** Source capture/event time in ms — never the Node receive time. */
  capturedAtMs: number;
  /** Optional handler execution time; dispatch-delay diagnostics only. */
  handlerAtMs?: number;
  /** Verbatim message bytes. */
  rawBytes: number[];
  transport: EngineMidiTransport;
  /**
   * Capture generation of the take this packet was observed in. Stamped by the
   * adapter at the MIDI callback (first observation), never by the queue
   * consumer. Absent when no take is active (legacy/idle input).
   */
  captureEpoch?: number;
}

export interface EngineIngestMidiPacket {
  packet: EngineRawMidiPacket;
  /** Mapped session time; null when no credible mapping exists. */
  sessionTimeMs: number | null;
  clockMappingId: string | null;
  clockUncertaintyMs: number | null;
  clockQuality: EngineClockQuality;
}

export interface EngineKeyPressObservation {
  pressId: string;
  sourceId: string;
  channel: number;
  noteNumber: number;
  velocityOn: number;
  noteOnEventId: string;
  noteOffEventId?: string;
  startSourceTimeMs: number;
  endSourceTimeMs?: number;
  keyDownDurationMs?: number;
  status: 'complete' | 'missing-note-off' | 'interrupted-by-disconnect' | 'ambiguous-pairing' | 'invalid-time';
  qualityReasons: string[];
  noteOnSourceSeq: number;
}

export interface EngineMidiDiagnostic {
  code: string;
  sourceId: string;
  sourceSeq?: number;
  detail: string;
}

export interface EngineKeyLifecycleReport {
  schemaVersion: number;
  algorithmVersion: string;
  observations: EngineKeyPressObservation[];
  diagnostics: EngineMidiDiagnostic[];
}

export interface EngineDiagnosticEvent {
  receivedEvents: number;
  queueOverflowCount: number;
  sequenceGapCount: number;
  duplicateOrRegressingSequenceCount: number;
  outOfOrderTimestampCount: number;
  invalidEventCount: number;
  lateArrivalCount: number;
}

// ---------------------------------------------------------------------------
// v0.3 key-down duration assessment (Note Off − Note On), kept separate from
// onset timing. See docs/DESIGN.md and the duration requirements doc.

export type DurationEvaluationPolicy = 'strict-keydown' | 'disabled';

export interface EngineDurationPolicy {
  policy: DurationEvaluationPolicy;
  toleranceMs: number;
  toleranceRatio: number;
}

export interface EngineDurationAssessment {
  targetIndex: number | null;
  targetId: string | null;
  /** Associated target measure; null for old records or unmatched events. */
  bar?: number | null;
  beat?: number | null;
  onsetSeq: number | null;
  pitch: number | null;
  nominalDurationMs: number | null;
  actualKeyDownMs: number | null;
  durationErrorMs: number | null;
  allowedErrorMs: number | null;
  interOnsetIntervalMs: number | null;
  result: 'within_tolerance' | 'too_short' | 'too_long' | 'unknown' | 'disabled';
  quality: 'ok' | 'overlapping_same_pitch' | 'open_note_interrupted' | 'crossed_pause_boundary';
}

export interface EngineDurationReport {
  policyVersion: number;
  assessments: EngineDurationAssessment[];
  orphanNoteOffCount: number;
  openNoteCount: number;
}

export interface EngineCaptureDiagnostics {
  /** Packets the client forwarded into the trace (currently notes only). */
  forwardedPackets: number;
  /** Dense scoring-event sequence length; independent of transport sourceSeq. */
  scoringEvents: number;
  /** Count-in notes that were traced but deliberately not scored. */
  countdownSuppressed: number;
  /** Packets suppressed by the pause policy. Packet unit, not notes. */
  pauseSuppressed?: number;
  /** Performed notes skipped because their Note On admission decision was suppressed. */
  pauseExcludedFromScore?: number;
  /** Admission ledger (policy B): one immutable decision per packet. */
  admission?: {
    version: string;
    packets: number;
    noteOns: number;
    nonOnsets: number;
    admittedNoteOns: number;
    pushHitCount: number;
    finalPerformedNotes: number;
    finalSkippedByAdmission: number;
    finalDuplicateLifecycles: number;
    suppressedNoteOns: { countIn: number; paused: number; clock: number; duplicate: number; outOfOrder: number };
    captureQuarantinedPackets: number;
    duplicateEventIds: number;
    pauseSegments: { segmentId: string; startSession: number; endSession: number | null }[];
  };
  /** Packets rejected because their captureEpoch did not match the active take. */
  epochMismatch: number;
  /** Adapter-reported health at finalization (healthy/degraded/disconnected). */
  inputHealth?: string;
  /** Persisted per-Take MIDI trace metadata. */
  traceId?: string | null;
  traceDropped?: number;
  tracePersistenceDegraded?: boolean;
  /** Cross-process clock quality gate applied before the report is trusted. */
  scoreStatus?: EngineScoreStatus;
  scoreInputNoteCount?: number;
  scoreUnmappedNoteCount?: number;
  pauseAdjusted?: boolean;
  clockMapping?: {
    quality: string;
    uncertaintyMs: number | null;
    mappedEvents: number;
    status: 'ok' | 'limited' | 'unscorable';
    reason: string;
  };
  /** Node MIDI adapter counters for this take. */
  node?: {
    backend: string;
    adapterGeneration: number;
    mappedEvents: number;
    unmappedEvents: number;
    staleGenerationEvents: number;
    queueDropped: number;
    clockQuality: string;
    clockUncertaintyMs: number | null;
  };
}

export interface EngineReportMessage {
  type: 'report';
  /** Server-assigned session id; also the filename key for /api/sessions/:id. */
  sessionId?: string;
  report: EngineReport;
  analysis: EngineTimingAnalysis | { error: string } | null;
  /** Key-down duration assessments; null when the session collected no raw notes. */
  durations?: EngineDurationReport | { error: string } | null;
  /** v0.6: authoritative key lifecycle report when raw packets were ingested. */
  keyLifecycles?: EngineKeyLifecycleReport | { error: string } | null;
  /** v0.6.1: input-attribution counters for diagnostics and future Take model. */
  captureDiagnostics?: EngineCaptureDiagnostics;
  scoreV1?: EngineSessionScoreReport | { error: string } | null;
  scoreStatus?: EngineScoreStatus;
  scoreConfigVersion?: string | null;
  scoreAlgorithmVersion?: string | null;
  scoreInputNoteCount?: number;
  scoreUnmappedNoteCount?: number;
  pauseAdjusted?: boolean;
  /** False when the engine could generate a report but could not persist the session record. */
  persisted?: boolean;
  persistenceStatus?: 'persisted' | 'pending-retry' | 'unknown' | string | null;
  persistenceError?: string | null;
  /** v0.6.2: PracticeSession / PerformanceTake identity of this report. */
  practiceSessionId?: string;
  takeId?: string;
  takeIndex?: number;
  takeSnapshot?: Record<string, unknown>;
  traceId?: string | null;
  trace?: {
    traceId: string;
    eventCount: number;
    dropped: number;
    persistenceDegraded: boolean;
    complete?: boolean;
    error?: string;
  } | null;
  /** Traceability: the exact effective config this Take was scored with. */
  scoringConfig?: EngineScoringConfig | null;
  scoringConfigVersion?: string | null;
  coreAlgorithmVersion?: string | null;
  scoreFingerprint?: string | null;
  playbackPlanId?: string | null;
  /** R2-3i: which planner produced this Take and its plan identity. */
  plannerAuthority?: 'rts' | 'rust' | null;
  plannerVersion?: string | null;
  planFingerprint?: string | null;
  scoreImportStatus?: string | null;
  hand?: HandSelection | null;
  scoreBarCount?: number | null;
  /** B2: source report/Take and the confirmed prescription for a retry. */
  sourceReportId?: string | null;
  sourceTakeId?: string | null;
  prescriptionId?: string | null;
  prescription?: TeachingPrescription | null;
  takeTemplateId?: string | null;
  takeTemplateName?: string | null;
  takeTemplateUpdatedAtIso?: string | null;
  retryComparison?: RetryComparison | null;
}

/** Messages sent by the engine service. */
export interface EngineScoringConfig {
  configVersion: string;
  modeId: string;
  modeLabel: string;
  judgmentProfile: EngineProfile;
  judgmentProfileSource: 'user' | 'mode-default';
  durationPolicy: DurationEvaluationPolicy;
  durationPolicySource: 'user' | 'mode-default';
  feedback: 'live' | 'after';
  pitchHint: boolean;
  scoringStartPolicy: string;
  diagnosis: Record<string, boolean>;
  notApplicable: string[];
}

/** Follow wire types. The Rust FollowRuntime on the engine service owns
 * target progression and the report; the browser only renders these. */
export interface FollowPitchRequest {
  midiNote: number;
  spelling: string;
}

export interface FollowGroupRequest {
  groupId: string;
  bar: number;
  /** Quarter-note beat from the playback origin. */
  playbackBeat: number;
  pitches: FollowPitchRequest[];
}

export interface FollowProgress {
  index: number;
  total: number;
  completed: number;
  currentGroupId?: string | null;
  isComplete?: boolean;
}

export interface FollowStartedMessage {
  type: 'follow-started';
  takeId: string;
  runtimeId: string;
  progress: FollowProgress;
  total: number;
  scoreFingerprint: string | null;
  plannerAuthority: 'rts' | 'rust' | null;
  plannerVersion: string | null;
  planFingerprint: string | null;
  targetSource: 'server-plan' | 'client-plan-projection';
}

export interface FollowEventMessage {
  type: 'follow-event';
  takeId: string;
  note: number;
  atMs: number;
  result: FollowNoteResult;
  progress: FollowProgress;
}

export interface FollowReportMessage {
  type: 'follow-report';
  takeId: string;
  report: FollowReport;
  persisted: boolean;
  persistenceStatus?: 'persisted' | 'pending-retry' | 'unknown' | string | null;
  persistenceError: string | null;
  endReason: 'completed' | 'interrupted';
  progress?: FollowProgress;
}

/** Result of an idempotent retry for one frozen but unsaved Take draft. */
export interface PersistRetryResultMessage {
  type: 'persist-retry-result';
  takeId: string;
  persisted: boolean;
  persistenceStatus: 'persisted' | 'pending-retry' | 'unknown' | string;
  persistenceError: string | null;
  created?: boolean;
  attempts?: number;
}

export interface FollowStartRequest {
  type: 'follow-start';
  /** Present when the plan was issued by the server (rust planner path). */
  planRequestId?: string;
  /** Required for the default rts path: the plan projection is validated by
   * the server and recorded as a client projection, never as a Rust plan. */
  groups?: FollowGroupRequest[];
  bpm: number;
  plannerAuthority: 'rts' | 'rust';
  plannerVersion?: string | null;
  planFingerprint?: string | null;
  scoreFingerprint?: string | null;
  scoreId?: string | null;
  configSnapshot?: Record<string, unknown> | null;
  startedAtIso?: string;
  /** Browser performance.now() at session zero, for hardware note mapping. */
  basePerfMs?: number;
  modeId?: string;
  timingToleranceMs?: number;
  chordSpreadToleranceMs?: number;
}

export type EngineServerMessage =
  | {
      type: 'started'; bpm: number; profile: EngineProfile; countInBeats: number;
      /** Canonical count-in actually used; null for legacy clients. */
      countInUs?: number | null;
      /** Backend-authoritative first note onset, relative to the session origin. */
      firstTargetAtMs: number | null;
      /** Count-in length used to build firstTargetAtMs. */
      countInMs: number;
      targets: EngineTarget[]; captureEpoch?: number;
      practiceSessionId?: string; takeId?: string; takeIndex?: number;
      scoringConfig?: EngineScoringConfig;
    }
  | { type: 'judgments'; items: EngineJudgment[]; noteFeedback?: EngineNoteFeedback[] }
  | { type: 'paused' }
  | { type: 'resumed'; deltaMs: number; resumedAtMs: number }
  | { type: 'clock-pong'; id: string; clientSendPerfMs: number; serverReceivePerfMs: number; serverSendPerfMs: number }
  | { type: 'clock-status'; offsetServerMinusClientMs: number; uncertaintyMs: number; rttMs: number; sampleCount: number; quality: string }
  | EngineReportMessage
  | {
      /** R2-3h: the server's active planner authority (single source of truth). */
      type: 'planner-status';
      authority: 'rts' | 'rust';
      plannerVersion: string;
      supportedModes: Array<'timeline' | 'follow'>;
    }
  | {
      /** R2-3h: the server-side Rust plan (or a coded rejection). */
      type: 'plan-response';
      requestId: string | null;
      ok: boolean;
      plannerAuthority?: 'rust';
      plannerVersion?: string;
      planFingerprint?: string;
      scoreFingerprint?: string;
      strictAllowed?: boolean;
      planIssues?: Array<{ code: string; blocksStrict?: boolean }>;
      scopeCodes?: string[];
      missingEventIds?: string[];
      atomIssueCodes?: string[];
      plan?: unknown;
      error?: { code: string; message: string };
    }
  | FollowStartedMessage
  | FollowEventMessage
  | FollowReportMessage
  | PersistRetryResultMessage
  | { type: 'error'; message: string };

export interface EngineStartRequest {
  type: 'start';
  modeId: string;
  bpm: number;
  profile: EngineProfile;
  countInBeats: number;
  /** Canonical count-in in microseconds; when present it is the only time origin. */
  countInUs?: number;
  ticksPerQuarter: number;
  atoms: EngineAtom[];
  /** Per-note final-score events; never a second target timeline. */
  scoreEvents?: EngineScoreEvent[];
  assisted?: boolean;
  /** v0.3 key-down duration evaluation policy. */
  durationPolicy?: DurationEvaluationPolicy;
  /** Traceability fields from the semantic score engine. */
  scoreFingerprint?: string;
  playbackPlanId?: string;
  scoreImportStatus?: string;
  hand?: HandSelection;
  scoreBarCount?: number;
  /** B2 targeted practice: source report/Take and confirmed prescription. */
  sourceReportId?: string;
  sourceTakeId?: string;
  prescriptionId?: string;
  prescription?: TeachingPrescription;
  takeTemplateId?: string;
}

/** Messages accepted by the engine service. */
export type EngineClientMessage =
  | EngineStartRequest
  | { type: 'hit'; seq: number; atMs: number; notes: number[] }
  | { type: 'note-on'; seq: number; atMs: number; pitch: number; velocity?: number }
  | { type: 'note-off'; seq: number; atMs: number; pitch: number }
  | { type: 'raw-midi'; ingest: EngineIngestMidiPacket }
  | { type: 'tick'; nowMs: number }
  | { type: 'pause'; nowMs: number; atSourceMs?: number }
  | { type: 'resume'; nowMs: number; atSourceMs?: number }
  | { type: 'clock-ping'; id: string; clientSendPerfMs: number; protocolVersion?: number }
  | { type: 'clock-sample'; id: string; clientReceivePerfMs: number; protocolVersion?: number }
  | { type: 'session-origin'; clientPerfMs: number; protocolVersion?: number }
  | { type: 'planner-status'; protocolVersion?: number }
  | {
      type: 'plan-request';
      protocolVersion?: number;
      requestId: string;
      mode: 'timeline' | 'follow';
      document: unknown;
      report: unknown;
      config: unknown;
    }
  | (FollowStartRequest & { protocolVersion?: number })
  | { type: 'follow-note'; note: number; atMs: number }
  | { type: 'follow-pause'; atMs?: number }
  | { type: 'follow-resume'; atMs?: number }
  | { type: 'follow-finish' }
  | { type: 'follow-abandon' }
  | { type: 'persist-retry'; takeId: string }
  | { type: 'finish' };
