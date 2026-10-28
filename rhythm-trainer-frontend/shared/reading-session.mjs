// Untimed MIDI set-membership bookkeeping shared by browser and server replay.
// Timing/duration scoring continues to belong to the Rust engine.
export class FreeReadingSession {
  #status = 'running';
  #index = 0;
  #hits = new Set();
  #completed = 0;
  #firstTry = 0;
  #wrongPresses = 0;
  #perPitch = new Map();
  #wrongByPitch = new Map();
  #weakTargets = new Map();
  #confusions = [];
  #questionWrong = 0;
  #hinted = new Set();
  #attempted = new Set();
  #events = [];
  #wrongQuestions = new Set();
  constructor(questions, { task = 'practice' } = {}) {
    if (!Array.isArray(questions) || !questions.length || questions.length > 80) throw new Error('需要 1–80 道题');
    if (!['practice', 'test'].includes(task)) throw new Error('练习类型非法');
    for (const q of questions) {
      if (!Array.isArray(q) || q.length < 1 || q.length > 4 || new Set(q).size !== q.length
        || q.some((m) => !Number.isInteger(m) || m < 28 || m > 108)) throw new Error('目标音非法');
    }
    this.questions = Object.freeze(questions.map((q) => Object.freeze([...q].sort((a, b) => a - b))));
    this.task = task;
  }
  get status() { return this.#status; }
  get currentIndex() { return this.#index; }
  get currentTargets() { return this.questions[this.#index] ?? []; }
  get currentHits() { return this.currentTargets.filter((m) => this.#hits.has(m)); }
  get completedQuestions() { return this.#completed; }
  get firstTryCorrectQuestions() { return this.#firstTry; }
  get totalWrongPresses() { return this.#wrongPresses; }
  pause() { if (this.#status === 'running') this.#status = 'paused'; }
  resume() { if (this.#status === 'paused') this.#status = 'running'; }
  endEarly() { if (['running', 'paused'].includes(this.#status)) this.#status = 'ended-early'; }
  hint() {
    if (this.#status !== 'running' || this.task === 'test' || this.#hinted.has(this.#index)) return false;
    this.#hinted.add(this.#index);
    this.#attempted.add(this.#index);
    this.#events.push({ type: 'hint' });
    return true;
  }
  noteOn(midi) {
    if (this.#status !== 'running' || !Number.isInteger(midi) || midi < 28 || midi > 108) return 'ignored';
    if (this.#events.length >= 5000) { this.endEarly(); return 'ignored'; }
    this.#events.push({ type: 'note', midi });
    this.#attempted.add(this.#index);
    if (this.#hits.has(midi)) return 'duplicate';
    if (this.currentTargets.includes(midi)) {
      this.#hits.add(midi);
      this.#bump(midi).hits += 1;
      if (this.#hits.size === this.currentTargets.length) {
        this.#completed += 1;
        if (!this.#questionWrong && !this.#hinted.has(this.#index)) this.#firstTry += 1;
        this.#questionWrong = 0;
        if (this.#index + 1 === this.questions.length) this.#status = 'completed';
        else { this.#index += 1; this.#hits = new Set(); }
      }
      return 'hit';
    }
    this.#wrongPresses += 1;
    this.#questionWrong += 1;
    this.#wrongQuestions.add(this.#index);
    this.#bump(midi).wrongPresses += 1;
    this.#wrongByPitch.set(midi, (this.#wrongByPitch.get(midi) ?? 0) + 1);
    const remainingTargets = this.currentTargets.filter((m) => !this.#hits.has(m));
    this.#confusions.push({ remainingTargets, pressed: midi, questionIndex: this.#index });
    for (const target of remainingTargets) this.#weakTargets.set(target, (this.#weakTargets.get(target) ?? 0) + 1);
    return 'wrong';
  }
  #bump(midi) {
    if (!this.#perPitch.has(midi)) this.#perPitch.set(midi, { hits: 0, wrongPresses: 0 });
    return this.#perPitch.get(midi);
  }
  weakestPitches(limit = 6) {
    return [...this.#weakTargets].map(([midi, wrong]) => ({ midi, wrong }))
      .sort((a, b) => b.wrong - a.wrong || a.midi - b.midi).slice(0, limit);
  }
  reviewQuestions() {
    const indices = new Set([...this.#wrongQuestions, ...this.#hinted]);
    return [...indices].sort((a, b) => a - b).map((i) => [...this.questions[i]]);
  }
  evidence() { return this.#events.map((e) => ({ ...e })); }
  snapshot() {
    const hits = [...this.#perPitch.values()].reduce((sum, s) => sum + s.hits, 0);
    return {
      status: this.#status, task: this.task, questionCount: this.questions.length,
      currentIndex: this.#index, currentTargets: [...this.currentTargets], currentHits: this.currentHits,
      completedQuestions: this.#completed, firstTryCorrectQuestions: this.#firstTry,
      attemptedQuestions: this.#attempted.size, totalWrongPresses: this.#wrongPresses,
      hitAccuracy: hits + this.#wrongPresses ? Math.round(hits / (hits + this.#wrongPresses) * 100) : null,
      firstTryAccuracy: this.#attempted.size ? Math.round(this.#firstTry / this.#attempted.size * 100) : null,
      totalHits: hits, hintedQuestions: this.#hinted.size,
      perPitch: new Map([...this.#perPitch].map(([m, s]) => [m, { ...s }])), wrongByPitch: new Map(this.#wrongByPitch),
      confusions: this.#confusions.map((c) => ({ ...c, remainingTargets: [...c.remainingTargets] })),
    };
  }
}
