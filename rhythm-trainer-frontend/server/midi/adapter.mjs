'use strict';

// Node-side MIDI input adapter. Owns device lifecycle, source sequence,
// monotonic capture time and a bounded queue. It does not decode for scoring,
// match notes, aggregate chords, or write to disk in the device callback.

import { decodeMidiMessage } from './codec.mjs';

export class MidiAdapterError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'MidiAdapterError';
    this.code = code;
    this.detail = detail;
  }
}

const HEALTH = ['unknown', 'healthy', 'degraded', 'disconnected'];

function adapterError(code, message, detail = null) {
  return new MidiAdapterError(code, message, detail);
}

export class NodeMidiAdapter {
  constructor(options = {}) {
    if (!options.backend) throw new Error('NodeMidiAdapter requires a backend');
    this.backend = options.backend;
    this.now = options.now ?? (() => performance.now());
    this.queueCapacity = Math.max(1, Number(options.queueCapacity) || 2048);
    this.traceCapacity = Math.max(1, Number(options.traceCapacity) || 5000);
    this.queue = [];
    this.trace = [];
    this.generation = 0;
    this.connection = null;
    this.lastCapturedAtMs = null;
    this.queueDropped = 0;
    this.traceDropped = 0;
    this.staleGenerationDropped = 0;
    this.drainScheduled = false;
    this.draining = false;
    this.lastError = null;
    this.overflowReported = false;
    this.handlers = { event: new Set(), status: new Set(), diagnostic: new Set() };
    this.health = 'unknown';
    this.lastDevice = null;
    // Handles for devices that disappeared while open. They are intentionally
    // kept referenced: finalizing the native object would call closePort() on an
    // invalid WinMM handle and terminate the process.
    this.zombieHandles = [];
  }

  onEvent(handler) {
    this.handlers.event.add(handler);
    return () => this.handlers.event.delete(handler);
  }

  onStatus(handler) {
    this.handlers.status.add(handler);
    return () => this.handlers.status.delete(handler);
  }

  onDiagnostic(handler) {
    this.handlers.diagnostic.add(handler);
    return () => this.handlers.diagnostic.delete(handler);
  }

  getStatus() {
    return {
      backend: this.backend.name,
      backendVersion: this.backend.version ?? 'unknown',
      connected: this.connection !== null,
      device: this.connection?.device ?? this.lastDevice,
      generation: this.generation,
      inputHealth: this.health,
      queueDepth: this.queue.length,
      queueCapacity: this.queueCapacity,
      queueDropped: this.queueDropped,
      sourceSeq: this.connection?.sourceSeq ?? 0,
      clockDomainId: 'node-performance-monotonic',
      staleGenerationDropped: this.staleGenerationDropped,
      traceDropped: this.traceDropped,
      lastError: this.lastError,
    };
  }

  emitStatus() {
    const status = this.getStatus();
    for (const handler of this.handlers.status) {
      try { handler(status); } catch { /* listener isolation */ }
    }
    return status;
  }

  emitDiagnostic(code, message, detail = {}) {
    const diagnostic = {
      code,
      message,
      severity: code === 'MIDI_INPUT_QUEUE_OVERFLOW' || code === 'MIDI_DEVICE_DISCONNECTED' ? 'warning' : 'error',
      device: this.connection?.device ?? this.lastDevice,
      generation: this.generation,
      ...detail,
    };
    for (const handler of this.handlers.diagnostic) {
      try { handler(diagnostic); } catch { /* listener isolation */ }
    }
    return diagnostic;
  }

  setHealth(health, reason = null) {
    if (!HEALTH.includes(health)) throw new Error(`invalid MIDI input health: ${health}`);
    if (this.health === health) return;
    this.health = health;
    if (reason) this.lastError = reason;
    this.emitStatus();
  }

  listInputs() {
    try {
      return this.backend.listInputs();
    } catch (error) {
      if (error instanceof MidiAdapterError) throw error;
      const wrapped = adapterError(
        error?.code ?? 'MIDI_DEVICE_LIST_FAILED',
        String(error?.message ?? error),
      );
      this.lastError = wrapped.code;
      this.emitDiagnostic(wrapped.code, wrapped.message);
      this.emitStatus();
      throw wrapped;
    }
  }

  openInput(deviceId) {
    // List first: if the previous device vanished, closing its native port
    // would throw inside RtMidi and terminate the process.
    let devices;
    try { devices = this.listInputs(); } catch (error) { throw error; }
    if (this.connection) {
      const previousMissing = !devices.some((device) => device.id === this.connection.device.id);
      this.close('switch', { silentDiagnostic: true, detachNative: previousMissing });
    }
    const device = devices.find((item) => item.id === deviceId)
      ?? devices.find((item) => item.name === deviceId)
      ?? (/^\d+$/.test(String(deviceId)) ? devices[Number(deviceId)] : undefined);
    if (!device) {
      const error = adapterError('MIDI_INPUT_OPEN_FAILED', `找不到 MIDI 输入设备: ${deviceId}`);
      this.lastError = error.code;
      this.emitDiagnostic(error.code, error.message);
      this.emitStatus();
      throw error;
    }

    this.generation += 1;
    const generation = this.generation;
    const sourceId = `node-midi:${device.id}#g${generation}`;
    this.queue = [];
    this.overflowReported = false;
    this.lastCapturedAtMs = null;

    let handle;
    try {
      handle = this.backend.openInput(device.id, (bytes, deltaTime) => {
        this.handleMessage(bytes, deltaTime);
      });
    } catch (error) {
      this.connection = null;
      this.lastDevice = device;
      this.health = 'disconnected';
      this.lastError = error?.code ?? 'MIDI_INPUT_OPEN_FAILED';
      this.emitDiagnostic(this.lastError, String(error?.message ?? error));
      this.emitStatus();
      if (error instanceof MidiAdapterError) throw error;
      throw adapterError(this.lastError, String(error?.message ?? error));
    }

    this.connection = { device, generation, sourceId, sourceSeq: 0, handle };
    this.lastDevice = device;
    this.health = 'healthy';
    this.lastError = null;
    this.emitStatus();
    return this.getStatus();
  }

