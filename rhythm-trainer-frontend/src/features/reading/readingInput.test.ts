import { describe, expect, it, vi } from 'vitest';
import { FreeReadingSession } from './freeReadingSession';
import { forwardReadingInput, heldReadingErrors, type ReadingInputFeedback } from './readingInput';

describe('untimed reading input routing', () => {
  it.each(['midi', 'virtual'] as const)('advances chords from %s input and emits feedback for rendering', (source) => {
    const session = new FreeReadingSession([[60, 64], [67]]);
    const feedback: ReadingInputFeedback[] = [];
    const emit = (value: ReadingInputFeedback) => { feedback.push(value); };
    for (const midi of [60, 64, 67]) {
      expect(forwardReadingInput(session, { midi, isRelease: false, source }, emit)).toBe(true);
    }
    expect(session.status).toBe('completed');
    expect(feedback.map((value) => [value.midi, value.result, value.source])).toEqual([
      [60, 'hit', source], [64, 'hit', source], [67, 'hit', source],
    ]);
    expect(session.evidence()).toEqual([60, 64, 67].map((midi) => ({ type: 'note', midi })));
  });

  it('consumes hardware Note Off without treating it as a second answer', () => {
    const session = new FreeReadingSession([[60], [60]]);
    const feedback = vi.fn();
    forwardReadingInput(session, { midi: 60, isRelease: false, source: 'midi' }, feedback);
    expect(forwardReadingInput(session, { midi: 60, isRelease: true, source: 'midi' }, feedback)).toBe(true);
    expect(session.completedQuestions).toBe(1);
    expect(feedback).toHaveBeenCalledTimes(2);
    expect(feedback).toHaveBeenLastCalledWith(expect.objectContaining({ isRelease: true, result: 'ignored' }));
    expect(session.evidence()).toEqual([{ type: 'note', midi: 60 }]);
  });

  it('keeps paused hardware notes out of timed scoring and answer evidence', () => {
    const session = new FreeReadingSession([[60], [64]]);
    session.pause();
    const feedback = vi.fn();
    expect(forwardReadingInput(session, { midi: 60, isRelease: false, source: 'midi' }, feedback)).toBe(true);
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ result: 'ignored', source: 'midi' }));
    expect(session.evidence()).toEqual([]);
    expect(session.completedQuestions).toBe(0);
  });

  it('leaves other practice modes alone when no reading session is active', () => {
    const feedback = vi.fn();
    const input = { midi: 60, isRelease: false, source: 'midi' } as const;
    expect(forwardReadingInput(null, input, feedback)).toBe(false);
    const session = new FreeReadingSession([[60]]);
    session.endEarly();
    expect(forwardReadingInput(session, input, feedback)).toBe(false);
    expect(feedback).not.toHaveBeenCalled();
  });

  it('retains the answered question and its green hits after automatic advancement', () => {
    const session = new FreeReadingSession([[60], [67]]);
    const feedback = vi.fn();
    forwardReadingInput(session, { midi: 60, isRelease: false, source: 'midi' }, feedback);
    expect(session.currentIndex).toBe(1);
    expect(feedback).toHaveBeenLastCalledWith(expect.objectContaining({
      questionIndex: 0, questionTargets: [60], questionHits: [60], completedQuestion: true,
    }));
  });

  it('removes only the released wrong note, including releases while paused', () => {
    const session = new FreeReadingSession([[60, 64, 67]]);
    let held: number[] = [];
    const feedback = (event: ReadingInputFeedback) => { held = heldReadingErrors(held, event); };
    for (const midi of [61, 66, 60]) forwardReadingInput(session, { midi, isRelease: false, source: 'midi' }, feedback);
    expect(held).toEqual([61, 66]);
    session.pause();
    forwardReadingInput(session, { midi: 61, isRelease: true, source: 'midi' }, feedback);
    expect(held).toEqual([66]);
    forwardReadingInput(session, { midi: 66, isRelease: true, source: 'midi' }, feedback);
    expect(held).toEqual([]);
    expect(session.evidence()).toHaveLength(3);
  });

  it('still clears held errors during the final green feedback after completion', () => {
    const session = new FreeReadingSession([[60]]);
    let held: number[] = [];
    const feedback = (event: ReadingInputFeedback) => { held = heldReadingErrors(held, event); };
    forwardReadingInput(session, { midi: 61, isRelease: false, source: 'midi' }, feedback);
    forwardReadingInput(session, { midi: 60, isRelease: false, source: 'midi' }, feedback);
    expect(session.status).toBe('completed');
    expect(held).toEqual([61]);
    forwardReadingInput(session, { midi: 61, isRelease: true, source: 'midi' }, feedback);
    expect(held).toEqual([]);
    expect(session.evidence()).toHaveLength(2);
  });
});
