import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import type { ScoreDocument } from '../domain/types';
import {
  assessPracticeScope,
  buildDefaultPianoHandMapping,
  DEFAULT_PIANO_HANDS,
  buildUserHandMapping,
  handByScoreEventIdFromMapping,
  suggestClefHeuristicMapping,
  type PracticeScopeV1,
} from './practice-scope';

const FIXTURE_ROOT = new URL('../../../../audit-r1/fixtures/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_ROOT), 'utf8');
}

function docOf(xml: string, fileName: string): ScoreDocument {
  const result = importMusicXml(xml, { fileName });
  if (!result.scoreDocument) throw new Error(`${fileName} did not import`);
  return result.scoreDocument;
}

function twoStaffScore(): ScoreDocument {
  // G2 treble + F4 bass piano score: the standard two-staff case.
  const xml = fixture('g6_unison_two_staves.musicxml');
  return docOf(xml, 'g6_unison_two_staves.musicxml');
}

function multiPartScore(): ScoreDocument {
  const xml = `<?xml version="1.0"?><score-partwise version="4.0">
    <part-list><score-part id="P1"><part-name>Piano</part-name></score-part><score-part id="P2"><part-name>Voice</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
    <part id="P2"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part>
  </score-partwise>`;
  return docOf(xml, 'two-parts.musicxml');
}

function scope(score: ScoreDocument, overrides: Partial<PracticeScopeV1> = {}): PracticeScopeV1 {
  const partId = overrides.partId ?? score.parts[0].id;
  return {
    schemaVersion: 1,
    partId,
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: Math.max(1, score.parts[0].measures.length) },
    hand: 'both',
    handMapping: buildUserHandMapping(partId, [
      { staffNumber: 1, hand: 'right' },
      { staffNumber: 2, hand: 'left' },
    ]),
    ...overrides,
  };
}

describe('global piano hand policy', () => {
  it('creates a strict-ready default for an ordinary two-staff piano without confirmation', () => {
    const score = twoStaffScore();
    const mapping = buildDefaultPianoHandMapping(score, DEFAULT_PIANO_HANDS)!;
    expect(mapping.parts[0].staves).toEqual([{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }]);
    expect(assessPracticeScope(score, scope(score, { handMapping: mapping })).ok).toBe(true);
  });

  it('applies changed global rules without reading clefs or mutating defaults', () => {
    const score = twoStaffScore();
    const mapping = buildDefaultPianoHandMapping(score, { single: 'left', upper: 'left', lower: 'right' })!;
    expect(mapping.parts[0].staves[0].hand).toBe('left');
    expect(mapping.parts[0].staves[1].hand).toBe('right');
    expect(DEFAULT_PIANO_HANDS.upper).toBe('right');
  });

  it('does not silently map a multi-part or unfamiliar staff layout', () => {
    expect(buildDefaultPianoHandMapping(multiPartScore(), DEFAULT_PIANO_HANDS)).toBeNull();
    const score = twoStaffScore();
    expect(buildDefaultPianoHandMapping({ ...score, parts: [{ ...score.parts[0], staves: 3 }] }, DEFAULT_PIANO_HANDS)).toBeNull();
  });
});

describe('assessPracticeScope: D1 double-treble staves', () => {
  it('accepts explicit user mapping even when both staves are treble', () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><staff>1</staff><type>whole</type></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><staff>2</staff><type>whole</type></note></measure></part></score-partwise>`;
    const score = docOf(xml, 'double-treble.musicxml');
    const assessment = assessPracticeScope(score, scope(score));
    expect(assessment.ok).toBe(true);
    expect(assessment.codes).toEqual([]);
  });

  it('rejects the clef heuristic for strict practice even though it looks plausible', () => {
    const score = twoStaffScore();
    const suggested = suggestClefHeuristicMapping(score, score.parts[0].id);
    expect(suggested.source).toBe('clef-heuristic');
    const assessment = assessPracticeScope(score, { ...scope(score), handMapping: suggested });
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toContain('hand_mapping_heuristic_not_allowed_for_strict');
  });
});

describe('assessPracticeScope: D2 standard piano G2/F4', () => {
  it('maps staff1=right staff2=left and covers every target', () => {
    const score = twoStaffScore();
    const assessment = assessPracticeScope(score, scope(score, { hand: 'both' }));
    expect(assessment.ok).toBe(true);
    const handByEventId = handByScoreEventIdFromMapping(score, scope(score, { hand: 'both' }));
    const notes = score.parts[0].measures[0].events.filter((event) => event.kind === 'note');
    expect(handByEventId.size).toBe(notes.length);
    for (const event of notes) {
      expect(handByEventId.get(event.id)).toBe(event.source.staffNumber === 1 ? 'right' : 'left');
    }
  });

  it('lists unmapped staffs with event counts when a staff is missing from the mapping', () => {
    const score = twoStaffScore();
    const incomplete = { ...scope(score), handMapping: buildUserHandMapping(score.parts[0].id, [{ staffNumber: 1, hand: 'right' }]) };
    const assessment = assessPracticeScope(score, incomplete);
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toContain('hand_mapping_incomplete');
    expect(assessment.missingStaffs).toEqual([{ partId: score.parts[0].id, staffNumber: 2, eventCount: 1 }]);
  });
});

describe('assessPracticeScope: D3 multi-part', () => {
  it('refuses multi-part scores outright until a Part selector exists (option A)', () => {
    const score = multiPartScore();
    // Even a well-formed scope for P2 is refused: without an explicit selection
    // flag the pure function cannot tell it from parts[0] defaulting.
    const assessment = assessPracticeScope(score, scope(score, { partId: 'P2' }));
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toContain('multiple_parts_require_part_selection');

    const unknown = assessPracticeScope(score, { ...scope(score), partId: 'nope' });
    expect(unknown.codes).toContain('range_part_mismatch');
  });
});

describe('assessPracticeScope: D4/D5 single hand and empty filter', () => {
  it('rejects a missing mapping instead of defaulting to right hand', () => {
    const score = twoStaffScore();
    const noMapping = { ...scope(score, { hand: 'left' }), handMapping: { schemaVersion: 1 as const, mappingVersion: 'hand-mapping-1', source: 'user' as const, parts: [] } };
    const assessment = assessPracticeScope(score, noMapping);
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toContain('hand_mapping_incomplete');
  });

  it('rejects a hand filter that empties the range', () => {
    const score = twoStaffScore();
    // g6 has C4 on BOTH staves. Mapping staff1=right satisfies completeness but
    // asking for LEFT hands leaves zero playable targets in range.
    const assessment = assessPracticeScope(score, {
      ...scope(score, { hand: 'left' }),
      handMapping: buildUserHandMapping(score.parts[0].id, [
        { staffNumber: 1, hand: 'right' },
        { staffNumber: 2, hand: 'right' },
      ]),
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toEqual(['range_empty_after_hand_filter']);
    expect(assessment.missingStaffs).toEqual([]);
  });

  it('reports range_part_mismatch for a part that does not exist', () => {
    const score = twoStaffScore();
    const assessment = assessPracticeScope(score, { ...scope(score), partId: 'P99' });
    expect(assessment.ok).toBe(false);
    expect(assessment.codes).toEqual(['range_part_mismatch']);
  });
});
