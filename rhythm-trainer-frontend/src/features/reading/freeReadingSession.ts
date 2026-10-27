// Free note-reading session: untimed, any-order pitch matching.
//
// This is NOT a second scoring engine: free mode deliberately has no timing,
// duration or speed evaluation (task spec §1/§5.2). Everything here is
// set-membership bookkeeping over real MIDI note-on events, kept pure and
// unit-tested so the UI can only render what this module decided.

import { READING_KEY_HIGH, READING_KEY_LOW } from './readingKeys';

export type FreeReadingStatus = 'running' | 'paused' | 'completed' | 'ended-early';

export interface FreeReadingPitchStat {
  /** Times this pitch was a target and got matched. */
  hits: number;
  /** Times this pitch was pressed while NOT a remaining target. */
  wrongPresses: number;
}

export interface FreeReadingSnapshot {
  status: FreeReadingStatus;
  questionCount: number;
  currentIndex: number;
  currentTargets: readonly number[];
  /** Targets of the current question already matched (deduped). */
  currentHits: readonly number[];
  completedQuestions: number;
  /** Questions finished with zero wrong presses (first-try correct). */
  firstTryCorrectQuestions: number;
  totalWrongPresses: number;
  perPitch: ReadonlyMap<number, FreeReadingPitchStat>;
  /** Wrong presses grouped by the pressed pitch, for weakest-key display. */
  wrongByPitch: ReadonlyMap<number, number>;
}

export class FreeReadingSession {
  readonly questions: readonly number[][];
  #status: FreeReadingStatus = 'running';
  #index = 0;
  #hits = new Set<number>();
  #completed = 0;
  #firstTry = 0;
  #wrongPresses = 0;
  #perPitch = new Map<number, FreeReadingPitchStat>();
  #wrongByPitch = new Map<number, number>();
  #questionWrong = 0;

  constructor(questions: readonly number[][]) {
    if (!questions.length) throw new Error('FreeReadingSession: 至少需要一道题');
    for (const question of questions) {
      if (!question.length) throw new Error('FreeReadingSession: 每道题至少一个目标音');
      if (question.some((midi) => midi < READING_KEY_LOW || midi > READING_KEY_HIGH)) {
        throw new Error('FreeReadingSession: 目标音超出 81 键范围');
      }
    }
    this.questions = questions.map((question) => [...question].sort((a, b) => a - b));
  }

  get status(): FreeReadingStatus { return this.#status; }
  get currentIndex(): number { return this.#index; }
  get currentTargets(): readonly number[] { return this.questions[this.#index] ?? []; }
  get currentHits(): readonly number[] { return this.currentTargets.filter((midi) => this.#hits.has(midi)); }
  get completedQuestions(): number { return this.#completed; }
  get firstTryCorrectQuestions(): number { return this.#firstTry; }
  get totalWrongPresses(): number { return this.#wrongPresses; }

  pause(): void {
    if (this.#status === 'running') this.#status = 'paused';
  }

  resume(): void {
    if (this.#status === 'paused') this.#status = 'running';
  }

  /** User-initiated early end; keeps everything recorded so far. */
  endEarly(): void {
    if (this.#status === 'running' || this.#status === 'paused') this.#status = 'ended-early';
  }

  /**
   * Feed one real MIDI note-on. Release events are irrelevant here (no
   * duration scoring in free mode). Returns what the input was.
   */
  noteOn(midi: number): 'hit' | 'duplicate' | 'wrong' | 'ignored' {
    if (this.#status !== 'running') return 'ignored';
    if (midi < READING_KEY_LOW || midi > READING_KEY_HIGH) return 'ignored';
    if (this.#hits.has(midi) && this.currentTargets.includes(midi)) return 'duplicate';
    if (this.currentTargets.includes(midi)) {
      this.#hits.add(midi);
      this.#bump(this.#perPitch, midi).hits += 1;
      if (this.#hits.size === this.currentTargets.length) this.#completeQuestion();
      return 'hit';
    }
    this.#wrongPresses += 1;
    this.#questionWrong += 1;
    this.#bump(this.#perPitch, midi).wrongPresses += 1;
    this.#wrongByPitch.set(midi, (this.#wrongByPitch.get(midi) ?? 0) + 1);
    return 'wrong';
  }

  #completeQuestion(): void {
    this.#completed += 1;
    if (this.#questionWrong === 0) this.#firstTry += 1;
    this.#questionWrong = 0;
    if (this.#index + 1 >= this.questions.length) {
      this.#status = 'completed';
      return;
    }
    this.#index += 1;
    this.#hits = new Set<number>();
  }

  #bump(map: Map<number, FreeReadingPitchStat>, midi: number): FreeReadingPitchStat {
    const stat = map.get(midi) ?? { hits: 0, wrongPresses: 0 };
    map.set(midi, stat);
    return stat;
  }

  snapshot(): FreeReadingSnapshot {
    return {
      status: this.#status,
      questionCount: this.questions.length,
      currentIndex: this.#index,
      currentTargets: this.currentTargets,
      currentHits: this.currentHits,
      completedQuestions: this.#completed,
      firstTryCorrectQuestions: this.#firstTry,
      totalWrongPresses: this.#wrongPresses,
      perPitch: new Map(this.#perPitch),
      wrongByPitch: new Map(this.#wrongByPitch),
    };
  }

  /** Pressed pitches ranked by wrong count; the "weakest keys" list. */
  weakestPitches(limit = 6): Array<{ midi: number; wrong: number }> {
    return [...this.#wrongByPitch.entries()]
      .map(([midi, wrong]) => ({ midi, wrong }))
      .sort((a, b) => b.wrong - a.wrong || a.midi - b.midi)
      .slice(0, limit);
  }
}
