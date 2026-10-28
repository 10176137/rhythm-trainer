import { poolFromRanges, type PitchRange, rangeLabel } from './readingKeys';
export type ReadingModeChoice = 'free' | 'rhythm';
export type ReadingComplexityChoice = 'basic' | 'intermediate' | 'advanced';
export interface ReadingSetupValue {
  mode: ReadingModeChoice; ranges: PitchRange[]; notesPerEvent: 1 | 2 | 3 | 4;
  seed: number; task: 'practice' | 'test'; questionCount: 10 | 20 | 40;
  timeSignature: [2 | 3 | 4, 4]; bpm: number; complexity: ReadingComplexityChoice;
  measures: 2 | 4 | 8; countInMeasures: 1 | 2;
}
export function defaultReadingSetup(mode: ReadingModeChoice = 'free'): ReadingSetupValue {
  return { mode, ranges: [{ startMidi: 60, endMidi: 71 }], notesPerEvent: 1, seed: Date.now() % 1_000_000,
    task: 'practice', questionCount: 20, timeSignature: [4, 4], bpm: 60, complexity: 'basic', measures: 4, countInMeasures: 1 };
}
export function loadReadingSettings(mode: ReadingModeChoice): ReadingSetupValue {
  const fallback = defaultReadingSetup(mode);
  try {
    const v = JSON.parse(localStorage.getItem(`rhythm.reading.${mode}.v1`) ?? 'null');
    if (!v || v.mode !== mode || !Array.isArray(v.ranges) || !v.ranges.length || v.ranges.length > 81
      || v.ranges.some((r: PitchRange) => !r || !Number.isInteger(r.startMidi) || !Number.isInteger(r.endMidi) || r.startMidi < 28 || r.endMidi > 108 || r.startMidi > r.endMidi)
      || ![1, 2, 3, 4].includes(v.notesPerEvent) || poolFromRanges(v.ranges).length < v.notesPerEvent
      || ![10, 20, 40].includes(v.questionCount) || !['practice', 'test'].includes(v.task)
      || !Array.isArray(v.timeSignature) || ![2, 3, 4].includes(v.timeSignature[0]) || v.timeSignature[1] !== 4
      || !Number.isFinite(v.bpm) || v.bpm < 40 || v.bpm > 180 || !['basic', 'intermediate', 'advanced'].includes(v.complexity)
      || ![2, 4, 8].includes(v.measures) || ![1, 2].includes(v.countInMeasures)) return fallback;
    return { ...fallback, ...v, seed: fallback.seed };
  } catch { return fallback; }
}
export function saveReadingSettings(value: ReadingSetupValue): void {
  try { localStorage.setItem(`rhythm.reading.${value.mode}.v1`, JSON.stringify(value)); } catch { /* preference persistence is best effort */ }
}
export function readingConfigLabel(value: ReadingSetupValue): string {
  return `${value.ranges.map(rangeLabel).join('、')} · ${value.notesPerEvent} 音 · ${value.mode === 'free' ? `${value.questionCount} 题 · ${value.task === 'test' ? '小测' : '练习'}` : `${value.bpm} BPM`}`;
}
