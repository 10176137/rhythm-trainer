import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import FullScoreReport from './FullScoreReport';
import type { EngineSessionScoreReport } from '../types/engine';

const report: EngineSessionScoreReport = {
  algorithmVersion: 'scoring-v1.0.0',
  configVersion: 'scoring-v1.0.0:default',
  alignmentPairs: [],
  missedScoreEventIds: [],
  extraPerformedIds: [],
  restWindowExtraIds: [],
  eventResults: [{
    result: 'MATCH',
    scoreEventId: 'target-1',
    performedNoteId: 'played-1',
    measure: 1,
    expectedPitch: 60,
    actualPitch: 60,
    onsetErrorMs: 8,
    pairingStatus: 'complete',
    reason: 'matched',
  }],
  pitch: {
    targets: 8,
    correct: 8,
    wrongPitch: 0,
    missed: 0,
    extra: 1,
    recall: 1,
    precision: 8 / 9,
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
  duration: { graded: 8, meanRatio: 0.96, tooShortCount: 0, tooLongCount: 0 },
  continuity: {
    coveredRatio: 1,
    longestMatchedStreak: 8,
    measuresTotal: 1,
    measuresWithAnyMatch: 1,
  },
  measures: [{ measure: 1, matched: 8, missed: 0, meanAbsOnsetErrorMs: 8, meanSpeedRatio: 1 }],
  overall: {
    score: 100,
    subscores: [{ name: 'pitch', score: 100, weight: 30, sampleCount: 8 }],
    renormalized: false,
  },
  confidence: 'high',
  dataDegraded: false,
  diagnostics: [],
  practiceRanges: [{ startMeasure: 1, endMeasure: 1, reason: 'extra-notes', priority: 1 }],
};

describe('FullScoreReport', () => {
  it('never renders a zero or placeholder overall when scoring is unavailable', () => {
    const html = renderToStaticMarkup(<FullScoreReport scoreV1={null} scoreStatus="UNAVAILABLE" />);
    expect(html).toContain('完整评分不可用');
    expect(html).not.toContain('<strong>0');
  });

  it('hides the overall score when the report is degraded', () => {
    const html = renderToStaticMarkup(<FullScoreReport scoreV1={report} scoreStatus="DEGRADED" />);
    expect(html).toContain('数据降级');
    expect(html).toContain('本轮不输出总体分');
    expect(html).toContain('<strong>不可用</strong>');
    expect(html).not.toContain('<strong>100.0</strong>');
  });

  it('renders the Rust overall only for an available, non-renormalized report', () => {
    const html = renderToStaticMarkup(<FullScoreReport scoreV1={report} scoreStatus="AVAILABLE" />);
    expect(html).toContain('<strong>100.0</strong>');
    expect(html).toContain('完整评分可用');
    expect(html).toContain('建议练习区间');
    expect(html).not.toContain('本轮不输出总体分');
  });

  it('withholds a renormalized overall instead of presenting it as complete', () => {
    const renormalized = {
      ...report,
      overall: { ...report.overall, renormalized: true },
    };
    const html = renderToStaticMarkup(<FullScoreReport scoreV1={renormalized} scoreStatus="AVAILABLE" />);
    expect(html).toContain('部分分项缺失');
    expect(html).toContain('<strong>不可用</strong>');
    expect(html).not.toContain('<strong>100.0</strong>');
  });
});
