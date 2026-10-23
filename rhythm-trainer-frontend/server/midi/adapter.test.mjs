import { describe, expect, it } from 'vitest';
import { NodeMidiAdapter } from './adapter.mjs';
import { createMockBackend } from './mock-backend.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const backend = createMockBackend(options.backend);
  let now = 1_000;
  const adapter = new NodeMidiAdapter({
    backend,
    now: () => (now += 1),
    queueCapacity: options.queueCapacity ?? 16,
    traceCapacity: 16,
  });
  const events = [];
  const diagnostics = [];
  adapter.onEvent((event) => events.push(event));
  adapter.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  return { backend, adapter, events, diagnostics };
}

describe('NodeMidiAdapter', () => {
  it('lists an empty device set without pretending a device exists', () => {
    const { adapter } = setup({ backend: { devices: [] } });
    expect(adapter.listInputs()).toEqual([]);
  });

  it('reports open failures with a stable code', () => {
    const { adapter } = setup({ backend: { devices: [] } });
    expect(() => adapter.openInput('missing')).toThrowError(/找不到 MIDI 输入设备/);
    try { adapter.openInput('missing'); } catch (error) { expect(error.code).toBe('MIDI_INPUT_OPEN_FAILED'); }
    expect(adapter.getStatus().inputHealth).toBe('unknown');
  });

  it('normalizes note-on, note-off, velocity-zero, CC and unknown messages', async () => {
    const { adapter, backend, events } = setup();
    adapter.openInput('mock:0');
    backend.emit([0x90, 60, 90]);
    backend.emit([0x90, 60, 0]);
    backend.emit([0x80, 60, 40]);
    backend.emit([0xb0, 64, 127]);
    backend.emit([0xf0, 0x7e]);
    await tick();

    expect(events.map((event) => event.messageType)).toEqual([
      'note-on', 'note-off', 'note-off', 'control-change', 'other',
    ]);
    expect(events[0]).toMatchObject({ noteNumber: 60, velocity: 90, channel: 0, sourceSeq: 1 });
    expect(events[1]).toMatchObject({ noteNumber: 60, velocity: 0, sourceSeq: 2 });
    expect(events[3]).toMatchObject({ controllerNumber: 64, controllerValue: 127, sourceSeq: 4 });
    expect(events[0].capturedAtMonotonicMs).toBeLessThan(events[4].capturedAtMonotonicMs);
    expect(events[0].rawData).toEqual([0x90, 60, 90]);
  });

  it('closes the previous port before a new open and never duplicates listeners', async () => {
    const { adapter, backend, events } = setup();
    adapter.openInput('mock:0');
    adapter.openInput('mock:0');
    expect(backend.getStats()).toMatchObject({ openCount: 2, closeCount: 1, listening: true });
    backend.emit([0x90, 62, 80]);
    await tick();
    expect(events).toHaveLength(1);
  });

  it('drops queued events from an old connection generation', async () => {
    const { adapter, backend, events } = setup();
    adapter.openInput('mock:0');
    backend.emit([0x90, 60, 90]);
    // Re-open before the queued event has drained.
    adapter.openInput('mock:0');
    await tick();
    expect(events).toHaveLength(0);
    expect(adapter.getStatus().staleGenerationDropped).toBeGreaterThanOrEqual(1);

    backend.emit([0x90, 64, 90]);
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0].connectionGeneration).toBe(adapter.getStatus().generation);
  });

  it('makes queue overflow visible and degrades input health', async () => {
    const { adapter, backend, events, diagnostics } = setup({ queueCapacity: 2 });
    adapter.openInput('mock:0');
    backend.emit([0x90, 60, 90]);
    backend.emit([0x90, 62, 90]);
    backend.emit([0x90, 64, 90]);
    await tick();

    expect(events).toHaveLength(2);
    expect(adapter.getStatus().queueDropped).toBe(1);
    expect(adapter.getStatus().inputHealth).toBe('degraded');
    expect(diagnostics.some((item) => item.code === 'MIDI_INPUT_QUEUE_OVERFLOW')).toBe(true);
  });

  it('stops delivering events and releases the backend on close', async () => {
    const { adapter, backend, events } = setup();
    adapter.openInput('mock:0');
    adapter.close('test');
    expect(backend.getStats().listening).toBe(false);
    backend.emit([0x90, 60, 90]);
    await tick();
    expect(events).toHaveLength(0);
    expect(adapter.getStatus().connected).toBe(false);
    expect(adapter.getStatus().inputHealth).toBe('disconnected');
  });

  it('reports timestamp regression instead of silently rewriting it', async () => {
    const backend = createMockBackend();
    let values = [100, 90];
    const adapter = new NodeMidiAdapter({ backend, now: () => values.shift() ?? 90 });
    const diagnostics = [];
    adapter.onDiagnostic((item) => diagnostics.push(item));
    adapter.openInput('mock:0');
    backend.emit([0x90, 60, 90]);
    backend.emit([0x90, 62, 90]);
    await tick();
    expect(diagnostics.some((item) => item.code === 'MIDI_TIMESTAMP_REGRESSION')).toBe(true);
    expect(adapter.getStatus().inputHealth).toBe('degraded');
  });
});
