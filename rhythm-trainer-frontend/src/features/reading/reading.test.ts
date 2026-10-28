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
import { READING_KEY_COUNT, keyFifths, keyScalePitchClasses, poolFromRanges, readingPool, spellMidi } from './readingKeys';

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

describe('key selection', () => {
  it('maps root+mode to key signatures (C 大调 0, b 小调 2, E♭ 大调 -3)', () => {
    expect(keyFifths({ root: 'C', mode: 'major' })).toBe(0);
    expect(keyFifths({ root: 'B', mode: 'minor' })).toBe(2);
    expect(keyFifths({ root: 'F', mode: 'major' })).toBe(-1);
    expect(keyFifths({ root: 'E', mode: 'major' })).toBe(4);
    expect(keyFifths({ root: 'A', mode: 'minor' })).toBe(0);
    expect(keyScalePitchClasses({ root: 'C', mode: 'major' })).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(keyScalePitchClasses({ root: 'A', mode: 'minor' })).toEqual([9, 11, 0, 2, 4, 5, 7]);
  });

  it('spells accidentals on the key’s side: sharps for sharp keys, flats for flat keys', () => {
    // C 大调（无调号）：黑键默认升号写法
    expect(spellMidi(61, 0)).toMatchObject({ step: 'C', alter: 1 });
    expect(spellMidi(70, 0)).toMatchObject({ step: 'A', alter: 1 });
    // F 大调（1 个降号）：B♭；E♭ 大调（3 个降号）：E♭/A♭/B♭
    expect(spellMidi(70, -1)).toMatchObject({ step: 'B', alter: -1 });
    expect(spellMidi(63, -3)).toMatchObject({ step: 'E', alter: -1 });
    expect(spellMidi(68, -3)).toMatchObject({ step: 'A', alter: -1 });
    expect(spellMidi(61, -3)).toMatchObject({ step: 'D', alter: -1 });
    // G 大调（1 个升号）：F♯；自然音永远是自然写法
    expect(spellMidi(66, 1)).toMatchObject({ step: 'F', alter: 1 });
    expect(spellMidi(64, 1)).toMatchObject({ step: 'E', alter: 0 });
    // 音池按调性筛选：C 大调在 C4–C5 内是 C4 与 C5 两个八度音 + 6 个中间音
    expect(readingPool([{ startMidi: 60, endMidi: 72 }], { root: 'C', mode: 'major' }))
      .toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
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

  it('honors a fixed staff preference: 左手 forces bass staff, 右手 forces treble', () => {
    for (const [preference, expectedStaff] of [['bass', 2], ['treble', 1]] as const) {
      const generated = generateRhythmScore({
        mode: 'rhythm', ranges: [{ startMidi: 60, endMidi: 72 }], notesPerEvent: 2, seed: 11,
        timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 2, countInMeasures: 1,
        staffPreference: preference,
      });
      const doc = importScoreText(generated.xml, 'reading.musicxml').doc;
      const staves = new Set<number>();
      for (const measure of doc?.engine?.parts[0]?.measures ?? []) {
        for (const event of measure.events) {
          if (event.kind === 'note') staves.add(event.source.staffNumber);
        }
      }
      expect([...staves]).toEqual([expectedStaff]);
      expect(questionStaff([60, 67], preference)).toBe(expectedStaff);
    }
  });

  it('writes the selected key signature and flat spellings into the score', () => {
    const generated = generateRhythmScore({
      mode: 'rhythm', ranges: [{ startMidi: 60, endMidi: 72 }], notesPerEvent: 2, seed: 12,
      timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 2, countInMeasures: 1,
      key: { root: 'E', mode: 'major' },
    });
    expect(generated.xml).toContain('<fifths>4</fifths>');
    const doc = importScoreText(generated.xml, 'reading.musicxml').doc;
    // E 大调音池内的音只允许自然音/升号侧拼写，不允许降号拼写
    for (const measure of doc?.engine?.parts[0]?.measures ?? []) {
      for (const event of measure.events) {
        if (event.kind !== 'note' || !event.pitch) continue;
        expect(['C', 'D', 'E', 'F', 'G', 'A', 'B']).toContain(event.pitch.step);
        expect(event.pitch.alter).toBeLessThanOrEqual(1);
      }
    }
    // 降调调性：F 大调（1 降号）的 B 写作 B♭
    const flat = generateRhythmScore({
      mode: 'rhythm', ranges: [{ startMidi: 60, endMidi: 72 }], notesPerEvent: 2, seed: 13,
      timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 2, countInMeasures: 1,
      key: { root: 'F', mode: 'major' },
    });
    expect(flat.xml).toContain('<fifths>-1</fifths>');
    expect(flat.xml).toContain('<alter>-1</alter>');
    const flatDoc = importScoreText(flat.xml, 'flat.musicxml').doc;
    const spellings = (flatDoc?.engine?.parts[0]?.measures ?? [])
      .flatMap((measure) => measure.events)
      .filter((event) => event.kind === 'note' && event.pitch?.midiNote === 70)
      .map((event) => `${event.pitch?.step}${event.pitch?.alter}`);
    expect(spellings.length).toBeGreaterThan(0);
    expect(new Set(spellings)).toEqual(new Set(['B-1']));
    // 题目 XML 同样携带调号
    expect(questionXml([70], 1, { root: 'F', mode: 'major' })).toContain('<fifths>-1</fifths>');
    expect(questionXml([70], 1)).toContain('<fifths>0</fifths>');
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
