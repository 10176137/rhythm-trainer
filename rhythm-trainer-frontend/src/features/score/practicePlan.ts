import type { ScoreNote } from '../../core/sampleScore';
import type { EngineAtom } from '../../types/engine';
import type { HandSelection, PracticeModeId } from '../../types/practice';

export interface PracticePlan {
  atoms: EngineAtom[];
  expectedNotes: { midiNote: number; noteName: string }[][];
  groupNoteIds: string[][];
}

/**
 * Groups filtered score notes into same-onset targets and maps them to engine
 * atoms. Display hints are intentionally not a parameter: toggling note names
 * or line/space overlays can never change this target timeline.
 */
export function buildPracticePlan(
  notes: readonly ScoreNote[],
  modeId: PracticeModeId,
  hand: HandSelection,
  loopStartBar: number,
  loopEndBar: number,
): PracticePlan {
  let scoped = notes.filter((note) => hand === 'both' || note.hand === hand);
  // The A–B range is a plan filter for the score-reading modes, including the
  // fixed-judgment-line view. It must not change the scoring mode.
  if (modeId === 'loop' || modeId === 'fixed-line') {
    scoped = scoped.filter((note) => note.bar >= loopStartBar && note.bar <= loopEndBar);
  }
  const sorted = [...scoped].sort((a, b) => a.beat - b.beat);
  const groups: { tick: number; notes: ScoreNote[] }[] = [];
  for (const note of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.tick === note.beat) last.notes.push(note);
    else groups.push({ tick: note.beat, notes: [note] });
  }
  const atoms: EngineAtom[] = groups.map((group) => ({
    startTick: Math.round(group.tick * 960),
    durationTicks: 960,
    kind: 'note',
    bar: group.notes[0].bar,
    beat: group.tick + 1,
  }));
  const expectedNotes = groups.map((group) => group.notes.map((note) => ({ midiNote: note.midiNote, noteName: note.noteName })));
  const groupNoteIds = groups.map((group) => group.notes.map((note) => note.id));
  return { atoms, expectedNotes, groupNoteIds };
}
