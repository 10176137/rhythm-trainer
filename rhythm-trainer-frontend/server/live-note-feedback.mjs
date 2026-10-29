/** Presentation of Rust pitch/onset alignment only. Never used as final scores.
 * Only ingress-admitted onsets enter here; pause/count-in/duplicate suppression
 * stays in the engine server. Releases/duration are assessed by the final report.
 */
export class LiveNoteFeedback {
  #events;
  #windows;
  #scorePerformance;
  #performed = new Map();
  #alignment = new Map();
  #shown = new Map();
  #dirty = false;

  constructor(scoreEvents, targets, scorePerformance) {
    this.#events = scoreEvents.map((event) => ({ ...event }));
    this.#windows = new Map(this.#events.map((event) => {
      const target = targets.find((item) => Math.abs(item.atMs - event.targetOnsetMs) < .01);
      if (!target) throw new Error('Live feedback event has no validated timing target');
      return [event.scoreEventId, target.goodWindowMs];
    }));
    this.#scorePerformance = scorePerformance;
  }

  addOnset(id, pitch, onsetMs) {
    if (this.#performed.has(id)) return;
    this.#performed.set(id, { performedNoteId: id, pitch, onsetMs, pairingStatus: 'missing-release' });
    this.#dirty = true;
  }

  resume(pausedAtMs, deltaMs) {
    for (const event of this.#events) {
      if (event.targetOnsetMs >= pausedAtMs) event.targetOnsetMs += deltaMs;
    }
    this.#dirty = this.#performed.size > 0;
  }

  update(nowMs) {
    if (this.#dirty) {
      // Same Rust alignment as the final report; cache until evidence changes.
      // Calling code treats failure as unavailable feedback, never as success.
      const report = this.#scorePerformance(this.#events, [...this.#performed.values()]);
      this.#alignment = new Map(report.eventResults.filter((item) => item.scoreEventId).map((item) => [item.scoreEventId, item]));
      this.#dirty = false;
    }
    const changes = [];
    for (const event of this.#events) {
      const window = this.#windows.get(event.scoreEventId);
      const result = this.#alignment.get(event.scoreEventId);
      const inWindow = Number.isFinite(result?.onsetErrorMs) && Math.abs(result.onsetErrorMs) <= window;
      let state = 'pending';
      if (result?.result === 'MATCH' && inWindow) state = 'hit';
      else if (result?.result === 'WRONG_PITCH' && inWindow) state = 'wrong';
      else if (nowMs > event.targetOnsetMs + window) state = 'miss';
      if (state === (this.#shown.get(event.scoreEventId) ?? 'pending')) continue;
      this.#shown.set(event.scoreEventId, state);
      changes.push({ scoreEventId: event.scoreEventId, state });
    }
    return changes;
  }
}
