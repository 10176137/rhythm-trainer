// Horizontal progress track for a LessonRun. Presentation only: step order,
// titles and statuses all come from the server run; no phase is invented here.

import type { TeachingRunDTO, TeachingStep } from '../services/teachingRunRepository';

const KIND_CN: Record<TeachingStep['kind'], string> = {
  study_score: '讲解',
  demonstrate: '示范',
  guided_practice: '带练',
  focused_practice: '针对性',
  independent_performance: '通过检查',
};

const HAND_CN: Record<'left' | 'right' | 'both', string> = {
  left: '左手',
  right: '右手',
  both: '双手',
};

function stepCaption(step: TeachingStep): string {
  if (step.hands && step.tempoBpm) return `${HAND_CN[step.hands]} · ${step.tempoBpm} BPM`;
  if (step.hands) return HAND_CN[step.hands];
  return KIND_CN[step.kind];
}

/** Short label for the track; the full title stays on the teacher panel. */
function trackTitle(step: TeachingStep): string {
  if (step.stepRunId === 'understand-score' || step.kind === 'study_score') return '讲解';
  if (step.stepRunId === 'hand-1' || step.stepRunId === 'hand-2') return '单手慢练';
  if (step.stepRunId === 'hands-together') return '合手慢练';
  if (step.stepRunId === 'pass-check' || step.kind === 'independent_performance') return '原速通过检查';
  if (step.kind === 'focused_practice') return '针对性慢练';
  return step.title;
}

interface Props {
  run: TeachingRunDTO;
}

export default function TeachingStepTrack({ run }: Props) {
  return (
    <ol className="teaching-track" aria-label="课程步骤">
      {run.steps.map((step, index) => {
        const current = step.stepRunId === run.currentStepId;
        const state = step.status === 'completed' || step.status === 'skipped'
          ? step.status
          : current ? 'current' : 'pending';
        return (
          <li
            key={step.stepRunId}
            className={`teaching-track-step ${state}`}
            aria-current={current ? 'step' : undefined}
          >
            <span className="teaching-track-index">{step.status === 'completed' ? '✓' : index + 1}</span>
            <span className="teaching-track-copy">
              <strong>{trackTitle(step)}</strong>
              <small>{stepCaption(step)}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
