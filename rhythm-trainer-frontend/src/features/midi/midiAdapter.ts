// Web MIDI adapter — v0.6 transport layer. It captures RawMidiPackets (bytes
// + source clock metadata) and appends an audit log. It does NOT decode for
// scoring: decoded kinds in the log are UI labels only, and the authoritative
// decode/pairing/scoring happens in the Rust core via the engine service.
//
// Timestamps: MIDIMessageEvent.timeStamp is kept as the capture time (same
// performance timeline as performance.now() on Chromium); handler entry time
// is a dispatch-delay diagnostic. Neither is a hardware sample time.

import { decodeMidiMessage } from './midiDecoder';
import { MidiEventLog, type MidiEventLogExport } from './midiEventLog';
import type { EngineRawMidiPacket } from '../../types/engine';

export interface MidiPortInfo {
  id: string;
  name: string;
  state: MIDIPortDeviceState;
  connection: MIDIPortConnectionState;
}

export interface MidiDeviceEvent {
  portId: string;
  name?: string;
  state: MIDIPortDeviceState;
  connection: MIDIPortConnectionState;
}

export interface MidiConnection {
  portId: string;
  portName: string;
  /** Audit log: every raw message with sourceSeq, bytes and both timestamps. */
  getLogEntries(): readonly import("./midiEventLog").LoggedMidiEvent[];
  exportLogJson(): MidiEventLogExport;
  disconnect(): void;
}

// Re-export so callers can log without importing the module directly.
export type { LoggedMidiEvent } from './midiEventLog';

export async function requestMidiAccess(): Promise<MIDIAccess> {
  if (typeof navigator.requestMIDIAccess !== 'function') {
    throw new Error('当前浏览器不支持 Web MIDI。请使用支持 Web MIDI 的桌面浏览器（Chrome/Edge），或接入本地 MIDI Adapter。');
  }
  // SysEx is never needed for keyboard events — do not request it.
  return navigator.requestMIDIAccess({ sysex: false });
}

export function listMidiInputs(access: MIDIAccess): MidiPortInfo[] {
  return Array.from(access.inputs.values()).map((input) => ({
    id: input.id,
    name: input.name || input.id,
    state: input.state,
    connection: input.connection,
  }));
}

/**
 * Binds exactly ONE user-selected input port and emits RawMidiPackets.
 * Never fans out to every port: a second MIDI device must not silently
 * bleed into the session (spec D10).
 */
export function connectMidi(options: {
  access: MIDIAccess;
  portId: string;
  onRawPacket: (packet: EngineRawMidiPacket) => void;
  onDeviceEvent?: (event: MidiDeviceEvent) => void;
  /**
   * Reads the capture generation of the currently active take. The adapter
   * calls this at MIDI callback time, so a packet is bound to the take that
   * was active when it was first observed — never to whatever take happens to
   * be active when an async consumer later processes it.
   */
  getCaptureEpoch?: () => number | null;
}): MidiConnection {
  const { access, portId, onRawPacket, onDeviceEvent, getCaptureEpoch } = options;
  const port = access.inputs.get(portId);
  if (!port) throw new Error('所选 MIDI 输入端口不存在（可能已被拔出）。请刷新设备列表。');

  const log = new MidiEventLog(portId);
  const clockDomainId = 'web-page-performance-timeline';
  let bound = true;

  const handler = (event: MIDIMessageEvent) => {
    if (!bound) return;
    const handlerNow = performance.now();
    // Chromium: DOMHighResTimeStamp on the performance timeline, same origin
    // as performance.now(). Fall back to handlerNow for non-conforming UAs.
    const capturedAtMs = typeof event.timeStamp === 'number' && isFinite(event.timeStamp) ? event.timeStamp : handlerNow;
    const rawBytes = Array.from(event.data ?? [], (b) => b & 0xff);
    if (rawBytes.length === 0) return;
    const captureEpoch = getCaptureEpoch?.() ?? undefined;
    // sourceSeq counts EVERY message (notes and controllers) so lost CCs are
    // detectable; the audit log keeps a decoded kind as a UI label only.
    const entry = log.append(decodeMidiMessage(rawBytes), {
      eventTimestampPerformanceMs: capturedAtMs,
      handlerNowPerformanceMs: handlerNow,
      captureEpoch,
    });
    const packet: EngineRawMidiPacket = {
      sourceId: port.id,
      sourceSeq: entry.sourceSeq,
      clockDomainId,
      capturedAtMs,
      handlerAtMs: handlerNow,
      rawBytes,
      transport: 'web-midi',
      ...(captureEpoch != null ? { captureEpoch } : {}),
    };
    onRawPacket(packet);
  };

  port.onmidimessage = handler;
  port.onstatechange = () => {
    onDeviceEvent?.({ portId: port.id, name: port.name ?? undefined, state: port.state, connection: port.connection });
  };

  return {
    portId: port.id,
    portName: port.name || port.id,
    getLogEntries: () => log.all(),
    exportLogJson: () => log.exportJson(),
    disconnect: () => {
      bound = false;
      port.onmidimessage = null;
      port.onstatechange = null;
    },
  };
}
