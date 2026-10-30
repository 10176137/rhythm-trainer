import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineBridge } from './engineBridge';
class Socket {
  static OPEN = 1;
  static sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(message: string) { Socket.sent.push(JSON.parse(message)); }
  close() { this.readyState = 3; this.onclose?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('engine start preserves configured feedback', () => {
  it.each(['after', 'live'])('forwards %s feedback from the frozen launch configuration', async (feedback) => {
    vi.stubGlobal('WebSocket', Socket);
    vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() });
    vi.stubGlobal('location', { host: '127.0.0.1:5173' });
    Socket.sent = [];
    const bridge = new EngineBridge({ onStarted: vi.fn(), onJudgments: vi.fn(), onPaused: vi.fn(), onResumed: vi.fn(), onReport: vi.fn(), onError: vi.fn(), onDisconnected: vi.fn() });
    try {
      await bridge.connect();
      bridge.start({ modeId: 'fixed-line', bpm: 60, profile: 'standard', countInBeats: 3, ticksPerQuarter: 960, atoms: [], configSnapshot: { feedback } });
      expect(Socket.sent.find((message) => message.type === 'start')?.feedback).toBe(feedback);
    } finally { bridge.close(); }
  });
});
