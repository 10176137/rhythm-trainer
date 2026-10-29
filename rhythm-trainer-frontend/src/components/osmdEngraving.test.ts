import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareMeasureGrid } from './osmdEngraving';
import { importScoreText } from '../features/score/scoreImport';
import { toNumber } from '../score-engine/domain/rational';

const sample = readFileSync(new URL('../features/score/fixtures/c-major-practice.musicxml', import.meta.url), 'utf8');
const bars = [...sample.matchAll(/<measure\b[\s\S]*?<\/measure>/g)].map((match) => match[0]);
function scoreWithMeasures(count: number) {
  return sample.replace(/<measure\b[\s\S]*<\/measure>/, Array.from({ length: count }, (_, index) =>
    bars[index === 0 ? 0 : 1 + (index - 1) % 3].replace(/number="\d+"/, `number="${index + 1}"`),
  ).join(''));
}

describe('display-only four-measure grid', () => {
  for (const count of [1, 3, 4, 5, 6, 7, 8, 9]) {
    it(`${count} real measures retain their notes and occupy ${Math.ceil(count / 4) * 4} slots`, () => {
      const xml = scoreWithMeasures(count);
      const original = importScoreText(xml, 'original.musicxml').doc!.engine!;
      const before = JSON.stringify(original);
      const grid = prepareMeasureGrid(xml);
      const display = importScoreText(grid.xml, 'display.musicxml').doc!.engine!;
      expect(grid.measureCount).toBe(count);
      expect(grid.slotCount).toBe(Math.ceil(count / 4) * 4);
      expect(display.parts[0].measures).toHaveLength(grid.slotCount);
      // Re-imported display XML has a different fingerprint/ID prefix. Compare
      // the musical events rather than those document identities.
      const events = (measures: typeof original.parts[number]['measures']) => measures.map((measure) => measure.events.map(({ id: _id, ...event }) => event));
      expect(events(display.parts[0].measures.slice(0, count))).toEqual(events(original.parts[0].measures));
      for (const measure of display.parts[0].measures.slice(count)) {
        expect(toNumber(measure.durationBeat)).toBe(4);
        expect(measure.events.every((event) => event.kind === 'rest')).toBe(true);
        expect(new Set(measure.events.map((event) => event.source.staffNumber))).toEqual(new Set([1, 2]));
      }
      expect(JSON.stringify(original)).toBe(before);
      if (count % 4 === 0) expect(grid.xml).toBe(xml);
    });
  }

  for (const [beats, beatType, duration] of [['3', '4', 3], ['6', '8', 3], ['3+2', '8', 2.5]] as const) {
    it(`uses the ending ${beats}/${beatType} meter for blank cells on both staves`, () => {
      const xml = scoreWithMeasures(5).replace('<measure number="5">', `<measure number="5"><attributes><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`);
      const padded = importScoreText(prepareMeasureGrid(xml).xml, 'meter.musicxml').doc!.engine!;
      for (const measure of padded.parts[0].measures.slice(5)) {
        expect(measure.events).toHaveLength(2);
        expect(measure.events.every((event) => event.kind === 'rest' && toNumber(event.durationBeat) === duration)).toBe(true);
        expect(toNumber(measure.events[0].onsetBeat)).toBe(toNumber(measure.events[1].onsetBeat));
      }
    });
  }

  it('keeps blank rests invisible rather than adding visible musical instructions', () => {
    const grid = prepareMeasureGrid(scoreWithMeasures(5));
    const appended = [...grid.xml.matchAll(/<measure\b[\s\S]*?<\/measure>/g)].slice(5).map((match) => match[0]);
    for (const measure of appended) {
      expect(measure.match(/print-object="no"/g)).toHaveLength(2);
      expect(measure).not.toMatch(/<pitch>|<time>|<clef>|<direction>|<sound/);
    }
  });

  it('pads every part to the same final slot without duplicating real measures', () => {
    const xml = scoreWithMeasures(5);
    const part = xml.match(/<part id="P1">[\s\S]*?<\/part>/)![0].replace('id="P1"', 'id="P2"');
    const multi = xml.replace('</part-list>', '<score-part id="P2"><part-name>Second piano</part-name></score-part></part-list>')
      .replace('</score-partwise>', `${part}</score-partwise>`);
    const display = importScoreText(prepareMeasureGrid(multi).xml, 'parts.musicxml').doc!.engine!;
    expect(display.parts.map((entry) => entry.measures.length)).toEqual([8, 8]);
    expect(display.parts.map((entry) => entry.measures.slice(5).flatMap((measure) => measure.events).every((event) => event.kind === 'rest'))).toEqual([true, true]);
  });
});
