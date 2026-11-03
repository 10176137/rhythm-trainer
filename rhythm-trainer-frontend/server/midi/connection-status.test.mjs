import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { NodeMidiAdapter } from './adapter.mjs';
import { createMockBackend } from './mock-backend.mjs';
import { observeConnectionStatus } from './connection-status.mjs';
it('releases each connection listener and does not notify closed sessions', () => {
  const adapter = new NodeMidiAdapter({ backend: createMockBackend() });
  let calls = 0;
  for (let i = 0; i < 500; i++) {
    const socket = new EventEmitter();
    observeConnectionStatus(adapter, socket, () => calls++);
    expect(adapter.handlers.status.size).toBe(1);
    socket.emit('close');
  }
  adapter.emitStatus();
  expect(adapter.handlers.status.size).toBe(0);
  expect(calls).toBe(0);
});
