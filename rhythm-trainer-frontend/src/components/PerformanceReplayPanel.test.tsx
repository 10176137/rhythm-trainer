// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import PerformanceReplayPanel from './PerformanceReplayPanel';
it('shows a lost local file without substituting score playback and ignores stale Take responses', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); let resolve!: (value: unknown) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ok: true, json: async () => ({ status: 'missing', message: '本地重放文件已丢失' }) }));
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<PerformanceReplayPanel takeId="old" />));
    await act(async () => root.render(<PerformanceReplayPanel takeId="new" />));
    await act(async () => resolve({ ok: true, json: async () => ({ status: 'unavailable', message: 'old response' }) }));
    expect(host.textContent).toContain('本地重放文件已丢失'); expect(host.textContent).not.toContain('old response');
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['重新检查文件']);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
