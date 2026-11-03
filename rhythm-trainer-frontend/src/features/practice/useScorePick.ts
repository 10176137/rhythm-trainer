import { useEffect, useRef, useState } from 'react';
import type { PracticeConfig, PracticeModeId } from '../../types/practice';
export type ScoreCommand = { kind: 'config'; patch: Partial<PracticeConfig> } | { kind: 'mode'; mode: PracticeModeId } | { kind: 'navigate'; path: string } | { kind: 'audition' };

/** A live Take keeps its frozen plan. Interrupt it immediately, then apply a
 * seek only after its final report is committed; newer picks replace older ones. */
export function useScorePick(options: { blocked: boolean; phase?: string; identity: string; interrupt: () => void; commitCommand?: (command: ScoreCommand) => void; commit: (id: string | null, edge?: 'start' | 'end') => void }) {
  const current = useRef(options); current.current = options;
  const [pending, setPending] = useState<{ id: string | null; identity: string; edge?: 'start' | 'end'; command?: ScoreCommand } | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (pending.identity !== options.identity) { setPending(null); return; }
    if (options.blocked) { current.current.interrupt(); return; }
    setPending(null);
    if (pending.command) current.current.commitCommand?.(pending.command);
    else if (pending.identity === options.identity) current.current.commit(pending.id, pending.edge);
  }, [pending, options.blocked, options.identity, options.phase]);
  return { requestCommand: (command: ScoreCommand) => { current.current.interrupt(); setPending({ id: null, command, identity: current.current.identity }); }, interrupt: () => current.current.interrupt(), pending: pending !== null, request: (id: string | null, edge?: 'start' | 'end') => {
    current.current.interrupt(); setPending({ id, edge, identity: current.current.identity });
  } };
}
