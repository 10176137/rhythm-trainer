import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeModeId } from './types/practice';
import App from './App';

const selection = vi.hoisted(() => ({ mode: 'reading-free' as PracticeModeId }));
vi.mock('./features/practice/practiceSettings', async (importOriginal) => {
  const settings = await importOriginal<typeof import('./features/practice/practiceSettings')>();
  return { ...settings, loadPracticeSettings: () => ({
    ...settings.defaultPracticeSettings,
    config: { ...settings.defaultPracticeSettings.config, modeId: selection.mode },
  }) };
});

describe('reading and performance workspace isolation', () => {
  it.each(['reading-free', 'reading-rhythm'] as const)('%s setup does not mount performance controls', (mode) => {
    selection.mode = mode;
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('识谱练习');
    expect(html).not.toContain('class="workspace-grid"');
    expect(html).not.toContain('class="session-strip"');
  });

  it('keeps the performance controls for score practice', () => {
    selection.mode = 'score';
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('class="workspace-grid"');
    expect(html).toContain('class="session-strip"');
  });
});
