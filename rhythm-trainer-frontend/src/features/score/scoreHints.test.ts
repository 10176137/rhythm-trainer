import { describe, expect, it } from 'vitest';
import { parseScoreHintOverrides, resolveScoreHints } from './scoreHints';

describe('score hint defaults', () => {
  it('starts with a clean score and opt-in hints', () => {
    const hints = resolveScoreHints({}, 'standard');
    expect(hints.noteNames).toBe(false);
    expect(hints.positionHints).toBe(false);
    expect(hints.noteNamesSource).toBe('default');
    expect(hints.positionHintsSource).toBe('default');
  });

  it('keeps note names off by default under strict assessment', () => {
    const hints = resolveScoreHints({}, 'strict');
    expect(hints.noteNames).toBe(false);
    expect(hints.positionHints).toBe(false);
    expect(hints.noteNamesSource).toBe('default');
  });

  it('lets an explicit user override win over the strict default', () => {
    const hints = resolveScoreHints({ noteNames: true, positionHints: false }, 'strict');
    expect(hints.noteNames).toBe(true);
    expect(hints.positionHints).toBe(false);
    expect(hints.noteNamesSource).toBe('user');
    expect(hints.positionHintsSource).toBe('user');
  });

  it('validates persisted overrides without trusting malformed data', () => {
    expect(parseScoreHintOverrides(null)).toEqual({});
    expect(parseScoreHintOverrides('not json')).toEqual({});
    expect(parseScoreHintOverrides('[]')).toEqual({});
    expect(parseScoreHintOverrides('{"noteNames":false}')).toEqual({ noteNames: false });
    expect(parseScoreHintOverrides('{"noteNames":"yes","positionHints":true}')).toEqual({ positionHints: true });
  });
});
