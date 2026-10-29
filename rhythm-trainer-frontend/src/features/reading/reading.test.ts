import { questionStaff, questionXml } from './readingNotation';
import { describe, expect, it } from 'vitest';
import { importScoreText } from '../score/scoreImport';
import { toNumber } from '../../score-engine/domain/rational';
import {
  ReadingGeneratorError,
  generateFreeQuestions,
  generateRhythmScore,
} from '../../../server/training/reading-generator.mjs';
import { FreeReadingSession } from './freeReadingSession';
import { READING_KEY_COUNT, poolFromRanges, READING_OCTAVES } from './readingKeys';

const RANGES = [{ startMidi: 60, endMidi: 72 }];

describe('reading key range', () => {
  it('offers non-overlapping octave groups covering the keyboard', () => {
    const ranges = READING_OCTAVES.map((octave) => octave.range);
    const all = ranges.flatMap((range) => poolFromRanges([range]));
    expect(all).toHaveLength(81);
    expect(new Set(all).size).toBe(81);
    expect(all[0]).toBe(28);
    expect(all.at(-1)).toBe(108);
    expect(READING_OCTAVES.find((octave) => octave.id === '4')?.range).toEqual({ startMidi: 60, endMidi: 71 });
  });

  it('defines exactly 81 keys and dedupes overlapping ranges', () => {
    expect(READING_KEY_COUNT).toBe(81);
    const pool = poolFromRanges([
      { startMidi: 60, endMidi: 72 },
      { startMidi: 67, endMidi: 79 },
      { startMidi: 36, endMidi: 40 },
    ]);
    expect(pool).toEqual([36, 37, 38, 39, 40, ...Array.from({ length: 20 }, (_, i) => 60 + i)]);
  });
});

