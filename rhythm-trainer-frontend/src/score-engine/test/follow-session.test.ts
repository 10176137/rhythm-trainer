import { describe, expect, it } from 'vitest';
import { rational } from '../domain/rational';
import type { Pitch, PlaybackGroup } from '../domain/types';
import { FollowSession } from '../practice/follow-session';

function pitch(spelling: string, midi: number): Pitch {
  return { step: spelling[0] as Pitch['step'], alter: 0, octave: Number(spelling.match(/\d/)?.[0] ?? 4), midiNote: midi, spelling };
}

function group(id: string, beat: number, pitches: Pitch[]): PlaybackGroup {
  return {
    groupId: id,
    playbackBeat: rational(beat),
    occurrenceIds: [id],
    scoreEventIds: [id],
    pitches,
    bar: 1,
    beatInMeasure: rational(beat),
    staffNumbers: [1],
    voiceIds: ['1'],
    durationBeat: rational(1),
  };
}

describe('FollowSession', () => {
  it('does not move the cursor without input', () => {
    const session = new FollowSession([group('g0', 0, [pitch('C4', 60)])], 60);
    const report = session.finish();
    expect(session.progress).toEqual({ index: 0, total: 1 });
    expect(report.completedTargets).toBe(0);
    expect(report.pendingTargetId).toBe('g0');
    expect(report.targets).toEqual([]);
  });

  it('advances only on correct pitches and still records wrong notes and chord spread', () => {
    const session = new FollowSession([
      group('g0', 0, [pitch('C4', 60)]),
      group('g1', 1, [pitch('E4', 64), pitch('G4', 67)]),
      group('g2', 2, [pitch('D4', 62)]),
    ], 60, { timingToleranceMs: 60, chordSpreadToleranceMs: 50 });

    expect(session.handleNoteOn(65, 0).kind).toBe('wrong');
    expect(session.progress.index).toBe(0);
    const c4 = session.handleNoteOn(60, 100);
    expect(c4.kind).toBe('correct');
    expect(c4.completedTarget?.standard).toBe(false);
    expect(session.progress.index).toBe(1);

    expect(session.handleNoteOn(64, 1100).kind).toBe('partial');
    expect(session.progress.index).toBe(1);
    const chord = session.handleNoteOn(67, 1200);
    expect(chord.kind).toBe('correct');
    expect(chord.completedTarget?.chordSpreadMs).toBe(100);
    expect(chord.completedTarget?.standard).toBe(false);
    expect(session.progress.index).toBe(2);

    const d4 = session.handleNoteOn(62, 2100);
    expect(d4.kind).toBe('complete');
    expect(d4.completedTarget?.intervalErrorMs).toBe(0);
    expect(d4.completedTarget?.standard).toBe(true);
    const report = session.finish();
    expect(report.completedTargets).toBe(3);
    expect(report.standardTargets).toBe(1);
    expect(report.wrongNoteCount).toBe(1);
    expect(report.timing.samples).toBe(2);
    expect(report.timing.meanSignedMs).toBe(0);
    expect(report.strictTiming).toBe(false);
  });

  it('counts duplicates inside a chord and a late interval as non-standard', () => {
    const session = new FollowSession([
      group('g0', 0, [pitch('C4', 60)]),
      group('g1', 1, [pitch('E4', 64), pitch('G4', 67)]),
    ], 60);
    session.handleNoteOn(60, 0);
    expect(session.handleNoteOn(64, 1175).kind).toBe('partial');
    expect(session.handleNoteOn(64, 1180).kind).toBe('duplicate');
    const chord = session.handleNoteOn(67, 1185);
    expect(chord.kind).toBe('complete');
    expect(chord.completedTarget?.intervalErrorMs).toBe(175);
    expect(chord.completedTarget?.standard).toBe(false);
    const report = session.finish();
    expect(report.duplicateNoteCount).toBe(1);
    expect(report.standardTargets).toBe(1);
  });
});
