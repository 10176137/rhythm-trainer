import type { FreeReadingSession } from './freeReadingSession';

interface ReadingNoteInput {
  midi: number;
  isRelease: boolean;
  source: 'midi' | 'virtual';
}

export interface ReadingInputFeedback extends ReadingNoteInput {
  result: ReturnType<FreeReadingSession['noteOn']>;
}

/** Both hardware and virtual input reach untimed reading before timed modes. */
export function forwardReadingInput(
  session: FreeReadingSession | null,
  input: ReadingNoteInput,
  onFeedback: (feedback: ReadingInputFeedback) => void,
): boolean {
  if (!session || (session.status !== 'running' && session.status !== 'paused')) return false;
  // Consumed releases and paused input must not fall through to timed scoring.
  if (!input.isRelease) onFeedback({ ...input, result: session.noteOn(input.midi) });
  return true;
}
