import { describe, expect, it } from 'vitest';
import { importScoreText } from '../score/scoreImport';
import { toNumber } from '../../score-engine/domain/rational';
import {
  ReadingGeneratorError,
  generateFreeQuestions,
  generateRhythmScore,
  questionStaff,
  questionXml,
} from './readingGenerator';
import { FreeReadingSession } from './freeReadingSession';
import { READING_KEY_COUNT, poolFromRanges } from './readingKeys';

const RANGES = [{ startMidi: 60, endMidi: 72 }];

describe('reading key range', () => {
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

  it('renders question XML that parses as a real one-measure score', () => {
    const xml = questionXml([60, 64, 67], questionStaff([60, 64, 67]));
    const imported = importScoreText(xml, 'q.musicxml');
    expect(imported.report.status).toMatch(/READY/);
    expect(imported.doc?.notes.filter((note) => !note.isTieContinuation)).toHaveLength(3);
  });
});

describe('free reading session', () => {
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
