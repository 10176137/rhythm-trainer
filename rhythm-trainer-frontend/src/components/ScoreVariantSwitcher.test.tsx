// @vitest-environment jsdom
import { AppTheme } from './ui/controls';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import ScoreVariantSwitcher from './ScoreVariantSwitcher';
import type { ScoreViewKey } from '../features/practice/scoreVariants';

function renderSwitcher(officialScorer: string | null, variants: Record<string, unknown> | null) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let current: ScoreViewKey = 'official';
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Harness = () => (
    <AppTheme>
      <ScoreVariantSwitcher
        officialScorer={officialScorer}
        variants={variants}
        value={current}
        onChange={(value) => { current = value; root.render(<Harness />); }}
      />
    </AppTheme>
  );
  const click = (label: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
    return act(async () => button.click());
  };
  const text = () => host.textContent ?? '';
  const unmount = () => act(async () => { root.unmount(); host.remove(); vi.unstubAllGlobals(); });
  return { root, render: () => act(async () => root.render(<Harness />)), click, text, unmount };
}

it('hides entirely when no stored variants exist (legacy takes)', async () => {
  const view = renderSwitcher('dp', null);
  await view.render();
  expect(view.text()).not.toContain('评分算法');
  await view.unmount();
});

it('offers official plus both stored variants and switches on click', async () => {
  const view = renderSwitcher('dp', { candidate: { algorithmVersion: 'x' }, legacy: { algorithmVersion: 'y' } });
  await view.render();
  expect(view.text()).toContain('评分算法');
  expect(view.text()).toContain('当时默认（DP 对齐）');
  expect(view.text()).toContain('规则候选');
  expect(view.text()).toContain('冻结 v1');
  expect(view.text()).toContain('【当前】当时默认');
  await view.click('规则候选');
  expect(view.text()).toContain('【当前】规则候选');
  await view.click('冻结 v1');
  expect(view.text()).toContain('【当前】冻结 v1');
  await view.unmount();
});

it('disables the official label gracefully for an unknown scorer id', async () => {
  const view = renderSwitcher(null, { legacy: { algorithmVersion: 'y' } });
  await view.render();
  expect(view.text()).toContain('当时默认（未知）');
  expect(view.text()).not.toContain('规则候选');
  await view.unmount();
});
