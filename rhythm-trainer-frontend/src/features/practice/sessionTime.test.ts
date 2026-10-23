// Pure-function tests for capture-time mapping. The important regression is
// the late packet: a performance-timeline stamp from before this take's origin
// must be quarantined, not re-timed as if it happened after start.

import { describe, expect, it } from 'vitest';
import { toSessionMs } from './sessionTime';

const ORIGIN = 1_000;
const PERFORMANCE = 'web-page-performance-timeline';
const DAY = 24 * 60 * 60 * 1000;

describe('toSessionMs', () => {
  it('maps a capture time after the session origin', () => {
    expect(toSessionMs(1_500, ORIGIN, PERFORMANCE, 9_999)).toBe(500);
  });

  it('quarantines a pre-origin performance-timeline stamp', () => {
    expect(toSessionMs(900, ORIGIN, PERFORMANCE, 2_000)).toBeNull();
  });

  it('quarantines a performance-timeline stamp beyond 24 hours', () => {
    expect(toSessionMs(ORIGIN + DAY, ORIGIN, PERFORMANCE, 2_000)).toBeNull();
  });

  it('keeps the handler-time fallback for a non-performance clock domain', () => {
    expect(toSessionMs(Date.now(), ORIGIN, 'epoch-timeline', 2_000)).toBe(1_000);
  });

  it('falls back when the device provides no timestamp', () => {
    expect(toSessionMs(undefined, ORIGIN, PERFORMANCE, 2_000)).toBe(1_000);
  });
});
