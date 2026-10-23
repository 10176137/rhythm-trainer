'use strict';

// Adapter-owned MIDI message labels. This is for the device monitor and the
// raw trace only: scoring still decodes raw bytes in the Rust core. The output
// must not depend on the third-party MIDI library.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(noteNumber) {
  if (!Number.isInteger(noteNumber) || noteNumber < 0 || noteNumber > 127) return '?';
  return `${NOTE_NAMES[noteNumber % 12]}${Math.floor(noteNumber / 12) - 1}`;
}

/**
 * @param {ArrayLike<number>} data
 * @returns {{
 *   messageType: 'note-on'|'note-off'|'control-change'|'other',
 *   channel: number,
 *   noteNumber: number|null,
 *   velocity: number|null,
 *   controllerNumber: number|null,
 *   controllerValue: number|null,
 *   rawData: number[],
 *   complete: boolean
 * }}
 */
export function decodeMidiMessage(data) {
  const rawData = Array.from(data ?? [], (b) => b & 0xff);
  const status = rawData[0];
  const base = {
    messageType: 'other',
    channel: 0,
    noteNumber: null,
    velocity: null,
    controllerNumber: null,
    controllerValue: null,
    rawData,
    complete: false,
  };
  if (status == null || status < 0x80) return base;
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const data1 = rawData[1];
  const data2 = rawData[2];

  if (command === 0x90) {
    if (data1 == null || data2 == null) return { ...base, channel, complete: false };
    // SP-A500 and most keyboards send Note Off as 9nH velocity=0.
    const type = data2 === 0 ? 'note-off' : 'note-on';
    return {
      ...base,
      messageType: type,
      channel,
      noteNumber: data1,
      velocity: data2,
      complete: true,
    };
  }
  if (command === 0x80) {
    if (data1 == null || data2 == null) return { ...base, channel, complete: false };
    return {
      ...base,
      messageType: 'note-off',
      channel,
      noteNumber: data1,
      velocity: data2,
      complete: true,
    };
  }
  if (command === 0xb0) {
    if (data1 == null || data2 == null) return { ...base, channel, complete: false };
    return {
      ...base,
      messageType: 'control-change',
      channel,
      controllerNumber: data1,
      controllerValue: data2,
      complete: true,
    };
  }
  return { ...base, channel, complete: rawData.length >= 1 };
}
