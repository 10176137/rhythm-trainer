// R2-2c acceptance class C: fail-closed rejection with normative codes
// (TS_RUST_PARITY_GATE_V1 §6 C + the frozen mapping table). Each case names
// the LAYER where rejection happens and asserts the concrete code; only this
// class requires TS/Rust code parity. Covered contract tests are reused by
// reference (map below); genuine gaps get new assertions.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan } from '../playback/playback-planner';
import {
  buildPlanFingerprintPayloadV1,
  planFingerprintV1,
  projectScoreDocumentV1,
} from '../contract-v1/plan-fingerprint';
import {
  mapServerRejectionToNormativeCode,
  validateCandidateScoreEvents,
} from './normative-codes';

const G1_XML = readFileSync('D:/123/audit-r1/fixtures/g1_single_voice.musicxml', 'utf8');

/** Reuse map: C-class items already asserted by committed contract tests. */
const REUSE_MAP: Record<string, { file: string; testTitle: string }> = {
  'N-ID-C3a duplicate partId -> DUPLICATE_PART_ID (projection)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'projection throws fail-closed on duplicate partId and unknown capability',
  },
  'N-ID-C3b duplicate source locator -> duplicate_source_locator (validator issue)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'document-level source locators must be unique',
  },
  'N-FP-C1 plan/document mismatch -> PLAN_DOCUMENT_MISMATCH (gate)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'a plan built from a different document is rejected at the gate',
  },
  'N-FP-C1 document/report mismatch -> DOCUMENT_REPORT_MISMATCH (projection)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'rejects a document/report fingerprint mismatch instead of stamping A with B identity',
  },
  'N-FP-C2 no bypass around the mandatory gate': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'an invalid ScoreDocumentV1 blocks the fingerprint at the gate',
  },
  'N-FP-C3 hand mapping conflicts -> hand_mapping_conflict': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'handMapping with a duplicate part entry is rejected',
  },
};

