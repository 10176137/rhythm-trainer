/** Armed takes keep the Rust plan's timeline intact. The first correct
 * positive Note On is mapped to its first target (including leading rests),
 * rather than rewriting targets or using WebSocket arrival time for scoring. */
export class ArmedTakeClock {
  constructor(firstTargetAtMs, firstPitches = []) {
    if (!Number.isFinite(firstTargetAtMs) || firstTargetAtMs < 0) throw new Error('首音目标时间非法');
    this.firstTargetAtMs = firstTargetAtMs;
    this.originServerMs = null;
    this.transport = null;
    this.firstPitches = new Set(firstPitches);
  }
  get waiting() { return this.originServerMs === null; }
  map(packet, { offsetServerMinusClientMs, paused = false } = {}) {
    const captured = packet.capturedAtMs;
    const node = packet.transport === 'node-midi';
    if (!Number.isFinite(captured) || (!node && !Number.isFinite(offsetServerMinusClientMs))) {
      throw new Error('MIDI 时钟尚未就绪，请稍后重新开始');
    }
    const capturedServerMs = captured + (node ? 0 : offsetServerMinusClientMs);
    let started = false;
    if (this.waiting) {
      const bytes = packet.rawBytes ?? [];
      if (paused || ((bytes[0] ?? 0) & 0xf0) !== 0x90 || !(bytes[2] > 0)) return null;
      if (this.firstPitches.size && !this.firstPitches.has(bytes[1])) return null;
      this.originServerMs = capturedServerMs - this.firstTargetAtMs;
      this.transport = packet.transport;
      started = true;
    }
    return { atMs: capturedServerMs - this.originServerMs, started };
  }
  now(serverNowMs) { return this.waiting ? 0 : serverNowMs - this.originServerMs; }
  clientOrigin(offsetServerMinusClientMs) {
    return !this.waiting && Number.isFinite(offsetServerMinusClientMs) ? this.originServerMs - offsetServerMinusClientMs : null;
  }
}
