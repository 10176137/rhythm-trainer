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
  #extrasByOnset = new Map();
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
      this.#extrasByOnset.clear();
      // Rust decides which inputs are EXTRA. Associate only nearby extras with
      // the closest validated attack for display; gaps stay in the final report.
      const groups = new Map(this.#events.map((event) => [event.targetOnsetMs, this.#windows.get(event.scoreEventId)]));
      for (const item of report.eventResults) {
        if (item.result !== 'EXTRA') continue;
        const note = this.#performed.get(item.performedNoteId);
        if (!note) continue;
        let closest;
        let distance = Infinity;
        for (const [onset, window] of groups) {
          const error = Math.abs(note.onsetMs - onset);
          if (error <= window && (error < distance || (error === distance && onset < closest))) {
            closest = onset;
            distance = error;
          }
        }
        if (closest !== undefined) this.#extrasByOnset.set(closest, (this.#extrasByOnset.get(closest) ?? 0) + 1);
      }
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
      const extraCount = this.#extrasByOnset.get(event.targetOnsetMs) ?? 0;
      const previous = this.#shown.get(event.scoreEventId);
      if (state === (previous?.state ?? 'pending') && extraCount === (previous?.extraCount ?? 0)) continue;
      this.#shown.set(event.scoreEventId, { state, extraCount });
      changes.push({ scoreEventId: event.scoreEventId, state,
        ...(extraCount || previous?.extraCount ? { extraCount } : {}) });
    }
    return changes;
  }
}
