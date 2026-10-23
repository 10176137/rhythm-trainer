/** REST client for the named MusicXML library owned by the engine service. */

import type { StoredImportSummary } from './scoreStatus';

export interface ScoreLibraryEntry {
  id: string;
  name: string;
  fileName: string;
  size: number;
  savedAtIso: string;
  updatedAtIso: string;
  /** Server-enriched listing flag; the XML file is missing. */
  fileMissing?: boolean;
  /** Persisted ImportReport summary (A1); old records may omit it. */
  importStatus?: string;
  importReportSummary?: StoredImportSummary;
  parserVersion?: string;
  importedAtIso?: string;
}

export interface ScoreLibraryEntryWithXml extends ScoreLibraryEntry {
  xml: string;
}

export interface CreateScoreLibraryInput {
  name: string;
  fileName: string;
  xml: string;
  importSummary?: StoredImportSummary;
}

export interface UpdateScoreLibraryPatch {
  name?: string;
  fileName?: string;
  xml?: string;
  importSummary?: StoredImportSummary;
}

export class ScoreLibraryClientError extends Error {
  constructor(message: string, readonly code = 'SCORE_LIBRARY_REQUEST_FAILED', readonly status = 0) {
    super(message);
    this.name = 'ScoreLibraryClientError';
  }
}

interface ApiEnvelope {
  scores?: ScoreLibraryEntry[];
  invalidCount?: number;
  score?: ScoreLibraryEntryWithXml;
  error?: string | { code?: string; message?: string };
}

async function request(path: string, init?: RequestInit): Promise<ApiEnvelope> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body
        ? { 'content-type': 'application/json', ...(init?.headers ?? {}) }
        : init?.headers,
    });
  } catch (error) {
    throw new ScoreLibraryClientError(`无法连接乐谱库服务：${error instanceof Error ? error.message : String(error)}`);
  }
  let body: ApiEnvelope | null = null;
  try {
    body = await response.json() as ApiEnvelope;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = body?.error;
    const message = typeof error === 'string'
      ? error
      : error?.message || `乐谱库请求失败（HTTP ${response.status}）`;
    const code = typeof error === 'object' && error?.code ? error.code : 'SCORE_LIBRARY_REQUEST_FAILED';
    throw new ScoreLibraryClientError(message, code, response.status);
  }
  return body ?? {};
}

export async function listScoreLibraryDetailed(): Promise<{
  entries: ScoreLibraryEntry[];
  invalidCount: number;
}> {
  const body = await request('/api/scores');
  return {
    entries: Array.isArray(body.scores) ? body.scores : [],
    invalidCount: Number.isFinite(body.invalidCount) ? Number(body.invalidCount) : 0,
  };
}

export async function listScoreLibrary(): Promise<ScoreLibraryEntry[]> {
  return (await listScoreLibraryDetailed()).entries;
}

export async function getScoreLibraryEntry(id: string): Promise<ScoreLibraryEntryWithXml> {
  const body = await request(`/api/scores/${encodeURIComponent(id)}`);
  if (!body.score) throw new ScoreLibraryClientError('乐谱库返回了空数据', 'SCORE_LIBRARY_EMPTY_RESPONSE');
  return body.score;
}

export async function createScoreLibraryEntry(input: CreateScoreLibraryInput): Promise<ScoreLibraryEntry> {
  const body = await request('/api/scores', { method: 'POST', body: JSON.stringify(input) });
  if (!body.score) throw new ScoreLibraryClientError('乐谱保存后未返回记录', 'SCORE_LIBRARY_EMPTY_RESPONSE');
  return body.score;
}

export async function updateScoreLibraryEntry(id: string, patch: UpdateScoreLibraryPatch): Promise<ScoreLibraryEntry> {
  const body = await request(`/api/scores/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
  if (!body.score) throw new ScoreLibraryClientError('乐谱更新后未返回记录', 'SCORE_LIBRARY_EMPTY_RESPONSE');
  return body.score;
}

export async function deleteScoreLibraryEntry(id: string): Promise<void> {
  await request(`/api/scores/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export const ACTIVE_SCORE_STORAGE_KEY = 'rhythm-trainer.active-score.v1';

export function parseActiveScoreId(raw: string | null): string | null {
  if (!raw) return null;
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

function activeScoreStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadStoredActiveScoreId(
  storage: Pick<Storage, 'getItem'> | null = activeScoreStorage(),
): string | null {
  if (!storage) return null;
  try {
    return parseActiveScoreId(storage.getItem(ACTIVE_SCORE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveStoredActiveScoreId(
  id: string | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = activeScoreStorage(),
): void {
  if (!storage) return;
  try {
    if (id) storage.setItem(ACTIVE_SCORE_STORAGE_KEY, parseActiveScoreId(id) ?? '');
    else storage.removeItem(ACTIVE_SCORE_STORAGE_KEY);
  } catch {
    // Best effort; a blocked storage must not break score loading.
  }
}
