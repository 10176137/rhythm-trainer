import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TeachingStepPanel from './TeachingStepPanel';
import type { TeachingRunDTO } from '../services/teachingRunRepository';

function run(overrides: Partial<TeachingRunDTO> = {}): TeachingRunDTO {
  return {
    schemaVersion: 1,
    runId: 'lesson-abc-123',
    templateVersion: 'guided-score-v1',
    policyVersion: 'teaching-policy-v1',
    revision: 3,
    status: 'in_progress',
    scoreFingerprint: 'fp-teaching',
    scoreBarCount: 16,
    sourceTakeId: null,
    sourceSelection: null,
    createdAtIso: '2026-10-26T00:00:00.000Z',
    updatedAtIso: '2026-10-26T00:01:00.000Z',
    currentStepId: 'guided-practice',
    steps: [
      { stepRunId: 'understand-score', kind: 'study_score', title: '先认识这段乐谱', instruction: '看清调号拍号。', status: 'completed', required: true, attemptCount: 1 },
      {
        stepRunId: 'guided-practice',
        kind: 'guided_practice',
        title: '跟着提示练习',
        instruction: '练短片段。',
        status: 'active',
        required: true,
        attemptCount: 0,
        measureRange: { startMeasure: 1, endMeasure: 4 },
        hands: 'right',
        tempoBpm: 72,
        practiceRequest: {
          scoreFingerprint: 'fp-teaching',
          scoreBarCount: 16,
          modeId: 'score',
          advanceMode: 'timeline',
          tempo: 72,
          hand: 'right',
          feedback: 'live',
          profile: 'standard',
          durationPolicy: 'disabled',
          loopEnabled: true,
          loopStartBar: 1,
          loopEndBar: 4,
        },
      },
      { stepRunId: 'independent-performance', kind: 'independent_performance', title: '独立演奏', instruction: '独立完成。', status: 'ready', required: true, attemptCount: 0, measureRange: { startMeasure: 1, endMeasure: 16 }, hands: 'right', tempoBpm: 72 },
    ],
    currentStep: null,
    availableActions: [
      { action: 'record-take', enabled: true, label: '登记这次演奏' },
      { action: 'abandon', enabled: true, label: '结束学习' },
    ],
    takeRefs: [],
    decisions: [],
    latestDecision: null,
    ...overrides,
  } as TeachingRunDTO;
}

const baseProps = {
  fingerprintMatch: true,
  busyAction: null,
  error: null,
  onAction: () => {},
  onStartPractice: () => true,
  takePending: null,
  onBackToWorkbench: () => {},
};

describe('TeachingStepPanel', () => {
  it('renders the current step with Node-authored range, hand and bpm', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} />,
    );
    expect(html).toContain('跟着提示练习');
    expect(html).toContain('第 1–4 小节');
    expect(html).toContain('72 BPM');
    expect(html).toContain('开始这一步的练习');
  });

  it('renders only actions the server allows, and disables them while busy', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} />,
    );
    expect(html).toContain('登记这次演奏');
    expect(html).not.toContain('跳过此步');
    const busy = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} busyAction="record-take" />,
    );
    expect(busy).toContain('处理中…');
    expect(busy).toContain('disabled');
  });

  it('renders the decision reason and prescription without raw enums as user copy', () => {
    const withDecision = run({
      currentStep: run().steps[1],
      latestDecision: {
        decisionId: 'decision-1',
        policyVersion: 'teaching-policy-v1',
        sourceTakeId: 'take-9',
        sourceScoreFingerprint: 'fp-teaching',
        stepRunId: 'guided-practice',
        action: 'focus_range',
        reasonCode: 'REMEDIATION_REQUIRED',
        reason: '第 2 小节有 3 个事件被引擎判定为 MISSING。',
        evidenceRefs: [{ source: 'score-event', metric: 'MISSING', value: 3, measure: 2, takeId: 'take-9' }],
        createdAtIso: '2026-10-26T00:01:00.000Z',
        prescription: {
          prescriptionId: 'rx-1',
          sourceTakeId: 'take-9',
          sourceReportId: 'take-9',
          sourceScoreFingerprint: 'fp-teaching',
          ruleId: 'MISSING_NOTES_V1',
          problemType: 'missing-notes',
          confidenceStatus: 'medium',
          measureRange: { startMeasure: 2, endMeasure: 2 },
          recommendedBpm: 60,
          recommendedHand: 'right',
          recommendedMode: 'loop',
          reason: '第 2 小节漏音。',
          action: '降低速度补齐。',
          status: 'EXECUTABLE',
          evidence: [],
          createdAtIso: '2026-10-26T00:01:00.000Z',
        },
      },
    });
    const html = renderToStaticMarkup(<TeachingStepPanel run={withDecision} {...baseProps} />);
    expect(html).toContain('第 2 小节有 3 个事件被引擎判定为 MISSING。');
    expect(html).toContain('漏音');
    expect(html).toContain('建议 60 BPM');
    expect(html).toContain('证据详情');
  });

  it('warns when the loaded score does not match the run fingerprint', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} fingerprintMatch={false} />,
    );
    expect(html).toContain('与当前打开曲谱不一致');
    expect(html).toMatch(/disabled/);
  });

  it('shows the take-pending state and never fabricates completion', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} takePending={{ takeId: 'take-7', persisted: false, status: 'pending-retry' }} />,
    );
    expect(html).toContain('尚未成功保存');
    expect(html).toContain('pending-retry');
    const completed = renderToStaticMarkup(
      <TeachingStepPanel run={run({ status: 'completed', currentStepId: null, currentStep: null })} {...baseProps} />,
    );
    expect(completed).toContain('课程已完成');
    expect(completed).toContain('不代表已经掌握');
  });
});
