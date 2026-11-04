// @vitest-environment jsdom
import { AppTheme } from './ui/controls';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import PerformanceToolbar from './PerformanceToolbar';
import ScorePlaybackControls from './ScorePlaybackControls';
import { defaultPracticeSettings, parsePracticeSettings, serializePracticeSettings } from '../features/practice/practiceSettings';
import type { PracticeConfig } from '../types/practice';

it('clears both note and bar boundaries when toggled off and starts a fresh selection when toggled on', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const initial: PracticeConfig = { ...defaultPracticeSettings.config, modeId: 'score', loopEnabled: true,
    loopStartBar: 8, loopEndBar: 12, loopStartNote: { eventId: 'old-a', measureOrdinal: 8, onsetBeat: '28/1' },
    loopEndNote: { eventId: 'old-b', measureOrdinal: 12, onsetBeat: '44/1' } };
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState(initial); current = config;
    return <AppTheme><PerformanceToolbar config={config} barCount={24} locked={false} busy={false} supportsHandSelection systemDuet={false}
      metronomeOn={false} midiConnected={false} deviceLabel="" onReturn={vi.fn()} onChooseScore={vi.fn()} onDevices={vi.fn()}
      playbackControls={<ScorePlaybackControls startLabel="起点：从头" active={false} pending={false} disabled={false} error="" onPlay={vi.fn()} onStop={vi.fn()} onFromStart={vi.fn()} />} onToggleMode={vi.fn()} onToggleMetronome={vi.fn()} onPatch={(patch) => setConfig((previous) => ({ ...previous, ...patch }))}>{null}</PerformanceToolbar></AppTheme>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => root.render(<Harness />));
    expect(host.querySelector('[aria-label="练习手"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="练习推进"]')).toBeNull();
    expect(button('节拍器')).toBeDefined();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="加速"]')!.click());
    expect(current.tempo).toBe(initial.tempo + 4);
    expect(button('循环中').closest('dialog')).toBeNull();
    expect(button('试听').closest('dialog')).toBeNull();
    expect(host.textContent).not.toContain('读谱 ⇄');
    await act(async () => button('更多设置').click());
    expect(button('读谱 ⇄').closest('dialog')).not.toBeNull();
    expect(host.querySelector('dialog[open]')).not.toBeNull();
    expect(host.querySelectorAll('[aria-label="练习手"]')).toHaveLength(1);
    expect(host.querySelector('dialog [aria-label="练习推进"]')).not.toBeNull();
    await act(async () => button('循环中').click());
    expect(current).toMatchObject({ loopEnabled: false, loopStartBar: 1, loopEndBar: 24, loopStartNote: null, loopEndNote: null, loopSelectionPending: false });
    await act(async () => button('循环').click());
    expect(current).toMatchObject({ loopEnabled: true, loopStartBar: 1, loopEndBar: 24, loopStartNote: null, loopEndNote: null, loopSelectionPending: true });
    // Two-phase pick (2026-11-05): fresh selection awaits the START first.
    expect(button('选起点')).toBeDefined();
    const restored = parsePracticeSettings(serializePracticeSettings({ config: current, metronomeOn: false }));
    expect(restored.config).toMatchObject({ loopSelectionPending: true, loopStartBar: 1, loopEndBar: 24 });
    expect(restored.config.loopStartNote).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('shows the B-stage label once the start is picked and the end is still pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const initial: PracticeConfig = { ...defaultPracticeSettings.config, modeId: 'score', loopEnabled: true,
    loopSelectionPending: true, loopStartNote: { eventId: 'new-a', measureOrdinal: 1, onsetBeat: '0/1' } };
  function Harness() {
    const [config, setConfig] = useState(initial);
    return <AppTheme><PerformanceToolbar config={config} barCount={24} locked={false} busy={false} supportsHandSelection systemDuet={false}
      metronomeOn={false} midiConnected={false} deviceLabel="" onReturn={vi.fn()} onChooseScore={vi.fn()} onDevices={vi.fn()}
      playbackControls={<ScorePlaybackControls startLabel="起点：从头" active={false} pending={false} disabled={false} error="" onPlay={vi.fn()} onStop={vi.fn()} onFromStart={vi.fn()} />} onToggleMode={vi.fn()} onToggleMetronome={vi.fn()} onPatch={(patch) => setConfig((previous) => ({ ...previous, ...patch }))}>{null}</PerformanceToolbar></AppTheme>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => root.render(<Harness />));
    expect(button('选终点')).toBeDefined();
    expect(button('选起点')).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
