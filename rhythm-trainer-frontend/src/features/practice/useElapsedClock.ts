import { useCallback, useEffect, useRef, useState } from 'react';

/** UI duration, independent of the immutable scoring/engraving origin.
 * An armed plan may begin at timeline 3000ms; the user's stopwatch begins at 0. */
export function useElapsedClock() {
  const [elapsed, setElapsed] = useState(0);
  const clock = useRef({ origin: 0, carried: 0, running: false });
  const reset = useCallback(() => { clock.current = { origin: 0, carried: 0, running: false }; setElapsed(0); }, []);
  const start = useCallback((origin: number, offsetMs = 0) => {
    clock.current = { origin: origin + offsetMs, carried: 0, running: true }; setElapsed(0);
  }, []);
  const pause = useCallback(() => {
    const c = clock.current;
    if (c.running) { c.carried += Math.max(0, performance.now() - c.origin); c.running = false; setElapsed(c.carried / 1000); }
  }, []);
  const resume = useCallback(() => { const c = clock.current; if (!c.running) { c.origin = performance.now(); c.running = true; } }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { const c = clock.current; if (c.running) setElapsed((c.carried + Math.max(0, performance.now() - c.origin)) / 1000); }, 100);
    return () => window.clearInterval(timer);
  }, []);
  return { elapsed, reset, start, pause, resume };
}
