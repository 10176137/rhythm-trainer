import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { questionXml, readingFeedbackXml } from './readingNotation';

const parser = new XMLParser({ ignoreAttributes: false });
function notes(xml: string) {
  const value = parser.parse(xml)['score-partwise'].part.measure.note;
  return (Array.isArray(value) ? value : [value]).filter((note) => note.pitch);
}
describe('display-only reading feedback notation', () => {
  it('colors only hit targets green and renders actual wrong pitches red', () => {
    const targets = Object.freeze([60, 64, 67]);
    const rendered = notes(readingFeedbackXml(targets, [60], [61], 1, null));
    expect(rendered.map((note) => [note.pitch.step, note.pitch.alter ?? 0, note['@_color']])).toEqual([
      ['C', 0, '#1D9B72'], ['E', 0, undefined], ['G', 0, undefined], ['C', 1, '#C34B58'],
    ]);
    expect(rendered[0].voice).toBe(1);
    expect(rendered[3].voice).toBe(2);
    expect(targets).toEqual([60, 64, 67]);
    expect(notes(questionXml(targets, 1))).toHaveLength(3);
  });
  it('removes released errors without erasing correct chord tones', () => {
    const rendered = notes(readingFeedbackXml([60, 64], [60], [], 1, null));
    expect(rendered).toHaveLength(2);
    expect(rendered[0]['@_color']).toBe('#1D9B72');
    expect(rendered.some((note) => note['@_color'] === '#C34B58')).toBe(false);
  });
  it('uses the same key spelling and staff for the played note and target', () => {
    const rendered = notes(readingFeedbackXml([65], [], [70], 2, { root: 'F', mode: 'major' }));
    expect(rendered[1].pitch).toEqual({ step: 'B', alter: -1, octave: 4 });
    expect(rendered.every((note) => note.staff === 2)).toBe(true);
  });
});
