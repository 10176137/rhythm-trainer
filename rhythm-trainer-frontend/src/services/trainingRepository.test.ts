import { afterEach, describe, expect, it, vi } from 'vitest';
import { trainingRepository } from './trainingRepository';
import { generateSkillExercise } from '../../server/training-service.mjs';

afterEach(() => { vi.unstubAllGlobals(); });
describe('training API client', () => {
  it('sends only the selected intent and uses the returned material', async () => {
    const input = { id: 'scales', level: 3, bpm: 60, options: { key: 'F', hand: 'left' } } as const;
    const drill = generateSkillExercise(input);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, drill })));
    vi.stubGlobal('fetch', fetcher);
    expect(await trainingRepository.skillDrill(input)).toEqual(drill);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(input);
  });
  it('does not generate local material when the backend rejects a request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'INVALID_TRAINING_REQUEST', message: '调性或手别无效' } }), { status: 400 })));
    await expect(trainingRepository.skillDrill({ id: 'scales', level: 1, bpm: 60 })).rejects.toThrow('调性或手别无效');
  });
  it('passes cancellation through for obsolete control selections', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    vi.stubGlobal('fetch', fetcher);
    await expect(trainingRepository.catalog(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
  it('reports a missing backend endpoint and incompatible schema explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, catalog: { schemaVersion: 2 } }))));
    await expect(trainingRepository.catalog()).rejects.toThrow('重启后端');
    await expect(trainingRepository.catalog()).rejects.toThrow('版本不兼容');
  });
});
