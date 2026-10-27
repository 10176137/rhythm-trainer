// REST client for the engine service's persistence API.
// Same-origin paths (/api/...) — in dev, Vite proxies them to the engine.

import type {
  EngineDurationReport,
  EngineReport,
  EngineScoringConfig,
  EngineScoreStatus,
  EngineSessionScoreReport,
  EngineTimingAnalysis,
  EngineStats,
} from '../types/engine';
import type { RetryComparison, TeachingPrescription } from '../types/teaching';
import type { FollowReport } from '../score-engine/practice/follow-session';

export type TakeReportKind = 'timeline' | 'follow' | 'unavailable';

export interface SessionSummary {
  sessionId: string;
  takeId?: string;
  reportKind?: TakeReportKind;
  endReason?: 'completed' | 'interrupted' | string | null;
  scoreStatus?: string | null;
  scoreId?: string | null;
  scoreSnapshotRef?: string | null;
  legacySessionId?: string | null;
  interrupted?: boolean;
  finishedAtIso: string;
  modeId: string;
  bpm: number | null;
  profile: string | null;
  trustworthy: boolean;
  targetCount: number;
  perfectCount: number;
  goodCount: number;
  missCount: number;
  extraCount: number;
  targetHitRate: number;
  meanSignedMs: number | null;
  meanAbsoluteMs: number | null;
  followCompletedTargets?: number;
  followStandardTargets?: number;
  followCompletionRate?: number;
  followWrongNoteCount?: number;
  followExtraNoteCount?: number;
  followDuplicateNoteCount?: number;
  followTimingSamples?: number;
  scoreFingerprint?: string | null;
  playbackPlanId?: string | null;
  plannerAuthority?: 'rts' | 'rust' | null;
  plannerVersion?: string | null;
  planFingerprint?: string | null;
  sourceReportId?: string | null;
  prescriptionId?: string | null;
  takeTemplateId?: string | null;
  takeTemplateName?: string | null;
}

export interface SessionDetail {
  schemaVersion: number;
  sessionId: string;
  interrupted?: boolean;
  finishedAtIso: string;
  modeId: string;
  bpm: number | null;
  profile: string | null;
  assisted: boolean;
  report: EngineReport;
  analysis: EngineTimingAnalysis | { error: string } | null;
  durations?: EngineDurationReport | { error: string } | null;
  scoreV1?: EngineSessionScoreReport | { error: string } | null;
  scoreStatus?: EngineScoreStatus | null;
  scoringConfig?: EngineScoringConfig | null;
  scoreConfigVersion?: string | null;
  scoreAlgorithmVersion?: string | null;
  scoreInputNoteCount?: number;
  scoreUnmappedNoteCount?: number;
  pauseAdjusted?: boolean;
  takeId?: string | null;
  scoreFingerprint?: string | null;
  playbackPlanId?: string | null;
  plannerAuthority?: 'rts' | 'rust' | null;
  plannerVersion?: string | null;
  planFingerprint?: string | null;
  hand?: string | null;
  scoreBarCount?: number | null;
  sourceReportId?: string | null;
  sourceTakeId?: string | null;
  prescriptionId?: string | null;
  prescription?: TeachingPrescription | null;
  takeTemplateId?: string | null;
  takeTemplateName?: string | null;
  takeTemplateUpdatedAtIso?: string | null;
  retryComparison?: RetryComparison | null;
}

export interface TakeRecordDetail {
  schemaVersion: number;
  takeId: string;
  score: {
    scoreId: string | null;
    scoreFingerprint: string | null;
    scoreSnapshotRef: string | null;
  };
  lifecycle: {
    startedAtIso: string | null;
    finishedAtIso: string | null;
    endReason: 'completed' | 'interrupted' | string;
    modeId: string;
  };
  context: {
    practiceConfigSnapshot: Record<string, unknown> | null;
    plannerAuthority: 'rts' | 'rust' | null;
    plannerVersion: string | null;
    planFingerprint: string | null;
    planSnapshotRef: string | null;
    planRunId: string | null;
  };
  evidence: {
    traceRef: string | null;
    journalRef: string | null;
    pauseIntervals: unknown[];
    captureDiagnostics: Record<string, unknown> | null;
  };
  assessment: {
    trustworthy: boolean;
    scoreStatus: string;
    scope?: 'follow' | string;
    strictTiming?: boolean;
    timelineReport?: SessionDetail | null;
    followReport?: FollowReport | null;
  };
  engineDiagnostics?: Record<string, unknown> | null;
  legacy?: {
    source: string;
    sessionId: string;
    engineTakeId: string | null;
    practiceSessionId: string | null;
  } | null;
}

export interface SkillSnapshot {
  skillId: string;
  state: string;
  trustworthyAttempts: number;
  consecutivePasses: number;
  transferPasses: number;
  delayedPasses: number;
  lastAttemptPassed: boolean | null;
}

export interface ProfileResponse {
  schemaVersion: number;
  skills: SkillSnapshot[];
  totals: { sessions: number; trustworthySessions: number };
}

export type StatsLike = Pick<EngineStats, 'targetHitRate' | 'meanAbsoluteMs'>;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${url} 失败 (${res.status})`);
  return res.json() as Promise<T>;
}

export const practiceRepository = {
  listSessions(limit = 50): Promise<{ items: SessionSummary[] }> {
    return getJson(`/api/sessions?limit=${limit}`);
  },

  getSession(sessionId: string): Promise<SessionDetail> {
    return getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  },

  /** Unified history: Timeline and Follow Takes, plus read-only legacy
   * sessions adapted on the server. */
  listTakes(limit = 50): Promise<{ items: SessionSummary[] }> {
    return getJson(`/api/takes?limit=${limit}`);
  },

  getTake(takeId: string): Promise<TakeRecordDetail> {
    return getJson(`/api/takes/${encodeURIComponent(takeId)}`);
  },

  getProfile(): Promise<ProfileResponse> {
    return getJson('/api/profile');
  },
};

export const MODE_CN: Record<string, string> = {
  rhythm: '节奏训练',
  score: '正常曲目演奏',
  'fixed-line': '固定判定线节奏练习',
  'reading-free': '自由识谱',
  'reading-rhythm': '节奏识谱',
  exercise: '生成练习（已下线）',
  hands: '分手练习',
  loop: '乐句循环',
  free: '自由弹奏',
  unknown: '未知',
};

export const MASTERY_CN: Record<string, string> = {
  not_assessed: '未评估',
  developing: '发展中',
  provisional: '初步掌握',
  consolidated: '已巩固',
  needs_review: '需要复习',
};

export const fmtSigned = (value: number | null | undefined) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}ms`;

export const fmtAbs = (value: number | null | undefined) =>
  value == null ? '—' : `${value.toFixed(1)}ms`;

/** Trend of mean absolute error over consecutive sessions (oldest → newest). */
export function maeTrend(sessions: SessionSummary[]): (number | null)[] {
  return [...sessions]
    .sort((a, b) => (a.finishedAtIso < b.finishedAtIso ? -1 : 1))
    .map((s) => s.meanAbsoluteMs);
}

export function avgOf(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v != null);
  if (real.length === 0) return null;
  return real.reduce((sum, v) => sum + v, 0) / real.length;
}