describe('reading generator', () => {
  it('covers each selected pitch before repeating a single-note target', () => {
    for (const seed of [1, 3, 7, 99]) {
      const questions = generateFreeQuestions({ mode: 'free', ranges: [{ startMidi: 60, endMidi: 71 }], notesPerEvent: 1, seed, questionCount: 20 });
      expect(new Set(questions.slice(0, 12).flatMap((q) => q.midiNotes)).size).toBe(12);
      expect(questions.some((q) => q.midiNotes[0] === 70)).toBe(true);
    }
  });
  it('is deterministic for the same config + seed and changes with the seed', () => {
    const a = generateFreeQuestions({ mode: 'free', ranges: RANGES, notesPerEvent: 2, seed: 7, questionCount: 20 });
    const b = generateFreeQuestions({ mode: 'free', ranges: RANGES, notesPerEvent: 2, seed: 7, questionCount: 20 });
    expect(a).toEqual(b);
    const c = generateFreeQuestions({ mode: 'free', ranges: RANGES, notesPerEvent: 2, seed: 8, questionCount: 20 });
    expect(c).not.toEqual(a);
  });

  it('generates the requested question count with distinct pitches per question', () => {
    const questions = generateFreeQuestions({ mode: 'free', ranges: RANGES, notesPerEvent: 3, seed: 1, questionCount: 40 });
    expect(questions).toHaveLength(40);
    for (const question of questions) {
      expect(new Set(question.midiNotes).size).toBe(3);
      expect(question.midiNotes.every((midi) => midi >= 60 && midi <= 72)).toBe(true);
    }
  });

  it('generates rhythm scores that parse and satisfy the meter for every time signature', () => {
    for (const timeSignature of [[2, 4], [3, 4], [4, 4]] as [2 | 3 | 4, 4][]) {
      const generated = generateRhythmScore({
        mode: 'rhythm', ranges: RANGES, notesPerEvent: 1, seed: 42,
        timeSignature, bpm: 60, complexity: 'basic', measures: 4, countInMeasures: 1,
      });
      const imported = importScoreText(generated.xml, 'reading.musicxml');
      expect(imported.report.status).toMatch(/READY/);
      expect(imported.doc?.engine?.parts[0]?.measures).toHaveLength(4);
      expect(generated.summary.beatsPerBar).toBe(timeSignature[0]);
    }
  });

  it('scales event chord size with notesPerEvent without duplicate pitches', () => {
    for (const notesPerEvent of [1, 2, 3, 4] as const) {
      const generated = generateRhythmScore({
        mode: 'rhythm', ranges: [{ startMidi: 48, endMidi: 84 }], notesPerEvent, seed: 5,
        timeSignature: [4, 4], bpm: 60, complexity: 'intermediate', measures: 2, countInMeasures: 1,
      });
      const doc = importScoreText(generated.xml, 'reading.musicxml').doc;
      const onsets = new Map<string, Set<number>>();
      for (const measure of doc?.engine?.parts[0]?.measures ?? []) {
        for (const event of measure.events) {
          if (event.kind !== 'note') continue;
          const key = `${measure.ordinal}:${toNumber(event.onsetBeat)}`;
          const set = onsets.get(key) ?? new Set<number>();
          set.add(event.pitch?.midiNote ?? -1);
          onsets.set(key, set);
        }
      }
      const sizes = [...onsets.values()].map((set) => set.size);
      expect(sizes.every((size) => size === notesPerEvent)).toBe(true);
      expect(generated.summary.eventCount).toBe(onsets.size);
    }
  });

  it('keeps multi-note events on one staff and single events on the pitch-matching staff', () => {
    const generated = generateRhythmScore({
      mode: 'rhythm', ranges: [{ startMidi: 48, endMidi: 84 }], notesPerEvent: 2, seed: 9,
      timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 2, countInMeasures: 1,
    });
    const doc = importScoreText(generated.xml, 'reading.musicxml').doc;
    for (const measure of doc?.engine?.parts[0]?.measures ?? []) {
      const groups = new Map<number, Set<number>>();
      for (const event of measure.events) {
        if (event.kind !== 'note') continue;
        const onset = toNumber(event.onsetBeat);
        const set = groups.get(onset) ?? new Set<number>();
        set.add(event.source.staffNumber);
        groups.set(onset, set);
      }
      for (const staves of groups.values()) expect(staves.size).toBe(1);
    }
    expect(questionStaff([48, 72])).toBe(2);
    expect(questionStaff([36, 48])).toBe(2);
    expect(questionStaff([60, 64])).toBe(1);
  });

  it('rejects pools too small for the requested chord size', () => {
    expect(() => generateFreeQuestions({ mode: 'free', ranges: [{ startMidi: 60, endMidi: 60 }], notesPerEvent: 2, seed: 1 }))
      .toThrowError(ReadingGeneratorError);
    expect(() => generateRhythmScore({
      mode: 'rhythm', ranges: [{ startMidi: 60, endMidi: 61 }], notesPerEvent: 3, seed: 1,
      timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 2,
    })).toThrowError(/不足/);
  });

  it('spells accidentals by key signature without changing MIDI pitch', () => {
    // MIDI 70 = A♯/B♭：不限调（fifths=0）写升号侧 A♯；F 大调（-1）写降号侧 B♭
    const natural = questionXml([70], 1);
    expect(natural).toContain('<step>A</step><alter>1</alter><octave>4</octave>');
    expect(importScoreText(natural, 'question.musicxml').doc?.notes[0]?.midiNote).toBe(70);
    const flat = questionXml([70], 1, { root: 'F', mode: 'major' });
    expect(flat).toContain('<fifths>-1</fifths>');
    expect(flat).toContain('<step>B</step><alter>-1</alter><octave>4</octave>');
    expect(importScoreText(flat, 'question.musicxml').doc?.notes[0]?.midiNote).toBe(70);
    // 节奏谱同理：F 大调把音高 70 记成 B♭，MIDI 不变
    const rhythm = generateRhythmScore({
      mode: 'rhythm', ranges: [{ startMidi: 70, endMidi: 70 }], notesPerEvent: 1, seed: 3, measures: 4,
      key: { root: 'F', mode: 'major' },
    });
    expect(rhythm.xml).toContain('<step>B</step><alter>-1</alter><octave>4</octave>');
    expect(importScoreText(rhythm.xml, 'rhythm.musicxml').doc?.notes.every((note) => note.midiNote === 70)).toBe(true);
  });

  it('renders question XML that parses as a real one-measure score', () => {
    const xml = questionXml([60, 64, 67], questionStaff([60, 64, 67]));
    const imported = importScoreText(xml, 'q.musicxml');
    expect(imported.report.status).toMatch(/READY/);
    expect(imported.doc?.notes.filter((note) => !note.isTieContinuation)).toHaveLength(3);
  });
});

