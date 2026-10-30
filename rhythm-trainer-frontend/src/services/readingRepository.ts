import { backendUrl, backendStorageKey } from './backendEndpoint';
import type { ReadingEvidenceEvent, FreeReadingSnapshot } from '../features/reading/freeReadingSession';
import type { ReadingSetupValue } from '../features/reading/readingSettings';
export interface ReadingAttemptPayload {
  id: string; startedAtIso: string; finishedAtIso: string;
  config: ReadingSetupValue; questions: readonly (readonly number[])[];
  events: ReadingEvidenceEvent[]; endReason: 'completed' | 'ended-early'; source: 'midi' | 'virtual' | 'mixed';
}
export interface ReadingRecord extends ReadingAttemptPayload {
  summary: Omit<FreeReadingSnapshot, 'perPitch' | 'wrongByPitch' | 'currentTargets' | 'currentHits'> & {
    weakTargets: Array<{ midi: number; wrong: number }>; coveredPitches: number; poolSize: number; reviewGroups: number[][];
    progression?: { canReview: boolean; canStartTest: boolean; nextNotesPerEvent: 2 | 3 | 4 | null };
  };
}
const KEY = 'rhythm.reading.pending.v1';
/** Stable across save retries; LAN HTTP pages cannot use crypto.randomUUID. */
export function createReadingAttemptId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function pendingReadingAttempts(): ReadingAttemptPayload[] {
  try { const values = JSON.parse(localStorage.getItem(backendStorageKey(KEY)) ?? '[]'); return Array.isArray(values) ? values.filter((v) => v && typeof v.id === 'string' && Array.isArray(v.events)) : []; } catch { return []; }
}
export async function saveReadingAttempt(payload: ReadingAttemptPayload): Promise<ReadingRecord> {
  const queue = pendingReadingAttempts().filter((item) => item.id !== payload.id);
  queue.push(payload);
  // Queue first: a failed HTTP save can be retried after a reload.
  localStorage.setItem(backendStorageKey(KEY), JSON.stringify(queue));
  const response = await fetch(backendUrl('/api/reading-attempts'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error('识谱记录尚未保存，请重试');
  const result = await response.json() as { record: ReadingRecord };
  localStorage.setItem(backendStorageKey(KEY), JSON.stringify(pendingReadingAttempts().filter((item) => item.id !== payload.id)));
  return result.record;
}
export async function listReadingAttempts(): Promise<ReadingRecord[]> {
  const response = await fetch(backendUrl('/api/reading-attempts'));
  if (!response.ok) throw new Error('无法读取识谱记录，请检查引擎服务');
  return (await response.json() as { items: ReadingRecord[] }).items;
}
