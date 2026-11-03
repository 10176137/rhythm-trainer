// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePlannerAuthority } from './usePlannerAuthority';

it('owns latest-probe ordering, invalidation, failure and unmount without fallback', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let cache!: ReturnType<typeof usePlannerAuthority>;
  function Harness() { cache = usePlannerAuthority(); return null; }
  const root = createRoot(document.createElement('div'));
  const deferred = () => { let resolve!: (r: { authority: string }) => void; let reject!: (e: Error) => void;
    const promise = new Promise<{ authority: string }>((r, e) => { resolve = r; reject = e; }); return { promise, resolve, reject }; };
  let unmounted = false;
  try {
    await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
    expect(cache.authorityRef.current).toBeNull();
    const first = deferred(); const second = deferred();
    const a = cache.refresh(() => first.promise); const b = cache.refresh(() => second.promise);
    await act(async () => { second.resolve({ authority: 'rust' }); await b; });
    await act(async () => { first.resolve({ authority: 'rts' }); await a; });
    expect(cache.authorityRef.current).toBe('rust');
    const old = deferred(); const pending = cache.refresh(() => old.promise); const version = cache.version;
    await act(async () => cache.invalidate()); expect(cache.version).toBeGreaterThan(version);
    await act(async () => { old.resolve({ authority: 'rust' }); await pending; }); expect(cache.authorityRef.current).toBeNull();
    await act(async () => { await cache.refresh(async () => ({ authority: 'rts' })); }); expect(cache.authorityRef.current).toBe('rts');
    await act(async () => { await cache.refresh(async () => { throw new Error('offline'); }); }); expect(cache.authorityRef.current).toBeNull();
    await act(async () => { await cache.refresh(async () => ({ authority: 'unsupported' })); }); expect(cache.authorityRef.current).toBeNull();
    const closing = deferred(); const late = cache.refresh(() => closing.promise);
    await act(async () => root.unmount()); unmounted = true;
    closing.resolve({ authority: 'rust' }); await late; expect(cache.authorityRef.current).toBeNull();
    const request = vi.fn(async () => ({ authority: 'rust' })); await cache.refresh(request); expect(request).not.toHaveBeenCalled();
  } finally { if (!unmounted) await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
