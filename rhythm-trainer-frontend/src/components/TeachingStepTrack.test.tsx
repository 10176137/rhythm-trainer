import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import TeachingStepTrack from './TeachingStepTrack';
import type { TeachingRunDTO, TeachingStep } from '../services/teachingRunRepository';

function step(overrides: Partial<TeachingStep> & Pick<TeachingStep, 'stepRunId' | 'kind' | 'title' | 'status'>): TeachingStep {
  return { instruction: '', required: true, attemptCount: 0, ...overrides };
}

function run(steps: TeachingStep[], currentStepId: string): TeachingRunDTO {
  return {
    schemaVersion: 1,
    runId: 'lesson-track',
    templateVersion: 'hands-progression-v1',
    policyVersion: 'teaching-policy-v1',
    revision: 3,
    status: 'in_progress',
    scoreFingerprint: 'fp',
    scoreBarCount: 8,
    lessonId: 'steady-beat-hands',
    lessonVersion: 1,
    firstHand: 'right',
    sourceTakeId: null,
    sourceSelection: null,
    createdAtIso: '2026-10-26T00:00:00.000Z',
    updatedAtIso: '2026-10-26T00:00:00.000Z',
    currentStepId,
    steps,
    currentStep: steps.find((item) => item.stepRunId === currentStepId) ?? null,
    availableActions: [],
    takeRefs: [],
    decisions: [],
    latestDecision: null,
    lesson: null,
  };
}

describe('TeachingStepTrack', () => {
  it('renders the server steps with short labels and hand/tempo captions', () => {
    const steps = [
      step({ stepRunId: 'understand-score', kind: 'study_score', title: '先听讲解：什么是“稳”', status: 'completed' }),
      step({ stepRunId: 'hand-1', kind: 'guided_practice', title: '单手带练：右手', hands: 'right', tempoBpm: 55, status: 'completed' }),
      step({ stepRunId: 'hand-2', kind: 'guided_practice', title: '单手带练：左手', hands: 'left', tempoBpm: 55, status: 'active' }),
      step({ stepRunId: 'hands-together', kind: 'guided_practice', title: '合手慢速带练', hands: 'both', tempoBpm: 60, status: 'ready' }),
      step({ stepRunId: 'pass-check', kind: 'independent_performance', title: '合手原速 · 练习通过检查', hands: 'both', tempoBpm: 72, status: 'ready' }),
    ];
    const html = renderToStaticMarkup(<TeachingStepTrack run={run(steps, 'hand-2')} />);
    expect(html).toContain('讲解');
    expect(html).toContain('单手慢练');
    expect(html).toContain('合手慢练');
    expect(html).toContain('原速通过检查');
    expect(html).toContain('左手 · 55 BPM');
    expect(html).toContain('✓');
    expect(html).toContain('aria-current="step"');
    // No phase that the server did not send.
    expect(html.match(/teaching-track-step/g)).toHaveLength(5);
  });

  it('keeps an inserted remediation step on the track', () => {
    const steps = [
      step({ stepRunId: 'understand-score', kind: 'study_score', title: '先听讲解', status: 'completed' }),
      step({ stepRunId: 'hand-1', kind: 'guided_practice', title: '单手带练', status: 'completed' }),
      step({ stepRunId: 'focus-missing-notes-3-3', kind: 'focused_practice', title: '针对性练习：漏音', hands: 'right', tempoBpm: 45, status: 'active' }),
    ];
    const html = renderToStaticMarkup(<TeachingStepTrack run={run(steps, 'focus-missing-notes-3-3')} />);
    expect(html).toContain('针对性慢练');
    expect(html).toContain('右手 · 45 BPM');
  });
});
