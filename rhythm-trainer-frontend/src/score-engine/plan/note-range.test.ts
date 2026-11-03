import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import type { ScoreDocument } from '../domain/types';
import {
  boundaryFromEvent,
  clampDraggedBoundary,
  canonicalLoopPickEventId,
  loopBoundaryForTap,
  loopRangeMutedEventIds,
  normalizeNoteRange,
  resolveBoundaryEvent,
  resolveNoteRange,
} from './note-range';
import { rational } from '../domain/rational';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Note range trim fixture</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note id="m1a"><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="m1b"><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="m1c"><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
    <measure number="2">
      <note id="m2a"><pitch><step>F</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="m2b"><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="m2c"><rest/><duration>2</duration><type>half</type></note>
    </measure>
    <measure number="3">
      <note id="m3a"><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><type>half</type></note>
      <note id="m3b"><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note id="m3c"><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

const CHORD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Chord pick fixture</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note id="chord-c"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <note id="chord-e"><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <note id="chord-g"><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <note id="after"><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

function docOf(xml: string): ScoreDocument {
  const result = importMusicXml(xml, { fileName: 'note-range-test.musicxml' });
  if (!result.scoreDocument) throw new Error('fixture did not import');
  return result.scoreDocument;
}

describe('note-level loop range', () => {
  it('normalizes two boundaries by absolute onset regardless of tap order', () => {
    const doc = docOf(XML);
    const a = boundaryFromEvent(eventByXmlId(doc, 'm1a'));
    const b = boundaryFromEvent(eventByXmlId(doc, 'm3c'));
    expect(normalizeNoteRange(b, a)).toEqual(normalizeNoteRange(a, b));
    expect(normalizeNoteRange(b, a).start.eventId).toBe(a.eventId);
  });

  it('resolves boundaries by id and rejects foreign ones', () => {
    const doc = docOf(XML);
    const first = eventByXmlId(doc, 'm1a');
    const boundary = boundaryFromEvent(first);
    expect(resolveBoundaryEvent(doc, boundary)?.id).toBe(boundary.eventId);
    expect(resolveBoundaryEvent(doc, { ...boundary, measureOrdinal: 99 })).toBeNull();
    expect(resolveBoundaryEvent(doc, null)).toBeNull();
    const other = docOf(CHORD_XML);
    expect(resolveNoteRange(other, boundary, boundary)).toBeNull();
  });







  it('mutes exactly the events outside the note range', () => {
    const doc = docOf(XML);
    const range = resolveNoteRange(doc, boundaryOf(doc, 'm1c'), boundaryOf(doc, 'm2a'));
    if (!range) throw new Error('range should resolve');
    const muted = loopRangeMutedEventIds(doc, range);
    expect(muted.has(idOf(doc, 'm1a'))).toBe(true);
    expect(muted.has(idOf(doc, 'm1b'))).toBe(true);
    expect(muted.has(idOf(doc, 'm1c'))).toBe(false);
    expect(muted.has(idOf(doc, 'm2a'))).toBe(false);
    expect(muted.has(idOf(doc, 'm2b'))).toBe(true);
    expect(muted.has(idOf(doc, 'm3a'))).toBe(true);
    // Rests are never muted (not playable targets).
    expect(muted.has(idOf(doc, 'm2c'))).toBe(false);
  });

  it('canonicalizes a chord tap to its lowest-source-ordinal member', () => {
    const doc = docOf(CHORD_XML);
    expect(canonicalLoopPickEventId(doc, idOf(doc, 'chord-g'))).toBe(idOf(doc, 'chord-c'));
    expect(canonicalLoopPickEventId(doc, idOf(doc, 'chord-c'))).toBe(idOf(doc, 'chord-c'));
    expect(canonicalLoopPickEventId(doc, idOf(doc, 'after'))).toBe(idOf(doc, 'after'));
    expect(canonicalLoopPickEventId(doc, 'nope')).toBeNull();
  });

  it('clamping: dragging one edge never moves the other', () => {
    const doc = docOf(XML);
    const a = boundaryFromEvent(eventByXmlId(doc, 'm1a'));
    const c = boundaryFromEvent(eventByXmlId(doc, 'm3a'));
    // drag END past START → end clamps onto start; start untouched
    expect(clampDraggedBoundary('end', a, c)).toEqual({ start: c, end: c });
    // drag START past END → start clamps onto end; end untouched
    expect(clampDraggedBoundary('start', c, a)).toEqual({ start: a, end: a });
    // a normal drag keeps the partner exactly where it was
    const later = boundaryFromEvent(eventByXmlId(doc, 'm2a'));
    expect(clampDraggedBoundary('end', later, a)).toEqual({ start: a, end: later });
  });

  it('a later tap moves the endpoint nearest the tapped note', () => {
    const start = rational(10, 1);
    const end = rational(20, 1);
    expect(loopBoundaryForTap(start, end, rational(0, 1))).toBe('start');
    expect(loopBoundaryForTap(start, end, rational(12, 1))).toBe('start');
    expect(loopBoundaryForTap(start, end, rational(15, 1))).toBe('start'); // tie
    expect(loopBoundaryForTap(start, end, rational(18, 1))).toBe('end');
    expect(loopBoundaryForTap(start, end, rational(30, 1))).toBe('end');
  });

  it('a tap outside a one-note range grows it on that side', () => {
    const only = rational(10, 1);
    expect(loopBoundaryForTap(only, only, rational(5, 1))).toBe('start');
    expect(loopBoundaryForTap(only, only, rational(15, 1))).toBe('end');
  });
});

function eventByXmlId(doc: ScoreDocument, xmlId: string) {
  for (const part of doc.parts) {
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.source.xmlId === xmlId) return event;
      }
    }
  }
  throw new Error(`${xmlId} missing`);
}

function boundaryOf(doc: ScoreDocument, xmlId: string) {
  return boundaryFromEvent(eventByXmlId(doc, xmlId));
}

function idOf(doc: ScoreDocument, xmlId: string): string {
  return eventByXmlId(doc, xmlId).id;
}
