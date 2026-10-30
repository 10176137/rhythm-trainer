import { describe, expect, it } from 'vitest';
import { fixedLineGroupHighlights } from './fixedLineFeedback';
describe('fixed-line highlight meaning', () => {
  it('shows the current target as a cue and never as a successful hit', () => {
    expect(fixedLineGroupHighlights([['a']], [], 0).get('a')).toBe('current');
  });
  it('only turns a chord green when all its tones are confirmed', () => {
    const partial = [{ scoreEventId: 'a', state: 'hit' as const }];
    expect(fixedLineGroupHighlights([['a', 'b']], partial, 0).get('a')).toBe('current');
    const complete = [...partial, { scoreEventId: 'b', state: 'hit' as const }];
    expect([...fixedLineGroupHighlights([['a', 'b']], complete, 0).values()]).toEqual(['hit', 'hit']);
  });
  it('maps runtime occurrence feedback onto engraved source ids', () => {
    const colors = fixedLineGroupHighlights([['source-a']], [{ scoreEventId: 'occ-a', state: 'hit' }], 0, new Map([['occ-a', 'source-a']]));
    expect(colors.get('source-a')).toBe('hit');
  });
  it('does not paint a complete chord green when the server reports an extra tone', () => {
    const feedback = ['c', 'e', 'g'].map((scoreEventId) => ({ scoreEventId, state: 'hit' as const, extraCount: 1 }));
    const colors = fixedLineGroupHighlights([['c', 'e', 'g'], ['next']], feedback, 1);
    expect(['c', 'e', 'g'].map((id) => colors.get(id))).toEqual(['error', 'error', 'error']);
    expect(colors.get('next')).toBe('current');
  });
  it('keeps errors red after the time cursor advances', () => {
    const colors = fixedLineGroupHighlights([['a'], ['b']], [{ scoreEventId: 'a', state: 'miss' }], 1);
    expect(colors.get('a')).toBe('error');
    expect(colors.get('b')).toBe('current');
  });
});
