import { describe, expect, it } from 'vitest';
import { createSkillDrill, SKILL_DRILLS, type DrillLevel } from '../../../server/training/skill-drills.mjs';
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


describe('rhythm drills isolate the advertised skill', () => {
  const events = (id: 'pulse' | 'subdivision' | 'syncopation' | 'coordination', level: DrillLevel) =>
    importScoreText(createSkillDrill(id, level, 60).xml, 'rhythm.musicxml').doc!.engine!.parts[0].measures.flatMap((measure) => measure.events);
  it('keeps one pitch per hand so rhythm levels do not become sight-reading tests', () => {
    for (const id of ['pulse', 'subdivision', 'syncopation', 'coordination'] as const) for (const level of [1, 2, 3] as DrillLevel[]) {
      const notes = events(id, level).filter((event) => event.kind === 'note');
      expect(new Set(notes.filter((note) => note.source.staffNumber === 1).map((note) => note.pitch?.midiNote))).toEqual(new Set([60]));
      if (id === 'coordination') expect(new Set(notes.filter((note) => note.source.staffNumber === 2).map((note) => note.pitch?.midiNote))).toEqual(new Set([48]));
    }
  });
  it('includes real offbeat sustains in advanced syncopation', () => {
    const notes = events('syncopation', 3).filter((event) => event.kind === 'note');
    expect(notes.some((event) => toNumber(event.onsetBeat) % 1 === .5 && toNumber(event.durationBeat) === 1.5)).toBe(true);
  });
  it('trains both alternating hands and shared attacks in coordination level 3', () => {
    const notes = events('coordination', 3).filter((event) => event.kind === 'note');
    const right = notes.filter((note) => note.source.staffNumber === 1).map((note) => toNumber(note.onsetBeat));
    const left = notes.filter((note) => note.source.staffNumber === 2).map((note) => toNumber(note.onsetBeat));
    expect(right.some((at) => left.includes(at))).toBe(true);
    expect(right.some((at) => !left.includes(at))).toBe(true);
    expect(left.some((at) => !right.includes(at))).toBe(true);
  });
});
