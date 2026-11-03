import { expect, it } from 'vitest';
import { TakeResourceBudget } from './resource-budget.mjs';

it('bounds retained input by both count and serialized bytes without consuming rejected input', () => {
  const budget = new TakeResourceBudget({ maxEvents: 3, maxBytes: 10 });
  expect(budget.accept('1234')).toBe(true); // six UTF-8 bytes including quotes
  expect(budget.accept('1234')).toBe(false);
  expect(budget.events).toBe(1);
  expect(budget.bytes).toBe(6);
  budget.reset();
  expect(budget.accept()).toBe(true);
  expect(budget.accept()).toBe(true);
  expect(budget.accept()).toBe(true);
  expect(budget.accept()).toBe(false);
});

it('counts UTF-8 bytes rather than character count', () => {
  const budget = new TakeResourceBudget({ maxBytes: 4 });
  expect(budget.accept('琴')).toBe(false);
});

it('reports one read-only measurement of limits and usage', () => {
  const budget = new TakeResourceBudget({ maxEvents: 2, maxBytes: 10 });
  budget.accept('ab');
  const snapshot = budget.snapshot();
  expect(snapshot).toEqual({ eventLimit: 2, byteLimit: 10, events: 1, bytes: 4 });
  snapshot.events = 99;
  expect(budget.snapshot().events).toBe(1);
});
