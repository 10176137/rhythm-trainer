import { describe, expect, it } from 'vitest';
import type { EngineDurationReport, EngineScoreEventResult, EngineScoreStatus, EngineSessionScoreReport } from '../../types/engine';
import { buildManualPrescription, buildTeachingPrescriptions } from './teachingPrescription';

const baseReport = (overrides: Partial<EngineSessionScoreReport> = {}): EngineSessionScoreReport => ({
  algorithmVersion: 'scoring-v1.0.0',
  configVersion: 'scoring-v1.0.0:default',
  alignmentPairs: [],
  missedScoreEventIds: [],
  extraPerformedIds: [],
  restWindowExtraIds: [],
  eventResults: [],
  pitch: {
    targets: 8,
    correct: 8,
    wrongPitch: 0,
    missed: 0,
    extra: 0,
    recall: 1,
    precision: 1,
  },
  onset: {
    matched: 8,
    signedMeanMs: 8,
    signedMedianMs: 8,
    meanAbsoluteMs: 8,
    p50AbsoluteMs: 8,
    p90AbsoluteMs: 8,
    outOfToleranceCount: 0,
    outOfToleranceRatio: 0,
  },
  rhythm: {
    intervalSamples: 7,
    meanSpeedRatio: 1,
    jitterRatioMad: 0,
    driftRatioSlopePerIndex: 0,
    rhythmCompensationSuspected: false,
  },
  duration: { graded: 8, meanRatio: 1, tooShortCount: 0, tooLongCount: 0 },
  continuity: {
    coveredRatio: 1,
    longestMatchedStreak: 8,
    measuresTotal: 2,
    measuresWithAnyMatch: 2,
  },
  measures: [
    { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 20, meanSpeedRatio: 1 },
    { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 20, meanSpeedRatio: 1 },
  ],
  overall: {
    score: 90,
    subscores: [{ name: 'pitch', score: 90, weight: 30, sampleCount: 8 }],
    renormalized: false,
  },
  confidence: 'high',
  dataDegraded: false,
  diagnostics: [],
  practiceRanges: [],
  ...overrides,
});

const baseDurations = (overrides: Partial<EngineDurationReport> = {}): EngineDurationReport => ({
  policyVersion: 3,
  assessments: [],
  orphanNoteOffCount: 0,
  openNoteCount: 0,
  ...overrides,
});

const input = (report: EngineSessionScoreReport, options: {
  status?: EngineScoreStatus;
  durations?: EngineDurationReport;
} = {}) => ({
  scoreReport: report,
  scoreStatus: options.status ?? 'AVAILABLE' as EngineScoreStatus,
  durations: options.durations ?? baseDurations(),
  sourceReportId: 's-source-1',
  sourceTakeId: 'take-source-1',
  bpm: 72,
  hand: 'both' as const,
  sourceScoreFingerprint: 'score-fp',
  scoreBarCount: 2,
  nowIso: '2026-10-22T12:00:00.000Z',
});

