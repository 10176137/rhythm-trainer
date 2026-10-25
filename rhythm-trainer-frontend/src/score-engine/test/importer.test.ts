import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { beatToString } from '../domain/rational';
import { importMusicXml } from '../import/musicxml-importer';
import { toLegacyScoreDocument, applyHandMappingToLegacyNotes } from '../legacy-bridge';
import { buildUserHandMapping } from '../scope/practice-scope';
import { buildPlaybackPlan, buildScoreOccurrences, scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import { buildTempoMap } from '../playback/tempo-map';
import type { ScoreDocument } from '../domain/types';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/golden.expected.json', import.meta.url), 'utf8'),
) as Record<string, any>;
const expectedPiano = JSON.parse(
  readFileSync(new URL('./fixtures/piano-two-staff-basic.expected.json', import.meta.url), 'utf8'),
);

function pitchString(note: any): string {
  return note.pitch?.spelling;
}

function normalizeNote(note: any) {
  return {
    xmlId: note.source?.xmlId,
    pitch: note.pitch?.spelling,
    onset: beatToString(note.onsetBeat),
    duration: beatToString(note.durationBeat),
    voice: note.source?.voiceId,
    staff: note.source?.staffNumber,
    chordGroup: Boolean(note.chordGroupId),
    tieStart: note.tieStart,
    tieStop: note.tieStop,
  };
}

function topLevelDoc(name: string): ScoreDocument {
  const result = importMusicXml(fixture(name), { fileName: name });
  if (!result.scoreDocument) throw new Error(`${name} did not import: ${result.importReport.status}`);
  return result.scoreDocument;
}

