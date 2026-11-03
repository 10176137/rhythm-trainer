import { expect, it } from 'vitest';
import { beginNativeTake, assertTakeCommand, finalizeAndRelease } from './take-lifecycle.mjs';
it('aborts a begun coordinator take if native session startup fails', () => {
  /** @type {any[][]} */
  const aborted = [];
  /** @param {...any} args */
  const abort = (...args) => aborted.push(args);
  const coordinator = { beginTake: () => ({ takeId: 7 }), abort };
  expect(() => beginNativeTake(coordinator, () => ({ start() { throw Error('native start'); } }))).toThrow('native start');
  expect(aborted).toEqual([[7, 0, 'start_failed']]);
});
it('returns resources only after native startup succeeds', () => {
  let started = false;
  const native = { start() { started = true; } };
  expect(beginNativeTake({ beginTake: () => ({ takeId: 8 }) }, () => native)).toEqual({ take: { takeId: 8 }, native });
  expect(started).toBe(true);
});
it('rejects explicit stale ownership while keeping legacy commands compatible', () => {
  expect(() => assertTakeCommand({ takeId: 'old' }, { businessTakeId: 'new' })).toThrow();
  expect(() => assertTakeCommand({ takeId: 'old' }, null)).toThrow();
  expect(() => assertTakeCommand({}, { businessTakeId: 'new' })).not.toThrow();
  expect(() => assertTakeCommand({ takeId: 'new' }, { businessTakeId: 'new' })).not.toThrow();
});
it('releases resources after both successful and failed finalization', () => {
  let released = 0;
  expect(finalizeAndRelease(() => 'report', () => { released++; })).toBe('report');
  expect(() => finalizeAndRelease(() => { throw Error('finalize'); }, () => { released++; })).toThrow('finalize');
  expect(released).toBe(2);
});
