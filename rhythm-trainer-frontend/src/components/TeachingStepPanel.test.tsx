import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TeachingStepPanel from './TeachingStepPanel';
import type { TeachingLessonView, TeachingRunDTO } from '../services/teachingRunRepository';

function lesson(): TeachingLessonView {
  return {
    lessonId: 'steady-beat-hands',
    version: 1,
    title: '稳住拍点（左手→右手→合手）',
    description: '先把每个音放在拍点上。',
    objectives: [{ id: 'steady', statement: '每个音落在拍点上', evidenceType: 'onset-timing' }],
    explainScript: {
      title: '什么是“稳”',
      explanation: '稳不是慢，而是每个音都在该到的时刻到。先数拍，再弹。',
      prompts: ['先数两拍再开始', '错了不要停下来重来'],
      successCriteria: ['连续四个小节每个音都在拍点附近'],
    },
    coachingByStepId: {
      'hand-1': { coaching: '单手最容易越弹越快。' },
      'hand-2': { coaching: '换手会更生疏，允许更慢。' },
      'hands-together': { coaching: '合手对不齐就退回单手。' },
      'pass-check': { coaching: '按原速独立完成。' },
    },
    transferNote: '迁移检查使用未练过的新片段；V1 未执行时会如实标注。',
    reviewPolicy: { trigger: '通过检查完成 1 天后', suggestedIntervalDays: [1, 3, 7] },
  };
}

function run(overrides: Partial<TeachingRunDTO> = {}): TeachingRunDTO {
  return {
    schemaVersion: 1,
    runId: 'lesson-abc-123',
    templateVersion: 'hands-progression-v1',
    policyVersion: 'teaching-policy-v1',
    revision: 3,
    status: 'in_progress',
    scoreFingerprint: 'fp-teaching',
    scoreBarCount: 16,
    lessonId: 'steady-beat-hands',
    lessonVersion: 1,
    firstHand: 'right',
    sourceTakeId: null,
    sourceSelection: null,
    createdAtIso: '2026-10-26T00:00:00.000Z',
    updatedAtIso: '2026-10-26T00:01:00.000Z',
    currentStepId: 'hand-1',
    steps: [
      { stepRunId: 'understand-score', kind: 'study_score', title: '先听讲解：什么是“稳”', instruction: '先数拍。', status: 'completed', required: true, attemptCount: 1 },
      {
        stepRunId: 'hand-1',
        kind: 'guided_practice',
        title: '单手带练：右手',
        instruction: '先只弹一只手，慢速把音和拍点弹稳。',
        status: 'active',
        required: true,
        attemptCount: 0,
        measureRange: { startMeasure: 1, endMeasure: 4 },
        hands: 'right',
        tempoBpm: 55,
        practiceRequest: {
          scoreFingerprint: 'fp-teaching',
          scoreBarCount: 16,
          modeId: 'score',
          advanceMode: 'timeline',
          tempo: 55,
          hand: 'right',
          feedback: 'live',
          profile: 'standard',
          durationPolicy: 'disabled',
          loopEnabled: true,
          loopStartBar: 1,
          loopEndBar: 4,
        },
      },
      { stepRunId: 'hand-2', kind: 'guided_practice', title: '单手带练：左手', instruction: '换左手。', status: 'ready', required: true, attemptCount: 0, measureRange: { startMeasure: 1, endMeasure: 4 }, hands: 'left', tempoBpm: 55 },
      { stepRunId: 'hands-together', kind: 'guided_practice', title: '合手慢速带练', instruction: '合手。', status: 'ready', required: true, attemptCount: 0, measureRange: { startMeasure: 1, endMeasure: 4 }, hands: 'both', tempoBpm: 60 },
      { stepRunId: 'pass-check', kind: 'independent_performance', title: '合手原速 · 练习通过检查', instruction: '原速。', status: 'ready', required: true, attemptCount: 0, measureRange: { startMeasure: 1, endMeasure: 4 }, hands: 'both', tempoBpm: 72 },
    ],
    currentStep: null,
    availableActions: [
      { action: 'record-take', enabled: true, label: '登记这次演奏' },
      { action: 'abandon', enabled: true, label: '结束学习' },
    ],
    takeRefs: [],
    decisions: [],
    latestDecision: null,
    lesson: lesson(),
    ...overrides,
  } as TeachingRunDTO;
}

