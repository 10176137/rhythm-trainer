import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLanCors } from './lan-origin.mjs';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
async function request(origin?: string, method = 'GET', headers: Record<string, string> = {}) {
  const server = http.createServer((req, res) => {
    if (applyLanCors(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return fetch(`http://127.0.0.1:${port}/api/health`, { method, headers: { ...(origin ? { Origin: origin } : {}), ...headers } });
}

describe('native shell cross-origin access', () => {
  it('allows the packaged iOS origin to read REST responses', async () => {
    const response = await request('capacitor://localhost');
    expect(response.headers.get('access-control-allow-origin')).toBe('capacitor://localhost');
    expect(await response.json()).toEqual({ ok: true });
  });
  it('permits JSON POST/PUT/DELETE preflight from the shell', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await request('capacitor://localhost', 'OPTIONS', { 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')).toContain(method);
      expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
    }
  });
  it.each(['https://evil.example', 'null', 'capacitor://evil'])('does not expose data to arbitrary origin %s', async (origin) => {
    const response = await request(origin);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await request(origin, 'OPTIONS', { 'Access-Control-Request-Method': 'POST' });
    expect(preflight.status).toBe(403);
  });
  it('rejects unsupported preflight headers', async () => {
    expect((await request('capacitor://localhost', 'OPTIONS', { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' })).status).toBe(403);
  });
  it('preserves normal same-origin browser and server requests', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
