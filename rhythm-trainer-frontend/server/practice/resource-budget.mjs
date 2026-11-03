// Owns only ingress accounting; the server owns how a limited Take is finalized.
// Count bounds native note/pause history; bytes bound large transport payloads.
export class TakeResourceBudget {
  /** @type {number} */ maxEvents;
  /** @type {number} */ maxBytes;
  /** @type {number} */ events = 0;
  /** @type {number} */ bytes = 0;
  /** @param {{ maxEvents?: number, maxBytes?: number }} [limits] */
  constructor({ maxEvents = 100000, maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.reset();
  }
  reset() { this.events = 0; this.bytes = 0; }
  /** Read-only measurement for Take evidence. */
  /** @returns {{ eventLimit: number, byteLimit: number, events: number, bytes: number }} */
  snapshot() {
    return { eventLimit: this.maxEvents, byteLimit: this.maxBytes, events: this.events, bytes: this.bytes };
  }
  /** @param {unknown} [payload] @returns {boolean} */
  accept(payload) {
    const bytes = payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (this.events >= this.maxEvents || this.bytes + bytes > this.maxBytes) return false;
    this.events += 1;
    this.bytes += bytes;
    return true;
  }
}
