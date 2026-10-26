import { describe, expect, it } from 'vitest';
import { buildScoreRangeBriefing } from './scoreBriefing';
import type { ScoreDocument as EngineScoreDocument, ScoreEvent, ScoreMeasure, ScorePart } from '../../score-engine/domain/types';

function noteEvent(measure: number, ordinal: number, midi: number | null, spelling: string, staff = 1): ScoreEvent {
  return {
    id: `m${measure}-e${ordinal}`,
    kind: midi === null ? 'rest' : 'note',
    source: { partId: 'P1', measureOrdinal: measure, staffNumber: staff, sourceOrdinal: ordinal },
    onsetBeat: { numerator: ordinal, denominator: 4 },
    durationBeat: { numerator: 1, denominator: 4 },
    dots: 0,
    ...(midi === null ? {} : { pitch: { step: 'C' as const, alter: 0, octave: 4, midiNote: midi, spelling } }),
    tieStart: false,
    tieStop: false,
    tiedStart: false,
    tiedStop: false,
    isGrace: false,
    isCue: false,
    articulations: [],
    capabilities: [],
  };
}

function measure(ordinal: number, events: ReturnType<typeof noteEvent>[]): ScoreMeasure {
  return {
    ordinal,
    implicit: false,
    startBeat: { numerator: (ordinal - 1) * 4, denominator: 4 },
    durationBeat: { numerator: 4, denominator: 4 },
    attributes: {
      divisions: 4,
      time: { beats: 4, beatType: 4 },
      key: { fifths: 0, mode: 'major' },
      staves: 2,
      clefs: [],
    },
    events,
    barlines: [],
    tempoMarks: [],
    capabilities: [],
  };
}

function engine(measures: ScoreMeasure[]): EngineScoreDocument {
  const part: ScorePart = { id: 'P1', name: 'P1', staves: 2, measures, voices: [] } as unknown as ScorePart;
  return {
    schemaVersion: 1, parserVersion: 'test', supportProfileVersion: 'test', fingerprint: 'fp',
    workTitle: 't', composer: '', source: {} as EngineScoreDocument['source'],
    parts: [part], tieSpans: [], tempoMarks: [], capabilities: [], strictAllowed: true,
  };
}

describe('buildScoreRangeBriefing', () => {
  const measures = [
    measure(1, [noteEvent(1, 1, 60, 'C4'), noteEvent(1, 2, 64, 'E4'), noteEvent(1, 3, null, 'rest')]),
    measure(2, [
      noteEvent(2, 1, 67, 'G4', 1),
      noteEvent(2, 2, 55, 'G3', 2),
      noteEvent(2, 3, 72, 'C5', 1),
      noteEvent(2, 4, 50, 'D3', 2),
    ]),
    measure(3, [noteEvent(3, 1, null, 'rest')]),
  ];

  it('summarizes notes, staff split, pitch span and busiest measure inside the range', () => {
    const briefing = buildScoreRangeBriefing(engine(measures), { startMeasure: 1, endMeasure: 3 });
    expect(briefing.keySignature).toBe('C 大调');
    expect(briefing.timeSignature).toBe('4/4');
    expect(briefing.noteCount).toBe(6);
    expect(briefing.restCount).toBe(2);
    expect(briefing.lowestSpelling).toBe('D3');
    expect(briefing.highestSpelling).toBe('C5');
    expect(briefing.staffCounts).toEqual([{ staff: 1, notes: 4 }, { staff: 2, notes: 2 }]);
    expect(briefing.busiestMeasure).toEqual({ measure: 2, notes: 4 });
    expect(briefing.measuresWithNotes).toBe(2);
    expect(briefing.totalMeasures).toBe(3);
  });

  it('restricts facts to the requested measure range', () => {
    const briefing = buildScoreRangeBriefing(engine(measures), { startMeasure: 2, endMeasure: 2 });
    expect(briefing.noteCount).toBe(4);
    expect(briefing.busiestMeasure).toEqual({ measure: 2, notes: 4 });
    expect(briefing.totalMeasures).toBe(1);
  });

  it('stays empty for an out-of-score range instead of inventing facts', () => {
    const briefing = buildScoreRangeBriefing(engine(measures), { startMeasure: 9, endMeasure: 12 });
    expect(briefing.noteCount).toBe(0);
    expect(briefing.lowestSpelling).toBeNull();
    expect(briefing.busiestMeasure).toBeNull();
    expect(briefing.totalMeasures).toBe(0);
  });
});
