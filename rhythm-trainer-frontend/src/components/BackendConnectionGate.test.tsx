// @vitest-environment jsdom
import { Capacitor } from '@capacitor/core';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BackendConnectionGate from './BackendConnectionGate';
import { activateBackendOrigin, BACKEND_DISCONNECTED_EVENT } from '../services/backendEndpoint';

let root: Root;
let host: HTMLDivElement;
const health = () => new Response(JSON.stringify({ ok: true, schemaVersion: 1 }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() });
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  localStorage.setItem('rhythm-trainer.computer-origin.v1', 'http://piano.local:8788');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); localStorage.clear(); activateBackendOrigin(null);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function connect() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
}
it('unmounts business effects immediately when the engine disconnects', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => health()));
  const start = vi.fn();
  function Practice() {
    useEffect(() => { const timer = setTimeout(start, 3000); return () => clearTimeout(timer); }, []);
    return <p>练习内容</p>;
  }
  await act(async () => root.render(<BackendConnectionGate><Practice /></BackendConnectionGate>));
  await connect(); expect(host.textContent).toContain('练习内容');
  await act(async () => window.dispatchEvent(new Event(BACKEND_DISCONNECTED_EVENT)));
  expect(host.textContent).not.toContain('练习内容');
  await act(async () => vi.advanceTimersByTime(4000)); expect(start).not.toHaveBeenCalled();
});
it('invalidates a health result when backgrounded before connection completes', async () => {
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
  await act(async () => root.render(<BackendConnectionGate><p>练习内容</p></BackendConnectionGate>));
  await connect();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => resolve(health()));
  expect(host.textContent).not.toContain('练习内容');
  expect(host.querySelector('form')).not.toBeNull();
});
it('preserves the existing web entry without a computer connection screen', async () => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await act(async () => root.render(<BackendConnectionGate><p>网页练习</p></BackendConnectionGate>));
  expect(host.textContent).toBe('网页练习'); expect(fetcher).not.toHaveBeenCalled();
});