/** Two-staff score whose second staff switches to a treble clef in measure 2. */
const clefCarryXml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
        <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note>
        <backup><duration>4</duration></backup>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice><type>whole</type><staff>2</staff></note>
      </measure>
      <measure number="2"><attributes><clef number="2"><sign>G</sign><line>2</line></clef></attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>2</staff></note>
      </measure>
      <measure number="3"><attributes><clef number="1"><sign>F</sign><line>4</line></clef></attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>2</staff></note>
      </measure>
    </part></score-partwise>`;

describe('MusicXML importer golden contracts', () => {
  for (const [name, expected] of Object.entries(golden)) {
    it(`imports ${name} with the expected semantic contract`, () => {
      const result = importMusicXml(fixture(name), { fileName: name });
      expect(result.importReport.status).toBe(expected.status);
      expect(result.importReport.strictAllowed).toBe(expected.strictAllowed);
      for (const code of expected.issueCodes ?? []) {
        expect(result.importReport.issues.map((issue) => issue.code)).toContain(code);
      }
      for (const [key, value] of Object.entries(expected.counts ?? {})) {
        expect(result.importReport.counts[key as keyof typeof result.importReport.counts]).toBe(value);
      }
      if (expected.status === 'REJECTED') {
        expect(result.scoreDocument).toBeUndefined();
        return;
      }
      const doc = result.scoreDocument!;
      const notes = doc.parts.flatMap((part) => part.measures.flatMap((measure) => measure.events))
        .filter((event) => event.kind === 'note');
      expect(notes).toHaveLength(expected.counts.noteCount);
      if (expected.measures) {
        const measures = doc.parts[0].measures;
        expected.measures.forEach((measure: any, index: number) => {
          expect(beatToString(measures[index].startBeat)).toBe(measure.start);
          expect(beatToString(measures[index].durationBeat)).toBe(measure.duration);
          if (measure.time) expect(`${measures[index].attributes.time.beats}/${measures[index].attributes.time.beatType}`).toBe(measure.time);
          if (measure.fifths !== undefined) expect(measures[index].attributes.key.fifths).toBe(measure.fifths);
          if (measure.implicit !== undefined) expect(measures[index].implicit).toBe(measure.implicit);
        });
      }
      if (expected.expectedFile) {
        expect(notes).toHaveLength(expectedPiano.expectedEvents.length);
        expect(notes.map(pitchString)).toEqual(expectedPiano.expectedEvents.map((event: any) => event.pitch));
        expect(notes.map((note) => beatToString(note.onsetBeat))).toEqual(expectedPiano.expectedEvents.map((event: any) => event.onsetBeat));
        expect(notes.map((note) => beatToString(note.durationBeat))).toEqual(expectedPiano.expectedEvents.map((event: any) => event.durationBeat));
        expect(notes.map((note) => note.source.staffNumber)).toEqual(expectedPiano.expectedEvents.map((event: any) => event.staff));
        expect(notes.map((note) => note.source.voiceId)).toEqual(expectedPiano.expectedEvents.map((event: any) => event.voice));
      } else if (expected.notes) {
        expect(notes.map(normalizeNote)).toEqual(expected.notes.map((note: any) => ({
          xmlId: note.xmlId,
          pitch: note.pitch,
          onset: note.onset,
          duration: note.duration,
          voice: note.voice,
          staff: note.staff,
          chordGroup: Boolean(note.chordGroup),
          tieStart: Boolean(note.tieStart),
          tieStop: Boolean(note.tieStop),
        })));
      }
      if (expected.tieSpans) {
        expect(doc.tieSpans).toHaveLength(expected.tieSpans.length);
        doc.tieSpans.forEach((span, index) => {
          expect(span.pitchKey).toBe(expected.tieSpans[index].pitchKey);
          expect(beatToString(span.startBeat)).toBe(expected.tieSpans[index].startBeat);
          expect(beatToString(span.endBeat)).toBe(expected.tieSpans[index].endBeat);
          expect(span.eventIds).toHaveLength(expected.tieSpans[index].eventCount);
        });
      }
      if (expected.timeline) {
        const measureCount = Math.max(...doc.parts.map((part) => part.measures.length));
        const plan = buildPlaybackPlan(doc, {
          range: { startMeasureOrdinal: 1, endMeasureOrdinal: measureCount },
          repeatSelection: { kind: 'none' },
          unsupportedNotationPolicy: 'reject-strict',
        });
        expect(plan.plan).toBeDefined();
        const occurrences = buildScoreOccurrences(
          plan.plan!,
          buildTempoMap({ bpm: 80, timeOrigin: 'playback-start' }),
        ).occurrences;
        expect(occurrences.map((item) => beatToString(item.beat)))
          .toEqual(expected.timeline.map((item: any) => item.beat));
        expected.timeline.forEach((item: any, index: number) => {
          expect(occurrences[index].atMs).toBeCloseTo(item.atMs, 6);
          if (item.pitches) {
            expect(occurrences[index].pitches.map((pitch) => pitch.spelling).sort())
              .toEqual([...item.pitches].sort());
          }
          if (item.durationMs !== undefined) expect(occurrences[index].durationMs).toBeCloseTo(item.durationMs, 6);
        });
      }
    });
  }
});

describe('MusicXML importer boundaries and determinism', () => {
  it('rejects unsafe or unsupported file forms with stable codes', () => {
    const timewise = importMusicXml('<score-timewise version="4.0"><part/></score-timewise>', { fileName: 'a.xml' });
    expect(timewise.importReport.status).toBe('REJECTED');
    expect(timewise.importReport.issues[0].code).toBe('unsupported_score_timewise');
    const mxl = importMusicXml('<score-partwise/>', { fileName: 'a.mxl' });
    expect(mxl.importReport.issues[0].code).toBe('unsupported_compressed_musicxml');
    const txt = importMusicXml('<score-partwise/>', { fileName: 'a.txt' });
    expect(txt.importReport.issues[0].code).toBe('unsupported_extension');
    const entity = importMusicXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///x">]><score-partwise/>', { fileName: 'a.xml' });
    expect(entity.importReport.issues[0].code).toBe('xml_external_entity_disabled');
    const tooLarge = importMusicXml('<score-partwise/>', { fileName: 'a.xml', maxBytes: 2 });
    expect(tooLarge.importReport.issues[0].code).toBe('file_too_large');
  });

  it('is deterministic for fingerprint, event ids and playback plan ids', () => {
    const xml = fixture('piano-two-staff-basic.musicxml');
    const first = importMusicXml(xml, { fileName: 'piano-two-staff-basic.musicxml' });
    const second = importMusicXml(xml, { fileName: 'piano-two-staff-basic.musicxml' });
    expect(first.importReport.fingerprint).toBe(second.importReport.fingerprint);
    expect(first.scoreDocument!.parts[0].measures[0].events.map((event) => event.id))
      .toEqual(second.scoreDocument!.parts[0].measures[0].events.map((event) => event.id));
    const request = {
      range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
      repeatSelection: { kind: 'none' as const },
      unsupportedNotationPolicy: 'reject-strict' as const,
    };
    const a = buildPlaybackPlan(first.scoreDocument!, request);
    const b = buildPlaybackPlan(second.scoreDocument!, request);
    expect(a.plan!.planId).toBe(b.plan!.planId);
    expect(a.plan!.occurrences.map((item) => item.occurrenceId)).toEqual(b.plan!.occurrences.map((item) => item.occurrenceId));
  });

  it('rejects invalid chord anchors and duration overflow without strict claims', () => {
    const chord = importMusicXml(fixture('invalid-chord-anchor.musicxml'), { fileName: 'invalid-chord-anchor.musicxml' });
    expect(chord.importReport.status).toBe('DISPLAY_ONLY');
    expect(chord.importReport.strictAllowed).toBe(false);
    expect(chord.importReport.issues.map((issue) => issue.code)).toContain('invalid_chord_anchor');
    const overflow = importMusicXml(fixture('duration-overflow.musicxml'), { fileName: 'duration-overflow.musicxml' });
    expect(overflow.importReport.status).toBe('DISPLAY_ONLY');
    expect(overflow.importReport.issues.map((issue) => issue.code)).toContain('duration_out_of_measure');
  });
});

describe('Playback plan and TempoMap acceptance', () => {
  const doc = topLevelDoc('piano-two-staff-basic.musicxml');
  const request = {
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
    repeatSelection: { kind: 'none' as const },
    unsupportedNotationPolicy: 'reject-strict' as const,
  };

  it('keeps both hands on one onset group and target order', () => {
    const plan = buildPlaybackPlan(doc, request).plan!;
    expect(plan.groups.map((group) => beatToString(group.playbackBeat))).toEqual([
      '0/1', '1/1', '2/1', '3/1', '4/1', '5/1', '6/1', '7/1',
    ]);
    expect(plan.groups[0].scoreEventIds).toHaveLength(2);
    expect(plan.groups[0].pitches.map((pitch) => pitch.spelling)).toEqual(['C4', 'C3']);
    const atoms = scoreOccurrencesToEngineAtoms(plan);
    expect(atoms.issues).toEqual([]);
    expect(atoms.atoms.map((atom) => atom.startTick)).toEqual([0, 960, 1920, 2880, 3840, 4800, 5760, 6720]);
  });

  it('changes target milliseconds with BPM but never music beats', () => {
    const plan = buildPlaybackPlan(doc, request).plan!;
    const at40 = buildScoreOccurrences(plan, buildTempoMap({ bpm: 40, timeOrigin: 'playback-start' })).occurrences;
    const at80 = buildScoreOccurrences(plan, buildTempoMap({ bpm: 80, timeOrigin: 'playback-start' })).occurrences;
    const at120 = buildScoreOccurrences(plan, buildTempoMap({ bpm: 120, timeOrigin: 'playback-start' })).occurrences;
    expect(at80.map((item) => beatToString(item.beat))).toEqual(at40.map((item) => beatToString(item.beat)));
    expect(at80.map((item) => beatToString(item.beat))).toEqual(at120.map((item) => beatToString(item.beat)));
    expect(at40[1].atMs).toBeCloseTo(1500);
    expect(at80[1].atMs).toBeCloseTo(750);
    expect(at120[1].atMs).toBeCloseTo(500);
  });

  it('assigns unique occurrence IDs per loop pass while retaining scoreEventId', () => {
    const plan = buildPlaybackPlan(doc, {
      ...request,
      repeatSelection: { kind: 'range-loop', count: 3 },
    }).plan!;
    expect(plan.occurrences).toHaveLength(36);
    expect(new Set(plan.occurrences.map((item) => item.occurrenceId)).size).toBe(36);
    expect(plan.occurrences.filter((item) => item.passIndex === 0).map((item) => item.scoreEventId))
      .toEqual(plan.occurrences.filter((item) => item.passIndex === 1).map((item) => item.scoreEventId));
    expect(plan.groups).toHaveLength(24);
  });

  it('does not create a new onset for a tie continuation and extends the tie onset', () => {
    const tieDoc = topLevelDoc('tie-across-measure.musicxml');
    const plan = buildPlaybackPlan(tieDoc, request).plan!;
    expect(plan.groups.map((group) => beatToString(group.playbackBeat))).toEqual(['2/1', '3/1', '5/1']);
    const tieGroup = plan.groups.find((group) => beatToString(group.playbackBeat) === '3/1')!;
    expect(tieGroup.scoreEventIds).toHaveLength(1);
    expect(beatToString(tieGroup.durationBeat)).toBe('2/1');
    const occurrences = buildScoreOccurrences(plan, buildTempoMap({ bpm: 80, timeOrigin: 'playback-start' })).occurrences;
    expect(occurrences.find((item) => beatToString(item.beat) === '3/1')!.durationMs).toBe(1500);
  });

  it('groups multi-voice notes at the same beat and supports chord pitch sets', () => {
    const multi = topLevelDoc('multi-voice-backup-forward.musicxml');
    const plan = buildPlaybackPlan(multi, { ...request, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 } }).plan!;
    expect(plan.groups).toHaveLength(4);
    expect(plan.groups[1].pitches.map((pitch) => pitch.spelling)).toEqual(['D4', 'G3']);
    const chord = topLevelDoc('triad-chord.musicxml');
    const chordPlan = buildPlaybackPlan(chord, { ...request, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 } }).plan!;
    expect(chordPlan.groups[0].pitches.map((pitch) => pitch.spelling)).toEqual(['C4', 'E4', 'G4']);
    expect(chordPlan.groups[0].scoreEventIds).toHaveLength(3);
  });

  it('blocks strict scoring for unsupported repeat/tempo semantics', () => {
    const docWithRepeat = topLevelDoc('unsupported-repeat-tempo-curve.musicxml');
    const plan = buildPlaybackPlan(docWithRepeat, { ...request, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 } });
    expect(plan.strictAllowed).toBe(false);
    expect(plan.issues.map((issue) => issue.code)).toContain('score_not_strict_ready');
  });

  it('selects a measure range and rejects invalid ranges', () => {
    const plan = buildPlaybackPlan(doc, {
      ...request,
      range: { startMeasureOrdinal: 2, endMeasureOrdinal: 2 },
    }).plan!;
    expect(plan.groups).toHaveLength(4);
    expect(plan.groups[0].pitches.map((pitch) => pitch.spelling)).toEqual(['G4', 'C3']);
    expect(() => buildPlaybackPlan(doc, {
      ...request,
      range: { startMeasureOrdinal: 2, endMeasureOrdinal: 1 },
    })).toThrow(/小节范围非法/);
  });
});

describe('capability and tie/tied separation', () => {
  it('keeps sound tie and notation tied marks separate', () => {
    const doc = topLevelDoc('tie-across-measure.musicxml');
    const notes = doc.parts[0].measures.flatMap((measure) => measure.events);
    const start = notes.find((event) => event.source.xmlId === 'tie-start')!;
    const stop = notes.find((event) => event.source.xmlId === 'tie-stop')!;
    expect(start.tieStart).toBe(true);
    expect(start.tiedStart).toBe(true);
    expect(stop.tieStop).toBe(true);
    expect(stop.tiedStop).toBe(true);
  });

  it('does not treat grace notes as strict targets and flags microtones', () => {
    const graceXml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><grace/><pitch><step>C</step><octave>4</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type><staff>1</staff></note></measure></part></score-partwise>`;
    const grace = importMusicXml(graceXml, { fileName: 'grace.musicxml' });
    expect(grace.importReport.status).toBe('DISPLAY_ONLY');
    expect(grace.importReport.capabilities).toContain('grace');
    expect(grace.scoreDocument!.parts[0].measures[0].events.some((event) => event.isGrace)).toBe(true);
    const microXml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>whole</type><staff>1</staff></note></measure></part></score-partwise>`;
    const micro = importMusicXml(microXml, { fileName: 'micro.musicxml' });
    expect(micro.importReport.status).toBe('DISPLAY_ONLY');
    expect(micro.importReport.capabilities).toContain('microtone');
    expect(micro.scoreDocument!.parts[0].measures[0].events[0].pitch!.midiNote).toBeNull();
  });
});

describe('per-staff clef changes', () => {
  it('carries the other staff clef forward when only one staff changes', () => {
    const xml = clefCarryXml;
    const result = importMusicXml(xml, { fileName: 'clef-carry.musicxml' });
    expect(result.scoreDocument).toBeTruthy();
    const measures = result.scoreDocument!.parts[0].measures;
    const clefs = measures[2].attributes.clefs.map((clef) => `${clef.staffNumber}:${clef.sign}${clef.line}`).sort();
    expect(clefs).toEqual(['1:F4', '2:G2']);
  });

  it('keeps staff 2 on the left hand even when its clef is treble', () => {
    const result = importMusicXml(clefCarryXml, { fileName: 'clef-carry.musicxml' });
    if (!result.scoreDocument) throw new Error('fixture did not import');
    const doc = toLegacyScoreDocument(result.scoreDocument, result.importReport, 'clef-carry.musicxml');
    const measure2 = doc.notes.filter((note) => note.bar === 2);
    const measure3 = doc.notes.filter((note) => note.bar === 3);
    expect(measure2).toHaveLength(1);
    expect(measure2[0].staff).toBe('treble'); // notation staff still follows the clef
    expect(measure2[0].hand).toBe('left');    // display hand follows the staff
    expect(measure3[0].hand).toBe('left');
  });

  it('lets the explicit user mapping override the staff default', () => {
    const result = importMusicXml(clefCarryXml, { fileName: 'clef-carry.musicxml' });
    if (!result.scoreDocument) throw new Error('fixture did not import');
    const engine = result.scoreDocument;
    const doc = toLegacyScoreDocument(engine, result.importReport, 'clef-carry.musicxml');
    const mapping = buildUserHandMapping('P1', [
      { staffNumber: 1, hand: 'left' },
      { staffNumber: 2, hand: 'right' },
    ]);
    const mapped = applyHandMappingToLegacyNotes(doc.notes, engine, mapping);
    expect(mapped.filter((note) => note.bar === 2 || note.bar === 3).every((note) => note.hand === 'right')).toBe(true);
    expect(mapped.find((note) => note.bar === 1 && note.staff === 'bass')?.hand).toBe('right');
    // The source notes are not mutated; the helper returns new objects only
    // where the mapping changed the hand.
    expect(doc.notes.filter((note) => note.bar === 2 || note.bar === 3).every((note) => note.hand === 'left')).toBe(true);
  });
});

describe('measure timeline metadata for the score view', () => {
  it('exposes each measure meter and start beat instead of a single 4/4 assumption', () => {
    const result = importMusicXml(fixture('time-key-change.musicxml'), { fileName: 'time-key-change.musicxml' });
    if (!result.scoreDocument) throw new Error('fixture did not import');
    const doc = toLegacyScoreDocument(result.scoreDocument, result.importReport, 'time-key-change.musicxml');
    expect(doc.meta.measures?.map((measure) => [
      measure.bar, measure.startBeat, measure.durationBeats, measure.beats, measure.beatType, measure.keyFifths,
    ])).toEqual([
      [1, 0, 4, 4, 4, 0],
      [2, 4, 3, 3, 4, 1],
    ]);
  });
});
