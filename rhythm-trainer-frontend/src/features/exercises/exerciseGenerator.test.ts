import { describe, expect, it } from 'vitest';
import { importScoreText } from '../score/scoreImport';
import {
  ExerciseGeneratorError,
  EXERCISE_GENERATOR_VERSION,
  generateExercise,
  type ArpeggioExerciseSpec,
  type RhythmExerciseSpec,
} from './exerciseGenerator';

function rhythm(overrides: Partial<RhythmExerciseSpec> = {}): RhythmExerciseSpec {
  return {
    kind: 'rhythm',
    seed: 20261027,
    bpm: 80,
    hand: 'right',
    timeSignature: [4, 4],
    bars: 4,
    rhythmPattern: 'quarter',
    pitchMode: 'fixed',
    ...overrides,
  };
}

function arpeggio(overrides: Partial<ArpeggioExerciseSpec> = {}): ArpeggioExerciseSpec {
  return {
    kind: 'arpeggio',
    seed: 20261027,
    bpm: 80,
    hand: 'right',
    timeSignature: [4, 4],
    bars: 2,
    rhythmPattern: 'quarter',
    root: 'C',
    quality: 'major',
    direction: 'up',
    octaves: 1,
    ...overrides,
  };
}

describe('exercise generator', () => {
  it('is deterministic for the same spec + seed + generator version', () => {
    const a = generateExercise(rhythm());
    const b = generateExercise(rhythm());
    expect(a.xml).toBe(b.xml);
    expect(a.exerciseId).toBe(b.exerciseId);
    expect(a.contentFingerprint).toBe(b.contentFingerprint);
    expect(a.generatorVersion).toBe(EXERCISE_GENERATOR_VERSION);
    expect(generateExercise(rhythm({ pitchMode: 'five-note', seed: 20261028 })).xml)
      .not.toBe(generateExercise(rhythm({ pitchMode: 'five-note' })).xml);
  });

  it('parses into a canonical score and respects the meter capacity', () => {
    for (const timeSignature of [[2, 4], [3, 4], [4, 4]] as [number, number][]) {
      const generated = generateExercise(rhythm({ timeSignature, bars: 4 }));
      const imported = importScoreText(generated.xml, 'generated.musicxml');
      expect(imported.report.status).toMatch(/READY/);
      expect(imported.doc?.engine).toBeTruthy();
      expect(imported.doc?.engine?.parts[0]?.measures).toHaveLength(4);
      expect(imported.doc?.engine?.parts[0]?.measures[0]?.attributes.time).toMatchObject({
        beats: timeSignature[0], beatType: 4,
      });
      expect(generated.summary.noteCount).toBeGreaterThan(0);
    }
  });

  it('generates rests and dotted rhythms without overflowing a measure', () => {
    const rest = generateExercise(rhythm({ rhythmPattern: 'eighth-rest', bars: 2 }));
    expect(rest.summary.restCount).toBe(2 * 4);
    const dotted = generateExercise(rhythm({ rhythmPattern: 'dotted', bars: 2 }));
    const imported = importScoreText(dotted.xml, 'dotted.musicxml');
    expect(imported.report.status).toMatch(/READY/);
    expect(dotted.xml).toContain('<dot/>');
  });

  it('builds arpeggio pitch order from root/quality/direction', () => {
    const up = generateExercise(arpeggio({ bars: 2 }));
    const doc = importScoreText(up.xml, 'arp.musicxml').doc;
    const notes = doc?.notes.filter((note) => !note.isTieContinuation).slice(0, 4) ?? [];
    expect(notes.map((note) => note.midiNote)).toEqual([60, 64, 67, 72]);
    const down = generateExercise(arpeggio({ direction: 'down', bars: 2 }));
    const downNotes = importScoreText(down.xml, 'arp.musicxml').doc?.notes.slice(0, 4) ?? [];
    expect(downNotes.map((note) => note.midiNote)).toEqual([72, 67, 64, 60]);
    const minor = generateExercise(arpeggio({ quality: 'minor', root: 'A', bars: 2 }));
    const minorNotes = importScoreText(minor.xml, 'arp.musicxml').doc?.notes.slice(0, 4) ?? [];
    expect(minorNotes.map((note) => note.midiNote)).toEqual([69, 72, 76, 81]);
  });

  it('puts left-hand exercises on staff 2', () => {
    const generated = generateExercise(rhythm({ hand: 'left', pitchMode: 'five-note' }));
    const doc = importScoreText(generated.xml, 'left.musicxml').doc;
    expect(doc?.engine?.parts[0]?.measures[0]?.events.some((event) => event.source.staffNumber === 2)).toBe(true);
  });

  it('rejects impossible specs instead of generating an invalid score', () => {
    expect(() => generateExercise(rhythm({ rhythmPattern: 'dotted', timeSignature: [3, 4] })))
      .toThrowError(ExerciseGeneratorError);
    expect(() => generateExercise(rhythm({ bars: 3 as 4 }))).toThrowError(/小节数/);
    expect(() => generateExercise(rhythm({ bpm: 10 }))).toThrowError(/BPM/);
  });
});
