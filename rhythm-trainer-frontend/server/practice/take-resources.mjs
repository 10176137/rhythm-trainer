/**
 * Allocate the resources of one practice Take in a single place.
 *
 * Each step's `acquire` receives the values acquired before it, so later
 * resources (a journal that must record `take_started`, a live feedback that
 * needs the plan) do not re-read connection state in a different order. When a
 * step throws, `onFailure` receives exactly the resources that were created
 * and the original error is rethrown. Rollback failures never mask the cause.
 *
 * The caller owns release. For the timeline path that is the existing
 * `failActiveTake` cleanup, so evidence sealing and lease release stay in one
 * failure path instead of being re-implemented here.
 *
 * @param {{ key: string, acquire: (context: Record<string, any>) => any }[]} steps
 * @param {{ onFailure?: (acquired: Record<string, any>, error: unknown) => void }} [options]
 * @returns {Record<string, any>}
 */
export function allocateTakeResources(steps, { onFailure } = {}) {
  /** @type {Record<string, any>} */
  const acquired = {};
  try {
    for (const step of steps) acquired[step.key] = step.acquire(acquired);
    return acquired;
  } catch (error) {
    if (onFailure) {
      try { onFailure(acquired, error); } catch { /* rollback must not mask the original failure */ }
    }
    throw error;
  }
}
