/** Shared transport destination. Web keeps same-origin paths; the native
 * connection gate explicitly activates a computer only after a health check. */
let activeOrigin: string | null = null;

export function normalizeBackendOrigin(input: string): string {
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) throw new Error('请输入完整的 http:// 或 https:// 电脑地址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('电脑地址格式不正确。'); }
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('只需填写电脑地址和端口，不要包含账号、页面路径或其他参数。');
  }
  return url.origin;
}

export function activateBackendOrigin(origin: string | null): void {
  const next = origin === null ? null : normalizeBackendOrigin(origin);
  if (activeOrigin && next && next !== activeOrigin) throw new Error('更换电脑前请返回连接页，重新加载 App。');
  activeOrigin = next;
}

export function backendUrl(path: string): string {
  if (!path.startsWith('/api/') || new URL(path, 'http://local').pathname !== path.split('?')[0] || path.includes('#') || path.includes('\\')) {
    throw new Error('无效的服务接口地址。');
  }
  return activeOrigin ? `${activeOrigin}${path}` : path;
}

/** Server-owned IDs and pending evidence must not migrate to another computer. */
export function backendStorageKey(key: string): string {
  return activeOrigin ? `${key}.${encodeURIComponent(activeOrigin)}` : key;
}

export function backendWebSocketUrl(): string {
  if (activeOrigin) return `${activeOrigin.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export async function probeBackend(input: string, signal?: AbortSignal): Promise<string> {
  const origin = normalizeBackendOrigin(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 7000);
  try {
    const response = await fetch(`${origin}/api/health`, { signal: controller.signal, cache: 'no-store' });
    const body = await response.json();
    if (controller.signal.aborted) throw new DOMException('连接检查已取消或超时。', 'AbortError');
    if (!response.ok || body?.ok !== true || body?.schemaVersion !== 1) {
      throw new Error('该地址不是兼容的练习服务，请确认电脑端已更新并启动。');
    }
    return origin;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export const BACKEND_DISCONNECTED_EVENT = 'rhythm-trainer:backend-disconnected';
export function notifyBackendDisconnected(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(BACKEND_DISCONNECTED_EVENT));
}
