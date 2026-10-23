// Append-only MIDI event audit log. Assigns a per-connection sourceSeq to
// every raw message, keeps original bytes and both timestamp flavours, and
// exports deterministic JSON so a captured device session can be replayed
// through the Rust core later (spec M1 / checklist §12).

import type { DecodedMidiMessage } from './midiDecoder';

export interface LoggedMidiEvent {
  /** Monotonic per-connection counter, starting at 1. */
  sourceSeq: number;
  sourceId: string;
  /** MIDIMessageEvent.timeStamp — browser performance timeline (Chromium). */
  eventTimestampPerformanceMs: number;
  /** performance.now() at handler entry — dispatch delay diagnostics only. */
  handlerNowPerformanceMs: number;
  dispatchDelayMs: number;
  statusByte: number;
  command: number;
  /** 0–15 internally; display as channel+1. */
  channel: number;
  kind: string;
  complete: boolean;
  rawBytes: number[];
  noteNumber?: number;
  velocity?: number;
  controller?: number;
  value?: number;
  /** Filled by the session layer when converting to the session clock. */
  sessionMs?: number;
  /** Capture generation active when the message was observed (absent when idle). */
  captureEpoch?: number;
}

// v2: system realtime messages (0xF8–0xFF: clock, active sensing, transport)
// are counted but not stored. They are ~99% of an idle SP-A500 stream and
// never participate in scoring; keeping them made the in-memory trace and the
// exported JSON grow by megabytes per minute.
export const MIDI_LOG_SCHEMA_VERSION = 2;

export interface MidiEventLogExport {
  schemaVersion: number;
  sourceId: string;
  capturedAtIso: string;
  /** Stored (non-realtime) events. */
  eventCount: number;
  /** Every received message, including skipped realtime ones. */
  sourceMessageCount: number;
  skippedRealtimeCount: number;
  events: LoggedMidiEvent[];
}

export class MidiEventLog {
  private entries: LoggedMidiEvent[] = [];
  private nextSeq = 1;
  private skippedRealtime = 0;

  constructor(readonly sourceId: string) {}

  append(decoded: DecodedMidiMessage, timestamps: { eventTimestampPerformanceMs: number; handlerNowPerformanceMs: number; captureEpoch?: number }): LoggedMidiEvent {
    const entry: LoggedMidiEvent = {
      sourceSeq: this.nextSeq++,
      sourceId: this.sourceId,
      eventTimestampPerformanceMs: timestamps.eventTimestampPerformanceMs,
      handlerNowPerformanceMs: timestamps.handlerNowPerformanceMs,
      dispatchDelayMs: timestamps.handlerNowPerformanceMs - timestamps.eventTimestampPerformanceMs,
      captureEpoch: timestamps.captureEpoch,
      statusByte: decoded.statusByte,
      command: decoded.command,
      channel: decoded.channel,
      kind: decoded.kind,
      complete: decoded.complete,
      rawBytes: decoded.rawBytes,
      noteNumber: decoded.noteNumber,
      velocity: decoded.velocity,
      controller: decoded.controller,
      value: decoded.value,
    };
    // sourceSeq must still count every message (lost-note/CC detection), but
    // realtime clock/active-sensing bytes are not stored.
    if (decoded.statusByte >= 0xf8) {
      this.skippedRealtime += 1;
      return entry;
    }
    this.entries.push(entry);
    return entry;
  }

  get size(): number {
    return this.entries.length;
  }

  get sourceMessageCount(): number {
    return this.nextSeq - 1;
  }

  get skippedRealtimeCount(): number {
    return this.skippedRealtime;
  }

  get last(): LoggedMidiEvent | null {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  all(): readonly LoggedMidiEvent[] {
    return this.entries;
  }

  exportJson(capturedAtIso: string = new Date().toISOString()): MidiEventLogExport {
    return {
      schemaVersion: MIDI_LOG_SCHEMA_VERSION,
      sourceId: this.sourceId,
      capturedAtIso,
      eventCount: this.entries.length,
      sourceMessageCount: this.sourceMessageCount,
      skippedRealtimeCount: this.skippedRealtime,
      events: this.entries,
    };
  }
}
