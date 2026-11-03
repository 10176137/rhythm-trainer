import { expect, it } from 'vitest';
import { waitsForFirstInput, automaticallyStartsPerformance } from './sessionStartPolicy';

it('arms reading performance but lets fixed-line and rhythm exercises advance without input', () => {
  expect(waitsForFirstInput('score')).toBe(true);
  expect(waitsForFirstInput('fixed-line')).toBe(false);
  expect(waitsForFirstInput('reading-rhythm')).toBe(false);
});

it('requires an explicit start for fixed-line performance', () => {
  expect(automaticallyStartsPerformance('score')).toBe(true);
  expect(automaticallyStartsPerformance('fixed-line')).toBe(false);
});
