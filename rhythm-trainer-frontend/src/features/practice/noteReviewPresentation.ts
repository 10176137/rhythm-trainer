import type { NoteReviewItem } from '../../../shared/note-review';
import type { ScoreDocument } from '../../score-engine/domain/types';
import type { HighlightState } from '../../score-engine/view/score-view-adapter';

/** Exact source ID or a unique runtime occurrence suffix, never pitch/row index.
 * Used only to locate stored feedback on the matching immutable score. */
export function locateReviewItems(items: NoteReviewItem[], score: ScoreDocument) {
  const ids = score.parts.flatMap(p => p.measures.flatMap(m => m.events.filter(e => e.kind === 'note').map(e => e.id)));
  const idSet = new Set(ids);
  return new Map(items.map(item => {
    const matches = item.eventId && !idSet.has(item.eventId) ? ids.filter(id => item.eventId!.endsWith(`:${id}`)) : [];
    return [item.id, item.eventId && idSet.has(item.eventId) ? item.eventId : matches.length === 1 ? matches[0] : null];
  }));
}
export function reviewHighlights(items: NoteReviewItem[], locations: Map<string, string | null>) {
  const rank = { good: 0, unknown: 1, attention: 2, error: 3 };
  const states = new Map<string, NoteReviewItem['state']>();
  for (const item of items) {
    const id = locations.get(item.id); if (!id) continue;
    const previous = states.get(id);
    if (!previous || rank[item.state] > rank[previous]) states.set(id, item.state);
  }
  const colors: Record<NoteReviewItem['state'], HighlightState> = { good: 'user', attention: 'marker', error: 'error', unknown: 'muted' };
  return Object.fromEntries([...states].map(([id, state]) => [id, colors[state]]));
}
