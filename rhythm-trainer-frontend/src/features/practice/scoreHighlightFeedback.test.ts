import { describe, expect, it } from 'vitest';
import type { PlaybackGroup, Pitch } from '../../score-engine/domain/types';
import { rational } from '../../score-engine/domain/rational';
import { FollowSession } from '../../score-engine/practice/follow-session';
import type { EngineJudgment } from '../../types/engine';
import { timelineHitNoteIds } from './scoreHighlightFeedback';

function group(id: string, beat: number, bar: number, pitch: Pitch): PlaybackGroup {
  return {
    groupId: id, playbackBeat: rational(beat), occurrenceIds: [id], scoreEventIds: [id],
    pitches: [pitch], bar, beatInMeasure: rational(0), staffNumbers: [bar === 1 ? 2 : 1],
    voiceIds: ['1'], durationBeat: rational(1),
  };
}

describe('score feedback source isolation', () => {
  it('does not color measure five when a slow player is still reading measure one', () => {
    const groups = [
      group('bar1-bass-bb', 0, 1, { step: 'B', alter: -1, octave: 2, midiNote: 46, spelling: 'Bb2' }),
      group('bar1-bass-f', 1, 1, { step: 'F', alter: 0, octave: 3, midiNote: 53, spelling: 'F3' }),
      group('bar5-treble-db', 16, 5, { step: 'D', alter: -1, octave: 5, midiNote: 73, spelling: 'Db5' }),
    ];
    const guide = new FollowSession(groups, 40);
    const completedIds = [...guide.currentGroup!.scoreEventIds];
    expect(guide.handleNoteOn(46, 24000).advanced).toBe(true);
    const timingHit = { grade: 'good' as const, targetIndex: 2 };
    const before = JSON.stringify(timingHit);
    const painted = [
      ...completedIds,
      ...timelineHitNoteIds(timingHit, groups.map((g) => g.scoreEventIds), true),
    ];
    expect(painted).toEqual(['bar1-bass-bb']);
    expect(guide.currentGroup!.scoreEventIds).toEqual(['bar1-bass-f']);
    // Even a pitch belonging to the later measure cannot advance this guide.
    expect(guide.handleNoteOn(73, 24100).kind).toBe('wrong');
    expect(guide.progress.index).toBe(1);
    expect(JSON.stringify(timingHit)).toBe(before);
  });

  it.each(['perfect', 'good'] as const)('keeps %s timing feedback for views without a pitch guide', (grade) => {
    expect(timelineHitNoteIds({ grade, targetIndex: 1 }, [['first'], ['chord-a', 'chord-b']], false))
      .toEqual(['chord-a', 'chord-b']);
    expect(timelineHitNoteIds({ grade, targetIndex: 1 }, [['first'], ['chord-a', 'chord-b']], true))
      .toEqual([]);
  });

  it('never marks misses, extras, or missing target groups as completed', () => {
    const cases: Array<Pick<EngineJudgment, 'grade' | 'targetIndex'>> = [
      { grade: 'miss', targetIndex: 0 }, { grade: 'extra', targetIndex: 0 },
      ...[null, -1, 2, 0.5, NaN].map((targetIndex) => ({ grade: 'good' as const, targetIndex })),
    ];
    for (const judgment of cases) expect(timelineHitNoteIds(judgment, [['first']], false)).toEqual([]);
  });
});
