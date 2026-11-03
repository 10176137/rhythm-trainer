// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import PracticeSessionControls from './PracticeSessionControls';
import type { SessionStatus } from '../types/practice';
afterEach(() => vi.unstubAllGlobals());
it('hides manual start for automatic performance and describes the correct-note trigger', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); const root = createRoot(host);
  const props = { statusLabel: '待弹', elapsed: 0, starting: false, preparing: null, active: false, locked: false,
    onStart: vi.fn(), onPause: vi.fn(), onResume: vi.fn(), onFinish: vi.fn(), onReset: vi.fn(), onCancelPreparation: vi.fn() };
  try {
    await act(async () => root.render(<PracticeSessionControls {...props} status="idle" automaticStart />));
    expect(host.textContent).not.toContain('开始练习');
    await act(async () => root.render(<PracticeSessionControls {...props} status="running" waitingForFirstInput automaticStart />));
    expect(host.textContent).toContain('等待起奏');
    expect(host.textContent).not.toContain('暂停');
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === '取消')!;
    await act(async () => cancel.click());
    expect(props.onFinish).toHaveBeenCalledOnce(); expect(host.textContent).toContain('00:00');
  } finally { await act(async () => root.unmount()); }
});
it.each(['running', 'paused', 'processing', 'completed', 'unsaved'])('exposes legal session actions for %s', async (scenario) => {
  const status = (scenario === 'unsaved' ? 'completed' : scenario) as SessionStatus;
  const unsaved = scenario === 'unsaved';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const pause = vi.fn(); const resume = vi.fn(); const finish = vi.fn(); const start = vi.fn();
  try {
    await act(async () => root.render(<PracticeSessionControls status={status} statusLabel="状态" elapsed={10} starting={false}
      preparing={null} active={status !== 'completed'} locked={status !== 'completed' || unsaved} startDisabled={unsaved}
      onStart={start} onPause={pause} onResume={resume} onFinish={finish} onReset={vi.fn()} onCancelPreparation={vi.fn()} />));
    const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === name)!;
    if (status === 'running') { await act(async () => button('暂停').click()); expect(pause).toHaveBeenCalledOnce(); }
    if (status === 'paused') { await act(async () => button('继续').click()); expect(resume).toHaveBeenCalledOnce(); }
    if (status === 'completed') { await act(async () => button('再练一次').click()); expect(start).toHaveBeenCalledTimes(unsaved ? 0 : 1); }
    expect(button('结束').disabled).toBe(status === 'processing' || status === 'completed');
    await act(async () => button('结束').click());
    expect(finish).toHaveBeenCalledTimes(status === 'running' || status === 'paused' ? 1 : 0);
    expect(button('重置').disabled).toBe(status !== 'completed' || unsaved);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
