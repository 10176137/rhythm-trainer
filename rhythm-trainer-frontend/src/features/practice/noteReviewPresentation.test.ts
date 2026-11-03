import { expect, it } from 'vitest';
import { importMusicXml } from '../../score-engine/import/musicxml-importer';
import xml from '../score/fixtures/c-major-practice.musicxml?raw';
import { locateReviewItems, reviewHighlights } from './noteReviewPresentation';
import type { NoteReviewItem } from '../../../shared/note-review';
it('locates exact source IDs and repeat occurrences, keeps the worst pass, never guesses by pitch', () => {
  const score = importMusicXml(xml).scoreDocument!;
  const id = score.parts[0].measures[0].events.find(e => e.kind === 'note')!.id;
  const items = [
    { id: 'a', eventId: id, state: 'good' },
    { id: 'b', eventId: `plan:runtime:p1:${id}`, state: 'error' },
    { id: 'c', eventId: 'unrelated', state: 'error' },
    { id: 'd', eventId: null, state: 'attention' },
  ] as NoteReviewItem[];
  const locations = locateReviewItems(items, score);
  expect([...locations.values()]).toEqual([id, id, null, null]);
  expect(reviewHighlights(items, locations)).toEqual({ [id]: 'error' });
});
