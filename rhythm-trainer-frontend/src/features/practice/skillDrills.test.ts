import { describe, expect, it } from 'vitest';
import { createSkillDrill, SKILL_DRILLS, type DrillLevel } from './skillDrills';
import { importScoreText } from '../score/scoreImport';
import { toNumber } from '../../score-engine/domain/rational';

describe('playable skill drills', () => {
  for (const drill of SKILL_DRILLS) {
    for (const level of [1, 2, 3] as DrillLevel[]) {
      it(`${drill.id} level ${level} imports as full 4/4 measures ready for strict practice`, () => {
        const generated = createSkillDrill(drill.id, level, 60);
        const result = importScoreText(generated.xml, 'drill.musicxml');
        expect(result.report.strictAllowed).toBe(true);
        expect(result.doc?.engine?.parts).toHaveLength(1);
        const part = result.doc!.engine!.parts[0];
        expect(part.staves).toBe(drill.id === 'coordination' ? 2 : 1);
        expect(part.measures).toHaveLength(generated.bars);
        for (const measure of part.measures) {
          expect(toNumber(measure.durationBeat)).toBe(4);
          expect(measure.events.some((event) => event.kind === 'note')).toBe(true);
        }
      });
    }
    it(`${drill.id} has reproducible material and distinct levels`, () => {
      expect(createSkillDrill(drill.id, 2, 60)).toEqual(createSkillDrill(drill.id, 2, 60));
      const body = (level: DrillLevel) => createSkillDrill(drill.id, level, 60).xml.replace(/<work>.*?<\/work>/, '');
      expect(body(2)).not.toBe(body(3));
    });
  }
  it('rejects unsupported speeds and levels before creating a score', () => {
    expect(() => createSkillDrill('pulse', 1, 0)).toThrow();
    expect(() => createSkillDrill('pulse', 4 as DrillLevel, 60)).toThrow();
  });
});
