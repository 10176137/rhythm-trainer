import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TargetedPracticePanel from './TargetedPracticePanel';
import type { EngineSessionScoreReport } from '../types/engine';

const report = (overrides: Partial<EngineSessionScoreReport> = {}): EngineSessionScoreReport => ({
  algorithmVersion: 'scoring-v1.0.0',
  configVersion: 'scoring-v1.0.0:default',
  alignmentPairs: [],
  missedScoreEventIds: [],
  extraPerformedIds: [],
  restWindowExtraIds: [],
  eventResults: [],
  pitch: { targets: 8, correct: 8, wrongPitch: 0, missed: 0, extra: 0, recall: 1, precision: 1 },
  onset: { matched: 8, signedMeanMs: 8, signedMedianMs: 8, meanAbsoluteMs: 8, p50AbsoluteMs: 8, p90AbsoluteMs: 8, outOfToleranceCount: 0, outOfToleranceRatio: 0 },
  rhythm: { intervalSamples: 7, meanSpeedRatio: 1, jitterRatioMad: 0, driftRatioSlopePerIndex: 0, rhythmCompensationSuspected: false },
  duration: { graded: 8, meanRatio: 1, tooShortCount: 0, tooLongCount: 0 },
  continuity: { coveredRatio: 1, longestMatchedStreak: 8, measuresTotal: 1, measuresWithAnyMatch: 1 },
  measures: [{ measure: 1, matched: 8, missed: 0, meanAbsOnsetErrorMs: 100, meanSpeedRatio: 1 }],
  overall: { score: 80, subscores: [], renormalized: false },
  confidence: 'high',
  dataDegraded: false,
  diagnostics: [],
  practiceRanges: [{ startMeasure: 1, endMeasure: 1, reason: 'mean |onset err| 100ms', priority: 1 }],
  ...overrides,
});

const props = {
  sourceReportId: 's-source',
  sourceTakeId: 'take-1',
  sourceScoreFingerprint: 'fp',
  activeScoreFingerprint: 'fp',
  practiceBpm: 72,
  practiceHand: 'both' as const,
  scoreBarCount: 1,
};

describe('TargetedPracticePanel', () => {
  it('renders an executable local prescription with evidence', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel
        {...props}
        scoreV1={report()}
        scoreStatus="AVAILABLE"
        onStartTargetedPractice={() => true}
      />,
    );
    expect(html).toContain('确认创建复练任务');
    expect(html).toContain('LOCAL_ONSET_V1');
    expect(html).toContain('meanAbsOnsetErrorMs');
    expect(html).toContain('第 1 小节');
  });

  it('shows no executable button when there is no evidence', () => {
    const flat = report({
      measures: [{ measure: 1, matched: 8, missed: 0, meanAbsOnsetErrorMs: 20, meanSpeedRatio: 1 }],
      practiceRanges: [],
    });
    const html = renderToStaticMarkup(
      <TargetedPracticePanel
        {...props}
        scoreV1={flat}
        scoreStatus="AVAILABLE"
        onStartTargetedPractice={() => true}
      />,
    );
    expect(html).toContain('本次没有足够证据生成针对性复练建议');
    expect(html).not.toContain('确认创建复练任务');
  });

  it('blocks automatic tasks for degraded reports while keeping manual selection explicit', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel
        {...props}
        scoreV1={report()}
        scoreStatus="DEGRADED"
        onStartTargetedPractice={() => true}
      />,
    );
    expect(html).toContain('不可自动执行');
    expect(html).toContain('手动选择小节');
    expect(html).not.toContain('确认创建复练任务');
  });

  it('blocks all task creation when the active score fingerprint differs', () => {
    const html = renderToStaticMarkup(
      <TargetedPracticePanel
        {...props}
        activeScoreFingerprint="another-fp"
        scoreV1={report()}
        scoreStatus="AVAILABLE"
        onStartTargetedPractice={() => true}
      />,
    );
    expect(html).toContain('当前打开曲谱与这份报告不一致');
    expect(html).toMatch(/disabled/);
  });
});
