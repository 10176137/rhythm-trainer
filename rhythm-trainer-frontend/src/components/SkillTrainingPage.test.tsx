// @vitest-environment jsdom
import { Capacitor } from '@capacitor/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { generateSkillExercise, getTrainingCatalog } from '../../server/training-service.mjs';
import SkillTrainingPage from './SkillTrainingPage';

afterEach(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it.each([true, false])('closes the native configuration only when start is accepted (%s)', async (accepted) => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom lacks the native dialog methods; retain their open/close effects.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const drill = generateSkillExercise({ id: 'five-finger', level: 1, bpm: 60, seed: 0, options: { key: 'C', hand: 'right' } });
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith('/catalog')
    ? { ok: true, catalog: getTrainingCatalog() } : { ok: true, drill }))));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const start = vi.fn(() => accepted);
  const button = (label: string) => Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)!;
  try {
    await act(async () => root.render(<SkillTrainingPage onStart={start} />));
    await act(async () => vi.advanceTimersByTime(200));
    await act(async () => button('单项打磨').click());
    await act(async () => host.querySelector<HTMLButtonElement>('.skill-drill-grid button')!.click());
    expect(host.querySelector('dialog')?.open).toBe(true);
    await act(async () => button('开始专项训练').click());
    expect(start.mock.calls[0]).toEqual([drill]);
    expect(host.querySelector('dialog') !== null).toBe(!accepted);
    if (!accepted) expect(host.textContent).toContain('暂时无法开始');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
