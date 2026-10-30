// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NoteReadingSetup from './NoteReadingSetup';
import { defaultReadingSetup, type ReadingSetupValue } from '../features/reading/readingSettings';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(initialValue?: ReadingSetupValue, mode: 'free' | 'rhythm' = 'free') {
  const start = vi.fn();
  await act(async () => root.render(<NoteReadingSetup initialValue={initialValue} initialMode={mode} busy={false}
    error={null} deviceConnected={false} deviceLabel="" handMappingReady onStart={start} />));
  return start;
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.startsWith(label));
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

it('uses one configuration when moving from a template to custom and starting', async () => {
  const start = await render();
  expect(host.querySelector('.reading-starters')).not.toBeNull();
  expect(host.querySelector('.reading-custom-fields')).toBeNull();
  await click('低音谱表入门');
  await click('调整当前参数');
  expect(host.querySelector('.reading-starters')).toBeNull();
  // Select by its label instead of relying on form order.
  const staff = Array.from(host.querySelectorAll('select')).find((item) => item.closest('label')!.textContent!.includes('识谱谱号'))!;
  expect(staff.value).toBe('bass');
  await act(async () => { staff.value = 'treble'; staff.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('.reading-summary-title')!.textContent).toBe('本轮配置 · 自定义');
  await click('推荐方案');
  expect(host.querySelectorAll('.reading-starters [aria-pressed="true"]').length).toBe(0);
  await click('自定义配置');
  expect(Array.from(host.querySelectorAll('select')).find((item) => item.closest('label')!.textContent!.includes('识谱谱号'))!.value).toBe('treble');
  await click('开始自由识谱');
  expect(start.mock.calls[0][0]).toMatchObject({ ranges: [{ startMidi: 48, endMidi: 59 }], staffPreference: 'treble', notesPerEvent: 1 });
});

it('applies the complete advertised template without retaining hidden custom test settings', async () => {
  const initial = { ...defaultReadingSetup(), task: 'test' as const, questionCount: 40 as const, notesPerEvent: 4 as const };
  const start = await render(initial);
  await click('推荐方案');
  await click('高音双音进阶');
  expect(host.querySelector('.reading-template-panel')!.textContent).not.toContain('BPM');
  await click('开始自由识谱');
  expect(start.mock.calls[0][0]).toMatchObject({ mode: 'free', task: 'practice', questionCount: 20,
    notesPerEvent: 2, staffPreference: 'treble', key: null, seed: initial.seed });
});

it('removes a rhythm template match when its timing parameters change', async () => {
  const start = await render(undefined, 'rhythm');
  await click('低音谱表入门');
  expect(host.querySelector('.reading-summary-title')!.textContent).toContain('低音谱表入门');
  await click('自定义配置');
  const length = Array.from(host.querySelectorAll('select')).find((item) => item.closest('label')!.textContent!.includes('练习长度'))!;
  await act(async () => { length.value = '8'; length.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('.reading-summary-title')!.textContent).toBe('本轮配置 · 自定义');
  await click('开始节奏识谱');
  expect(start.mock.calls[0][0]).toMatchObject({ mode: 'rhythm', measures: 8, staffPreference: 'bass' });
});

