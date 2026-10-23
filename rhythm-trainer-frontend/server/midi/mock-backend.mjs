'use strict';

// Deterministic backend for tests and for the software-only server integration
// path. It never touches a real MIDI device.

export function createMockBackend(options = {}) {
  const devices = options.devices ?? [{ id: 'mock:0', name: 'Mock Piano', state: 'available' }];
  let current = null;
  let openCount = 0;
  let closeCount = 0;

  return {
    name: 'mock-midi',
    version: '1.0.0',
    listInputs() {
      if (options.listError) throw Object.assign(new Error('mock list failure'), { code: 'MIDI_DEVICE_LIST_FAILED' });
      return devices.map((device) => ({ ...device }));
    },
    openInput(deviceId, onMessage) {
      if (options.openError) throw Object.assign(new Error('mock open failure'), { code: 'MIDI_INPUT_OPEN_FAILED' });
      if (!devices.some((device) => device.id === deviceId)) {
        throw Object.assign(new Error(`mock device not found: ${deviceId}`), { code: 'MIDI_INPUT_OPEN_FAILED' });
      }
      openCount += 1;
      current = { deviceId, onMessage };
      return {
        close() {
          closeCount += 1;
          current = null;
        },
      };
    },
    emit(bytes) {
      if (!current) return false;
      current.onMessage(Array.from(bytes ?? []), 0);
      return true;
    },
    getStats() {
      return { openCount, closeCount, listening: current !== null };
    },
  };
}
