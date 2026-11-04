import { describe, expect, it } from 'vitest';
import { needsFollowScroll } from './followScroll';

const viewport = { top: 100, bottom: 660 };
const margin = 8;

describe('needsFollowScroll', () => {
  it('leaves a fully visible system alone', () => {
    expect(needsFollowScroll({ top: 200, bottom: 320 }, viewport, margin)).toBe(false);
  });

  it('treats a system exactly at the margins as visible', () => {
    expect(needsFollowScroll({ top: 108, bottom: 652 }, viewport, margin)).toBe(false);
  });

  it('scrolls when the next system is below the pane', () => {
    expect(needsFollowScroll({ top: 700, bottom: 820 }, viewport, margin)).toBe(true);
    expect(needsFollowScroll({ top: 600, bottom: 760 }, viewport, margin)).toBe(true);
  });

  it('scrolls when the system is clipped above the pane', () => {
    expect(needsFollowScroll({ top: 80, bottom: 200 }, viewport, margin)).toBe(true);
  });

  it('scrolls a system taller than the visible pane', () => {
    expect(needsFollowScroll({ top: 90, bottom: 700 }, viewport, margin)).toBe(true);
  });
});
