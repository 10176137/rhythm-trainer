import type { PracticeConfig } from '../types/practice';

export interface TakeTemplate {
  schemaVersion: number;
  id: string;
  name: string;
  config: PracticeConfig;
  scoreFingerprint: string | null;
  scoreLabel: string | null;
  scoreLibraryId: string | null;
  sourceReportId: string | null;
  sourceTakeId: string | null;
  prescriptionId: string | null;
  createdAtIso: string;
  updatedAtIso: string;
}

export type TakeTemplateInput = {
  name: string;
  config: PracticeConfig;
  scoreFingerprint?: string | null;
  scoreLabel?: string | null;
  scoreLibraryId?: string | null;
  sourceReportId?: string | null;
  sourceTakeId?: string | null;
  prescriptionId?: string | null;
};

export class TakeTemplateClientError extends Error {
  code: string | null;
  status: number;

  constructor(message: string, code: string | null = null, status = 0) {
    super(message);
    this.name = 'TakeTemplateClientError';
    this.code = code;
    this.status = status;
  }
}

async function parseResponse<T>(res: Response, url: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const error = body && typeof body === 'object' ? (body as { error?: { code?: string; message?: string } }).error : null;
    throw new TakeTemplateClientError(error?.message ?? `API ${url} 失败 (${res.status})`, error?.code ?? null, res.status);
  }
  return body as T;
}

const jsonHeaders = { 'content-type': 'application/json' };

export const takeTemplateRepository = {
  async list(): Promise<TakeTemplate[]> {
    const body = await parseResponse<{ items: TakeTemplate[] }>(
      await fetch('/api/take-templates'),
      '/api/take-templates',
    );
    return body.items ?? [];
  },

  async create(input: TakeTemplateInput): Promise<TakeTemplate> {
    const body = await parseResponse<{ take: TakeTemplate }>(
      await fetch('/api/take-templates', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      }),
      '/api/take-templates',
    );
    return body.take;
  },

  async update(id: string, patch: Partial<TakeTemplateInput>): Promise<TakeTemplate> {
    const body = await parseResponse<{ take: TakeTemplate }>(
      await fetch(`/api/take-templates/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(patch),
      }),
      `/api/take-templates/${id}`,
    );
    return body.take;
  },

  async remove(id: string): Promise<void> {
    await parseResponse<{ ok: boolean }>(
      await fetch(`/api/take-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      `/api/take-templates/${id}`,
    );
  },
};
