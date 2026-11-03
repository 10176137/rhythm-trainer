// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { getInstrument, instrumentVoice, prepareInstrument, saveInstrument } from './instruments';
import { INSTRUMENTS } from './instrumentCatalog';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it('persists all seven instruments and safely loads legacy or unknown preferences', () => {
  for (const instrument of INSTRUMENTS) {
    saveInstrument(instrument.id);
    expect(getInstrument()).toBe(instrument.id);
  }
  localStorage.setItem('rhythm-trainer.instrument.v1', 'deleted-preset');
  expect(getInstrument()).toBe('grand');
});

it('shares the local sample bank across piano variants and needs no download for synthesized voices', async () => {
  const fetchSample = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetchSample);
  const ctx = { decodeAudioData: vi.fn(async () => ({})) } as unknown as AudioContext;
  const [grand, bright, soft] = await Promise.all((['grand', 'bright-grand', 'soft-grand'] as const).map(id => prepareInstrument(ctx, id)));
  expect(grand).toBe(bright); expect(grand).toBe(soft);
  expect(fetchSample).toHaveBeenCalledTimes(30);
  for (const instrument of INSTRUMENTS.filter(item => item.kind === 'synth')) {
    expect(await prepareInstrument(ctx, instrument.id)).toEqual([]);
  }
  expect(fetchSample).toHaveBeenCalledTimes(30);
});

it('retries sample loading after a failure', async () => {
  const fetchSample = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal('fetch', fetchSample);
  const ctx = { decodeAudioData: vi.fn(async () => ({})) } as unknown as AudioContext;
  await expect(prepareInstrument(ctx, 'grand')).rejects.toThrow('采样缺失');
  fetchSample.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  expect(await prepareInstrument(ctx, 'soft-grand')).toHaveLength(30);
});

it('renders sampled variants with different brightness and releases their nodes', () => {
  const cutoffs: number[] = [];
  for (const id of ['soft-grand', 'grand', 'bright-grand'] as const) {
    const param = () => ({ value: 0, setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const node = () => ({ connect: vi.fn((target: unknown) => target), disconnect: vi.fn() });
    const source = { ...node(), buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
    const filter = { ...node(), frequency: { value: 0 }, type: '' };
    const gain = { ...node(), gain: param() };
    const ctx = { currentTime: 0, sampleRate: 48000, createBufferSource: () => source, createBiquadFilter: () => filter, createGain: () => gain } as unknown as AudioContext;
    const voice = instrumentVoice(ctx, {} as AudioNode, 60, .1, .7, id, Array(30).fill({}));
    cutoffs.push(filter.frequency.value);
    voice.release(1); voice.forceStop(0);
    expect(source.stop).toHaveBeenLastCalledWith(0);
    source.onended?.();
    expect(gain.disconnect).toHaveBeenCalledOnce();
  }
  expect(cutoffs[0]).toBeLessThan(cutoffs[1]); expect(cutoffs[1]).toBeLessThan(cutoffs[2]);
});
