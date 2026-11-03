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
it('exposes one isolated snapshot for downstream evidence', () => {
  const ledger = new PauseLedger();
  ledger.pause(100, 100, () => {});
  const snapshot = ledger.snapshot();
  expect(snapshot).toEqual({
    pausedAtMs: 100, pausedSourceMs: 100, activeSegmentId: 'pause-1', lastNowMs: 100,
    segments: [{ segmentId: 'pause-1', startSession: 100, endSession: null }], sourceIntervals: [],
  });
  snapshot.segments[0].endSession = 999;
  snapshot.sourceIntervals.push(1, 2);
  expect(ledger.snapshot().segments[0].endSession).toBeNull();
  expect(ledger.snapshot().sourceIntervals).toEqual([]);
});
it('records a zero-length pause without inventing a duration', () => {
  const ledger = new PauseLedger();
  ledger.pause(200, 200, () => {});
  expect(ledger.resume(200, 200, () => {}).deltaMs).toBe(0);
  expect(ledger.pauseSegments).toEqual([{ segmentId: 'pause-1', startSession: 200, endSession: 200 }]);
  expect(ledger.pauseIntervalsSourceMs).toEqual([200, 200]);
});
it('stays paused when a half-applied resume fails after the coordinator changed state', () => {
  const ledger = new PauseLedger();
  ledger.pause(100, 100, () => {});
  let coordinatorResumed = 0;
  // The coordinator call succeeded before the kernel threw: the ledger must
  // not report a resume that did not happen. The caller runs its existing
  // failure cleanup; the open interval stays as evidence.
  expect(() => ledger.resume(1100, 1100, () => {
    coordinatorResumed += 1;
    throw Error('native resume failed');
  })).toThrow('native resume failed');
  expect(coordinatorResumed).toBe(1);
  expect(ledger.pausedAtMs).toBe(100);
  expect(ledger.pauseSegments).toEqual([{ segmentId: 'pause-1', startSession: 100, endSession: null }]);
  expect(ledger.pauseIntervalsSourceMs).toEqual([]);
});
it('stays running when a half-applied pause fails after the coordinator paused', () => {
  const ledger = new PauseLedger();
  let coordinatorPaused = 0;
  expect(() => ledger.pause(100, 100, () => {
    coordinatorPaused += 1;
    throw Error('native pause failed');
  })).toThrow('native pause failed');
  expect(coordinatorPaused).toBe(1);
  expect(ledger.pausedAtMs).toBeNull();
  expect(ledger.pauseSegments).toEqual([]);
  // No false evidence: a later valid pause starts a single new segment.
  ledger.pause(200, 200, () => {});
  expect(ledger.pauseSegments).toEqual([{ segmentId: 'pause-1', startSession: 200, endSession: null }]);
});
