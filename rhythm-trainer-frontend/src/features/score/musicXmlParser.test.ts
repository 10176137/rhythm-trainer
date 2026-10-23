import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sampleScore } from '../../core/sampleScore';
import { parseMusicXml, ScoreImportError } from './musicXmlParser';
import { getStaffPlacement } from './staffMapping';
import { buildScoreViewModel } from './scoreLayout';

const fixtureXml = readFileSync(
  new URL('./fixtures/rhythm-trainer-score-reading-example-v2.musicxml', import.meta.url),
  'utf8',
);
const ledgerDemoXml = readFileSync(
  new URL('./fixtures/ledger-lines-demo.musicxml', import.meta.url),
  'utf8',
);

describe('MusicXML import', () => {
  it('parses the bundled two-staff fixture into the same notation as sampleScore', () => {
    const doc = parseMusicXml(fixtureXml, 'rhythm-trainer-score-reading-example-v2.musicxml');
    expect(doc.meta.title).toBe('线间音符识谱练习');
    expect(doc.meta.barCount).toBe(2);
    expect(doc.meta.staves).toBe(2);
    expect(doc.meta.clefs).toEqual({ staff1: 'treble', staff2: 'bass' });
    expect(doc.meta.timeSignature).toEqual([4, 4]);
    expect(doc.meta.beatsPerBar).toBe(4);
    expect(doc.meta.integration).toBe('imported');
    expect(doc.warnings).toEqual([]);
    expect(doc.notes).toHaveLength(sampleScore.length);

    const byPosition = (a: { bar: number; beat: number; staff: string; voice: number }, b: { bar: number; beat: number; staff: string; voice: number }) =>
      a.bar - b.bar || a.beat - b.beat || a.staff.localeCompare(b.staff) || a.voice - b.voice;
    const normalized = [...doc.notes].sort(byPosition).map((note) => ({
      step: note.step, alter: note.alter, octave: note.octave, staff: note.staff,
      voice: note.voice, bar: note.bar, beat: note.beat, duration: note.durationBeats, type: note.noteType,
    }));
    const expected = [...sampleScore].sort(byPosition).map((note) => ({
      step: note.step, alter: note.alter, octave: note.octave, staff: note.staff,
      voice: note.voice, bar: note.bar, beat: note.beat, duration: note.durationBeats, type: note.noteType,
    }));
    expect(normalized).toEqual(expected);
  });

  it('keeps notes outside the five lines in the parsed model', () => {
    const doc = parseMusicXml(ledgerDemoXml, 'ledger-lines-demo.musicxml');
    expect(doc.meta.staves).toBe(1);
    expect(doc.meta.clefs).toEqual({ staff1: 'treble' });
    expect(doc.meta.title).toBe('谱表外音符示例');
    expect(doc.notes.map((note) => note.noteName)).toEqual([
      'C4', 'A3', 'F3', 'G5', 'A5', 'C6', 'E6', 'B5',
    ]);

    const placement = (name: string) => {
      const note = doc.notes.find((entry) => entry.noteName === name)!;
      return getStaffPlacement(note.staff, note.step, note.alter, note.octave)!;
    };
    expect(placement('C4').kind).toBe('ledger-below');
    expect(placement('C4').ledgerLineYs).toEqual([154]);
    expect(placement('A3').ledgerLineYs).toEqual([154, 168]);
    expect(placement('F3').ledgerLineYs).toEqual([154, 168, 182]);
    expect(placement('G5').kind).toBe('above-staff');
    expect(placement('G5').ledgerLineYs).toEqual([]);
    expect(placement('A5').ledgerLineYs).toEqual([70]);
    expect(placement('C6').ledgerLineYs).toEqual([70, 56]);
    expect(placement('E6').ledgerLineYs).toEqual([70, 56, 42]);
    expect(placement('B5').ledgerLineYs).toEqual([70]);
  });

  it('places out-of-staff labels next to the notes', () => {
    const doc = parseMusicXml(ledgerDemoXml, 'ledger-lines-demo.musicxml');
    const layout = buildScoreViewModel(
      doc.notes,
      { showNoteNames: true, showPositionHints: true },
      doc.meta.barCount,
      doc.meta.beatsPerBar,
    );
    const byName = (name: string) => layout.notes.find((item) => item.note.noteName === name)!;
    expect(byName('C4').label.nameY).toBe(179);
    expect(byName('G5').label.nameY).toBe(57);
    expect(byName('G5').label.badgeY).toBe(21);
    expect(byName('A5').label.nameY).toBe(50);
    expect(byName('A5').label.badgeY).toBe(14);
    expect(byName('A5').placement.positionLabel).toBe('加线上');
    expect(byName('B5').placement.positionLabel).toBe('加线间上');
  });

  it('parses explicit accidentals and a single bass staff', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise version="4.0">
        <part-list><score-part id="P1"><part-name>Bass</part-name></score-part></part-list>
        <part id="P1"><measure number="1">
          <attributes>
            <divisions>1</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>3</beats><beat-type>4</beat-type></time>
            <clef><sign>F</sign><line>4</line></clef>
          </attributes>
          <note><pitch><step>F</step><alter>1</alter><octave>3</octave></pitch><duration>1</duration><type>quarter</type><staff>1</staff></note>
          <note><rest/><duration>1</duration><type>quarter</type><staff>1</staff></note>
          <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><type>quarter</type><staff>1</staff></note>
        </measure></part>
      </score-partwise>`;
    const doc = parseMusicXml(xml, 'bass.musicxml');
    expect(doc.meta.staves).toBe(1);
    expect(doc.meta.clefs.staff1).toBe('bass');
    expect(doc.meta.beatsPerBar).toBe(3);
    expect(doc.notes).toHaveLength(2);
    expect(doc.notes[0]).toMatchObject({ noteName: 'F♯3', alter: 1, staff: 'bass', beat: 0 });
    expect(doc.notes[1]).toMatchObject({ noteName: 'G2', beat: 2 });
    expect(getStaffPlacement('bass', 'F', 1, 3)).not.toBeNull();
  });

  it('warns about constructs it approximates instead of silently claiming support', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise version="4.0"><part id="P1"><measure number="1">
        <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
          <clef><sign>G</sign><line>2</line></clef></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/><type>half</type></note>
      </measure></part></score-partwise>`;
    const doc = parseMusicXml(xml, 'tie.musicxml');
    expect(doc.warnings.some((warning) => warning.toLowerCase().includes('tie'))).toBe(true);
  });

  it('rejects non-partwise or empty documents with a readable error', () => {
    expect(() => parseMusicXml('<score-timewise/>', 'timewise.musicxml')).toThrow(ScoreImportError);
    expect(() => parseMusicXml('<score-partwise><part id="P1"/></score-partwise>', 'empty.musicxml')).toThrow(/没有小节/);
  });
});
