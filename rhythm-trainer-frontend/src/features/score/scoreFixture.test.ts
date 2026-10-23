import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleScore } from '../../core/sampleScore';
import { formatPitchName, midiNoteFor } from './staffMapping';

const xml = readFileSync(
  new URL('./fixtures/rhythm-trainer-score-reading-example-v2.musicxml', import.meta.url),
  'utf8',
);

interface XmlNote {
  step: string;
  octave: number;
  duration: number;
  type: string;
  staff: number;
  voice: number;
}

function capture(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  if (!match) throw new Error(`Missing <${tag}> in note block: ${block}`);
  return match[1];
}

const noteBlocks = xml.match(/<note>[\s\S]*?<\/note>/g) ?? [];
const xmlNotes: XmlNote[] = noteBlocks.map((block) => ({
  step: capture(block, 'step'),
  octave: Number(capture(block, 'octave')),
  duration: Number(capture(block, 'duration')),
  type: capture(block, 'type'),
  staff: Number(capture(block, 'staff')),
  voice: Number(capture(block, 'voice')),
}));

describe('MusicXML fixture correspondence', () => {
  it('reads the attached two-bar 4/4 grand-staff example', () => {
    expect(xml).toContain('<work-title>线间音符识谱练习</work-title>');
    expect(xml).toContain('<divisions>1</divisions>');
    expect(xml).toContain('<staves>2</staves>');
    expect(xml).toContain('<beats>4</beats><beat-type>4</beat-type>');
    expect(xml).toContain('<clef number="1"><sign>G</sign><line>2</line></clef>');
    expect(xml).toContain('<clef number="2"><sign>F</sign><line>4</line></clef>');
    expect(xml.match(/<backup><duration>4<\/duration><\/backup>/g)).toHaveLength(2);
    expect(xmlNotes).toHaveLength(10);
  });

  it('matches the right-hand C4–C5 quarter-note sequence in the UI fixture', () => {
    const xmlRight = xmlNotes
      .filter((note) => note.staff === 1)
      .map((note) => ({ step: note.step, octave: note.octave, duration: note.duration, type: note.type, voice: note.voice }));
    const uiRight = sampleScore
      .filter((note) => note.hand === 'right')
      .map((note) => ({
        step: note.step,
        octave: note.octave,
        duration: note.durationBeats,
        type: note.noteType,
        voice: note.voice,
      }));
    expect(xmlRight).toHaveLength(8);
    expect(uiRight).toEqual(xmlRight);
    expect(xmlRight.map((note) => `${note.step}${note.octave}`)).toEqual([
      'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5',
    ]);
  });

  it('matches the left-hand whole notes and their bar onsets', () => {
    const xmlLeft = xmlNotes
      .filter((note) => note.staff === 2)
      .map((note) => ({ step: note.step, octave: note.octave, duration: note.duration, type: note.type, voice: note.voice }));
    const uiLeft = sampleScore
      .filter((note) => note.hand === 'left')
      .map((note) => ({
        step: note.step,
        octave: note.octave,
        duration: note.durationBeats,
        type: note.noteType,
        voice: note.voice,
      }));
    expect(xmlLeft).toHaveLength(2);
    expect(uiLeft).toEqual(xmlLeft);
    expect(xmlLeft.map((note) => `${note.step}${note.octave}`)).toEqual(['C3', 'G2']);
    expect(xmlLeft.every((note) => note.type === 'whole' && note.duration === 4)).toBe(true);
    expect(sampleScore.filter((note) => note.hand === 'left').map((note) => [note.bar, note.beat])).toEqual([
      [1, 0],
      [2, 4],
    ]);
  });

  it('keeps the written pitch and MIDI number consistent for every note', () => {
    for (const note of sampleScore) {
      expect(formatPitchName(note.step, note.alter, note.octave)).toBe(note.noteName);
      expect(midiNoteFor(note.step, note.alter, note.octave)).toBe(note.midiNote);
    }
  });
});
