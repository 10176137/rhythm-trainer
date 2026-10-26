// REST client for the Node Teaching Orchestrator (same-origin /api/teaching).
// The browser never sends reports/diagnostics/prescriptions — only user intent
// and already-persisted Take ids; the server reads the authoritative Take.

export type TeachingGoal = 'learn-score' | 'rhythm' | 'pitch' | 'duration' | 'rehearse';
export type TeachingHand = 'left' | 'right' | 'both';
export type TeachingRunStatus = 'ready' | 'in_progress' | 'awaiting_evidence' | 'completed' | 'abandoned';
export type TeachingStepKind =
  | 'study_score'
  | 'demonstrate'
  | 'guided_practice'
  | 'focused_practice'
  | 'independent_performance';
export type TeachingStepStatus = 'ready' | 'active' | 'completed' | 'skipped';
export type TeachingActionName =
  | 'begin'
  | 'complete-step'
  | 'skip-step'
  | 'record-take'
  | 'retry-current-step'
  | 'abandon';
export type TeachingDecisionAction = 'focus_range' | 'check_input' | 'collect_more_evidence' | 'advance' | 'ask_learner';

export interface TeachingAvailableAction {
  action: TeachingActionName;
  enabled: boolean;
  label: string;
}

export interface TeachingMeasureRange {
  startMeasure: number;
  endMeasure: number;
}

export interface TeachingPracticeRequest {
  scoreFingerprint: string;
  scoreBarCount: number;
  modeId: string;
  advanceMode: 'timeline' | 'follow';
  tempo: number;
  hand: TeachingHand;
  feedback: 'live' | 'after';
  profile: string;
  durationPolicy: string;
  loopEnabled: boolean;
  loopStartBar: number;
  loopEndBar: number;
}

export interface TeachingStep {
  stepRunId: string;
  kind: TeachingStepKind;
  title: string;
  instruction: string;
  status: TeachingStepStatus;
  required: boolean;
  attemptCount: number;
  measureRange?: TeachingMeasureRange;
  hands?: TeachingHand;
  tempoBpm?: number;
  /** Present on practice steps; authored by Node, never by the browser. */
  practiceRequest?: TeachingPracticeRequest;
}

export interface TeachingEvidenceRef {
  source: string;
  metric: string;
  value: string | number | null;
  measure?: number;
  eventId?: string;
  detail?: string;
  takeId?: string;
}

export interface TeachingPrescriptionDTO {
  prescriptionId: string;
  sourceTakeId: string;
  sourceReportId: string;
  sourceScoreFingerprint: string | null;
  ruleId: string;
  problemType: string;
  confidenceStatus: string;
  measureRange: TeachingMeasureRange;
  recommendedBpm: number;
  recommendedHand: TeachingHand;
  recommendedMode: 'loop';
  reason: string;
  action: string;
  status: string;
  evidence: TeachingEvidenceRef[];
  createdAtIso: string;
}

export interface TeachingDecision {
  decisionId: string;
  policyVersion: string;
  sourceTakeId: string;
  sourceScoreFingerprint: string | null;
  stepRunId: string | null;
  action: TeachingDecisionAction;
  reasonCode: string;
  reason: string;
  evidenceRefs: TeachingEvidenceRef[];
  createdAtIso: string;
  prescription?: TeachingPrescriptionDTO;
}

export interface TeachingTakeRef {
  takeId: string;
  stepRunId: string;
  addedAtIso: string;
}

export interface TeachingRunDTO {
  schemaVersion: number;
  runId: string;
  templateVersion: string;
  policyVersion: string;
  revision: number;
  status: TeachingRunStatus;
  scoreFingerprint: string;
  scoreBarCount: number;
  /** Set only for runs created from an existing persisted Take. */
  sourceTakeId: string | null;
  sourceSelection: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  currentStepId: string | null;
  steps: TeachingStep[];
  currentStep: TeachingStep | null;
  availableActions: TeachingAvailableAction[];
  takeRefs: TeachingTakeRef[];
  decisions: TeachingDecision[];
  latestDecision: TeachingDecision | null;
  duplicateCommand?: boolean;
}

export interface CreateRunInput {
  scoreFingerprint: string;
  scoreBarCount: number;
  bpm?: number;
  hand?: TeachingHand;
  startMeasure?: number;
  endMeasure?: number;
  goal?: TeachingGoal;
  referenceAvailable?: boolean;
  profile?: string;
  durationPolicy?: string;
  feedback?: 'live' | 'after';
}

export interface CreateRunFromTakeInput extends Omit<CreateRunInput, 'scoreFingerprint'> {
  takeId: string;
  /** Server validates against the Take; a mismatch is a 409. */
  scoreFingerprint?: string;
  /** Marks the range as the user's choice, not an algorithm diagnosis. */
  manualRange?: boolean;
}

export interface TeachingActionInput {
  commandId: string;
  expectedRevision: number;
  action: TeachingActionName;
  takeId?: string;
}

/** Structured 4xx body from the engine service; message is already Chinese. */
export class TeachingApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'TeachingApiError';
  }
}

async function request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  const response = await fetch(urlPath, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    throw new TeachingApiError('TEACHING_BAD_RESPONSE', `教学服务返回了无法解析的内容（HTTP ${response.status}）`, response.status);
  }
  const record = (json ?? {}) as { ok?: boolean; error?: { code?: string; message?: string } };
  if (!response.ok || record.ok === false) {
    const code = record.error?.code ?? `HTTP_${response.status}`;
    const message = record.error?.message ?? `教学服务请求失败（HTTP ${response.status}）`;
    throw new TeachingApiError(code, message, response.status);
  }
  return json as T;
}

const LAST_RUN_KEY = 'rhythm-trainer.teaching.last-run.v1';

/** At most a recovery pointer; the server run is the only state authority. */
export function loadLastRunId(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_RUN_KEY);
    return value && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLastRunId(runId: string | null): void {
  try {
    if (runId) window.localStorage.setItem(LAST_RUN_KEY, runId);
    else window.localStorage.removeItem(LAST_RUN_KEY);
  } catch { /* best effort */ }
}

export const teachingRunRepository = {
  createRun(input: CreateRunInput): Promise<TeachingRunDTO> {
    return request<{ ok: true; run: TeachingRunDTO }>('POST', '/api/teaching/runs', input).then((data) => data.run);
  },

  createRunFromTake(input: CreateRunFromTakeInput): Promise<TeachingRunDTO> {
    return request<{ ok: true; run: TeachingRunDTO }>('POST', '/api/teaching/runs/from-take', input).then((data) => data.run);
  },

  getRun(runId: string): Promise<TeachingRunDTO> {
    return request<{ ok: true; run: TeachingRunDTO }>('GET', `/api/teaching/runs/${encodeURIComponent(runId)}`).then((data) => data.run);
  },

  applyAction(runId: string, input: TeachingActionInput): Promise<TeachingRunDTO> {
    return request<{ ok: true; run: TeachingRunDTO }>(
      'POST',
      `/api/teaching/runs/${encodeURIComponent(runId)}/actions`,
      input,
    ).then((data) => data.run);
  },
};
