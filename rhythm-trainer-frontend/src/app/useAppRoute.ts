import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppRouteDefinition } from './routes';
import { matchAppRoute, normalizePath } from './routes';

const ROUTE_CHANGE_EVENT = 'rhythm-trainer:route-change';

function readLocationPath(): string {
  if (typeof window === 'undefined') return matchAppRoute('/').path;
  return matchAppRoute(window.location.pathname).path;
}

/**
 * Minimal History API routing. No router dependency and no second view state:
 * the URL pathname is the route source; popstate handles back/forward.
 */
export interface UseAppRouteOptions {
  /** Return false to veto a browser back/forward jump and restore the current URL. */
  canLeave?: (nextPath: string) => boolean;
}

export function useAppRoute(options: UseAppRouteOptions = {}): {
  path: string;
  route: AppRouteDefinition | null;
  navigate: (nextPath: string) => void;
} {
  const [path, setPath] = useState(readLocationPath);
  const pathRef = useRef(path);
  pathRef.current = path;
  const canLeaveRef = useRef(options.canLeave);
  canLeaveRef.current = options.canLeave;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initial = matchAppRoute(window.location.pathname);
    if (initial.path !== normalizePath(window.location.pathname)) {
      window.history.replaceState(null, '', initial.path);
    }
    setPath(initial.path);

    const onPopState = () => {
      const next = matchAppRoute(window.location.pathname);
      const current = pathRef.current;
      if (next.path !== normalizePath(window.location.pathname)) {
        window.history.replaceState(null, '', next.path);
      }
      if (next.path !== current && canLeaveRef.current && !canLeaveRef.current(next.path)) {
        window.history.pushState(null, '', current);
        return;
      }
      setPath(next.path);
    };
    const onRouteChange = () => setPath(readLocationPath());
    window.addEventListener('popstate', onPopState);
    window.addEventListener(ROUTE_CHANGE_EVENT, onRouteChange);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener(ROUTE_CHANGE_EVENT, onRouteChange);
    };
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (typeof window === 'undefined') return;
    const next = matchAppRoute(nextPath).path;
    if (next === readLocationPath()) return;
    window.history.pushState(null, '', next);
    setPath(next);
    window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  }, []);

  return {
    path,
    route: matchAppRoute(path).route,
    navigate,
  };
}
