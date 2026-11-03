// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionControl } from './useSessionControl';
import type { EngineBridge } from '../../services/engineBridge';

afterEach(() => vi.unstubAllGlobals());
it('recovers a revoked page using current backend ownership and keeps stale conflicts blocked', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const lease = { leaseId: 'new-lease', kind: 'follow' as const, self: false };
  const requestSessionControl = vi.fn().mockResolvedValueOnce({ ok: true, conflict: lease })
    .mockResolvedValueOnce({ ok: false, conflict: { ...lease, leaseId: 'newer-lease' }, message: '状态已变化' })
    .mockResolvedValueOnce({ ok: true, conflict: null });
  const bridge = { connect: vi.fn().mockResolvedValue(undefined), requestSessionControl } as unknown as EngineBridge;
  let control!: ReturnType<typeof useSessionControl>;
  function Probe() { control = useSessionControl(useRef(bridge)); return null; }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Probe />));
    await act(async () => control.block(null, '被其他页面接管'));
    await act(async () => { expect(await control.takeover()).toBe(false); });
    expect(requestSessionControl.mock.calls).toEqual([['status'], ['takeover', 'new-lease']]);
    expect(control.blocked.current).toBe(true);
    expect(control.conflict?.message).toBe('状态已变化');
    await act(async () => { expect(await control.takeover()).toBe(true); });
    expect(requestSessionControl.mock.calls.at(-1)).toEqual(['takeover', 'newer-lease']);
    expect(control.blocked.current).toBe(false); expect(control.conflict).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it('coalesces duplicate clicks and never grants access from a reply after unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let resolve!: (result: unknown) => void;
  const requestSessionControl = vi.fn(() => new Promise(r => { resolve = r; }));
  const bridge = { connect: vi.fn().mockResolvedValue(undefined), requestSessionControl } as unknown as EngineBridge;
  let control!: ReturnType<typeof useSessionControl>;
  function Probe() { control = useSessionControl(useRef(bridge)); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  await act(async () => control.block({ leaseId: 'lease', kind: 'timeline', self: false }, '被占用'));
  let pending!: Promise<boolean>;
  await act(async () => { pending = control.takeover(); expect(await control.takeover()).toBe(false); });
  expect(requestSessionControl).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  resolve({ ok: true });
  await expect(pending).resolves.toBe(false);
  expect(control.blocked.current).toBe(true);
});
