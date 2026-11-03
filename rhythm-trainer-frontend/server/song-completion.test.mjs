import { expect, it } from 'vitest';
import { reachedSongEnd, songCompletionAtMs } from './song-completion.mjs';
const meta = { modeId: 'score', configSnapshot: { modeId: 'score', loopEnabled: false }, bpm: 60, ticksPerQuarter: 960, countInMs: 3000,
  targets: [{ atMs: 3000, nominalDurationMs: 4000 }, { atMs: 4000, nominalDurationMs: 1000 }],
  scoreEvents: [{ targetOnsetMs: 3000, targetDurationMs: 4000 }], atoms: [] };
it('waits for the longest sounding note, not the last onset, and keeps a release margin', () => {
  expect(songCompletionAtMs(meta)).toBe(7250);
  expect(reachedSongEnd(7250, 5000)).toBe(false); expect(reachedSongEnd(7250, 7249)).toBe(false); expect(reachedSongEnd(7250, 7250)).toBe(true);
});
it('includes trailing rests and excludes all paused time', () => {
  const end = songCompletionAtMs({ ...meta, atoms: [{ startTick: 3840, durationTicks: 960 }] }); expect(end).toBe(8250);
  expect(reachedSongEnd(end, 9000, [{ startSession: 4000, endSession: null }])).toBe(false);
  expect(reachedSongEnd(end, 10249, [{ startSession: 4000, endSession: 6000 }])).toBe(false);
  expect(reachedSongEnd(end, 10250, [{ startSession: 4000, endSession: 6000 }])).toBe(true);
});
it('ends a loop pass and leaves other modes or empty plans to their own lifecycle', () => {
  for (const modeId of ['fixed-line', 'reading-rhythm', 'free']) expect(songCompletionAtMs({ ...meta, modeId })).toBeNull();
  expect(songCompletionAtMs({ ...meta, modeId: 'loop', configSnapshot: { modeId: 'score', loopEnabled: true } })).toBe(7250);
  expect(songCompletionAtMs({ ...meta, modeId: 'hands' })).toBe(7250);
  expect(songCompletionAtMs({ ...meta, targets: [] })).toBeNull();
});
