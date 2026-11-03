import type { PerformanceReplay } from '../../../shared/performance-replay';
import type { ReferencePlaybackPlan } from '../../score-engine/playback/reference-playback-plan';
/** Audio scheduling projection only. Never fed into a scoring session. */
export function performedPlaybackPlan(replay: PerformanceReplay, speed = 1): ReferencePlaybackPlan {
  const notes = replay.notes.map(n => ({ eventId: n.id, groupId: n.id, occurrenceIds: [n.id], scoreEventIds: [], activeScoreEventIds: [],
    atMs: n.atMs / speed, durationMs: n.durationMs / speed, bar: 1, beat: n.atMs / 500 / speed, staffNumbers: [], voiceIds: [n.id],
    voices: [{ voiceId: n.id, occurrenceId: n.id, scoreEventId: '', midiNote: n.pitch, velocity: n.velocity / 127, atMs: n.atMs / speed, durationMs: n.durationMs / speed }] }));
  return { planId: `listening:${replay.takeId}:${speed}`, sourcePlanId: replay.takeId, scoreFingerprint: '', bpm: 120, countInMs: 0,
    hand: 'both', range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 }, notes, lastEndMs: replay.durationMs / speed,
    issues: [], strictAllowed: true };
}
