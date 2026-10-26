// Score-fact briefing for teaching steps. This is PRESENTATION of the parsed
// score only: counts, spans and staff distribution for the step's measure
// range. It makes no teaching decision — remediation/step selection stays in
// the Node orchestrator.

import type { ScoreDocument as EngineScoreDocument } from '../../score-engine/domain/types';

export interface ScoreRangeBriefing {
  keySignature: string | null;
  timeSignature: string | null;
  noteCount: number;
  restCount: number;
  /** Written spellings of the range's lowest/highest playable pitches. */
  lowestSpelling: string | null;
  highestSpelling: string | null;
  /** Note counts per notated staff (谱表 1 = 上方谱表, 谱表 2 = 下方谱表). */
  staffCounts: Array<{ staff: number; notes: number }>;
  busiestMeasure: { measure: number; notes: number } | null;
  measuresWithNotes: number;
  totalMeasures: number;
}

function toDisplayBeat(beats: number, beatType: number): string {
  return `${beats}/${beatType}`;
}

/** Same display mapping as legacy-bridge's key label (kept local: display only). */
function keyDisplay(fifths: number, mode: string): string {
  const major = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
  const flatMajor = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭'];
  const minor = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
  const flatMinor = ['A', 'D', 'G', 'C', 'F', 'B♭', 'E♭', 'A♭'];
  const index = Math.min(7, Math.abs(Math.trunc(fifths)));
  if (mode === 'minor') return `${fifths >= 0 ? minor[index] : flatMinor[index]} 小调`;
  return `${fifths >= 0 ? major[index] : flatMajor[index]} 大调`;
}

export function buildScoreRangeBriefing(
  engine: EngineScoreDocument,
  range: { startMeasure: number; endMeasure: number },
): ScoreRangeBriefing {
  const measures = (engine.parts[0]?.measures ?? [])
    .filter((measure) => measure.ordinal >= range.startMeasure && measure.ordinal <= range.endMeasure);

  let noteCount = 0;
  let restCount = 0;
  let lowest: { midi: number; spelling: string } | null = null;
  let highest: { midi: number; spelling: string } | null = null;
  const staffTally = new Map<number, number>();
  let busiest: { measure: number; notes: number } | null = null;
  let measuresWithNotes = 0;
  let keySignature: string | null = null;
  let timeSignature: string | null = null;

  for (const measure of measures) {
    if (keySignature === null && measure.attributes.key) {
      keySignature = keyDisplay(measure.attributes.key.fifths, measure.attributes.key.mode);
    }
    if (timeSignature === null && measure.attributes.time) {
      timeSignature = toDisplayBeat(measure.attributes.time.beats, measure.attributes.time.beatType);
    }
    let measureNotes = 0;
    for (const event of measure.events) {
      if (event.kind !== 'note' || event.isGrace) continue;
      noteCount += 1;
      measureNotes += 1;
      const staff = event.source.staffNumber;
      staffTally.set(staff, (staffTally.get(staff) ?? 0) + 1);
      const midi = event.pitch?.midiNote;
      if (midi != null) {
        const spelling = event.pitch?.spelling ?? String(midi);
        if (lowest === null || midi < lowest.midi) lowest = { midi, spelling };
        if (highest === null || midi > highest.midi) highest = { midi, spelling };
      }
    }
    for (const event of measure.events) {
      if (event.kind === 'rest' && !event.isGrace) restCount += 1;
    }
    if (measureNotes > 0) {
      measuresWithNotes += 1;
      if (busiest === null || measureNotes > busiest.notes) {
        busiest = { measure: measure.ordinal, notes: measureNotes };
      }
    }
  }

  return {
    keySignature,
    timeSignature,
    noteCount,
    restCount,
    lowestSpelling: lowest?.spelling ?? null,
    highestSpelling: highest?.spelling ?? null,
    staffCounts: [...staffTally.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([staff, notes]) => ({ staff, notes })),
    busiestMeasure: busiest,
    measuresWithNotes,
    totalMeasures: measures.length,
  };
}
