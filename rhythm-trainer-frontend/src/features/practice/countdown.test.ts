import { describe, expect, it } from 'vitest';
import { countdownToFirstNoteMs, countdownWholeSeconds, countInBeatsForTempo, practiceCountIn } from './countdown';

describe('first-note countdown', () => {
  it('keeps reading measures and canonical launch microseconds consistent', () => {
    const config = { modeId: 'reading-rhythm', tempo: 60, timeSignature: [4, 4] as [number, number] };
    expect(practiceCountIn(config, 1)).toEqual({ countInBeats: 4, countInUs: 4_000_000 });
    expect(practiceCountIn({ ...config, tempo: 80, timeSignature: [3, 4] }, 2))
      .toEqual({ countInBeats: 6, countInUs: 4_500_000 });
    expect(practiceCountIn({ ...config, modeId: 'score' }, 2))
      .toEqual({ countInBeats: 3, countInUs: 3_000_000 });
  });
  it('uses a three-second preparation at every tempo', () => {
    expect(countInBeatsForTempo(40) * (60_000 / 40)).toBe(3000);
    expect(countInBeatsForTempo(80) * (60_000 / 80)).toBe(3000);
    expect(countInBeatsForTempo(120) * (60_000 / 120)).toBe(3000);
    expect(countInBeatsForTempo(40)).toBe(2);
    expect(countInBeatsForTempo(80)).toBe(4);
    expect(countInBeatsForTempo(120)).toBe(6);
    expect(countInBeatsForTempo(70)).toBeCloseTo(3.5, 6);
  });

  it('ends exactly at the backend first-note time', () => {
    // Backend schedule: 4-beat count-in at 120 BPM (2000 ms).
    expect(countdownToFirstNoteMs(2000, 10_000, 10_000)).toBe(2000);
    expect(countdownToFirstNoteMs(2000, 10_000, 11_400)).toBe(600);
    expect(countdownToFirstNoteMs(2000, 10_000, 12_000)).toBe(0);
    expect(countdownToFirstNoteMs(2000, 10_000, 12_500)).toBe(0);
  });

  it('includes a leading rest in the score schedule', () => {
    // Count-in 2000 ms + one beat rest at 120 BPM.
    expect(countdownToFirstNoteMs(2500, 10_000, 10_100)).toBe(2400);
  });

  it('has no countdown before the engine fixes the session origin', () => {
    expect(countdownToFirstNoteMs(2000, null, 10_000)).toBeNull();
    expect(countdownToFirstNoteMs(null, 10_000, 10_000)).toBeNull();
  });

  it('shows whole seconds until the first note and nothing at zero', () => {
    expect(countdownWholeSeconds(2000)).toBe(2);
    expect(countdownWholeSeconds(1)).toBe(1);
    expect(countdownWholeSeconds(0)).toBeNull();
    expect(countdownWholeSeconds(null)).toBeNull();
  });
});
