// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppShell from './AppShell';
vi.mock('./OsmdScoreView', () => ({ default: () => null, ENGRAVED_SCORE_WIDTH: 1000 }));
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(pinned = false) {
  await act(async () => root.render(<AppShell immersive revealControls={pinned} sidebar={null} topbar={null}>
    <div data-testid="blank" /><div className="performance-toolbar-panel" data-practice-chrome><button>设置</button></div>
    <div className="osmd-host" data-tap-match="direct"><svg><path /></svg></div>
  </AppShell>));
}
const visible = () => host.querySelector('.app-shell')!.classList.contains('controls-visible');
async function pointer(target: Element, type: string, x = 20, y = 20) { await act(async () => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))); }
async function tap(target = host.querySelector('[data-testid=blank]')!) { await pointer(target, 'pointerdown'); await pointer(target, 'pointerup'); }
it('starts hidden and stays revealed until another blank tap', async () => {
  await render(); expect(visible()).toBe(false);
  await tap(); expect(visible()).toBe(true);
  await act(async () => vi.advanceTimersByTime(20000)); expect(visible()).toBe(true);
  await tap(); expect(visible()).toBe(false);
});
it('ignores drags, scrolling and selecting score notes', async () => {
  await render(); const blank = host.querySelector('[data-testid=blank]')!;
  await pointer(blank, 'pointerdown'); await pointer(blank, 'pointermove', 50); await pointer(blank, 'pointerup', 50); expect(visible()).toBe(false);
  await pointer(blank, 'pointerdown'); await act(async () => blank.dispatchEvent(new Event('scroll', { bubbles: true }))); await pointer(blank, 'pointerup'); expect(visible()).toBe(false);
  await tap(host.querySelector('path')!); expect(visible()).toBe(false);
});
it('shows controls on pause, permits hiding again and reveals for keyboard navigation', async () => {
  await render(true); expect(visible()).toBe(true);
  await tap(); expect(visible()).toBe(false);
  const stage = host.querySelector<HTMLElement>('.app-shell')!;
  await act(async () => stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
  expect(visible()).toBe(true);
});

it('does not suspend score following when tapping blank space to reveal controls', async () => {
  const { default: ScoreViewer } = await import('./ScoreViewer');
  const { practiceScoreDocument: doc } = await import('../features/score/practiceScore');
  await act(async () => root.render(<AppShell immersive sidebar={null} topbar={null}><ScoreViewer score={doc.notes} meta={doc.meta}
    sourceXml={doc.sourceXml} engine={doc.engine} activeNoteIds={[]} hand="both" tempo={72} strictAssessment={false}
    showNoteNames={false} showPositionHints={false} lastInputMidi={null} /></AppShell>));
  const pane = host.querySelector('.score-systems')!;
  await tap(pane);
  expect(visible()).toBe(true);
  expect(host.querySelector('.score-follow-return')).toBeNull();
  await pointer(pane, 'pointerdown'); await pointer(pane, 'pointermove', 60);
  expect(host.querySelector('.score-follow-return')).not.toBeNull();
});