  close(reason = 'user', options = {}) {
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      if (options.detachNative) {
        // The device is already gone. RtMidi's closePort/destructor throw on an
        // invalid WinMM handle and that exception terminates the process, so we
        // only drop the JS listener and keep the native handle referenced.
        try { connection.handle.detach?.(); } catch { /* best effort */ }
        this.zombieHandles.push(connection.handle);
      } else {
        try { connection.handle.close(); } catch { /* best effort */ }
      }
      this.generation += 1;
      this.lastDevice = connection.device;
      this.staleGenerationDropped += this.queue.length;
      this.queue = [];
    }
    this.health = 'disconnected';
    if (!options.silentDiagnostic && connection) {
      this.emitDiagnostic(
        'MIDI_DEVICE_DISCONNECTED',
        `MIDI 输入已断开 (${reason})`,
        { reason, nativeDetached: Boolean(options.detachNative) },
      );
    }
    return this.emitStatus();
  }

  refreshDevices() {
    const devices = this.listInputs();
    if (this.connection && !devices.some((device) => device.id === this.connection.device.id)) {
      this.close('device_missing', { detachNative: true });
    }
    return devices;
  }

  handleMessage(bytes, deltaTime = 0) {
    const connection = this.connection;
    if (!connection) return;
    const rawData = Array.from(bytes ?? [], (b) => b & 0xff);
    if (rawData.length === 0) {
      this.emitDiagnostic('MIDI_INVALID_MESSAGE', '收到空 MIDI 消息');
      return;
    }
    const decoded = decodeMidiMessage(rawData);
    const capturedAtMonotonicMs = this.now();
    if (this.lastCapturedAtMs != null && capturedAtMonotonicMs < this.lastCapturedAtMs) {
      this.setHealth('degraded', 'MIDI_TIMESTAMP_REGRESSION');
      this.emitDiagnostic('MIDI_TIMESTAMP_REGRESSION', 'MIDI 采集时间戳回退', {
        previousMs: this.lastCapturedAtMs,
        currentMs: capturedAtMonotonicMs,
      });
    }
    this.lastCapturedAtMs = capturedAtMonotonicMs;
    connection.sourceSeq += 1;
    const event = {
      sourceId: connection.sourceId,
      connectionGeneration: connection.generation,
      sourceSeq: connection.sourceSeq,
      capturedAtMonotonicMs,
      messageType: decoded.messageType,
      channel: decoded.channel,
      noteNumber: decoded.noteNumber,
      velocity: decoded.velocity,
      controllerNumber: decoded.controllerNumber,
      controllerValue: decoded.controllerValue,
      rawData,
      libraryDeltaTimeMs: Number(deltaTime) || 0,
    };

    if (this.queue.length >= this.queueCapacity) {
      this.queueDropped += 1;
      this.setHealth('degraded', 'MIDI_INPUT_QUEUE_OVERFLOW');
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.emitDiagnostic('MIDI_INPUT_QUEUE_OVERFLOW', 'MIDI 输入队列已满，事件被丢弃', {
          queueCapacity: this.queueCapacity,
          dropped: this.queueDropped,
          generation: connection.generation,
        });
      }
      return;
    }
    this.queue.push(event);
    this.scheduleDrain();
  }

  scheduleDrain() {
    if (this.drainScheduled || this.draining) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        const connection = this.connection;
        if (!connection || event.connectionGeneration !== connection.generation) {
          this.staleGenerationDropped += 1;
          continue;
        }
        this.trace.push(event);
        if (this.trace.length > this.traceCapacity) {
          this.trace.shift();
          this.traceDropped += 1;
        }
        for (const handler of this.handlers.event) {
          try { handler(event); } catch { /* listener isolation */ }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Drain queued events before finalizing a take. */
  flush() {
    this.drain();
    return this.getStatus();
  }

  /** Test-only: emit through the injected backend (mock backend only). */
  injectMessage(bytes) {
    if (typeof this.backend.emit !== 'function') return false;
    return this.backend.emit(bytes);
  }

  getTrace() {
    return {
      schemaVersion: 1,
      source: 'node-midi',
      clockDomainId: 'node-performance-monotonic',
      exportedAtIso: new Date().toISOString(),
      device: this.connection?.device ?? this.lastDevice,
      generation: this.generation,
      eventCount: this.trace.length,
      dropped: this.traceDropped,
      queueDropped: this.queueDropped,
      staleGenerationDropped: this.staleGenerationDropped,
      events: this.trace,
    };
  }
}
