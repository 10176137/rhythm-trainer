/** Session time and pause evidence only. Rust owns scoring and target shifts.
 * Engine callbacks run before committing ledger state. A callback failure must
 * terminate the take if an external participant has already changed state. */
export class PauseLedger {
  #paused = null;
  #source = null;
  #sourceIntervals = [];
  #segments = [];
  #sequence = 0;
  #active = 'active-0';
  #now = 0;
  get pausedAtMs() { return this.#paused; }
  get pausedSourceMs() { return this.#source; }
  get pauseIntervalsSourceMs() { return [...this.#sourceIntervals]; }
  get pauseSegments() { return this.#segments.map(segment => ({ ...segment })); }
  get activePauseSegmentId() { return this.#active; }
  get lastNowMs() { return this.#now; }
  reset() {
    this.#paused = null; this.#source = null; this.#sourceIntervals = [];
    this.#segments = []; this.#sequence = 0; this.#active = 'active-0'; this.#now = 0;
  }
  canAdvance(nowMs) { return this.#paused === null && Number.isFinite(nowMs) && nowMs >= this.#now; }
  advance(nowMs) { this.#validate(nowMs, 'tick'); this.#now = nowMs; }
  #validate(nowMs, command) {
    if (!Number.isFinite(nowMs) || nowMs < this.#now) throw new Error(`${command} 时间非法或早于上次会话时间`);
  }
  pause(nowMs, sourceMs, apply) {
    if (this.#paused !== null) return { duplicate: true };
    this.#validate(nowMs, 'pause');
    const judgments = apply();
    this.#paused = nowMs;
    this.#source = Number.isFinite(sourceMs) ? sourceMs : null;
    this.#active = `pause-${++this.#sequence}`;
    this.#segments.push({ segmentId: this.#active, startSession: nowMs, endSession: null });
    this.#now = nowMs;
    return { duplicate: false, judgments };
  }
  resume(nowMs, sourceMs, apply) {
    if (this.#paused === null) return { duplicate: true, deltaMs: 0, resumedAtMs: this.#now };
    this.#validate(nowMs, 'resume');
    const pausedAtMs = this.#paused;
    const deltaMs = nowMs - pausedAtMs;
    apply();
    this.#segments.at(-1).endSession = nowMs;
    if (this.#source !== null && Number.isFinite(sourceMs) && sourceMs >= this.#source) this.#sourceIntervals.push(this.#source, sourceMs);
    this.#source = null; this.#paused = null; this.#now = nowMs;
    this.#active = `active-${++this.#sequence}`;
    return { duplicate: false, deltaMs, pausedAtMs, resumedAtMs: nowMs };
  }
  finish() {
    if (this.#source !== null) this.#sourceIntervals.push(this.#source, Number.MAX_SAFE_INTEGER);
    this.#source = null; this.#paused = null;
    // Keep the final open segment as evidence; finishing is not resuming.
  }
}
