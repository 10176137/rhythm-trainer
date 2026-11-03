import { expect, it } from 'vitest';
import { allocateTakeResources } from './take-resources.mjs';

it('acquires in order and passes earlier resources to later steps', () => {
  /** @type {string[]} */
  const order = [];
  const acquired = allocateTakeResources([
    { key: 'trace', acquire: () => { order.push('trace'); return { id: 't' }; } },
    { key: 'journal', acquire: (context) => { order.push(`journal:${context.trace.id}`); return { id: 'j' }; } },
    { key: 'sink', acquire: (context) => { order.push(`sink:${context.journal.id}`); return true; } },
  ]);
  expect(order).toEqual(['trace', 'journal:t', 'sink:j']);
  expect(acquired).toEqual({ trace: { id: 't' }, journal: { id: 'j' }, sink: true });
});

it('hands only the resources acquired so far to the failure handler', () => {
  /** @type {string[]} */
  const released = [];
  const steps = [
    { key: 'trace', acquire: () => ({ close: () => released.push('trace') }) },
    { key: 'journal', acquire: () => ({ close: () => released.push('journal') }) },
    { key: 'sink', acquire: () => { throw Error('attach failed'); } },
  ];
  let seen;
  expect(() => allocateTakeResources(steps, {
    onFailure: (acquired, error) => {
      seen = { keys: Object.keys(acquired), error: String(/** @type {Error} */ (error).message) };
      for (const key of Object.keys(acquired).reverse()) acquired[key].close();
    },
  })).toThrow('attach failed');
  expect(seen).toEqual({ keys: ['trace', 'journal'], error: 'attach failed' });
  expect(released).toEqual(['journal', 'trace']);
});

it('rethrows the original failure even when rollback also fails', () => {
  expect(() => allocateTakeResources([
    { key: 'trace', acquire: () => ({}) },
    { key: 'journal', acquire: () => { throw Error('factory failed'); } },
  ], { onFailure: () => { throw Error('rollback failed'); } })).toThrow('factory failed');
});

it('does nothing beyond rethrowing when no failure handler is supplied', () => {
  expect(() => allocateTakeResources([{ key: 'x', acquire: () => { throw Error('boom'); } }])).toThrow('boom');
});
