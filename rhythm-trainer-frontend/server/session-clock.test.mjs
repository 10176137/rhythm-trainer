import { describe, expect, it } from 'vitest';
import { ArmedTakeClock } from './session-clock.mjs';
const packet = (rawBytes, capturedAtMs, transport = 'node-midi') => ({ rawBytes, capturedAtMs, transport });
describe('armed take capture clock', () => {
  it('ignores wrong notes until a member of the first target chord is played', () => {
    const clock = new ArmedTakeClock(3000, [60, 64, 67]);
    expect(clock.map(packet([0x90, 61, 90], 100))).toBeNull(); expect(clock.waiting).toBe(true);
    expect(clock.map(packet([0x80, 61, 0], 200))).toBeNull();
    expect(clock.map(packet([0x90, 64, 90], 900))).toEqual({ atMs: 3000, started: true });
    expect(clock.map(packet([0x90, 61, 90], 1000))).toEqual({ atMs: 3100, started: false });
  });
  it('starts only on positive Note On and retains releases and pedal after the anchor', () => {
    const clock = new ArmedTakeClock(4000);
    for (const bytes of [[0x80, 60, 0], [0x90, 60, 0], [0xb0, 64, 127], [0xf8]]) expect(clock.map(packet(bytes, 500))).toBeNull();
    expect(clock.waiting).toBe(true);
    expect(clock.map(packet([0x90, 60, 90], 1000))).toEqual({ atMs: 4000, started: true });
    expect(clock.map(packet([0x80, 60, 0], 1400))).toEqual({ atMs: 4400, started: false });
    expect(clock.map(packet([0xb0, 64, 127], 1500))).toEqual({ atMs: 4500, started: false });
    expect(clock.now(1600)).toBe(4600);
    expect(clock.clientOrigin(200)).toBe(-3200);
  });
  it('uses browser capture plus the calibrated offset, never packet arrival time', () => {
    const clock = new ArmedTakeClock(3000);
    expect(clock.map(packet([0x90, 60, 90], 10000, 'mock'), { offsetServerMinusClientMs: -6000 })).toEqual({ atMs: 3000, started: true });
    expect(clock.clientOrigin(-6000)).toBe(7000);
    expect(clock.map(packet([0x80, 60, 0], 10500, 'mock'), { offsetServerMinusClientMs: -6000 })).toEqual({ atMs: 3500, started: false });
  });
  it('does not arm on input during pause and rejects unavailable clock mappings', () => {
    const clock = new ArmedTakeClock(0);
    expect(clock.map(packet([0x90, 60, 90], 100), { paused: true })).toBeNull();
    expect(clock.now(100)).toBe(0);
    expect(() => clock.map(packet([0x90, 60, 90], 100, 'mock'))).toThrow('时钟');
    expect(clock.waiting).toBe(true);
    expect(clock.map(packet([0x90, 60, 90], 300))).toEqual({ atMs: 0, started: true });
  });
});
