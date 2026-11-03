import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { importMusicXml } from '../src/score-engine/import/musicxml-importer';
import { projectScoreDocumentV1, validateScoreDocumentV1 } from '../src/score-engine/contract-v1/plan-fingerprint';
import { applyPlanNoteRange } from './plan-note-range.mjs';
import { createPlannerService } from './planner-service.mjs';
import { toPlaybackPlan, rangeSpanFromDocument } from '../src/score-engine/plan/rust-plan';
import { assertPracticePlanBundle, buildPracticePlanBundleFromRust } from '../src/score-engine/plan/practice-plan-bundle';

const native = createRequire(import.meta.url)('../../rhythm-trainer-core-v0.2/bindings/node');
const service = createPlannerService({ authority: 'rust', nativeModule: native });
const note = (id: string, step: string, duration: number, tie: string, chord = false) => `<note id="${id}">${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice><type>quarter</type>${tie}</note>`;
const XML = `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${note('a', 'C', 1, '<tie type="start"/>')}${note('b', 'C', 1, '<tie type="stop"/><tie type="start"/>')}${note('c', 'C', 1, '<tie type="stop"/>')}${note('d', 'D', 1, '')}${note('chord', 'F', 1, '', true)}</measure></part></score-partwise>`;
const imported = importMusicXml(XML);
const source = imported.scoreDocument!;
const document = projectScoreDocumentV1(source, imported.importReport).dto;
const config = { partId: 'P1', range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 }, repeatSelection: { kind: 'none' }, hand: 'both',
  handMapping: { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }] }] },
  bpm: { numerator: 60, denominator: 1 }, ticksPerQuarter: 960, countInUs: 3000000, unsupportedNotationPolicy: 'reject-strict' };
const id = (xmlId: string) => source.parts[0].measures[0].events.find((event) => event.source.xmlId === xmlId)!.id;

describe('server-owned note selection with real Rust planning and fingerprint gate', () => {
  it.each([['d', 'd', 0], ['b', 'c', 1], ['a', 'b', 1], ['b', 'b', 0]])('supports cutting ties at %s–%s', (start, end, spans) => {
    const selection = { startEventId: id(start), endEventId: id(end) };
    const refined = applyPlanNoteRange(document, selection, config);
    expect(validateScoreDocumentV1(refined)).toEqual([]);
    expect(refined.tieSpans).toHaveLength(spans);
    const response = service.buildRustPlan({ document, report: imported.importReport, config, mode: 'timeline', noteRange: selection });
    expect(response.planFingerprint).toBeTruthy();
    expect(response.strictAllowed).toBe(true);
    // The browser validates against the untouched semantic source. Moving
    // selection to Node must preserve that frozen launch integrity check.
    const parsed = toPlaybackPlan(response, { range: config.range, repeatSelection: { kind: 'none' }, ...rangeSpanFromDocument(source.parts[0].measures, config.range) });
    expect(() => assertPracticePlanBundle(buildPracticePlanBundleFromRust({ response, plan: parsed.plan,
      config: { ...config, modeId: 'score', advanceMode: 'timeline', plannerVersion: response.plannerVersion },
      fingerprint: { document: source, report: imported.importReport, partId: 'P1' } }))).not.toThrow();
    expect(response.plan.occurrences[0].scoreEventId).toBe(id(start));
    if (start === 'd') expect(response.plan.occurrences.map((event) => event.scoreEventId)).toEqual([id('d'), id('chord')]);
    expect(document.tieSpans).toHaveLength(1);
    expect(source.parts[0].measures[0].events).toHaveLength(5);
  });
  it('rejects foreign IDs, unknown selection fields and conflicting bar ranges', () => {
    expect(() => applyPlanNoteRange(document, { startEventId: 'foreign', endEventId: id('d') }, config)).toThrow('当前乐谱');
    expect(() => applyPlanNoteRange(document, { startEventId: id('a'), endEventId: id('d'), extra: 1 } as never, config)).toThrow('两个有效');
    expect(() => applyPlanNoteRange(document, { startEventId: id('a'), endEventId: id('d') }, { ...config, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 } })).toThrow('小节范围');
  });
});
