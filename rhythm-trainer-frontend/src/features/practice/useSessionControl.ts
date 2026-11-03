import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { EngineBridge } from '../../services/engineBridge';
import type { SessionConflict } from '../../types/engine';

/** The backend owns the lease; this hook owns only the conflict/retry UI. */
export function useSessionControl(bridge: RefObject<EngineBridge | null>) {
  const [conflict, setConflict] = useState<{ lease: SessionConflict | null; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const block = useCallback((lease: SessionConflict | null, message: string) => {
    blocked.current = true; generation.current++; pending.current = false; setBusy(false);
    setConflict({ lease, message });
  }, []);
  const takeover = async () => {
    const connection = bridge.current;
    if (!connection || !conflict || pending.current) return false;
    const token = ++generation.current;
    pending.current = true; setBusy(true);
    try {
      await connection.connect();
      // A revoked page has no current lease snapshot. Read it before the
      // compare-and-takeover, so stale requests cannot stop a newer Take.
      const lease = conflict.lease ?? (await connection.requestSessionControl('status')).conflict;
      if (token !== generation.current) return false;
      const result = await connection.requestSessionControl('takeover', lease?.leaseId ?? null);
      if (token !== generation.current) return false;
      if (result.ok) { blocked.current = false; setConflict(null); return true; }
      setConflict({ lease: result.conflict, message: result.message ?? '接管失败，请重试。' });
    } catch (error) {
      if (token === generation.current) setConflict({ ...conflict, message: error instanceof Error ? error.message : String(error) });
    } finally { if (token === generation.current) { pending.current = false; setBusy(false); } }
    return false;
  };
  return { conflict, busy, blocked, block, takeover };
}
