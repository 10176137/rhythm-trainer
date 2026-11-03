/** One ingress decision per MIDI event. Rust still owns decoding and scoring.
 * Replay reads the first frozen decision; it never reclassifies old input. */

/** @typedef {{ kind?: string, eventId?: string | null, noteNumber?: number | null, complete?: boolean }} DecodedEvent */
/** @typedef {{ sourceId: string | number, sourceSeq: number | string, capturedAtMs: number, clockDomainId?: string | null, handlerAtMs?: number | null }} RawPacket */
/** @typedef {{ startSession: number, endSession: number | null }} AdmissionPauseSegment */
/** @typedef {{ paused: boolean, pauseSegments: AdmissionPauseSegment[], scoringStartMs: number, segmentId: string }} AdmissionContext */
/** @typedef {'count-in' | 'paused' | 'clock' | 'duplicate' | 'out-of-order'} SuppressionReason */

export class MidiAdmissionLedger {
  /** @type {Map<string, any>} */ #byEventId = new Map();
  /** @type {number} */ #sequence = 0;
  /** @type {number | null} */ #lastOnset = null;
  counters = {
    packets: 0,
    noteOns: 0,
    nonOnsets: 0,
    admittedNoteOns: 0,
    pushHitCount: 0,
    finalPerformedNotes: 0,
    finalSkippedByAdmission: 0,
    finalDuplicateLifecycles: 0,
    suppressedNoteOns: { 'count-in': 0, paused: 0, clock: 0, duplicate: 0, 'out-of-order': 0 },
    captureQuarantinedPackets: 0,
    duplicateEventIds: 0,
  };
  /** @param {string} eventId */
  get(eventId) { return this.#byEventId.get(eventId); }
  /** @param {number} atMs */
  commitOnset(atMs) { this.#lastOnset = atMs; }
  reset() {
    this.#byEventId.clear();
    this.#sequence = 0;
    this.counters.packets = 0;
    this.counters.noteOns = 0;
    this.counters.nonOnsets = 0;
    this.counters.admittedNoteOns = 0;
    this.counters.pushHitCount = 0;
    this.counters.finalPerformedNotes = 0;
    this.counters.finalSkippedByAdmission = 0;
    this.counters.finalDuplicateLifecycles = 0;
    this.counters.captureQuarantinedPackets = 0;
    this.counters.duplicateEventIds = 0;
    this.counters.suppressedNoteOns['count-in'] = 0;
    this.counters.suppressedNoteOns.paused = 0;
    this.counters.suppressedNoteOns.clock = 0;
    this.counters.suppressedNoteOns.duplicate = 0;
    this.counters.suppressedNoteOns['out-of-order'] = 0;
    this.#lastOnset = null;
  }
  /**
   * @param {DecodedEvent | null | undefined} decoded
   * @param {RawPacket} packet
   * @param {number | null} atMs
   * @param {AdmissionContext} context
   */
  record(decoded, packet, atMs, context) {
    const isNoteOn = decoded?.kind === 'note-on';
    const eventId = decoded?.eventId ?? null;
    // Identity first: a packet whose event id was already admitted/rejected is a
    // duplicate and can never produce a second hit or a second lifecycle.
    const existing = eventId ? this.#byEventId.get(eventId) : undefined;
    const complete = decoded?.complete !== false;
    /** @type {SuppressionReason | null} */
    let reason = null;
    if (existing) {
      reason = 'duplicate';
    } else if (context.paused) {
      reason = 'paused';
    } else if (atMs === null || !Number.isFinite(atMs)) {
      // Applies to note-offs too: an unmappable packet has no usable event time.
      reason = 'clock';
    } else if (isNoteOn && context.pauseSegments.some(segment => segment.endSession !== null && atMs >= segment.startSession && atMs < segment.endSession)) {
      reason = 'paused';
    } else if (isNoteOn && atMs < context.scoringStartMs) {
      reason = 'count-in';
    } else if (isNoteOn && complete && this.#lastOnset !== null
      && atMs < this.#lastOnset) {
      // The Rust matcher rejects non-monotonic onset times and invalidates the
      // whole session. Isolate the regression here; equal timestamps still pass.
      reason = 'out-of-order';
    }
    const admitted = isNoteOn && complete && reason === null && !existing;
    const decision = Object.freeze({
      decisionId: `adm-${++this.#sequence}`,
      eventId,
      sourceId: String(packet.sourceId),
      sourceSeq: Number(packet.sourceSeq),
      kind: decoded?.kind ?? 'unknown',
      decisionSegmentId: context.segmentId,
      capturedAtMs: Number(packet.capturedAtMs),
      handlerAtMs: Number.isFinite(Number(packet.handlerAtMs)) ? Number(packet.handlerAtMs) : null,
      sessionTimeMs: atMs === null || !Number.isFinite(atMs) ? null : atMs,
      clockDomainId: packet.clockDomainId ?? null,
      suppressionReason: reason,
      duplicateOf: existing?.decisionId ?? null,
      eligibleForRealtime: admitted,
      eligibleForFinalOnsetScore: admitted,
    });
    this.counters.packets += 1;
    if (isNoteOn) {
      this.counters.noteOns += 1;
      if (admitted) this.counters.admittedNoteOns += 1;
      else if (reason) this.counters.suppressedNoteOns[reason] += 1;
    } else {
      this.counters.nonOnsets += 1;
    }
    if (eventId && !existing) {
      this.#byEventId.set(eventId, decision);
    } else if (existing) {
      this.counters.duplicateEventIds += 1;
    }
    return decision;
  }

}
