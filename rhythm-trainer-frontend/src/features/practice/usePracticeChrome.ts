import { createContext, useEffect, useRef, useState } from 'react';

export const PracticeChromeContext = createContext(true);
const CONTROL = '[data-practice-chrome],dialog,.ant-select-dropdown';
const INTERACTIVE = 'button,input,select,textarea,a,[role=button],[role=combobox],.osmd-loop-highlight-layer';

/** Presentation-only visibility. Never consumes score gestures or MIDI input. */
export function usePracticeChrome(enabled: boolean, revealForState: boolean) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const stage = stageRef.current;
    setShown(false);
    if (!enabled || !stage) return;
    let pointer: { id: number; x: number; y: number; at: number } | null = null;
    const reveal = () => setShown(true);
    const down = (event: PointerEvent) => {
      pointer = null;
      if (event.button !== 0 || event.isPrimary === false) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest(CONTROL)) { reveal(); return; }
      if (target.closest(INTERACTIVE)) return;
      // OSMD has already resolved this pointerdown before it bubbles here.
      // Both direct and near-note hits belong to score selection, not chrome.
      const host = target.closest<HTMLElement>('.osmd-host');
      const match = host?.dataset.tapMatch;
      if (match === 'direct' || match?.startsWith('nearest:')) return;
      if (target.closest('svg path,svg use,svg text')) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
    };
    const move = (event: PointerEvent) => {
      if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) pointer = null;
    };
    const cancel = () => { pointer = null; };
    const up = (event: PointerEvent) => {
      const tap = pointer; pointer = null;
      if (!tap || tap.id !== event.pointerId || performance.now() - tap.at > 500
        || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) return;
      setShown(previous => !previous);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ' || event.target instanceof Element && event.target.closest(CONTROL)) reveal();
    };
    const focus = (event: FocusEvent) => { if (event.target === stage) { reveal(); } };
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', cancel);
    stage.addEventListener('scroll', cancel, true);
    stage.addEventListener('keydown', key);
    stage.addEventListener('focusin', focus);
    return () => {
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', cancel);
      stage.removeEventListener('scroll', cancel, true);
      stage.removeEventListener('keydown', key);
      stage.removeEventListener('focusin', focus);
    };
  }, [enabled]);
  useEffect(() => { if (enabled && revealForState) setShown(true); }, [enabled, revealForState]);
  return { stageRef, visible: !enabled || shown };
}
