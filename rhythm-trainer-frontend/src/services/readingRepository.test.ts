import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultReadingSetup } from '../features/reading/readingSettings';
import { createReadingAttemptId, pendingReadingAttempts, saveReadingAttempt, type ReadingAttemptPayload } from './readingRepository';
import { activateBackendOrigin } from './backendEndpoint';

afterEach(() => { activateBackendOrigin(null); vi.unstubAllGlobals(); });

describe('reading attempt identity', () => {
  it('keeps failed native saves on their original computer when switching connections', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const payload: ReadingAttemptPayload = {
      id: 'db718d18-ad95-4fa5-a9e6-ac050a311985', startedAtIso: '2026-10-30T01:00:00.000Z', finishedAtIso: '2026-10-30T01:01:00.000Z',
      config: { ...defaultReadingSetup('free'), questionCount: 10, seed: 1 },
      questions: Array.from({ length: 10 }, () => [60]), events: [], endReason: 'ended-early', source: 'midi',
    };
    activateBackendOrigin('http://piano-a.local:8788');
    await expect(saveReadingAttempt(payload)).rejects.toThrow();
    // New document after a native reload: modules start without an origin.
    activateBackendOrigin(null); activateBackendOrigin('http://piano-b.local:8788');
    expect(pendingReadingAttempts()).toEqual([]);
    activateBackendOrigin(null); activateBackendOrigin('http://piano-a.local:8788');
    expect(pendingReadingAttempts()).toEqual([payload]);
  });
  it('uses native UUIDs when available and preserves the Crypto receiver', () => {
    const id = 'db718d18-ad95-4fa5-a9e6-ac050a311985';
    const randomUUID = vi.fn(function (this: unknown) {
      expect(this).toBe(crypto);
      return id;
    });
    vi.stubGlobal('crypto', { randomUUID });
    expect(createReadingAttemptId()).toBe(id);
  });

  it('generates distinct UUID v4 IDs on LAN HTTP without randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 1000 }, createReadingAttemptId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('keeps the same LAN-generated ID when retrying a failed record save', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    });
    const payload: ReadingAttemptPayload = {
      id: createReadingAttemptId(), startedAtIso: '2026-10-29T11:00:00.000Z', finishedAtIso: '2026-10-29T11:01:00.000Z',
      config: { ...defaultReadingSetup('free'), questionCount: 10, seed: 1 },
      questions: Array.from({ length: 10 }, () => [60]), events: [], endReason: 'ended-early', source: 'virtual',
    };
    const record = { ...payload, summary: {} };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ record })));
    vi.stubGlobal('fetch', fetcher);
    await expect(saveReadingAttempt(payload)).rejects.toThrow('识谱记录尚未保存');
    expect(await saveReadingAttempt(payload)).toEqual(record);
    const sentIds = fetcher.mock.calls.map(([, options]) => JSON.parse(options.body).id);
    expect(sentIds).toEqual([payload.id, payload.id]);
    expect(JSON.parse([...stored.values()][0])).toEqual([]);
  });
});
