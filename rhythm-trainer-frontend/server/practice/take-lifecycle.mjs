/** Allocate locally before publishing resources to the socket's live state. */
export function beginNativeTake(coordinator, createNative) {
  const take = coordinator.beginTake(0);
  try {
    const native = createNative();
    native.start();
    return { take, native };
  } catch (error) {
    try { coordinator.abort(take.takeId, 0, 'start_failed'); } catch { /* retain original failure */ }
    throw error;
  }
}

/** Optional ownership permits old clients; upgraded clients bind each command
 * to the server-issued business Take ID, never an engine-local counter. */
export function assertTakeCommand(message, activeTake) {
  if (message.takeId === undefined) return;
  if (typeof message.takeId !== 'string' || !activeTake || message.takeId !== activeTake.businessTakeId) {
    throw new Error('练习轮次已过期，请使用当前轮次重新操作');
  }
}

/** Release callback must only detach resources and must not throw. The frozen
 * persistence draft belongs to TakeFinalizationService, not the live runtime. */
export function finalizeAndRelease(finalize, release) {
  try { return finalize(); } finally { release(); }
}
