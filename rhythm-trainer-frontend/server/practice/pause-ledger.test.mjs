import { expect, it } from 'vitest';
import { PauseLedger } from './pause-ledger.mjs';
it('commits only after the engine accepts a transition and ignores duplicates', () => {
  const ledger = new PauseLedger();
  expect(() => ledger.pause(100, 100, () => { throw Error('engine'); })).toThrow('engine');
  expect(ledger.pausedAtMs).toBeNull();
  expect(ledger.pauseSegments).toEqual([]);
  ledger.pause(100, 100, () => []);
  expect(ledger.pause(200, 200, () => { throw Error('duplicate'); }).duplicate).toBe(true);
  expect(() => ledger.resume(1100, 1100, () => { throw Error('engine'); })).toThrow('engine');
  expect(ledger.pausedAtMs).toBe(100);
  expect(ledger.resume(1100, 1100, () => {}).deltaMs).toBe(1000);
  expect(ledger.resume(1200, 1200, () => { throw Error('duplicate'); }).deltaMs).toBe(0);
  expect(ledger.pauseIntervalsSourceMs).toEqual([100, 1100]);
});
it('rejects regressing time without mutation and preserves open evidence at finish', () => {
  const ledger = new PauseLedger();
  ledger.advance(500);
  expect(ledger.canAdvance(200)).toBe(false);
  expect(() => ledger.pause(100, null, () => {})).toThrow();
  ledger.pause(600, 600, () => {});
  expect(() => ledger.resume(550, 550, () => {})).toThrow();
  ledger.finish(); ledger.finish();
  expect(ledger.pauseSegments).toEqual([{ segmentId: 'pause-1', startSession: 600, endSession: null }]);
  expect(ledger.pauseIntervalsSourceMs).toEqual([600, Number.MAX_SAFE_INTEGER]);
});
it('accumulates separate pauses and provides isolated snapshots and reset', () => {
  const ledger = new PauseLedger();
  ledger.pause(0, null, () => {}); ledger.resume(100, null, () => {});
  ledger.pause(200, 200, () => {}); ledger.resume(200, 200, () => {});
  expect(ledger.activePauseSegmentId).toBe('active-4');
  const snapshot = ledger.pauseSegments; snapshot[0].endSession = 900;
  expect(ledger.pauseSegments[0].endSession).toBe(100);
  ledger.reset();
  expect(ledger.lastNowMs).toBe(0); expect(ledger.pauseSegments).toEqual([]);
});
it('rejects invalid commands before invoking external participants', () => {
  const ledger = new PauseLedger();
  let calls = 0;
  for (const now of [-1, NaN, Infinity]) expect(() => ledger.pause(now, null, () => { calls++; })).toThrow();
  expect(calls).toBe(0);
  ledger.pause(0, 0, () => {});
  expect(() => ledger.resume(-1, null, () => { calls++; })).toThrow();
  expect(calls).toBe(0);
  ledger.resume(0, 0, () => {});
  expect(ledger.pauseIntervalsSourceMs).toEqual([0, 0]);
});
