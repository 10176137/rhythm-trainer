// Audit-log semantics: sourceSeq counts every message, but system realtime
// bytes (clock/active sensing) are counted only. Storing them made the real
// SP-A500 trace grow by megabytes per minute.

import { describe, expect, it } from 'vitest';
import { decodeMidiMessage } from './midiDecoder';
import { MidiEventLog } from './midiEventLog';

const timestamps = { eventTimestampPerformanceMs: 10, handlerNowPerformanceMs: 11 };

describe('MidiEventLog', () => {
  it('skips system realtime messages while keeping their sequence numbers', () => {
    const log = new MidiEventLog('input-0');
    log.append(decodeMidiMessage([0xf8]), timestamps);
    log.append(decodeMidiMessage([0xfe]), timestamps);
    const note = log.append(decodeMidiMessage([0x90, 60, 90]), { ...timestamps, captureEpoch: 7 });

    expect(log.size).toBe(1);
    expect(note.sourceSeq).toBe(3);
    expect(log.sourceMessageCount).toBe(3);
    expect(log.skippedRealtimeCount).toBe(2);
    expect(log.all()[0].captureEpoch).toBe(7);
    expect(log.all()[0].kind).toBe('note_on');
  });

  it('still stores controllers and keeps them replayable', () => {
    const log = new MidiEventLog('input-0');
    log.append(decodeMidiMessage([0xf8]), timestamps);
    log.append(decodeMidiMessage([0xb0, 64, 127]), timestamps);

    expect(log.size).toBe(1);
    expect(log.all()[0].kind).toBe('control_change');
    expect(log.all()[0].sourceSeq).toBe(2);
    expect(log.skippedRealtimeCount).toBe(1);
  });

  it('exports counts for both stored and skipped messages', () => {
    const log = new MidiEventLog('input-0');
    log.append(decodeMidiMessage([0xf8]), timestamps);
    log.append(decodeMidiMessage([0x90, 60, 90]), timestamps);

    const exported = log.exportJson('2026-01-01T00:00:00.000Z');
    expect(exported.schemaVersion).toBe(2);
    expect(exported.eventCount).toBe(1);
    expect(exported.sourceMessageCount).toBe(2);
    expect(exported.skippedRealtimeCount).toBe(1);
    expect(exported.events).toHaveLength(1);
  });
});
