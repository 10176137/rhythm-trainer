import { describe, expect, it } from 'vitest';
import {
  addBeat,
  beatToString,
  fromMusicXmlDuration,
  rational,
  subtractBeat,
  toTicks,
} from '../domain/rational';

describe('RationalBeat', () => {
  it('reduces fractions and keeps exact arithmetic', () => {
    expect(fromMusicXmlDuration(1, 6)).toEqual({ numerator: 1, denominator: 6 });
    expect(addBeat(fromMusicXmlDuration(1, 6), fromMusicXmlDuration(1, 3))).toEqual({ numerator: 1, denominator: 2 });
    expect(subtractBeat(rational(3, 2), rational(1, 3))).toEqual({ numerator: 7, denominator: 6 });
    expect(beatToString(rational(4, 2))).toBe('2/1');
  });

  it('does not accumulate floating point', () => {
    let beat = rational(0, 1);
    for (let index = 0; index < 12; index += 1) beat = addBeat(beat, fromMusicXmlDuration(1, 3));
    expect(beat).toEqual({ numerator: 4, denominator: 1 });
  });

  it('converts to a tick grid only when exact', () => {
    expect(toTicks(fromMusicXmlDuration(1, 3), 960)).toBe(320);
    expect(toTicks(fromMusicXmlDuration(1, 7), 960)).toBeNull();
  });
});
