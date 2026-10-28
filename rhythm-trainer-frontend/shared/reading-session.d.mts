export type FreeReadingStatus = 'running' | 'paused' | 'completed' | 'ended-early';
export type ReadingEvidenceEvent = { type: 'note'; midi: number } | { type: 'hint' };
export interface FreeReadingPitchStat { hits: number; wrongPresses: number }
export interface FreeReadingSnapshot {
  status: FreeReadingStatus; task: 'practice' | 'test'; questionCount: number; currentIndex: number;
  currentTargets: readonly number[]; currentHits: readonly number[];
  completedQuestions: number; firstTryCorrectQuestions: number; attemptedQuestions: number;
  totalWrongPresses: number; totalHits: number; hintedQuestions: number;
  hitAccuracy: number | null; firstTryAccuracy: number | null;
  perPitch: ReadonlyMap<number, FreeReadingPitchStat>; wrongByPitch: ReadonlyMap<number, number>;
  confusions: Array<{ remainingTargets: number[]; pressed: number; questionIndex: number }>;
}
export class FreeReadingSession {
  constructor(questions: readonly (readonly number[])[], options?: { task?: 'practice' | 'test' });
  readonly questions: readonly (readonly number[])[]; readonly task: 'practice' | 'test';
  readonly status: FreeReadingStatus; readonly currentIndex: number; readonly currentTargets: readonly number[];
  readonly currentHits: readonly number[]; readonly completedQuestions: number; readonly firstTryCorrectQuestions: number;
  readonly totalWrongPresses: number;
  pause(): void; resume(): void; endEarly(): void; hint(): boolean;
  noteOn(midi: number): 'hit' | 'duplicate' | 'wrong' | 'ignored';
  snapshot(): FreeReadingSnapshot; weakestPitches(limit?: number): Array<{ midi: number; wrong: number }>;
  reviewQuestions(): number[][]; evidence(): ReadingEvidenceEvent[];
}
