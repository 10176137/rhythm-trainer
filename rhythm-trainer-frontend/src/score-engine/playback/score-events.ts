import type { PlaybackPlan } from '../domain/types';
import { toNumber } from '../domain/rational';
import type { EngineScoreEvent } from '../../types/engine';
import { beatToMsAtBpm } from './tempo-map';

/**
 * Converts the single playback occurrence plan into per-note final-score
 * events. This is not a second timeline: atoms, reference audio and these
 * events all come from the same PlaybackPlan/occurrences.
 */
export function buildEngineScoreEvents(
  plan: PlaybackPlan,
  bpm: number,
  countInBeats: number,
): EngineScoreEvent[] {
  const countInMs = countInBeats * (60_000 / bpm);
  const events: EngineScoreEvent[] = [];
  for (const occurrence of plan.occurrences) {
    const pitch = occurrence.pitch?.midiNote;
    if (pitch == null || !Number.isFinite(pitch)) {
      throw new Error(`目标 ${occurrence.occurrenceId} 缺少可评分的 MIDI pitch`);
    }
    const onsetMs = countInMs + beatToMsAtBpm(occurrence.playbackBeat, bpm);
    const durationMs = beatToMsAtBpm(occurrence.durationBeat, bpm);
    if (!Number.isFinite(onsetMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new Error(`目标 ${occurrence.occurrenceId} 的时间/时值非法`);
    }
    events.push({
      scoreEventId: occurrence.occurrenceId,
      measure: occurrence.bar,
      beatPosition: toNumber(occurrence.playbackBeat),
      pitch,
      targetOnsetMs: onsetMs,
      targetDurationMs: durationMs,
      partId: `staff-${occurrence.staffNumber}:voice-${occurrence.voiceId ?? '1'}`,
      parseConfidence: 1,
    });
  }
  events.sort((a, b) => a.targetOnsetMs - b.targetOnsetMs || a.scoreEventId.localeCompare(b.scoreEventId));
  return events;
}
