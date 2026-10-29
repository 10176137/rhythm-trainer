import type { EngineJudgment } from '../../types/engine';

/**
 * Display ownership only. The pitch-following guide owns score progress while
 * fixed-clock rhythm results continue to feed the engine's final report.
 * A rhythm hit on that clock must not paint a different, unplayed score note.
 */
export function timelineHitNoteIds(
  judgment: Pick<EngineJudgment, 'grade' | 'targetIndex'>,
  groups: readonly (readonly string[])[],
  hasPitchGuide: boolean,
): readonly string[] {
  if (hasPitchGuide || (judgment.grade !== 'perfect' && judgment.grade !== 'good')) return [];
  const index = judgment.targetIndex;
  if (index === null || !Number.isInteger(index) || index < 0) return [];
  return groups[index] ?? [];
}