function g1Fixture() {
  const result = importMusicXml(G1_XML, { fileName: 'g1_single_voice.musicxml' });
  if (!result.scoreDocument) throw new Error('g1 import failed');
  return { scoreDocument: result.scoreDocument, importReport: result.importReport };
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? '';

describe('acceptance C: reuse map for contract-layer rejections', () => {
  it('reuse anchors exist in the committed tests', () => {
    for (const [item, anchor] of Object.entries(REUSE_MAP)) {
      const source = readFileSync(`D:/123/rhythm-trainer-frontend/${anchor.file}`, 'utf8');
      expect(source.includes(anchor.testTitle), `${item}: anchor missing`).toBe(true);
    }
  });
});

describe('acceptance C: candidate-output rejection with normative codes (harness layer)', () => {
  const okTargets = [
    { scoreEventId: 'plan:p0:a', pitch: 60, measure: 1, targetDurationMs: 750 },
    { scoreEventId: 'plan:p0:b', pitch: 64, measure: 1, targetDurationMs: 750 },
  ];

  it('a clean candidate passes', () => {
    expect(validateCandidateScoreEvents(okTargets)).toBeNull();
  });

  it('duplicate EngineScoreEvent.scoreEventId in one scoring array -> duplicate_target_id', () => {
    const duplicated = [...okTargets, { ...okTargets[0] }];
    expect(validateCandidateScoreEvents(duplicated)).toBe('duplicate_target_id');
  });

  it('out-of-range / non-integer pitch or non-positive duration -> invalid_target_pitch', () => {
    expect(validateCandidateScoreEvents([...okTargets, { scoreEventId: 'x', pitch: 128, measure: 1, targetDurationMs: 1 }]))
      .toBe('invalid_target_pitch');
    expect(validateCandidateScoreEvents([...okTargets, { scoreEventId: 'x', pitch: 60.5, measure: 1, targetDurationMs: 1 }]))
      .toBe('invalid_target_pitch');
    expect(validateCandidateScoreEvents([...okTargets, { scoreEventId: 'x', pitch: 60, measure: 1, targetDurationMs: 0 }]))
      .toBe('invalid_target_pitch');
  });

  it('measure coverage mismatch vs note atoms -> measure_coverage_mismatch', () => {
    expect(validateCandidateScoreEvents(okTargets, { atomBars: [1, 2] })).toBe('measure_coverage_mismatch');
  });

  it('target outside the prescription range -> target_outside_prescription_range', () => {
    expect(validateCandidateScoreEvents(okTargets, { prescriptionRange: { start: 2, end: 3 } }))
      .toBe('target_outside_prescription_range');
  });

  it('server message anchors map to normative codes; anything else is NOT reinterpreted', () => {
    expect(mapServerRejectionToNormativeCode('scoreEvents 目标 ID 重复: plan:p0:a')).toBe('duplicate_target_id');
    expect(mapServerRejectionToNormativeCode('scoreEvents 含非法目标，无法形成可评分计划')).toBe('invalid_target_pitch');
    expect(mapServerRejectionToNormativeCode('scoreEvents 的小节覆盖与 atoms 不一致（scoreEvents: 1 / atoms: 1,2）')).toBe('measure_coverage_mismatch');
    expect(mapServerRejectionToNormativeCode('scoreEvents 超出处方小节范围')).toBe('target_outside_prescription_range');
    // The harness may only map the four frozen anchors — no guessing.
    expect(mapServerRejectionToNormativeCode('some unrelated error')).toBeNull();
    expect(mapServerRejectionToNormativeCode('目标 ID 重复（改写过的锚点文本）')).toBeNull();
  });
});

describe('acceptance C: contract-layer rejections not yet covered elsewhere', () => {
  it('N-ID-C3c: duplicate note@id -> projection throws DUPLICATE_XML_ID (uppercase gate code)', () => {
    const { scoreDocument, importReport } = g1Fixture();
    const doc = JSON.parse(JSON.stringify(scoreDocument));
    doc.parts[0].measures[1].events[0].source.xmlId = doc.parts[0].measures[0].events[0].source.xmlId ?? 'n1';
    doc.parts[0].measures[0].events[0].source.xmlId = doc.parts[0].measures[1].events[0].source.xmlId;
    expect(() => projectScoreDocumentV1(doc, importReport)).toThrowError();
    try {
      projectScoreDocumentV1(doc, importReport);
    } catch (error) {
      expect(codeOf(error)).toBe('DUPLICATE_XML_ID');
    }
  });

  it('same projection entry throws DUPLICATE_EVENT_ID for a duplicated eventId', () => {
    const { scoreDocument, importReport } = g1Fixture();
    const doc = JSON.parse(JSON.stringify(scoreDocument));
    doc.parts[0].measures[1].events[0].id = doc.parts[0].measures[0].events[0].id;
    try {
      projectScoreDocumentV1(doc, importReport);
      throw new Error('expected DUPLICATE_EVENT_ID');
    } catch (error) {
      expect(codeOf(error)).toBe('DUPLICATE_EVENT_ID');
    }
  });

  it('N-ID-C2: the same occurrenceId twice in one plan -> DUPLICATE_OCCURRENCE_ID at payload build', () => {
    const { scoreDocument } = g1Fixture();
    const plan = buildPlaybackPlan(scoreDocument, {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    const tampered = JSON.parse(JSON.stringify(plan));
    tampered.occurrences[1].occurrenceId = tampered.occurrences[0].occurrenceId;
    try {
      buildPlanFingerprintPayloadV1({
        plannerVersion: 'parity-harness-1',
        scoreRevisionId: 'score-revision-v1:sha256:' + '0'.repeat(64),
        normalizerVersion: 'normalizer-1',
        supportProfileVersion: 'musicxml-v1.0',
        partId: 'P1',
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
        hand: 'both',
        handMapping: { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }] }] },
        repeatSelection: { kind: 'none' },
        bpm: { numerator: 80, denominator: 1 },
        ticksPerQuarter: 960,
        countInBeats: { numerator: 4, denominator: 1 },
        plan: tampered,
      });
      throw new Error('expected DUPLICATE_OCCURRENCE_ID');
    } catch (error) {
      expect(codeOf(error)).toBe('DUPLICATE_OCCURRENCE_ID');
    }
  });

  it('N-FP-C4: planner input validation — invalid_range and invalid_repeat_count', () => {
    const { scoreDocument } = g1Fixture();
    const base = { repeatSelection: { kind: 'none' as const }, unsupportedNotationPolicy: 'reject-strict' as const };
    for (const range of [
      { startMeasureOrdinal: 0, endMeasureOrdinal: 2 },
      { startMeasureOrdinal: 2, endMeasureOrdinal: 1 },
      { startMeasureOrdinal: 1, endMeasureOrdinal: 3 },
    ]) {
      try {
        buildPlaybackPlan(scoreDocument, { ...base, range });
        throw new Error('expected invalid_range');
      } catch (error) {
        expect(codeOf(error)).toBe('invalid_range');
      }
    }
    for (const count of [0, 33]) {
      try {
        buildPlaybackPlan(scoreDocument, {
          range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
          repeatSelection: { kind: 'range-loop', count },
          unsupportedNotationPolicy: 'reject-strict',
        });
        throw new Error('expected invalid_repeat_count');
      } catch (error) {
        expect(codeOf(error)).toBe('invalid_repeat_count');
      }
    }
  });

  it('N-FP-C4: empty plan -> gate PAYLOAD_VALIDATION_FAILED (underlying issue empty_plan)', () => {
    // G3 with range m2..m2: the only notated note in range is a tie
    // CONTINUATION (span start lives in m1), so the plan legitimately has
    // zero occurrences (frozen semantics, parity case G3-range-m2).
    const xml = readFileSync('D:/123/audit-r1/fixtures/g3_tie_across_bar.musicxml', 'utf8');
    const imported = importMusicXml(xml, { fileName: 'g3_tie_across_bar.musicxml' });
    if (!imported.scoreDocument) throw new Error('g3 import failed');
    const { scoreDocument, importReport } = imported;
    const plan = buildPlaybackPlan(scoreDocument, {
      range: { startMeasureOrdinal: 2, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' },
      unsupportedNotationPolicy: 'reject-strict',
    }).plan!;
    expect(plan.occurrences).toHaveLength(0);
    expect(plan.issues.some((issue) => issue.code === 'no_playable_notes' && issue.blocksStrict)).toBe(true);
    try {
      planFingerprintV1({
        document: scoreDocument,
        report: importReport,
        plan,
        plannerVersion: 'parity-harness-1',
        partId: 'P1',
        range: { startMeasureOrdinal: 2, endMeasureOrdinal: 2 },
        hand: 'both',
        handMapping: { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }] }] },
        repeatSelection: { kind: 'none' },
        bpm: { numerator: 120, denominator: 1 },
        ticksPerQuarter: 960,
        countInBeats: { numerator: 4, denominator: 1 },
      });
      throw new Error('expected PAYLOAD_VALIDATION_FAILED');
    } catch (error) {
      expect(codeOf(error)).toBe('PAYLOAD_VALIDATION_FAILED');
      expect((error as Error).message).toMatch(/empty_plan/);
    }
  });

  it('N-PITCH-C2: microtonal alter is rejected upstream by the importer (unrepresentable_pitch, blocks strict)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
    const result = importMusicXml(xml, { fileName: 'microtonal.musicxml' });
    // Layer: UPSTREAM importer — the note never reaches a plan or fingerprint.
    expect(result.importReport.issues.some((issue) => issue.code === 'unrepresentable_pitch' && issue.blocksStrict))
      .toBe(true);
  });
});
