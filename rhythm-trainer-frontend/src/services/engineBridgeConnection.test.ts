import { afterEach, expect, it, vi } from 'vitest';
import { EngineBridge } from './engineBridge';

class DelayedSocket {
  static OPEN = 1;
  static instances: DelayedSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  closed = false;
  messages: string[] = [];
  constructor() { DelayedSocket.instances.push(this); }
  send(message: string) { this.messages.push(message); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); DelayedSocket.instances = []; });
function bridge() {
  vi.stubGlobal('WebSocket', DelayedSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'piano.local:8788' });
  vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn(), dispatchEvent: vi.fn() });
  return new EngineBridge({ onStarted: vi.fn(), onJudgments: vi.fn(), onPaused: vi.fn(), onResumed: vi.fn(), onReport: vi.fn(), onError: vi.fn(), onDisconnected: vi.fn() });
}
it('cancels a pending handshake and never starts an abandoned practice', async () => {
  const engine = bridge();
  const started = vi.fn();
  const result = engine.connect().then(() => { started(); engine.finish(); }).catch((error: Error) => error.message);
  const socket = DelayedSocket.instances[0];
  engine.close();
  expect(socket.closed).toBe(true);
  socket.readyState = 1; socket.onopen?.();
  expect(await result).toContain('取消');
  expect(started).not.toHaveBeenCalled(); expect(socket.messages).toEqual([]);
});
it('settles a handshake that closes without an error event', async () => {
  const engine = bridge(); const result = engine.connect().catch((error: Error) => error.message);
  DelayedSocket.instances[0].close();
  expect(await result).toContain('断开');
});