const decision = {
  decisionId: 'decision-1',
  policyVersion: 'teaching-policy-v1',
  sourceTakeId: 'take-9',
  sourceScoreFingerprint: 'fp-teaching',
  stepRunId: 'hand-1',
  action: 'focus_range' as const,
  reasonCode: 'REMEDIATION_REQUIRED',
  reason: '第 2 小节有 3 个事件被引擎判定为 MISSING。',
  highlights: [{
    source: 'score-measure',
    metric: 'matched',
    value: 4,
    measure: 1,
    detail: '该小节 4 个目标全部命中，平均绝对起音误差 9.0ms',
    takeId: 'take-9',
  }],
  evidenceRefs: [{ source: 'score-event', metric: 'MISSING', value: 3, measure: 2, takeId: 'take-9' }],
  learnerFeedback: {
    message: '有几个音没有出声。先别管快慢，把每个键都弹响。',
    nextAction: '慢速补齐漏掉的音，确认每个起音都出声后继续本阶段。',
    source: 'lesson' as const,
  },
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
    recommendedBpm: 45,
    recommendedHand: 'right' as const,
    recommendedMode: 'loop' as const,
    reason: '第 2 小节漏音。',
    action: '降低速度补齐。',
    status: 'EXECUTABLE',
    evidence: [],
    createdAtIso: '2026-10-26T00:01:00.000Z',
  },
};

const baseProps = {
  fingerprintMatch: true,
  busyAction: null,
  error: null,
  onAction: () => {},
  onStartPractice: () => true,
  takePending: null,
  onRestart: () => {},
  onExit: () => {},
};

describe('TeachingStepPanel', () => {
  it('renders the current step with Node-authored range, hand and bpm', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} />,
    );
    expect(html).toContain('单手带练：右手');
    expect(html).toContain('先只弹一只手，慢速把音和拍点弹稳。');
    expect(html).toContain('第 1–4 小节 · 右手 · 55 BPM');
    expect(html).toContain('开始这一步的练习');
    // Lesson coaching for this phase, not a generic hint.
    expect(html).toContain('单手最容易越弹越快。');
  });

  it('shows the lesson explanation on the study step', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel
        run={run({ status: 'ready', currentStepId: 'understand-score', currentStep: run().steps[0] })}
        {...baseProps}
      />,
    );
    expect(html).toContain('什么是“稳”');
    expect(html).toContain('稳不是慢，而是每个音都在该到的时刻到。');
    expect(html).toContain('先数两拍再开始');
    expect(html).toContain('过关标准');
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

  it('renders evidence-backed did-well, one fix, evidence and next step', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel
        run={run({ currentStep: run().steps[1], status: 'awaiting_evidence', latestDecision: decision })}
        {...baseProps}
      />,
    );
    expect(html).toContain('做得好');
    expect(html).toContain('第 1 小节');
    expect(html).toContain('全部命中');
    expect(html).toContain('一处要改');
    expect(html).toContain('有几个音没有出声');
    expect(html).toContain('漏音');
    expect(html).toContain('建议 45 BPM');
    expect(html).toContain('下一步');
    expect(html).toContain('慢速补齐漏掉的音');
    expect(html).toContain('证据详情');
    expect(html).toContain('MISSING');
  });

  it('never fabricates praise when the server reports untrusted evidence', () => {
    const untrusted = {
      ...decision,
      action: 'check_input' as const,
      reasonCode: 'INPUT_OR_ATTEMPT_UNTRUSTED',
      reason: '本次演奏的输入或完整性证据不足。',
      highlights: [],
      evidenceRefs: [],
      learnerFeedback: {
        message: '这次输入数据不可靠，老师不能下结论。先检查设备/连接再弹一遍。',
        nextAction: '检查输入健康后重弹本阶段。',
        source: 'lesson' as const,
      },
      prescription: undefined,
    };
    const html = renderToStaticMarkup(
      <TeachingStepPanel
        run={run({ currentStep: run().steps[1], status: 'awaiting_evidence', latestDecision: untrusted })}
        {...baseProps}
      />,
    );
    expect(html).toContain('老师不编造结论');
    expect(html).toContain('不能下结论');
    expect(html).not.toContain('全部命中');
  });

  it('warns when the loaded score does not match the run fingerprint', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} fingerprintMatch={false} />,
    );
    expect(html).toContain('当前打开的曲谱与本课程不一致');
    expect(html).toMatch(/disabled/);
  });

  it('shows the take-pending state and never fabricates completion', () => {
    const html = renderToStaticMarkup(
      <TeachingStepPanel run={run({ currentStep: run().steps[1] })} {...baseProps} takePending={{ takeId: 'take-7', persisted: false, status: 'pending-retry' }} />,
    );
    expect(html).toContain('尚未成功保存');
    expect(html).toContain('pending-retry');
    const completed = renderToStaticMarkup(
      <TeachingStepPanel
        run={run({
          status: 'completed',
          currentStepId: null,
          currentStep: null,
          latestDecision: {
            ...decision,
            action: 'advance',
            reasonCode: 'NO_TARGETED_REMEDIATION',
            transfer: { status: 'not-executed', note: 'V1 未执行迁移检查。' },
            reviewSuggestion: { trigger: '通过检查完成 1 天后', suggestedIntervalDays: [1, 3, 7] },
            prescription: undefined,
            evidenceRefs: [],
          },
        })}
        {...baseProps}
      />,
    );
    expect(completed).toContain('课程已完成');
    expect(completed).toContain('不代表已经掌握');
    expect(completed).toContain('迁移检查：未执行');
    expect(completed).toContain('复习建议');
    expect(completed).toContain('开始新课程');
  });
});
