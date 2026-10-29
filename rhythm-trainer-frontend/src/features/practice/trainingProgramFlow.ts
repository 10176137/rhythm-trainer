import type { GeneratedSkillDrill, TrainingProgram, TrainingProgramReview } from '../../../shared/training-contract';
import { trainingRepository } from '../../services/trainingRepository';

export interface ProgramFlowOptions {
  program: TrainingProgram; takeId: string; signal: AbortSignal; isStopped: () => boolean;
  onReview: (review: TrainingProgramReview) => void; onLaunch: (drill: GeneratedSkillDrill) => boolean;
  onComplete: () => void; wait?: (signal: AbortSignal) => Promise<void>;
}
function waitBetweenSegments(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    // The engine already schedules a three-second count-in for the new Take.
    // Yield for cancellation without adding another idle countdown here.
    const timer = setTimeout(done, 0);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** Request lifecycle only. The server owns eligibility, remaining time and material. */
export async function runTrainingProgramFlow(
  options: ProgramFlowOptions,
  repository: Pick<typeof trainingRepository, 'reviewProgram' | 'nextProgram'> = trainingRepository,
) {
  const { program, takeId, signal } = options;
  const cancelled = () => signal.aborted || options.isStopped();
  const review = await repository.reviewProgram(program.id, takeId, signal);
  if (signal.aborted) return;
  options.onReview(review);
  if (program.config.mode === 'assessment' || !review.assessable || cancelled()) return;
  await (options.wait ?? waitBetweenSegments)(signal);
  if (cancelled()) return;
  const next = await repository.nextProgram(program.id, takeId, signal);
  if (cancelled()) return;
  if (next.drill) {
    if (!options.onLaunch(next.drill)) throw new Error('下一段未能启动，请重新选择训练计划。');
  } else options.onComplete();
}
