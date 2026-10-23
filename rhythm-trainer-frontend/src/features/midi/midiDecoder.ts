// Pure MIDI byte-stream decoder. Turns one MIDIMessageEvent payload into a
// normalized semantic event. Deliberately knows nothing about scoring, the
// session, React, or the engine — see docs/DESIGN.md §9: TypeScript handles
// device APIs and transport only; all judgment lives in the Rust core.
//
// Decoding rules follow the SP-A500 manual's MIDI implementation table:
// Note Off may arrive as standard 0x80 OR as 0x90 with velocity=0 (9nH, V=0).
// Channel is stored 0–15 internally; the UI may display 1–16.

export type NormalizedMidiKind =
  | 'note_on'
  | 'note_off'
  | 'control_change'
  | 'pitch_bend'
  | 'program_change'
  | 'other';

export interface DecodedMidiMessage {
  statusByte: number;
  /** statusByte & 0xF0 */
  command: number;
  /** statusByte & 0x0F (0–15). Display as channel+1. */
  channel: number;
  kind: NormalizedMidiKind;
  data1?: number;
  data2?: number;
  noteNumber?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  /** False when the payload lacks bytes this message type requires. */
  complete: boolean;
  rawBytes: number[];
}

export function decodeMidiMessage(data: ArrayLike<number>): DecodedMidiMessage {
  const rawBytes = Array.from(data, (b) => b & 0xff);
  const statusByte = rawBytes[0];
  const base: DecodedMidiMessage = {
    statusByte: statusByte ?? 0,
    command: 0,
    channel: 0,
    kind: 'other',
    complete: false,
    rawBytes,
  };
  // No status byte (or a system/real-time byte we do not model): keep the raw
  // bytes for the audit log, never guess a note.
  if (statusByte == null || statusByte < 0x80) {
    return base;
  }
  const command = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  const data1 = rawBytes[1];
  const data2 = rawBytes[2];
  const partial = { statusByte, command, channel, kind: 'other' as const, rawBytes, complete: false };

  switch (command) {
    case 0x80:
      return data1 == null || data2 == null
        ? { ...partial, kind: 'note_off', data1 }
        : { statusByte, command, channel, kind: 'note_off', data1, data2, noteNumber: data1, velocity: data2, complete: true, rawBytes };
    case 0x90:
      // SP-A500 sends Note Off as 9nH with velocity=0 — normalize to note_off
      // but keep the original bytes so the audit log shows what actually arrived.
      if (data1 == null || data2 == null) return { ...partial, kind: 'note_on', data1 };
      return data2 === 0
        ? { statusByte, command, channel, kind: 'note_off', data1, data2, noteNumber: data1, velocity: 0, complete: true, rawBytes }
        : { statusByte, command, channel, kind: 'note_on', data1, data2, noteNumber: data1, velocity: data2, complete: true, rawBytes };
    case 0xa0:
      // Polyphonic key pressure: recorded as other for now.
      return data1 == null ? partial : { ...partial, kind: 'other', data1, data2, complete: data2 != null };
    case 0xb0:
      return data1 == null || data2 == null
        ? { ...partial, kind: 'control_change', data1 }
        : { statusByte, command, channel, kind: 'control_change', data1, data2, controller: data1, value: data2, complete: true, rawBytes };
    case 0xc0:
      // Program Change is a TWO-byte message: data2 must never be read.
      return data1 == null
        ? { ...partial, kind: 'program_change' }
        : { statusByte, command, channel, kind: 'program_change', data1, complete: true, rawBytes };
    case 0xd0:
      // Channel (key) pressure — the SP-A500 MIDI table does not list sending it.
      return { ...partial, kind: 'other', data1, complete: data1 != null };
    case 0xe0:
      if (data1 == null || data2 == null) return { ...partial, kind: 'pitch_bend', data1 };
      return {
        statusByte, command, channel, kind: 'pitch_bend',
        data1, data2, value: data1 | (data2 << 7), complete: true, rawBytes,
      };
    default:
      return base;
  }
}

/** Human-readable controller names for the pedal trio the SP-A500 can send. */
export function controllerName(controller: number): string | null {
  switch (controller) {
    case 64: return 'sustain (CC64)';
    case 66: return 'sostenuto (CC66)';
    case 67: return 'soft (CC67)';
    default: return null;
  }
}
