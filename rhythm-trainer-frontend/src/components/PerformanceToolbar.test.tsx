// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import PerformanceToolbar from './PerformanceToolbar';
import { defaultPracticeSettings, parsePracticeSettings, serializePracticeSettings } from '../features/practice/practiceSettings';
import type { PracticeConfig } from '../types/practice';

it('clears both note and bar boundaries when toggled off and starts a fresh selection when toggled on', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const initial: PracticeConfig = { ...defaultPracticeSettings.config, modeId: 'score', loopEnabled: true,
    loopStartBar: 8, loopEndBar: 12, loopStartNote: { eventId: 'old-a', measureOrdinal: 8, onsetBeat: '28/1' },
    loopEndNote: { eventId: 'old-b', measureOrdinal: 12, onsetBeat: '44/1' } };
  let current = initial;
  function Harness() {
    const [config, setConfig] = useState(initial); current = config;
    return <PerformanceToolbar config={config} barCount={24} locked={false} busy={false} supportsHandSelection systemDuet={false}
      metronomeOn={false} midiConnected={false} deviceLabel="" onReturn={vi.fn()} onChooseScore={vi.fn()} onDevices={vi.fn()}
      onToggleMode={vi.fn()} onToggleMetronome={vi.fn()} onPatch={(patch) => setConfig((previous) => ({ ...previous, ...patch }))}>{null}</PerformanceToolbar>;
  }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => button('循环中').click());
    expect(current).toMatchObject({ loopEnabled: false, loopStartBar: 1, loopEndBar: 24, loopStartNote: null, loopEndNote: null, loopSelectionPending: false });
    await act(async () => button('循环').click());
    expect(current).toMatchObject({ loopEnabled: true, loopStartBar: 1, loopEndBar: 24, loopStartNote: null, loopEndNote: null, loopSelectionPending: true });
    expect(button('选择循环范围')).toBeDefined();
    const restored = parsePracticeSettings(serializePracticeSettings({ config: current, metronomeOn: false }));
    expect(restored.config).toMatchObject({ loopSelectionPending: true, loopStartBar: 1, loopEndBar: 24 });
    expect(restored.config.loopStartNote).toBeUndefined();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