describe('free reading session', () => {
  it('reports no assessment before input, and counts actual hits in a partial chord', () => {
    const s = new FreeReadingSession([[60, 64], [67]]);
    expect(s.snapshot().hitAccuracy).toBeNull();
    expect(s.snapshot().firstTryAccuracy).toBeNull();
    s.noteOn(60); s.noteOn(61); s.endEarly();
    expect(s.snapshot().hitAccuracy).toBe(50);
    expect(s.snapshot().firstTryAccuracy).toBe(0);
  });

  it('records the expected target and mistaken key separately for review', () => {
    const s = new FreeReadingSession([[70], [60, 64]]);
    s.noteOn(69); s.noteOn(70); s.noteOn(60); s.noteOn(65);
    expect(s.weakestPitches().map((item) => item.midi)).toEqual([64, 70]);
    expect(s.snapshot().confusions).toEqual([
      { remainingTargets: [70], pressed: 69, questionIndex: 0 },
      { remainingTargets: [64], pressed: 65, questionIndex: 1 },
    ]);
  });

  it('records help as assisted and excludes it from first-try success', () => {
    const s = new FreeReadingSession([[70]]);
    s.hint(); s.noteOn(70);
    expect(s.snapshot().hintedQuestions).toBe(1);
    expect(s.snapshot().firstTryAccuracy).toBe(0);
    const test = new FreeReadingSession([[70]], { task: 'test' });
    expect(test.hint()).toBe(false);
  });
  function session(): FreeReadingSession {
    return new FreeReadingSession([[60, 64], [67, 72], [60]]);
  }

  it('matches targets in any order, dedupes repeats, and requires all targets', () => {
    const s = session();
    expect(s.noteOn(64)).toBe('hit');
    expect(s.noteOn(64)).toBe('duplicate');
    expect(s.noteOn(60)).toBe('hit');
    expect(s.status).toBe('running');
    expect(s.currentIndex).toBe(1);
  });

  it('records wrong presses per pitch without advancing or penalizing timing', () => {
    const s = session();
    expect(s.noteOn(61)).toBe('wrong');
    expect(s.noteOn(61)).toBe('wrong');
    expect(s.noteOn(64)).toBe('hit');
    expect(s.noteOn(60)).toBe('hit');
    expect(s.currentIndex).toBe(1);
    expect(s.totalWrongPresses).toBe(2);
    expect(s.snapshot().wrongByPitch.get(61)).toBe(2);
    // 61 was pressed wrongly, never a target: it must not appear as a hit stat.
    expect(s.snapshot().perPitch.get(61)).toMatchObject({ hits: 0, wrongPresses: 2 });
  });

  it('completes after the last question and tracks first-try correctness', () => {
    const s = session();
    s.noteOn(60); s.noteOn(64); // q1 clean
    s.noteOn(67); s.noteOn(72); // q2 clean
    s.noteOn(61); // q3 wrong first
    s.noteOn(60);
    expect(s.status).toBe('completed');
    expect(s.completedQuestions).toBe(3);
    expect(s.firstTryCorrectQuestions).toBe(2);
  });

  it('ignores input while paused and after ending early', () => {
    const s = session();
    s.pause();
    expect(s.noteOn(60)).toBe('ignored');
    s.resume();
    expect(s.noteOn(60)).toBe('hit');
    s.endEarly();
    expect(s.noteOn(64)).toBe('ignored');
    expect(s.status).toBe('ended-early');
  });
});
