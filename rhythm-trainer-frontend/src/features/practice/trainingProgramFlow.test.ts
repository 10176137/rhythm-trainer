import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSkillDrill, TrainingProgram, TrainingProgramReview } from '../../../shared/training-contract';
import { runTrainingProgramFlow, shouldFinishTrainingSegment } from './trainingProgramFlow';

function setup() {
  const controller = new AbortController();
  const program = { id: 'program-test', config: { mode: 'continuous' } } as TrainingProgram;
  const review = { schemaVersion: 1, assessable: true } as TrainingProgramReview;
  const drill = { title: 'server material' } as GeneratedSkillDrill;
  const repository = { reviewProgram: vi.fn().mockResolvedValue(review), nextProgram: vi.fn().mockResolvedValue({ schemaVersion: 1, drill }) };
  const options = { program, takeId: 'take-test', signal: controller.signal, isStopped: () => false, onReview: vi.fn(), onLaunch: vi.fn().mockReturnValue(true), onComplete: vi.fn(), wait: vi.fn().mockResolvedValue(undefined) };
  return { controller, program, review, drill, repository, options };
}
describe('continuous program UI lifecycle', () => {
  it('waits for a persisted server review and launches only the server-provided next segment', async () => {
    const s = setup(); await runTrainingProgramFlow(s.options, s.repository);
    expect(s.options.onReview).toHaveBeenCalledWith(s.review);
    expect(s.repository.nextProgram).toHaveBeenCalledWith(s.program.id, 'take-test', s.controller.signal);
    expect(s.options.onLaunch).toHaveBeenCalledWith(s.drill);
  });
  it.each(['assessment', 'insufficient', 'stopped'])('does not continue %s work', async (kind) => {
    const s = setup(); if (kind === 'assessment') s.program.config.mode = 'assessment';
    if (kind === 'insufficient') s.review.assessable = false;
    if (kind === 'stopped') s.options.isStopped = () => true;
    await runTrainingProgramFlow(s.options, s.repository);
    expect(s.repository.nextProgram).not.toHaveBeenCalled();
  });
  it('cancels safely while waiting and after a late next-segment response', async () => {
    const s = setup(); s.options.wait = vi.fn(async () => s.controller.abort());
    await runTrainingProgramFlow(s.options, s.repository);
    expect(s.repository.nextProgram).not.toHaveBeenCalled();
    const late = setup(); late.repository.nextProgram.mockImplementation(async () => { late.controller.abort(); return { schemaVersion: 1, drill: late.drill }; });
    await runTrainingProgramFlow(late.options, late.repository);
    expect(late.options.onLaunch).not.toHaveBeenCalled();
  });
  it('finishes timed work when the server returns no further segment', async () => {
    const s = setup(); s.program.config.mode = 'timed'; s.repository.nextProgram.mockResolvedValue({ schemaVersion: 1, drill: null });
    await runTrainingProgramFlow(s.options, s.repository);
    expect(s.options.onComplete).toHaveBeenCalledOnce(); expect(s.options.onLaunch).not.toHaveBeenCalled();
  });
  it('surfaces persistence failures instead of skipping to another segment', async () => {
    const s = setup(); s.repository.reviewProgram.mockRejectedValue(new Error('not saved'));
    await expect(runTrainingProgramFlow(s.options, s.repository)).rejects.toThrow('not saved');
    expect(s.repository.nextProgram).not.toHaveBeenCalled();
  });
});


describe('training segment completion boundary', () => {
  const running = { program: { seconds: 60 } as TrainingProgram, status: 'running' as const, countInMs: 3000, elapsedMs: 62999, pauseShiftMs: 0 };
  it('finishes at the whole score end including count-in and trailing rests', () => {
    expect(shouldFinishTrainingSegment(running)).toBe(false);
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 63000 })).toBe(true);
  });
  it('excludes time spent paused and never closes a paused segment', () => {
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 70000, pauseShiftMs: 10000 })).toBe(false);
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 73000, pauseShiftMs: 10000 })).toBe(true);
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 80000, status: 'paused' })).toBe(false);
  });
  it('leaves manual single-drill sessions and sessions without engine timing alone', () => {
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 80000, program: undefined })).toBe(false);
    expect(shouldFinishTrainingSegment({ ...running, elapsedMs: 80000, countInMs: null })).toBe(false);
  });
});
