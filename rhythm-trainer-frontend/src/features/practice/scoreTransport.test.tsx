// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useElapsedClock } from './useElapsedClock';
import { useScorePick } from './useScorePick';
import { bindNoteSelection } from '../score/bindNoteSelection';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('starts armed elapsed at zero, excludes pauses, and resets between rounds', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers();
  let now = 10000; vi.spyOn(performance, 'now').mockImplementation(() => now);
  let clock!: ReturnType<typeof useElapsedClock>;
  const root = createRoot(document.createElement('div'));
  function Harness() { clock = useElapsedClock(); return null; }
  await act(async () => root.render(<Harness />));
  const tick = async (ms: number) => { now += ms; await act(async () => vi.advanceTimersByTime(ms)); };
  try {
    await act(async () => clock.start(now - 3000, 3000));
    expect(clock.elapsed).toBe(0); await tick(1200); expect(clock.elapsed).toBeCloseTo(1.2);
    await act(async () => clock.pause()); await tick(5000); expect(clock.elapsed).toBeCloseTo(1.2);
    await act(async () => clock.resume()); await tick(500);
    await act(async () => clock.resume()); await tick(500); expect(clock.elapsed).toBeCloseTo(2.2);
    await act(async () => clock.reset()); await tick(500); expect(clock.elapsed).toBe(0);
    await act(async () => clock.start(now)); await tick(300); expect(clock.elapsed).toBeCloseTo(.3);
  } finally { await act(async () => root.unmount()); }
});
it('interrupts immediately, waits for report persistence, keeps latest pick, discards foreign route picks', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const interrupt = vi.fn(); const commit = vi.fn(); const commitCommand = vi.fn();
  let pick!: ReturnType<typeof useScorePick>;
  const root = createRoot(document.createElement('div'));
  function Harness(props: { blocked: boolean; identity: string; phase?: string }) { pick = useScorePick({ ...props, interrupt, commit, commitCommand }); return null; }
  const render = async (blocked: boolean, identity = 'performance|score1', phase = 'starting') => act(async () => root.render(<Harness {...{ blocked, identity, phase }} />));
  try {
    await render(true); await act(async () => pick.request('a')); expect(interrupt).toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    await act(async () => pick.request('b', 'end'));
    const calls = interrupt.mock.calls.length; await render(true, undefined, 'running'); expect(interrupt.mock.calls.length).toBeGreaterThan(calls);
    await render(false); expect(commit).toHaveBeenLastCalledWith('b', 'end'); expect(commit).toHaveBeenCalledOnce();
    await render(true); await act(async () => pick.request('c')); interrupt.mockClear();
    await render(true, 'training|score2'); expect(interrupt).not.toHaveBeenCalled();
    await render(false, 'training|score2'); expect(commit).toHaveBeenCalledOnce();
    await act(async () => pick.request(null)); expect(commit).toHaveBeenLastCalledWith(null, undefined);
    await render(true);
    await act(async () => pick.requestCommand({ kind: 'config', patch: { tempo: 80 } })); expect(commitCommand).not.toHaveBeenCalled();
    await render(false); expect(commitCommand).toHaveBeenCalledWith({ kind: 'config', patch: { tempo: 80 } });
  } finally { await act(async () => root.unmount()); }
});
it('selects on pointer down without waiting for release, deduplicates click, and unbinds', () => {
  const host = document.createElement('div'); const select = vi.fn(); const unbind = bindNoteSelection(host, select);
  host.dispatchEvent(new MouseEvent('pointerdown', { button: 0 })); expect(select).toHaveBeenCalledOnce();
  host.dispatchEvent(new MouseEvent('click', { detail: 1 })); expect(select).toHaveBeenCalledOnce();
  host.dispatchEvent(new MouseEvent('click', { detail: 0 })); expect(select).toHaveBeenCalledTimes(2);
  unbind(); host.dispatchEvent(new MouseEvent('pointerdown')); expect(select).toHaveBeenCalledTimes(2);
});