describe('teaching prescriptions', () => {
  it('creates a local-onset prescription only with measure-local contrast', () => {
    const report = baseReport({
      measures: [
        { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 110, meanSpeedRatio: 1 },
        { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 20, meanSpeedRatio: 1 },
      ],
      practiceRanges: [{ startMeasure: 1, endMeasure: 1, reason: 'mean |onset err| 110ms', priority: 1 }],
      diagnostics: [{ category: 'local-jitter', severity: 'moderate', measureStart: null, measureEnd: null, evidence: 'global jitter', confidence: 'high', suggestedAction: 'slow', scoreEventIds: [], performedEventIds: [] }],
    });
    const result = buildTeachingPrescriptions(input(report));
    expect(result.prescriptions).toHaveLength(1);
    const prescription = result.prescriptions[0];
    expect(prescription.problemType).toBe('local-onset');
    expect(prescription.ruleId).toBe('LOCAL_ONSET_V1');
    expect(prescription.measureRange).toEqual({ startMeasure: 1, endMeasure: 1 });
    expect(prescription.recommendedBpm).toBe(60);
    expect(prescription.status).toBe('EXECUTABLE');
    expect(prescription.sourceReportId).toBe('s-source-1');
    expect(prescription.evidence.some((item) => item.metric === 'meanAbsOnsetErrorMs' && item.value === 110)).toBe(true);
    expect(prescription.evidence.some((item) => item.source === 'practice-range')).toBe(true);
  });

  it('does not infer a local measure from a global offset / flat global average', () => {
    const report = baseReport({
      measures: [
        { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 110, meanSpeedRatio: 1 },
        { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 108, meanSpeedRatio: 1 },
      ],
      diagnostics: [{
        category: 'global-offset',
        severity: 'high',
        measureStart: null,
        measureEnd: null,
        evidence: 'median signed onset error 80ms',
        confidence: 'high',
        suggestedAction: 'check input latency',
        scoreEventIds: [],
        performedEventIds: [],
      }],
    });
    const result = buildTeachingPrescriptions(input(report));
    expect(result.prescriptions).toHaveLength(0);
    expect(result.blocks.some((block) => block.ruleId === 'GLOBAL_GLOBAL_OFFSET_V1')).toBe(true);
  });

  it('creates a duration prescription only from valid complete pairs with measures', () => {
    const report = baseReport({
      duration: { graded: 2, meanRatio: 0.5, tooShortCount: 2, tooLongCount: 0 },
      diagnostics: [{
        category: 'duration',
        severity: 'moderate',
        measureStart: null,
        measureEnd: null,
        evidence: '2/2 graded releases shorter',
        confidence: 'medium',
        suggestedAction: 'hold longer',
        scoreEventIds: [],
        performedEventIds: [],
      }],
    });
    const durations = baseDurations({
      assessments: [
        { targetIndex: 0, targetId: 't1', bar: 1, beat: 1, onsetSeq: 1, pitch: 60, nominalDurationMs: 500, actualKeyDownMs: 200, durationErrorMs: -300, allowedErrorMs: 75, interOnsetIntervalMs: 500, result: 'too_short', quality: 'ok' },
        { targetIndex: 1, targetId: 't2', bar: 1, beat: 2, onsetSeq: 2, pitch: 62, nominalDurationMs: 500, actualKeyDownMs: 250, durationErrorMs: -250, allowedErrorMs: 75, interOnsetIntervalMs: 500, result: 'too_short', quality: 'ok' },
      ],
    });
    const result = buildTeachingPrescriptions(input(report, { durations }));
    expect(result.prescriptions).toHaveLength(1);
    expect(result.prescriptions[0].problemType).toBe('duration');
    expect(result.prescriptions[0].measureRange.startMeasure).toBe(1);
    expect(result.prescriptions[0].evidence.some((item) => item.metric === 'durationErrorMs')).toBe(true);
  });

  it('does not turn a missing Note Off into a duration prescription', () => {
    const report = baseReport({
      diagnostics: [{
        category: 'duration',
        severity: 'moderate',
        measureStart: null,
        measureEnd: null,
        evidence: 'duration diagnostic',
        confidence: 'medium',
        suggestedAction: 'hold longer',
        scoreEventIds: [],
        performedEventIds: [],
      }],
    });
    const durations = baseDurations({
      assessments: [{
        targetIndex: 0, targetId: 't1', bar: 1, beat: 1, onsetSeq: 1, pitch: 60,
        nominalDurationMs: 500, actualKeyDownMs: null, durationErrorMs: null, allowedErrorMs: 75,
        interOnsetIntervalMs: null, result: 'unknown', quality: 'open_note_interrupted',
      }],
      openNoteCount: 1,
    });
    const result = buildTeachingPrescriptions(input(report, { durations }));
    expect(result.prescriptions.some((item) => item.problemType === 'duration')).toBe(false);
    expect(result.blocks.some((item) => item.ruleId === 'DURATION_NO_VALID_SAMPLE_V1')).toBe(true);
  });

  it('does not convert AMBIGUOUS into a definite pitch or missing prescription', () => {
    const ambiguous: EngineScoreEventResult = {
      result: 'AMBIGUOUS', scoreEventId: 's1', performedNoteId: 'p1', measure: 1,
      expectedPitch: 60, actualPitch: 61, onsetErrorMs: 0, pairingStatus: 'ambiguous', reason: 'ambiguous_pairing',
    };
    const report = baseReport({
      eventResults: [ambiguous],
      pitch: { ...baseReport().pitch, correct: 7, wrongPitch: 0, missed: 0, extra: 0, recall: 0.875 },
    });
    const result = buildTeachingPrescriptions(input(report));
    expect(result.prescriptions).toHaveLength(0);
    expect(result.blocks.some((item) => item.ruleId === 'AMBIGUOUS_V1')).toBe(true);
  });

  it('gates automatic prescriptions on a degraded or insufficient report', () => {
    const degraded = buildTeachingPrescriptions(input(baseReport(), { status: 'DEGRADED' }));
    expect(degraded.prescriptions).toHaveLength(0);
    expect(degraded.canCreateManual).toBe(true);
    expect(degraded.blocks.some((item) => item.ruleId === 'STATUS_DEGRADED_V1')).toBe(true);

    const insufficient = buildTeachingPrescriptions(input(baseReport(), { status: 'INSUFFICIENT_DATA' }));
    expect(insufficient.prescriptions).toHaveLength(0);
    expect(insufficient.canCreateManual).toBe(true);
    expect(insufficient.blocks.some((item) => item.ruleId === 'STATUS_INSUFFICIENT_DATA_V1')).toBe(true);

    const unavailable = buildTeachingPrescriptions({
      ...input(baseReport()),
      scoreReport: null,
      scoreStatus: 'UNAVAILABLE',
    });
    expect(unavailable.prescriptions).toHaveLength(0);
    expect(unavailable.canCreateManual).toBe(false);
    expect(unavailable.blocks.some((item) => item.ruleId === 'REPORT_UNAVAILABLE_V1')).toBe(true);
  });

  it('keeps manual selection explicitly distinct from a system diagnosis', () => {
    const manual = buildManualPrescription({
      sourceReportId: 's-source-1',
      sourceTakeId: 'take-source-1',
      startMeasure: 3,
      endMeasure: 5,
      bpm: 65,
      hand: 'right',
      nowIso: '2026-10-22T12:00:00.000Z',
    });
    expect(manual).not.toBeNull();
    expect(manual!.status).toBe('MANUAL');
    expect(manual!.ruleId).toBe('MANUAL_RANGE_V1');
    expect(manual!.confidenceStatus).toBe('not-assessable');
    expect(manual!.evidence[0].source).toBe('user-selection');
    expect(manual!.measureRange).toEqual({ startMeasure: 3, endMeasure: 5 });
    expect(manual!.recommendedHand).toBe('right');
  });

  it('uses event-level MISSING/WRONG_PITCH clearly and blocks unmeasured EXTRA', () => {
    const missing = buildTeachingPrescriptions(input(baseReport({
      pitch: { ...baseReport().pitch, correct: 7, missed: 1, recall: 0.875 },
      eventResults: [{ result: 'MISSING', scoreEventId: 's2', measure: 2, expectedPitch: 64 }],
    })));
    expect(missing.prescriptions[0].problemType).toBe('missing-notes');
    expect(missing.prescriptions[0].measureRange.startMeasure).toBe(2);

    const wrong = buildTeachingPrescriptions(input(baseReport({
      pitch: { ...baseReport().pitch, correct: 7, wrongPitch: 1, recall: 0.875 },
      eventResults: [{ result: 'WRONG_PITCH', scoreEventId: 's3', measure: 1, expectedPitch: 60, actualPitch: 62 }],
    })));
    expect(wrong.prescriptions[0].problemType).toBe('pitch-errors');

    const extra = buildTeachingPrescriptions(input(baseReport({
      pitch: { ...baseReport().pitch, extra: 1 },
      eventResults: [{ result: 'EXTRA', performedNoteId: 'p4', actualPitch: 67, measure: null }],
    })));
    expect(extra.prescriptions).toHaveLength(0);
    expect(extra.blocks.some((item) => item.ruleId === 'EXTRA_NO_MEASURE_V1')).toBe(true);
  });

  it('shows no evidence rather than a default prescription', () => {
    const result = buildTeachingPrescriptions(input(baseReport()));
    expect(result.prescriptions).toHaveLength(0);
    expect(result.blocks).toHaveLength(0);
    expect(result.canCreateManual).toBe(true);
  });
});
