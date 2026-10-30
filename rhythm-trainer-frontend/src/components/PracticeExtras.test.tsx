// @vitest-environment jsdom
import { Capacitor } from '@capacitor/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import PracticeExtras from './PracticeExtras';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps native practice aids collapsed until explicitly opened', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<PracticeExtras><p>输入与反馈</p></PracticeExtras>));
    const button = host.querySelector('button')!;
    const panel = host.querySelector<HTMLElement>('.practice-dock-content')!;
    expect(panel.hidden).toBe(true); expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => button.click());
    expect(panel.hidden).toBe(false); expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click()); expect(panel.hidden).toBe(true);
  } finally { await act(async () => root.unmount()); }
});
it('preserves the existing visible aids on desktop web', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<PracticeExtras><p>输入与反馈</p></PracticeExtras>));
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector<HTMLElement>('.practice-dock-content')!.hidden).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
