import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineBridge } from './engineBridge';
class Socket {
  static OPEN = 1;
  static latest: Socket;
  onmessage?: (event: { data: string }) => void;
  static sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  constructor() { Socket.latest = this; queueMicrotask(() => this.onopen?.()); }
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

it('binds lifecycle commands to the server-issued timeline take', async () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() });
  vi.stubGlobal('location', { host: '127.0.0.1:5173' });
  Socket.sent = [];
  const bridge = new EngineBridge({ onStarted: vi.fn(), onJudgments: vi.fn(), onPaused: vi.fn(), onResumed: vi.fn(), onReport: vi.fn(), onError: vi.fn(), onDisconnected: vi.fn() });
  try {
    await bridge.connect();
    Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'started', takeId: 'take-current', targets: [] }) });
    bridge.tick(100); bridge.pause(100); bridge.resume(200); bridge.finish();
    const commands = Socket.sent.filter(message => ['tick', 'pause', 'resume', 'finish'].includes(String(message.type)));
    expect(commands).toHaveLength(4);
    expect(commands.every(message => message.takeId === 'take-current')).toBe(true);
  } finally { bridge.close(); }
});

it('binds Follow inputs and control commands to the server-issued take', async () => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('window', { setTimeout: vi.fn(), clearTimeout: vi.fn() });
  vi.stubGlobal('location', { host: '127.0.0.1:5173' });
  Socket.sent = [];
  const bridge = new EngineBridge({ onStarted: vi.fn(), onJudgments: vi.fn(), onPaused: vi.fn(), onResumed: vi.fn(), onReport: vi.fn(), onError: vi.fn(), onDisconnected: vi.fn() });
  try {
    await bridge.connect();
    Socket.latest.onmessage?.({ data: JSON.stringify({ type: 'follow-started', takeId: 'follow-current' }) });
    bridge.followNote(60, 100); bridge.followPause(200); bridge.followResume(300); bridge.followFinish(); bridge.followAbandon();
    const commands = Socket.sent.filter(message => String(message.type).startsWith('follow-'));
    expect(commands).toHaveLength(5);
    expect(commands.every(message => message.takeId === 'follow-current')).toBe(true);
  } finally { bridge.close(); }
});
