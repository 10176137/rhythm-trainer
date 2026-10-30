import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateBackendOrigin, backendUrl, backendWebSocketUrl, normalizeBackendOrigin, probeBackend } from './backendEndpoint';

afterEach(() => { activateBackendOrigin(null); vi.unstubAllGlobals(); });

describe('computer backend endpoint', () => {
  it('normalizes an explicitly entered HTTP or HTTPS origin', () => {
    expect(normalizeBackendOrigin(' http://192.168.1.20:8788/ ')).toBe('http://192.168.1.20:8788');
    expect(normalizeBackendOrigin('https://PIANO.local:443')).toBe('https://piano.local');
  });
  it.each(['', '192.168.1.2:8788', 'file:///tmp', 'ftp://piano.local', 'http://user:secret@piano.local', 'http://piano.local/api', 'http://piano.local?x=1', 'http://piano.local#x'])('rejects ambiguous or unsafe input %s', (input) => {
    expect(() => normalizeBackendOrigin(input)).toThrow();
  });
  it('preserves browser relative REST paths and selects secure WebSocket for HTTPS', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'piano.local:8443' });
    expect(backendUrl('/api/profile')).toBe('/api/profile');
    expect(backendWebSocketUrl()).toBe('wss://piano.local:8443/ws');
  });
  it('routes all remote requests to the chosen computer, independently of the shell origin', () => {
    vi.stubGlobal('location', { protocol: 'capacitor:', host: 'localhost' });
    activateBackendOrigin('http://192.168.1.20:8788');
    expect(backendUrl('/api/scores?id=a')).toBe('http://192.168.1.20:8788/api/scores?id=a');
    expect(backendWebSocketUrl()).toBe('ws://192.168.1.20:8788/ws');
  });
  it('uses secure transport for an HTTPS computer', () => {
    activateBackendOrigin('https://piano.local:8443');
    expect(backendWebSocketUrl()).toBe('wss://piano.local:8443/ws');
  });
  it('refuses to change computers in a live JavaScript context', () => {
    activateBackendOrigin('http://piano-a.local:8788');
    expect(() => activateBackendOrigin('http://piano-b.local:8788')).toThrow();
    expect(backendUrl('/api/scores')).toBe('http://piano-a.local:8788/api/scores');
  });
  it.each(['//other.local/api', 'https://other.local/api', '/assets/a', '/api/../secret'])('rejects non-API destinations %s', (path) => {
    expect(() => backendUrl(path)).toThrow();
  });
  it('checks the selected server without changing the active destination', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('http://192.168.1.20:8788/api/health');
      return new Response(JSON.stringify({ ok: true, schemaVersion: 1 }));
    }));
    expect(await probeBackend('http://192.168.1.20:8788')).toBe('http://192.168.1.20:8788');
    expect(backendUrl('/api/profile')).toBe('/api/profile');
  });
  it.each([{ ok: false, schemaVersion: 1 }, { ok: true, schemaVersion: 2 }, { hello: 'different service' }])('rejects a different or incompatible service', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(probeBackend('http://piano.local')).rejects.toThrow();
  });
  it('does not accept a late health result after cancellation', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return new Response(JSON.stringify({ ok: true, schemaVersion: 1 })); }));
    await expect(probeBackend('http://piano.local', controller.signal)).rejects.toThrow();
  });
});
