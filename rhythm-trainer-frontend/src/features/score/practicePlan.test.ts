import { describe, expect, it } from 'vitest';
import { sampleScore } from '../../core/sampleScore';
import { buildPracticePlan } from './practicePlan';

describe('practice plan', () => {
  it('groups both hands by onset and keeps the left-hand whole notes aligned to bar starts', () => {
    const plan = buildPracticePlan(sampleScore, 'score', 'both', 1, 2);
    expect(plan.atoms).toHaveLength(8);
    expect(plan.groupNoteIds[0]).toEqual(['r1', 'l1']);
    expect(plan.expectedNotes[0]).toEqual([
      { midiNote: 60, noteName: 'C4' },
      { midiNote: 48, noteName: 'C3' },
    ]);
    expect(plan.groupNoteIds[4]).toEqual(['r5', 'l2']);
    expect(plan.atoms.map((atom) => atom.startTick)).toEqual([0, 960, 1920, 2880, 3840, 4800, 5760, 6720]);
    expect(plan.atoms.map((atom) => atom.bar)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('filters by hand without altering the remaining target order', () => {
    const right = buildPracticePlan(sampleScore, 'score', 'right', 1, 2);
    const left = buildPracticePlan(sampleScore, 'score', 'left', 1, 2);
    expect(right.atoms).toHaveLength(8);
    expect(left.atoms).toHaveLength(2);
    expect(left.expectedNotes).toEqual([[{ midiNote: 48, noteName: 'C3' }], [{ midiNote: 43, noteName: 'G2' }]]);
  });

  it('is independent of display hint preferences', () => {
    const learningPlan = buildPracticePlan(sampleScore, 'score', 'both', 1, 2);
    const strictPlan = buildPracticePlan(sampleScore, 'score', 'both', 1, 2);
    expect(strictPlan).toEqual(learningPlan);
  });

  it('restricts the loop mode to the selected bars', () => {
    const barTwo = buildPracticePlan(sampleScore, 'loop', 'both', 2, 2);
    expect(barTwo.atoms).toHaveLength(4);
    expect(barTwo.expectedNotes).toEqual([
      [{ midiNote: 67, noteName: 'G4' }, { midiNote: 43, noteName: 'G2' }],
      [{ midiNote: 69, noteName: 'A4' }],
      [{ midiNote: 71, noteName: 'B4' }],
      [{ midiNote: 72, noteName: 'C5' }],
    ]);
  });
});
