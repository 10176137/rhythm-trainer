import { useEffect, useRef } from 'react';

/** Reports stay available for review/retry. Rewind presentation immediately;
 * open the next immutable Take only after this one is durably saved. */
export function useRoundReturn(options: { enabled: boolean; completed: boolean; takeId: string | null; persisted: boolean;
  repeat: boolean; onReturn: () => void; onRepeat: () => void }) {
  const current = useRef(options); current.current = options;
  const returned = useRef<string | null>(null); const repeated = useRef<string | null>(null);
  const wantsRepeat = useRef(false);
  useEffect(() => {
    if (!options.enabled || !options.completed || !options.takeId) return;
    if (returned.current !== options.takeId) {
      returned.current = options.takeId; wantsRepeat.current = options.repeat; current.current.onReturn();
    }
    if (!options.repeat) wantsRepeat.current = false;
    if (options.persisted && wantsRepeat.current && repeated.current !== options.takeId) {
      repeated.current = options.takeId; current.current.onRepeat();
    }
  }, [options.enabled, options.completed, options.takeId, options.persisted, options.repeat]);
}
