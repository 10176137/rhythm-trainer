// Pure-function tests for the MIDI byte decoder. No device, no browser.
// Covers the SP-A500 manual constraints: Note Off may arrive as 0x80 or as
// 0x90 velocity=0 (9nH, V=0); CC64/66/67 are control changes; Program Change
// is a two-byte message.

import { describe, expect, it } from 'vitest';
import { controllerName, decodeMidiMessage } from './midiDecoder';

describe('decodeMidiMessage', () => {
  it('decodes Note On with velocity > 0 as note_on', () => {
    const d = decodeMidiMessage([0x90, 60, 90]);
    expect(d.kind).toBe('note_on');
    expect(d.channel).toBe(0);
    expect(d.noteNumber).toBe(60);
    expect(d.velocity).toBe(90);
    expect(d.complete).toBe(true);
  });

  it('normalizes 0x90 velocity=0 to note_off (SP-A500 9nH,V=0 form)', () => {
    const d = decodeMidiMessage([0x90, 60, 0]);
    expect(d.kind).toBe('note_off');
    expect(d.noteNumber).toBe(60);
    expect(d.velocity).toBe(0);
    expect(d.complete).toBe(true);
  });

  it('decodes standard 0x80 Note Off', () => {
    const d = decodeMidiMessage([0x81, 62, 64]);
    expect(d.kind).toBe('note_off');
    expect(d.channel).toBe(1);
    expect(d.noteNumber).toBe(62);
  });

  it('decodes Control Change with controller and value', () => {
    const d = decodeMidiMessage([0xb0, 64, 127]);
    expect(d.kind).toBe('control_change');
    expect(d.controller).toBe(64);
    expect(d.value).toBe(127);
    expect(controllerName(64)).toBe('sustain (CC64)');
    expect(controllerName(66)).toBe('sostenuto (CC66)');
    expect(controllerName(67)).toBe('soft (CC67)');
  });

  it('decodes Pitch Bend as a 14-bit combined value', () => {
    const d = decodeMidiMessage([0xe2, 0x00, 0x40]);
    expect(d.kind).toBe('pitch_bend');
    expect(d.value).toBe(0x2000); // center position
  });

  it('reads Program Change as a two-byte message without touching data2', () => {
    const d = decodeMidiMessage([0xc5, 12]);
    expect(d.kind).toBe('program_change');
    expect(d.channel).toBe(5);
    expect(d.data1).toBe(12);
    expect(d.complete).toBe(true);
  });

  it('flags truncated messages as incomplete instead of guessing', () => {
    const note = decodeMidiMessage([0x90, 60]);
    expect(note.complete).toBe(false);
    const cc = decodeMidiMessage([0xb0, 64]);
    expect(cc.complete).toBe(false);
  });

  it('keeps data-less or non-status payloads as other with raw bytes', () => {
    const empty = decodeMidiMessage([]);
    expect(empty.kind).toBe('other');
    expect(empty.complete).toBe(false);
    const stray = decodeMidiMessage([0x40]);
    expect(stray.kind).toBe('other');
    expect(stray.rawBytes).toEqual([0x40]);
  });

  it('stores channel as 0-15 regardless of display convention', () => {
    expect(decodeMidiMessage([0x90, 60, 90]).channel).toBe(0);
    expect(decodeMidiMessage([0x9f, 60, 90]).channel).toBe(15);
  });
});
