import type {
  ScoreDocument as EngineScoreDocument,
  ImportReport,
} from './domain/types';
import type {
  ScoreDocument as LegacyScoreDocument,
  ScoreMeta,
  ScoreNote,
  ScoreStaff,
  ScoreNoteType,
} from '../core/sampleScore';
import { toNumber } from './domain/rational';
import type { HandMappingV1 } from './scope/practice-scope';

function formatLegacyPitch(step: string, alter: number, octave: number): string {
  const accidental = alter === 0 ? '' : alter > 0 ? '♯'.repeat(alter) : '♭'.repeat(-alter);
  return `${step}${accidental}${octave}`;
}

function keyLabel(fifths: number, mode: string): string {
  const major = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
  const flatMajor = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭'];
  const minor = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
  const flatMinor = ['A', 'D', 'G', 'C', 'F', 'B♭', 'E♭', 'A♭'];
  const index = Math.min(7, Math.abs(fifths));
  if (mode === 'minor') return `${fifths >= 0 ? minor[index] : flatMinor[index]} 小调`;
  return `${fifths >= 0 ? major[index] : flatMajor[index]} 大调`;
}

function legacyNoteType(type: string | undefined, durationBeats: number): ScoreNoteType {
  if (type === 'whole' || type === 'half' || type === 'quarter' || type === 'eighth' || type === '16th') return type;
  if (durationBeats >= 4) return 'whole';
  if (durationBeats >= 2) return 'half';
  if (durationBeats >= 1) return 'quarter';
  if (durationBeats >= 0.5) return 'eighth';
  return '16th';
}

/**
 * Converts the semantic document into the existing React/custom-SVG view model.
 * This bridge is display-only; practice targets now come from buildPlaybackPlan
 * over `engine`, so ties/chords/rests are not re-derived here.
 */
export function toLegacyScoreDocument(
  engine: EngineScoreDocument,
  report: ImportReport,
  sourceFile: string,
  integration: 'fixture' | 'imported' = 'imported',
): LegacyScoreDocument {
  const notes: ScoreNote[] = [];
  const tieSpanFor = (eventId: string) => engine.tieSpans.find((span) => span.eventIds.includes(eventId));

  for (const part of engine.parts) {
    for (const measure of part.measures) {
      const clefFor = (staffNumber: number): ScoreStaff => {
        const clef = measure.attributes.clefs.find((entry) => entry.staffNumber === staffNumber)
          ?? measure.attributes.clefs.find((entry) => entry.staffNumber === 1);
        return clef?.sign === 'F' ? 'bass' : 'treble';
      };
      for (const event of measure.events) {
        if (event.kind !== 'note' || !event.pitch || event.pitch.midiNote === null) continue;
        const staff = clefFor(event.source.staffNumber);
        // Hand is NOT a clef fact: a left-hand part can switch to a treble
        // clef mid-score. The piano staff convention is the display default;
        // the user's explicit staff→hand mapping overrides it below.
        const hand = event.source.staffNumber > 1 ? 'left' : 'right';
        const span = event.tieSpanId ? tieSpanFor(event.id) : undefined;
        const continuation = Boolean(span && span.eventIds[0] !== event.id);
        const durationBeats = toNumber(event.durationBeat);
        notes.push({
          id: event.id,
          midiNote: event.pitch.midiNote,
          noteName: formatLegacyPitch(event.pitch.step, event.pitch.alter, event.pitch.octave),
          step: event.pitch.step,
          alter: event.pitch.alter,
          octave: event.pitch.octave,
          hand,
          staff,
          voice: Number(event.source.voiceId) || 1,
          beat: toNumber(event.onsetBeat),
          bar: event.source.measureOrdinal,
          durationBeats,
          noteType: legacyNoteType(event.notatedType, durationBeats),
          isTieContinuation: continuation,
          isGrace: event.isGrace,
          isCue: event.isCue,
          tieSpanId: event.tieSpanId,
        });
      }
    }
  }

  const referencePart = engine.parts[0];
  const firstMeasure = referencePart?.measures[0];
  const timeSignature: [number, number] = firstMeasure
    ? [firstMeasure.attributes.time.beats, firstMeasure.attributes.time.beatType]
    : [4, 4];
  const staff1Clef = firstMeasure?.attributes.clefs.find((clef) => clef.staffNumber === 1)?.sign === 'F' ? 'bass' : 'treble';
  const staff2Clef = firstMeasure?.attributes.clefs.find((clef) => clef.staffNumber === 2)?.sign === 'F' ? 'bass' : 'treble';
  const staves = Math.max(1, ...engine.parts.map((part) => part.staves));
  const measures = referencePart?.measures.map((measure, index) => ({
    bar: index + 1,
    startBeat: toNumber(measure.startBeat),
    durationBeats: toNumber(measure.durationBeat),
    beats: measure.attributes.time.beats,
    beatType: measure.attributes.time.beatType,
    keyFifths: measure.attributes.key.fifths,
    implicit: measure.implicit,
  }));
  const meta: ScoreMeta = {
    title: engine.workTitle,
    composer: engine.composer,
    timeSignature,
    beatsPerBar: firstMeasure ? (timeSignature[0] * 4) / timeSignature[1] : 4,
    keySignature: firstMeasure ? keyLabel(firstMeasure.attributes.key.fifths, firstMeasure.attributes.key.mode) : 'C 大调',
    barCount: Math.max(0, ...engine.parts.map((part) => part.measures.length)),
    staves: staves === 1 ? 1 : 2,
    clefs: staves === 1 ? { staff1: staff1Clef } : { staff1: staff1Clef, staff2: staff2Clef },
    measures,
    sourceFile,
    integration,
    integrationNote: integration === 'fixture'
      ? '内置示例（MusicXML 语义解析生成）。'
      : '浏览器端 MusicXML 简单子集导入；未支持记号见导入报告。',
  };

  return {
    notes,
    meta,
    warnings: report.issues.map((issue) => issue.message),
    engine,
    importReport: report,
  };
}

/**
 * Re-applies the user's explicit staff→hand mapping to legacy display notes.
 * The bridge above can only apply the piano staff default at import time; the
 * mapping is confirmed later (and the planner already consumes it), so display
 * scoping, counts and labels must be brought back in line with it.
 *
 * Returns the SAME array when every note already matches, so callers can use
 * reference equality to avoid a state update loop.
 */
export function applyHandMappingToLegacyNotes(
  notes: ScoreNote[],
  engine: EngineScoreDocument,
  handMapping: HandMappingV1,
): ScoreNote[] {
  const parts = new Map(handMapping.parts.map((part) => [part.partId, part]));
  const handByEventId = new Map<string, 'left' | 'right'>();
  for (const part of engine.parts) {
    const mappedPart = parts.get(part.id);
    if (!mappedPart) continue;
    const staffHand = new Map(mappedPart.staves.map((staff) => [staff.staffNumber, staff.hand]));
    for (const measure of part.measures) {
      for (const event of measure.events) {
        if (event.kind !== 'note') continue;
        const hand = staffHand.get(event.source.staffNumber);
        if (hand) handByEventId.set(event.id, hand);
      }
    }
  }
  if (handByEventId.size === 0) return notes;

  let changed = false;
  const mapped = notes.map((note) => {
    const hand = handByEventId.get(note.id);
    if (!hand || hand === note.hand) return note;
    changed = true;
    return { ...note, hand };
  });
  return changed ? mapped : notes;
}
