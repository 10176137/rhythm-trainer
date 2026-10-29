import type { TrainingCatalog, SkillDrillRequest, GeneratedSkillDrill } from '../../shared/training-contract';
import type { ReadingConfig, GeneratedReadingExercise } from '../../shared/reading-contract';

async function request<T extends { schemaVersion: 1 }>(path: string, field: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: input === undefined ? 'GET' : 'POST', signal,
      ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('无法连接训练服务，请确认后端已启动后重试。', { cause: error });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(response.status === 404 && !body?.error?.code
      ? '训练服务尚未更新，请重启后端服务后重试。'
      : body?.error?.message ?? `训练服务请求失败（${response.status}），请检查后端服务后重试。`);
  }
  const result = body?.[field];
  if (result?.schemaVersion !== 1) throw new Error('训练服务数据版本不兼容，请更新后重试。');
  return result as T;
}

export const trainingRepository = {
  catalog(signal?: AbortSignal) { return request<TrainingCatalog>('/api/training/catalog', 'catalog', undefined, signal); },
  skillDrill(input: SkillDrillRequest, signal?: AbortSignal) { return request<GeneratedSkillDrill>('/api/training/drills', 'drill', input, signal); },
  reading(config: ReadingConfig, reviewAttemptId?: string, signal?: AbortSignal) {
    return request<GeneratedReadingExercise>('/api/training/reading', 'exercise', { config, ...(reviewAttemptId ? { reviewAttemptId } : {}) }, signal);
  },
};
