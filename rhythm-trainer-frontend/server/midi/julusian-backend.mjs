'use strict';

// Real Windows/macOS backend. This is the only module that knows about the
// third-party MIDI library; the adapter and server only see plain data.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function backendError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createJulusianBackend() {
  let midi;
  let version = 'unknown';
  try {
    midi = require('@julusian/midi');
    version = require('@julusian/midi/package.json').version;
  } catch (error) {
    throw backendError(
      'MIDI_BACKEND_UNAVAILABLE',
      `无法加载 @julusian/midi: ${String(error && error.message ? error.message : error)}`,
    );
  }

  return {
    name: '@julusian/midi',
    version,

    listInputs() {
      let input;
      try {
        input = new midi.Input();
        const count = input.getPortCount();
        const devices = [];
        for (let index = 0; index < count; index += 1) {
          devices.push({
            id: `node-midi:${index}`,
            name: input.getPortName(index) || `MIDI Input ${index + 1}`,
            state: 'available',
          });
        }
        return devices;
      } catch (error) {
        throw backendError('MIDI_DEVICE_LIST_FAILED', `无法枚举 MIDI 输入端口: ${String(error && error.message ? error.message : error)}`);
      } finally {
        try { input?.destroy(); } catch { /* best effort */ }
      }
    },

    openInput(deviceId, onMessage) {
      const match = /^node-midi:(\d+)$/.exec(String(deviceId));
      if (!match) throw backendError('MIDI_INPUT_OPEN_FAILED', `未知 MIDI 设备 id: ${deviceId}`);
      const index = Number(match[1]);
      let input;
      try {
        input = new midi.Input();
        if (index < 0 || index >= input.getPortCount()) {
          throw backendError('MIDI_INPUT_OPEN_FAILED', `MIDI 端口 ${index} 不存在（可能已拔出）`);
        }
        input.ignoreTypes(true, true, true);
        input.on('message', (deltaTime, message) => {
          onMessage(Array.from(message ?? []), Number(deltaTime) || 0);
        });
        input.openPort(index);
        return {
          close() {
            try { input.removeAllListeners('message'); } catch { /* ignore */ }
            try { input.closePort(); } catch { /* ignore */ }
            try { input.destroy(); } catch { /* ignore */ }
          },
          /**
           * Used when the OS already removed the device. RtMidi's closePort()
           * (and its destructor) throw on an invalid WinMM handle; that C++
           * exception escapes napi and terminates the process, so a vanished
           * device must never reach close/closePort/destroy. Only the JS
           * listener is dropped here; the native object stays referenced by the
           * caller for the lifetime of the service.
           */
          detach() {
            try { input.removeAllListeners('message'); } catch { /* ignore */ }
          },
        };
      } catch (error) {
        try { input?.destroy(); } catch { /* ignore */ }
        if (error && error.code) throw error;
        throw backendError('MIDI_INPUT_OPEN_FAILED', `无法打开 MIDI 端口: ${String(error && error.message ? error.message : error)}`);
      }
    },
  };
}
