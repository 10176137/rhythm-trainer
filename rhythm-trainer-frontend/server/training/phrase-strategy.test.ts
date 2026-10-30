import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { generateSkillExercise } from '../training-service.mjs';
import { generateProgram } from '../training-programs.mjs';
import { importScoreText } from '../../src/features/score/scoreImport';
import { toNumber } from '../../src/score-engine/domain/rational';
import { SKILL_DRILLS } from './skill-drill-catalog.mjs';
import { projectScoreDocumentV1 } from '../../src/score-engine/contract-v1/plan-fingerprint';

function inspect(id: string, level = 1, seed = 0, key = 'C', hand = 'right') {
  const definition = SKILL_DRILLS.find((entry) => entry.id === id)!;
  const drill = generateSkillExercise({ id, level, bpm: 60, seed,
    ...(definition.category === 'fundamentals' ? { options: { key, hand } } : {}) } as never);
  const imported = importScoreText(drill.xml, 'phrase.musicxml');
  return { drill, imported, measures: imported.doc!.engine!.parts[0].measures };
}

describe('bounded, goal-specific practice phrases', () => {
  it('teaches tonic triad attacks, holding and re-entry instead of copying one bar', () => {
    const { drill, measures } = inspect('triads');
    const signatures = measures.map((measure) => JSON.stringify(measure.events.map((event) =>
      [event.kind, event.pitch?.midiNote, toNumber(event.onsetBeat) - toNumber(measure.startBeat), toNumber(event.durationBeat)])));
    expect(new Set(signatures).size).toBeGreaterThanOrEqual(3);
    expect(new Set(measures.flatMap((measure) => measure.events.filter((event) => event.kind === 'note').map((event) => event.pitch!.midiNote)))).toEqual(new Set([60, 64, 67]));
    expect(measures.some((measure) => measure.events.some((event) => event.kind === 'rest'))).toBe(true);
    expect(measures.at(-1)!.events.filter((event) => event.kind === 'note').map((event) => [event.pitch!.midiNote, toNumber(event.durationBeat)])).toEqual([[60, 4], [64, 4], [67, 4]]);
    expect(drill.lesson.pattern).toContain('休止');
    expect(drill.xml).toContain('<bar-style>light-heavy</bar-style>');
  });
  it('replays a seed exactly and offers several complete triad variants', () => {
    expect(inspect('triads', 1, 1).drill.xml).toBe(inspect('triads', 1, 1).drill.xml);
    expect(new Set([0, 1, 2, 3, 4, 5].map((seed) => inspect('triads', 1, seed).drill.xml)).size).toBeGreaterThanOrEqual(3);
    for (const seed of [-1, 1.5, 0x100000000]) expect(() => inspect('triads', 1, seed)).toThrow();
  });
  for (const id of ['five-finger', 'scales', 'broken-chords', 'triads', 'arpeggios', 'leaps']) {
    for (const level of [1, 2, 3]) it(`${id} level ${level} keeps complete voices, playable ranges and tonic endings across variants`, () => {
      const variants = new Set<string>();
      for (const seed of [0, 1, 2]) for (const key of ['C', 'G', 'F']) for (const hand of ['right', 'left', 'both']) {
        const { drill, imported, measures } = inspect(id, level, seed, key, hand);
        expect(imported.report.strictAllowed).toBe(true);
        expect(imported.report.issues).toEqual([]);
        for (const measure of measures) expect(toNumber(measure.durationBeat)).toBe(4);
        for (const measure of measures) for (const staff of drill.staffHands) {
          const durations = new Map<number, number>();
          for (const event of measure.events.filter((event) => event.source.staffNumber === staff.staffNumber)) durations.set(toNumber(event.onsetBeat) - toNumber(measure.startBeat), toNumber(event.durationBeat));
          let end = 0;
          for (const [at, duration] of [...durations].sort((a, b) => a[0] - b[0])) { expect(at).toBe(end); end += duration; }
          expect(end).toBe(4);
        }
        const notes = measures.flatMap((measure) => measure.events.filter((event) => event.kind === 'note'));
        if (key === 'C' && hand === 'right') variants.add(drill.xml);
        if (id === 'five-finger' && level === 1) {
          for (const staff of drill.staffHands) {
            const pitches = notes.filter((event) => event.source.staffNumber === staff.staffNumber).map((event) => event.pitch!.midiNote);
            expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThanOrEqual(7);
          }
          expect(notes.every((event) => toNumber(event.durationBeat) >= 1)).toBe(true);
        }
        if (id === 'scales') for (const staff of drill.staffHands) {
          const pitches = notes.filter((event) => event.source.staffNumber === staff.staffNumber).map((event) => event.pitch!.midiNote);
          const tonic = key === 'C' ? 0 : key === 'G' ? 7 : 5;
          expect(pitches.at(-1)! % 12).toBe(tonic);
          // A full octave route always contains all seven scale degrees.
          expect(new Set(pitches.map((pitch) => pitch % 12)).size).toBe(7);
        }
      }
      expect(variants.size).toBeGreaterThanOrEqual(2);
    });
  }
  it('varies rhythm phrases while keeping a single pitch per hand and complete voices', () => {
    for (const id of ['pulse', 'subdivision', 'syncopation', 'coordination']) for (const level of [1, 2, 3]) {
      const variants = new Set<string>();
      for (const seed of [0, 1, 2]) {
        const { drill, imported, measures } = inspect(id, level, seed);
        expect(imported.report.issues).toEqual([]);
        variants.add(drill.xml);
        for (const staff of drill.staffHands) {
          const events = measures.flatMap((measure) => measure.events).filter((event) => event.source.staffNumber === staff.staffNumber);
          expect(new Set(events.filter((event) => event.kind === 'note').map((event) => event.pitch!.midiNote))).toEqual(new Set([staff.hand === 'left' ? 48 : 60]));
          for (const measure of measures) expect(measure.events.filter((event) => event.source.staffNumber === staff.staffNumber).reduce((sum, event) => sum + toNumber(event.durationBeat), 0)).toBe(4);
        }
      }
      if (id !== 'pulse') expect(variants.size).toBeGreaterThanOrEqual(2);
    }
  });
  it('changes phrases even with a single selected project and key; repeat mode remains reproducible', () => {
    const config = { mode: 'timed', minutes: 2, variation: 'shuffle', ids: ['triads'], keys: ['C'], hand: 'right', level: 1, bpm: 60, seed: 0 };
    const drill = generateProgram(config);
    const phrases = drill.xml.match(/<measure\b[^>]*>[\s\S]*?<\/measure>/g)!;
    const normalized = phrases.map((bar) => bar.replace(/<attributes>[\s\S]*?<\/attributes>/g, '').replace(/<direction[\s\S]*?<\/direction>/g, '').replace(/number="\d+"/, ''));
    expect(new Set(normalized.slice(0, 4)).size).toBeGreaterThanOrEqual(3);
    expect(normalized.slice(0, 4)).not.toEqual(normalized.slice(4, 8));
    expect(generateProgram({ ...config, seed: 1 }).xml).not.toBe(drill.xml);
    expect(generateProgram({ ...config, variation: 'repeat', seed: 1 }).xml).toBe(generateProgram({ ...config, variation: 'repeat', seed: 2 }).xml);
  });
  it('keeps the existing fixed baseline score suitable for historical comparisons', () => {
    const baseline = generateProgram({ mode: 'assessment' });
    expect(baseline.program.benchmarkVersion).toBe('piano-baseline-1');
    expect(createHash('sha256').update(baseline.xml).digest('hex')).toBe('b8aa2d5f3fd612cf2eed4a4d17ece2b5e32aed68d61515c7f694b2a03fea31eb');
  });
  it('preserves coverage and phrase variation across minute-long segment boundaries', () => {
    const config = { mode: 'continuous', minutes: 5, variation: 'shuffle', ids: ['five-finger', 'scales', 'triads'], keys: ['C', 'G', 'F'], hand: 'right', level: 1, bpm: 60, seed: 7 };
    let generationState;
    const sections = [];
    for (let segment = 0; segment < 3; segment++) {
      const drill = generateProgram(config, { generationState });
      generationState = drill.program.generationState;
      sections.push(...drill.program.sections);
    }
    expect(new Set(sections.slice(0, 9).map((section) => `${section.id}:${section.key}`)).size).toBe(9);
    expect(sections.every((section, index) => index === 0 || `${section.id}:${section.key}` !== `${sections[index - 1].id}:${sections[index - 1].key}`)).toBe(true);
  });
  it('passes generated variants through the real Rust plan and fingerprint gate', () => {
    const native = createRequire(import.meta.url)('../../../rhythm-trainer-core-v0.2/bindings/node');
    for (const definition of SKILL_DRILLS) for (const level of [1, 2, 3]) for (const seed of [0, 1, 2]) {
      const { drill, imported } = inspect(definition.id, level, seed, 'F', 'both');
      const { dto } = projectScoreDocumentV1(imported.doc!.engine!, imported.report);
      const config = { partId: 'P1', range: { startMeasureOrdinal: 1, endMeasureOrdinal: drill.bars }, repeatSelection: { kind: 'none' }, hand: drill.hand,
        handMapping: { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: [{ partId: 'P1', staves: drill.staffHands }] },
        bpm: { numerator: 60, denominator: 1 }, ticksPerQuarter: 960, countInUs: 3000000, unsupportedNotationPolicy: 'reject-strict', plannerVersion: 'rust-planner-1' };
      const plan = JSON.parse(native.buildPlanV1(JSON.stringify(dto), JSON.stringify(imported.report), JSON.stringify(config)));
      expect(plan.planStrictAllowed).toBe(true);
      expect(plan.occurrences).toHaveLength(imported.report.counts.noteCount);
      expect(native.planFingerprintV1Gate(JSON.stringify(dto), JSON.stringify(imported.report), JSON.stringify(plan), JSON.stringify(config))).toMatch(/^plan-v1:sha256:/);
    }
  }, 15000);
});
