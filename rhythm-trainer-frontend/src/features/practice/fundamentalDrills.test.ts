import { describe, expect, it } from 'vitest';
import { createSkillDrill, FUNDAMENTAL_DRILLS, type DrillKey, type DrillHand, type DrillLevel } from '../../../server/training/skill-drills.mjs';
import { importScoreText } from '../score/scoreImport';
import { getUnsupportedNotes } from '../score/staffMapping';
import { toNumber } from '../../score-engine/domain/rational';
import { assessPracticeScope, buildUserHandMapping } from '../../score-engine/scope/practice-scope';

const keys: DrillKey[] = ['C', 'G', 'F'];
const hands: DrillHand[] = ['right', 'left', 'both'];
const levels: DrillLevel[] = [1, 2, 3];

describe('fundamental drill score contracts', () => {
  for (const definition of FUNDAMENTAL_DRILLS) {
    for (const key of keys) for (const hand of hands) for (const level of levels) {
      it(`${definition.id}: ${key}, ${hand}, level ${level} has complete voices and a strict-playable hand scope`, () => {
        const generated = createSkillDrill(definition.id, level, 60, { key, hand });
        const result = importScoreText(generated.xml, 'fundamental.musicxml');
        expect(result.report.strictAllowed).toBe(true);
        expect(getUnsupportedNotes(result.doc!.notes, generated.bars)).toEqual([]);
        const engine = result.doc!.engine!;
        const part = engine.parts[0];
        expect(part.staves).toBe(hand === 'both' ? 2 : 1);
        expect(part.measures).toHaveLength(generated.bars);
        for (const measure of part.measures) {
          expect(toNumber(measure.durationBeat)).toBe(4);
          for (const { staffNumber } of generated.staffHands) {
            const durations = new Map<number, number>();
            for (const event of measure.events.filter((event) => event.source.staffNumber === staffNumber)) {
              const at = toNumber(event.onsetBeat) - toNumber(measure.startBeat);
              const duration = toNumber(event.durationBeat);
              expect(at).toBeGreaterThanOrEqual(0);
              expect(at + duration).toBeLessThanOrEqual(4);
              durations.set(at, Math.max(durations.get(at) ?? 0, duration));
              if (event.kind === 'note') expect(event.pitch?.midiNote).not.toBeNull();
            }
            let end = 0;
            for (const [at, duration] of [...durations].sort((a, b) => a[0] - b[0])) {
              expect(at).toBe(end);
              end += duration;
            }
            expect(end).toBe(4);
          }
        }
        expect(assessPracticeScope(engine, {
          schemaVersion: 1, partId: part.id, range: { startMeasureOrdinal: 1, endMeasureOrdinal: generated.bars },
          hand, handMapping: buildUserHandMapping(part.id, generated.staffHands),
        }).ok).toBe(true);
      });
    }
  }

  it('uses the correct sharp/flat spelling for G and F major scales', () => {
    for (const [key, alteredStep, alter] of [['G', 'F', 1], ['F', 'B', -1]] as const) {
      const generated = createSkillDrill('scales', 1, 60, { key, hand: 'right' });
      const notes = importScoreText(generated.xml, 'scale.musicxml').doc!.engine!.parts[0].measures.flatMap((measure) => measure.events).filter((event) => event.kind === 'note');
      expect(notes.some((note) => note.pitch?.step === alteredStep && note.pitch.alter === alter)).toBe(true);
      expect(notes.some((note) => note.pitch?.step === alteredStep && note.pitch.alter === 0)).toBe(false);
    }
  });

  it('creates triads as simultaneous three-note groups, not sequential notes', () => {
    const generated = createSkillDrill('triads', 1, 60, { key: 'C', hand: 'right' });
    const notes = importScoreText(generated.xml, 'chords.musicxml').doc!.engine!.parts[0].measures[0].events;
    expect(notes.slice(0, 3).map((note) => note.pitch?.midiNote)).toEqual([60, 64, 67]);
    expect(notes.slice(0, 3).map((note) => toNumber(note.onsetBeat))).toEqual([0, 0, 0]);
    expect(new Set(notes.slice(0, 3).map((note) => note.chordGroupId)).size).toBe(1);
  });

  it('places left-only material on a bass staff and maps it to the left hand', () => {
    const generated = createSkillDrill('five-finger', 1, 60, { key: 'C', hand: 'left' });
    const part = importScoreText(generated.xml, 'left.musicxml').doc!.engine!.parts[0];
    expect(part.measures[0].attributes.clefs[0].sign).toBe('F');
    expect(part.measures[0].events[0].pitch?.midiNote).toBe(48);
    expect(generated.staffHands).toEqual([{ staffNumber: 1, hand: 'left' }]);
    expect(generated.xml).toContain('<fingering placement="above">5</fingering>');
  });

  it('annotates F-major right-hand B-flat with finger 4 and keeps all fingers in range', () => {
    const xml = createSkillDrill('scales', 1, 60, { key: 'F', hand: 'right' }).xml;
    const notes = xml.match(/<note>.*?<\/note>/g)!;
    const bFlat = notes.find((note) => note.includes('<step>B</step><alter>-1</alter>'))!;
    expect(bFlat).toContain('<fingering placement="above">4</fingering>');
    for (const match of xml.matchAll(/<fingering placement="above">(\d+)<\/fingering>/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(1);
      expect(Number(match[1])).toBeLessThanOrEqual(5);
    }
  });

  it('rejects unsupported keys and hands instead of silently changing them', () => {
    expect(() => createSkillDrill('scales', 1, 60, { key: 'D' as DrillKey, hand: 'right' })).toThrow();
    expect(() => createSkillDrill('scales', 1, 60, { key: 'C', hand: 'none' as DrillHand })).toThrow();
  });
});
