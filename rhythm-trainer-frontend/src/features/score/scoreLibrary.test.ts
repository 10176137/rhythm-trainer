import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScoreLibraryClientError,
  createScoreLibraryEntry,
  deleteScoreLibraryEntry,
  getScoreLibraryEntry,
  listScoreLibrary,
  updateScoreLibraryEntry,
} from './scoreLibrary';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scoreLibrary client', () => {
  it('lists entries and returns an empty array for a malformed payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { schemaVersion: 1, scores: [{ id: 'a', name: 'A' }] }))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    expect(await listScoreLibrary()).toEqual([{ id: 'a', name: 'A' }]);
    expect(await listScoreLibrary()).toEqual([]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/scores', expect.any(Object));
  });

  it('creates, gets, updates and deletes through the REST endpoints', async () => {
    const entry = { id: 'score-1', name: 'A', fileName: 'a.musicxml', size: 4, savedAtIso: 'x', updatedAtIso: 'x' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, score: entry }))
      .mockResolvedValueOnce(jsonResponse(200, { score: { ...entry, xml: '<x/>' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, score: { ...entry, name: 'B' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await createScoreLibraryEntry({ name: 'A', fileName: 'a.musicxml', xml: '<x/>' })).id).toBe('score-1');
    expect((await getScoreLibraryEntry('score-1')).xml).toBe('<x/>');
    expect((await updateScoreLibraryEntry('score-1', { name: 'B' })).name).toBe('B');
    await deleteScoreLibraryEntry('score-1');

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/scores/score-1', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(4, '/api/scores/score-1', expect.objectContaining({ method: 'DELETE' }));
    const updateCall = fetchMock.mock.calls[2][1] as RequestInit;
    expect(updateCall.method).toBe('PUT');
    expect(updateCall.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('surfaces the server error code/message and HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, {
      ok: false,
      error: { code: 'SCORE_NAME_CONFLICT', message: '已有同名乐谱' },
    })));
    await expect(createScoreLibraryEntry({ name: 'A', fileName: 'a.musicxml', xml: '<x/>' }))
      .rejects.toMatchObject({ code: 'SCORE_NAME_CONFLICT', status: 409, message: '已有同名乐谱' });
  });

  it('wraps network failures in a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(listScoreLibrary()).rejects.toBeInstanceOf(ScoreLibraryClientError);
    await expect(listScoreLibrary()).rejects.toThrowError(/无法连接乐谱库服务/);
  });
});

describe('active score persistence', () => {
  it('validates stored ids so a corrupted value cannot address an arbitrary path', async () => {
    const { parseActiveScoreId, saveStoredActiveScoreId, loadStoredActiveScoreId } = await import('./scoreLibrary');
    expect(parseActiveScoreId('score-abc_123')).toBe('score-abc_123');
    expect(parseActiveScoreId('../../etc/passwd')).toBeNull();
    expect(parseActiveScoreId('')).toBeNull();

    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    } as Storage;
    saveStoredActiveScoreId('score-abc', storage);
    expect(loadStoredActiveScoreId(storage)).toBe('score-abc');
    saveStoredActiveScoreId(null, storage);
    expect(loadStoredActiveScoreId(storage)).toBeNull();
  });
});
