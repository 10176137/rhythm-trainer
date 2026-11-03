// The note-level range must survive the REAL planner boundary: the trimmed
// document is refined on Node and the Rust NAPI plans it with the frozen measure
// range. This pins the contract the loop launch relies on — the plan contains
// exactly the notes between the two picked boundaries, never the rest of the
// boundary measures.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import type { ScoreDocument } from '../domain/types';
import { projectScoreDocumentV1 } from '../contract-v1/plan-fingerprint';
import { findRepoRoot } from '../parity/case-bundle';
import { applyPlanNoteRange } from '../../../server/plan-note-range.mjs';
import {
  boundaryFromEvent,
  resolveNoteRange,
} from './note-range';

const require = createRequire(import.meta.url);
const root = findRepoRoot();
const native = require(join(root, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>Note range rust fixture</work-title></work>
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

const CONFIG = {
  partId: 'P1',
  range: { startMeasureOrdinal: 1, endMeasureOrdinal: 3 },
  repeatSelection: { kind: 'none' },
  hand: 'both',
  handMapping: {
    schemaVersion: 1,
    mappingVersion: 'hand-mapping-1',
    source: 'user',
    parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }] }],
  },
  bpm: { numerator: 60, denominator: 1 },
  ticksPerQuarter: 960,
  countInUs: 3000000,
  unsupportedNotationPolicy: 'reject-strict',
  plannerVersion: 'rust-planner-1',
};

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

function planFor(xml: string, startXmlId: string, endXmlId: string) {
  const imported = importMusicXml(xml, { fileName: 'note-range-rust.musicxml' });
  if (!imported.scoreDocument) throw new Error('fixture did not import');
  const doc = imported.scoreDocument;
  const startEvent = eventByXmlId(doc, startXmlId);
  const endEvent = eventByXmlId(doc, endXmlId);
  const range = resolveNoteRange(doc, boundaryFromEvent(startEvent), boundaryFromEvent(endEvent));
  if (!range) throw new Error('range did not resolve');
  const projected = projectScoreDocumentV1(doc, imported.importReport);
  expect(projected.issues).toEqual([]);
  return {
    plan: JSON.parse(native.buildPlanV1(
      JSON.stringify(applyPlanNoteRange(projected.dto, { startEventId: startEvent.id, endEventId: endEvent.id }, CONFIG)),
      JSON.stringify(imported.importReport),
      JSON.stringify(CONFIG),
    )) as { occurrences: Array<{ scoreEventId: string; playbackBeat: string }> },
    ids: Object.fromEntries(['m1a', 'm1b', 'm1c', 'm2a', 'm2b', 'm3a', 'm3b', 'm3c']
      .map((xmlId) => [xmlId, eventByXmlId(doc, xmlId).id])),
  };
}

describe('note-level loop range through the Rust planner', () => {
  it('plans exactly the notes between the two boundaries', () => {
    const { plan, ids } = planFor(XML, 'm1b', 'm3b');
    const planned = plan.occurrences.map((occurrence) => occurrence.scoreEventId);
    // m1a is before the start onset; m3c is after the end onset; the rest is
    // not a planned note. Chord mates share an onset and are kept together.
    expect(planned).toEqual([ids.m1b, ids.m1c, ids.m2a, ids.m2b, ids.m3a, ids.m3b]);
    expect(planned).not.toContain(ids.m1a);
    expect(planned).not.toContain(ids.m3c);
  });

  it('starts the timeline at the start boundary note even mid-measure', () => {
    const { plan } = planFor(XML, 'm1b', 'm3b');
    // m1b is beat 1 of measure 1 (0-based), so the plan's first occurrence is
    // exactly there — not at the measure start. Rust serializes rationals "n/d".
    expect(plan.occurrences[0].playbackBeat).toBe('1/1');
  });
});
