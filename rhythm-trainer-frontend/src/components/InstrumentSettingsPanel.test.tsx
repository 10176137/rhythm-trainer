// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const audio = vi.hoisted(() => ({ prepare: vi.fn(), dispose: vi.fn(), currentTime: () => 0, scheduleNoteOn: vi.fn(), scheduleNoteOff: vi.fn() }));
vi.mock('../features/playback/audioEngineAdapter', () => ({ WebAudioEngineAdapter: class { constructor() { return audio; } } }));
import InstrumentSettingsPanel from './InstrumentSettingsPanel';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); localStorage.clear(); });

it('offers every sound, cancels pending playback on selection, and stops on unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolve!: () => void;
  audio.prepare.mockImplementationOnce(() => new Promise<void>(r => { resolve = r; })).mockResolvedValue(undefined);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<InstrumentSettingsPanel />));
    const select = host.querySelector('select')!;
    expect(select.options.length).toBe(7);
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('取消加载');
    await act(async () => { select.value = 'organ'; select.dispatchEvent(new Event('change', { bubbles: true })); resolve(); });
    expect(audio.scheduleNoteOn).not.toHaveBeenCalled();
    expect(host.textContent).toContain('按住时持续发声');
    await act(async () => host.querySelector('button')!.click());
    expect(audio.scheduleNoteOn).toHaveBeenCalledTimes(4);
    expect(host.textContent).toContain('停止试听');
  } finally { await act(async () => root.unmount()); }
  expect(audio.dispose).toHaveBeenCalledTimes(2);
});

it('shows a failed preview and allows retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  audio.prepare.mockRejectedValueOnce(new Error('采样文件不可用')).mockResolvedValue(undefined);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<InstrumentSettingsPanel />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('采样文件不可用');
    await act(async () => host.querySelector('button')!.click());
    expect(audio.scheduleNoteOn).toHaveBeenCalledTimes(4);
  } finally { await act(async () => root.unmount()); }
});
