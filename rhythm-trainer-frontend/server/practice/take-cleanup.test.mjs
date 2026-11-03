import { expect, it } from 'vitest';
import { closeTakeEvidence } from './take-cleanup.mjs';
it('attempts both writers even when journal append fails and reports each error', () => {
  const calls = [];
  const errors = closeTakeEvidence({ journal: {
    append() { throw Error('append'); }, finalize() { calls.push('journal'); throw Error('journal'); },
  }, trace: { finalize() { calls.push('trace'); throw Error('trace'); } } }, 'start_failed', 100);
  expect(calls).toEqual(['journal', 'trace']);
  expect(errors.map(item => item.stage)).toEqual(['journal-append', 'journal-finalize', 'trace-finalize']);
});
it('keeps the interruption reason and time as journal evidence', () => {
  const entries = [];
  closeTakeEvidence({ journal: { append: (...args) => entries.push(args), finalize: (...args) => entries.push(args) } }, 'connection_closed', 50);
  expect(entries).toEqual([['take_aborted', { reason: 'connection_closed', atSessionMs: 50 }], [{ aborted: true, reason: 'connection_closed' }]]);
});

it('reports writers that return degraded persistence without throwing', () => {
  const errors = closeTakeEvidence({ trace: { finalize: () => ({ persistenceDegraded: true, error: 'disk full' }) } }, 'invalid_input', 0);
  expect(errors).toHaveLength(1);
  expect(errors[0].error.message).toContain('disk full');
});
