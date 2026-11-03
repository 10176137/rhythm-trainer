import { useCallback, useEffect, useRef, useState } from 'react';

type Authority = 'rust' | 'rts' | null;
type RequestStatus = () => Promise<{ authority: string }>;

/** Connection-scoped authority cache, not a second planner selector.
 * Unknown/failed probes never imply a browser-planner fallback. */
export function usePlannerAuthority() {
  const authority = useRef<Authority>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; authority.current = null; };
  }, []);
  const invalidate = useCallback(() => {
    generation.current++; authority.current = null;
    if (mounted.current) setVersion(n => n + 1);
  }, []);
  const refresh = useCallback(async (request: RequestStatus): Promise<Authority> => {
    if (!mounted.current) return null;
    const token = ++generation.current;
    let next: Authority = null;
    try {
      const response = await request();
      if (response.authority === 'rust' || response.authority === 'rts') next = response.authority;
    } catch { /* Unknown is fail-closed; never select a fallback. */ }
    if (!mounted.current || token !== generation.current) return authority.current;
    authority.current = next; setVersion(n => n + 1); return next;
  }, []);
  return { authorityRef: authority as Readonly<{ current: Authority }>, version, invalidate, refresh };
}
