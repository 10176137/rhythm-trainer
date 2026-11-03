/**
 * One classification for every way a timeline Take can end.
 *
 * The triggers overlap in practice: the user may press finish on the same tick
 * the song boundary is reached, and a flush during finalization can itself
 * exceed the input budget. Whichever path calls first wins because the engine
 * finalizes synchronously and nulls `native`; this module only fixes what each
 * trigger means, so the same trigger cannot produce different health, journal
 * or persisted-reason values in different call sites.
 *
 * Persisted history is deliberately unchanged:
 *   user / song-end      -> endReason null   -> stored as 'completed'
 *   resource_limit       -> endReason 'resource_limit'
 *   connection_closed    -> endReason null   -> stored as 'interrupted'
 */

/** @typedef {'user'|'song-end'|'resource_limit'|'connection_closed'} TakeEndTrigger */
/** @typedef {{ trigger: TakeEndTrigger, interrupted: boolean, endReason: 'resource_limit'|null, journalEvent: 'resource_limit_closed'|'connection_closed'|null, health: 'degraded'|'disconnected'|null }} TakeEnd */

/** @type {Record<TakeEndTrigger, TakeEnd>} */
const ENDS = {
  user: Object.freeze({ trigger: 'user', interrupted: false, endReason: null, journalEvent: null, health: null }),
  'song-end': Object.freeze({ trigger: 'song-end', interrupted: false, endReason: null, journalEvent: null, health: null }),
  resource_limit: Object.freeze({
    trigger: 'resource_limit', interrupted: true, endReason: 'resource_limit',
    journalEvent: 'resource_limit_closed', health: 'degraded',
  }),
  connection_closed: Object.freeze({
    trigger: 'connection_closed', interrupted: true, endReason: null,
    journalEvent: 'connection_closed', health: 'disconnected',
  }),
};

/**
 * @param {TakeEndTrigger} trigger
 * @returns {TakeEnd}
 */
export function classifyTakeEnd(trigger) {
  const end = ENDS[trigger];
  if (!end) throw new Error(`未知的结束原因: ${String(trigger)}`);
  return end;
}
