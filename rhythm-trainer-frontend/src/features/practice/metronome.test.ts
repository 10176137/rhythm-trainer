import { describe, expect, it } from 'vitest';
import { buildBeatClicks, metronomeClickAudioTime } from './metronome';

describe('metronome timeline', () => {
  it('adds the session origin before converting to AudioContext time', () => {
    // Session origin 100 s, click at +3 s, now 101 s, audio clock at 5 s.
    // The click is 2 s in the future, not 98 s in the past.
    expect(metronomeClickAudioTime(3000, 100_000, 101_000, 5)).toBeCloseTo(7, 6);
  });

  it('counts in before the first target and accents 4/4 bar heads', () => {
    const clicks = buildBeatClicks(3000, 6000, 750, 4, 4);
    expect(clicks[0].atMs).toBe(0);
    expect(clicks[0].frequency).toBe(880);
    expect(clicks[4].atMs).toBe(3000);
    expect(clicks[4].frequency).toBe(880);
  });

  it('uses the score bar length for accents instead of hard-coded 4/4', () => {
    const clicks = buildBeatClicks(3000, 6000, 750, 4, 3);
    expect(clicks[3].frequency).toBe(880);
    expect(clicks[4].frequency).toBe(550);
    expect(clicks[6].frequency).toBe(880);
  });
});
