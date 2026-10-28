import { afterEach, describe, it, expect, vi } from 'vitest';
import { defaultReadingSetup, loadReadingSettings, saveReadingSettings } from './readingSettings';
import { pendingReadingAttempts, saveReadingAttempt, type ReadingAttemptPayload } from '../../services/readingRepository';
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => vi.unstubAllGlobals());
describe('reading preferences and failed saves', () => {
  it('restores separate configurations for each mode and rejects corrupt preferences', () => {
    const local = storage(); vi.stubGlobal('localStorage', local);
    const config = { ...defaultReadingSetup(), ranges: [{ startMidi: 48, endMidi: 71 }], task: 'test' as const, notesPerEvent: 2 as const };
    saveReadingSettings(config);
    expect(loadReadingSettings('free')).toMatchObject({ ranges: config.ranges, task: 'test', notesPerEvent: 2 });
    expect(loadReadingSettings('rhythm').mode).toBe('rhythm');
    local.setItem('rhythm.reading.free.v1', JSON.stringify({ ...config, ranges: [{ startMidi: -1, endMidi: 999 }] }));
    expect(loadReadingSettings('free').ranges).toEqual(defaultReadingSetup().ranges);
  });
  it('keeps failed evidence across reloads and retries under the same ID', async () => {
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => ({ record: { id: 'same-attempt' } }) }));
    const payload: ReadingAttemptPayload = { id: 'same-attempt', config: defaultReadingSetup(), startedAtIso: '2026-10-28T00:00:00Z', finishedAtIso: '2026-10-28T00:01:00Z', questions: [[70]], events: [], source: 'virtual', endReason: 'ended-early' };
    await expect(saveReadingAttempt(payload)).rejects.toThrow('offline');
    expect(pendingReadingAttempts()).toEqual([payload]);
    await saveReadingAttempt(pendingReadingAttempts()[0]);
    expect(pendingReadingAttempts()).toEqual([]);
  });
});
