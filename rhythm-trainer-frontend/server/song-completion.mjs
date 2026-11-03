// Session lifecycle only: consume the validated plan's end, never infer that
// "all note attacks were judged" means the final note has finished sounding.

/** @typedef {{ atMs: number, nominalDurationMs: number }} CompletionTarget */
/** @typedef {{ targetOnsetMs?: number, targetDurationMs?: number }} CompletionScoreEvent */
/** @typedef {{ startTick?: number, durationTicks?: number }} CompletionAtom */
/** @typedef {{
 *   modeId: string,
 *   configSnapshot?: { modeId?: string } | null,
 *   targets?: CompletionTarget[] | null,
 *   scoreEvents?: CompletionScoreEvent[] | null,
 *   atoms?: CompletionAtom[] | null,
 *   bpm?: number,
 *   ticksPerQuarter?: number,
 *   countInMs: number,
 * }} CompletionMeta */
/** @typedef {{ startSession?: number, endSession?: number | null }} PauseLike */

/** @type {(value: unknown) => value is number} */
const finite = value => typeof value === 'number' && Number.isFinite(value);
/** @param {CompletionMeta} meta @returns {number | null} */
export function songCompletionAtMs(meta) {
  if (!['score', 'hands', 'loop'].includes(meta.modeId)
    || (meta.configSnapshot?.modeId && !['score', 'loop'].includes(meta.configSnapshot.modeId)) || !meta.targets?.length) return null;
  const ends = meta.targets.map(t => t.atMs + t.nominalDurationMs).filter(finite);
  for (const note of meta.scoreEvents ?? []) {
    if (finite(note.targetOnsetMs) && finite(note.targetDurationMs)) ends.push(note.targetOnsetMs + note.targetDurationMs);
  }
  // Rest atoms remain part of the validated musical span, including trailing rests.
  if (finite(meta.bpm) && meta.bpm > 0 && finite(meta.ticksPerQuarter) && meta.ticksPerQuarter > 0) {
    for (const atom of meta.atoms ?? []) if (finite(atom.startTick) && finite(atom.durationTicks)) {
      ends.push(meta.countInMs + (atom.startTick + atom.durationTicks) * 60000 / meta.bpm / meta.ticksPerQuarter);
    }
  }
  // Allow late releases/transport packets to arrive before freezing evidence.
  return ends.length ? Math.max(...ends) + 250 : null;
}
/**
 * @param {unknown} boundary
 * @param {unknown} nowMs
 * @param {PauseLike[]} [pauses]
 * @returns {boolean}
 */
export function reachedSongEnd(boundary, nowMs, pauses = []) {
  if (!finite(boundary) || !finite(nowMs) || pauses.some(p => p.endSession === null)) return false;
  const shift = pauses.reduce((sum, p) => sum + (finite(p.startSession) && finite(p.endSession) ? Math.max(0, p.endSession - p.startSession) : 0), 0);
  return nowMs >= boundary + shift;
}
