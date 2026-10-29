import type { FreeReadingSession } from './freeReadingSession';

interface ReadingNoteInput {
  midi: number;
  isRelease: boolean;
  source: 'midi' | 'virtual';
}

export interface ReadingInputFeedback extends ReadingNoteInput {
  result: ReturnType<FreeReadingSession['noteOn']>;
  questionIndex: number;
  questionTargets: readonly number[];
  questionHits: readonly number[];
  completedQuestion: boolean;
}

export function heldReadingErrors(previous: readonly number[], input: ReadingInputFeedback): number[] {
  const held = new Set(previous);
  if (input.isRelease || input.result === 'hit' || input.result === 'duplicate') held.delete(input.midi);
  else if (input.result === 'wrong') held.add(input.midi);
  return [...held].sort((a, b) => a - b);
}

/** Both hardware and virtual input reach untimed reading before timed modes. */
export function forwardReadingInput(
  session: FreeReadingSession | null,
  input: ReadingNoteInput,
  onFeedback: (feedback: ReadingInputFeedback) => void,
): boolean {
  if (!session || (session.status !== 'running' && session.status !== 'paused'
    && !(input.isRelease && session.status === 'completed'))) return false;
  const questionIndex = session.currentIndex;
  const questionTargets = [...session.currentTargets];
  const completedBefore = session.completedQuestions;
  // Releases update held-note visuals, but never become answer evidence.
  const result = input.isRelease ? 'ignored' : session.noteOn(input.midi);
  onFeedback({ ...input, result, questionIndex, questionTargets,
    questionHits: session.currentIndex === questionIndex ? [...session.currentHits] : questionTargets,
    completedQuestion: session.completedQuestions > completedBefore });
  return true;
}
