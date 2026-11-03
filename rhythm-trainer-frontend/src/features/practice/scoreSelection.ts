import type { PracticeConfig } from '../../types/practice';
import type { ScoreDocument } from '../../score-engine/domain/types';
import { boundaryFromEvent, resolveBoundaryEvent, resolveNoteRange, wholeScoreBoundaries } from '../../score-engine/plan/note-range';

/** Selection descriptors for display and requests only. Node validates IDs,
 * clips the semantic source and asks Rust for all note times and durations. */
export function scoreSelection(score: ScoreDocument, config: PracticeConfig) {
  if (config.modeId !== 'score') return null;
  if (config.loopEnabled) return resolveNoteRange(score, config.loopStartNote, config.loopEndNote);
  const start = resolveBoundaryEvent(score, config.playbackStartNote);
  const whole = wholeScoreBoundaries(score);
  return start && whole ? { start: boundaryFromEvent(start), end: whole.end } : null;
}
export function scoreSelectionBars(score: ScoreDocument, config: PracticeConfig, barCount: number) {
  const notes = scoreSelection(score, config);
  return notes ? { startMeasureOrdinal: notes.start.measureOrdinal, endMeasureOrdinal: notes.end.measureOrdinal }
    : { startMeasureOrdinal: config.modeId === 'score' && config.loopEnabled ? config.loopStartBar : 1,
      endMeasureOrdinal: config.modeId === 'score' && config.loopEnabled ? config.loopEndBar : barCount };
}
