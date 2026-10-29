import type { EngineNoteFeedback } from '../../types/engine';
import type { HighlightState } from '../../score-engine/view/score-view-adapter';

/** Render server states; no timing/pitch grading happens in the browser.
 * OSMD can share a chord glyph: only a complete confirmed group may be green.
 */
export function fixedLineGroupHighlights(
  groups: readonly string[][],
  feedback: readonly EngineNoteFeedback[],
  activeIndex: number,
  sourceIds: ReadonlyMap<string, string> = new Map(),
): Map<string, HighlightState> {
  const states = new Map(feedback.map((item) => [sourceIds.get(item.scoreEventId) ?? item.scoreEventId, item.state]));
  const colors = new Map<string, HighlightState>();
  groups.forEach((ids, index) => {
    const allHit = ids.length > 0 && ids.every((id) => states.get(id) === 'hit');
    const error = ids.some((id) => states.get(id) === 'wrong' || states.get(id) === 'miss');
    const partial = ids.some((id) => states.get(id) === 'hit');
    const color: HighlightState = allHit ? 'hit' : error ? 'error' : index === activeIndex || partial ? 'current' : 'default';
    for (const id of ids) colors.set(id, color);
  });
  return colors;
}
