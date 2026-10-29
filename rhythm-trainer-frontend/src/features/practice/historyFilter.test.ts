import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../services/practiceRepository';
import { EMPTY_HISTORY_FILTER, filterPracticeHistory } from './historyFilter';

const now = new Date(2026, 9, 29, 12);
function record(id: string, changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id, takeId: id, modeId: 'score', reportKind: 'timeline', endReason: 'completed',
    finishedAtIso: new Date(2026, 9, 29, 9).toISOString(), bpm: 72, profile: 'standard', trustworthy: true,
    targetCount: 10, perfectCount: 5, goodCount: 5, missCount: 0, extraCount: 0,
    targetHitRate: 1, meanSignedMs: 0, meanAbsoluteMs: 12, ...changes,
  };
}

describe('practice history retrieval', () => {
  it('matches all search terms against user labels, dates and saved scheme names', () => {
    const items = [record('one', { takeTemplateName: '左手慢练' }), record('two', { bpm: 96 })];
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, query: ' 左手   72 bpm ' }, now).map((item) => item.takeId)).toEqual(['one']);
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, query: '正常曲目 2026-10-29' }, now)).toHaveLength(2);
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, query: '不存在' }, now)).toEqual([]);
    expect(filterPracticeHistory([record('take-72', { bpm: 40 })], { ...EMPTY_HISTORY_FILTER, query: '72 BPM' }, now)).toEqual([]);
  });

  it('combines mode and record status instead of counting unknown endings as completed', () => {
    const items = [record('one'), record('two', { modeId: 'reading-rhythm', endReason: 'interrupted' }), record('old', { endReason: null })];
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, mode: 'reading-rhythm', status: 'interrupted' }, now).map((item) => item.takeId)).toEqual(['two']);
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, status: 'completed' }, now).map((item) => item.takeId)).toEqual(['one']);
    expect(filterPracticeHistory([record('bad', { trustworthy: false })], { ...EMPTY_HISTORY_FILTER, status: 'trustworthy' }, now)).toEqual([]);
  });

  it('uses local calendar boundaries, excludes future dates and tolerates invalid legacy dates', () => {
    const items = [record('today'), record('start', { finishedAtIso: new Date(2026, 9, 23, 0).toISOString() }),
      record('outside', { finishedAtIso: new Date(2026, 9, 22, 23, 59).toISOString() }),
      record('future', { finishedAtIso: new Date(2026, 9, 30).toISOString() }), record('invalid', { finishedAtIso: 'invalid' })];
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, period: 'week' }, now).map((item) => item.takeId)).toEqual(['today', 'start']);
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, period: 'today' }, now).map((item) => item.takeId)).toEqual(['today']);
    expect(filterPracticeHistory(items, EMPTY_HISTORY_FILTER, now)).toHaveLength(5);
  });

  it('clearing filters preserves original order and does not mutate the reports', () => {
    const items = [record('second'), record('first', { bpm: null })];
    expect(filterPracticeHistory(items, EMPTY_HISTORY_FILTER, now)).toEqual(items);
    expect(filterPracticeHistory(items, { ...EMPTY_HISTORY_FILTER, query: 'null' }, now)).toEqual([]);
    expect(items[1].bpm).toBeNull();
  });
});
