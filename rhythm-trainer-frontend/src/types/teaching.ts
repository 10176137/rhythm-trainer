import type { HandSelection } from './practice';

export type PrescriptionProblemType =
  | 'local-onset'
  | 'missing-notes'
  | 'duration'
  | 'pitch-errors'
  | 'extra-notes'
  | 'manual-range';

export type PrescriptionStatus = 'EXECUTABLE' | 'MANUAL' | 'BLOCKED';
export type PrescriptionConfidenceStatus = 'high' | 'medium' | 'low' | 'not-assessable';

export interface MeasureRange {
  startMeasure: number;
  endMeasure: number;
}

export interface PrescriptionEvidence {
  source:
    | 'score-measure'
    | 'score-event'
    | 'duration-assessment'
    | 'score-diagnostic'
    | 'practice-range'
    | 'user-selection';
  metric: string;
  value: string | number | null;
  measure?: number;
  eventId?: string;
  detail?: string;
}

export interface TeachingPrescription {
  prescriptionId: string;
  sourceReportId: string;
  sourceTakeId: string;
  ruleId: string;
  problemType: PrescriptionProblemType;
  evidence: PrescriptionEvidence[];
  confidenceStatus: PrescriptionConfidenceStatus;
  measureRange: MeasureRange;
  recommendedBpm: number;
  recommendedHand: HandSelection;
  recommendedMode: 'loop';
  reason: string;
  action: string;
  status: PrescriptionStatus;
  createdAtIso: string;
  sourceScoreFingerprint?: string | null;
}

export interface PrescriptionBlock {
  ruleId: string;
  problemType: string;
  reason: string;
  evidence: PrescriptionEvidence[];
}

export interface PrescriptionAnalysis {
  prescriptions: TeachingPrescription[];
  blocks: PrescriptionBlock[];
  canCreateManual: boolean;
  manualBlockReason: string | null;
}

/** The request the report sends after the user confirms a targeted practice. */
export interface TargetedPracticeStartRequest {
  scoreFingerprint: string;
  sourceReportId: string;
  sourceTakeId: string;
  prescription: TeachingPrescription;
  bpm: number;
  hand: HandSelection;
  measureRange: MeasureRange;
  scoreBarCount: number;
}

export interface RetryComparisonMetric {
  key: string;
  label: string;
  unit: 'ratio' | 'ms';
  before: number;
  after: number;
  delta: number;
  lowerIsBetter: boolean;
}

export interface RetryComparison {
  sourceReportId: string;
  sourceTakeId: string;
  retryReportId: string;
  retryTakeId: string;
  prescriptionId: string;
  comparable: boolean;
  blockedReason: string | null;
  limitations: string[];
  sourceStatus: string | null;
  retryStatus: string | null;
  metrics: RetryComparisonMetric[];
}
