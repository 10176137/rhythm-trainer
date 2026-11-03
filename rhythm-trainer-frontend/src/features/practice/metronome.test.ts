import { describe, expect, it } from 'vitest';
import { buildArmedCueClicks, buildBeatClicks, metronomeClickAudioTime } from './metronome';

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

  it('spaces clicks by the practice tempo (60_000 / bpm)', () => {
    for (const bpm of [52, 86, 120]) {
      const quarterMs = 60_000 / bpm;
      const clicks = buildBeatClicks(4 * quarterMs, 8 * quarterMs, quarterMs, 4, 4);
      expect(clicks).toHaveLength(9);
      for (let index = 1; index < clicks.length; index += 1) {
        expect(clicks[index].atMs - clicks[index - 1].atMs).toBeCloseTo(quarterMs, 6);
      }
    }
  });

  it('gives an armed take a lead-in cue at the practice tempo from t=0', () => {
    const quarterMs = 60_000 / 52;
    const clicks = buildArmedCueClicks(quarterMs, 4, 16);
    expect(clicks).toHaveLength(16);
    expect(clicks[0]).toMatchObject({ atMs: 0, frequency: 880 });
    expect(clicks[4].frequency).toBe(880);
    expect(clicks[1].frequency).toBe(550);
    for (let index = 1; index < clicks.length; index += 1) {
      expect(clicks[index].atMs - clicks[index - 1].atMs).toBeCloseTo(quarterMs, 6);
    }
  });
});
