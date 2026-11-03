// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useRoundReturn } from './useRoundReturn';
it('rewinds every finished Take, waits for persistence before looping, and never repeats a manual stop', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const onReturn = vi.fn(); const onRepeat = vi.fn(); const root = createRoot(document.createElement('div'));
  function Harness(props: { enabled: boolean; completed: boolean; takeId: string | null; persisted: boolean; repeat: boolean }) { useRoundReturn({ ...props, onReturn, onRepeat }); return null; }
  const render = async (overrides = {}) => act(async () => root.render(<Harness enabled completed takeId="take-1" persisted={false} repeat {...overrides} />));
  try {
    await render(); expect(onReturn).toHaveBeenCalledOnce(); expect(onRepeat).not.toHaveBeenCalled();
    await render(); expect(onReturn).toHaveBeenCalledOnce();
    await render({ persisted: true }); expect(onRepeat).toHaveBeenCalledOnce();
    await render({ persisted: true }); expect(onRepeat).toHaveBeenCalledOnce();
    await render({ completed: false, takeId: null });
    await render({ takeId: 'take-2', persisted: true, repeat: false }); expect(onReturn).toHaveBeenCalledTimes(2); expect(onRepeat).toHaveBeenCalledOnce();
    // Clicking Start clears the manual-stop flag before the next started ack.
    // That must not revive the just-ended manual Take's repeat decision.
    await render({ takeId: 'take-2', persisted: true, repeat: true }); expect(onRepeat).toHaveBeenCalledOnce();
    await render({ takeId: 'take-3', persisted: true, enabled: false }); expect(onReturn).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
