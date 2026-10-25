// Cross-language oracle: the browser's original FollowSession and the Rust
// NativeFollowRuntime must produce the same per-note decisions and report for
// the same inputs. This is a parity guard while TS keeps a FollowSession only
// for the Timeline guide cursor.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rational } from '../src/score-engine/domain/rational';
import type { Pitch, PlaybackGroup } from '../src/score-engine/domain/types';
import { FollowSession } from '../src/score-engine/practice/follow-session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const addon = require(path.join(REPO, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

function pitch(spelling: string, midiNote: number): Pitch {
  return {
    step: spelling[0] as Pitch['step'],
    alter: 0,
    octave: Number(spelling.match(/\d/)?.[0] ?? 4),
    midiNote,
    spelling,
  };
}

function tsGroup(id: string, beat: number, pitches: Pitch[]): PlaybackGroup {
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

function normalizeTarget(target) {
  return {
    targetId: target.targetId,
    bar: target.bar,
    expectedPitches: [...target.expectedPitches],
    matchedPitches: [...target.matchedPitches],
    wrongNotes: [...target.wrongNotes].map((note) => ({ midiNote: note.midiNote, atMs: note.atMs })),
    duplicateNotes: target.duplicateNotes,
    completed: target.completed,
    standard: target.standard,
    firstCorrectAtMs: target.firstCorrectAtMs ?? null,
    completionAtMs: target.completionAtMs ?? null,
    chordSpreadMs: target.chordSpreadMs ?? null,
    intervalErrorMs: target.intervalErrorMs ?? null,
    intervalJudged: target.intervalJudged,
  };
}

function normalizeReport(report) {
  return {
    strictTiming: report.strictTiming,
    totalTargets: report.totalTargets,
    completedTargets: report.completedTargets,
    standardTargets: report.standardTargets,
    pendingTargetId: report.pendingTargetId ?? null,
    wrongNoteCount: report.wrongNoteCount,
    extraNoteCount: report.extraNoteCount,
    duplicateNoteCount: report.duplicateNoteCount,
    timing: {
      samples: report.timing.samples,
      meanSignedMs: report.timing.meanSignedMs ?? null,
      meanAbsoluteMs: report.timing.meanAbsoluteMs ?? null,
      standardDeviationMs: report.timing.standardDeviationMs ?? null,
    },
    targets: report.targets.map(normalizeTarget),
  };
}

function normalizeResult(result) {
  return {
    kind: result.kind,
    targetId: result.targetId ?? null,
    advanced: result.advanced,
    expectedPitches: [...result.expectedPitches],
    remainingPitches: [...result.remainingPitches],
    completedTarget: result.completedTarget ? normalizeTarget(result.completedTarget) : null,
    hasReport: !!result.report,
    progressIndex: result.progressIndex,
    progressTotal: result.progressTotal,
    completedCount: result.completedCount,
  };
}

describe('FollowSession / NativeFollowRuntime parity', () => {
  it('matches per-note decisions and the final report', () => {
    const tsGroups = [
      tsGroup('g0', 0, [pitch('C4', 60)]),
      tsGroup('g1', 1, [pitch('C4', 60), pitch('E4', 64)]),
      tsGroup('g2', 2, [pitch('G4', 67)]),
      tsGroup('g3', 3, [pitch('A4', 69)]),
    ];
    const nativeGroups = [
      { groupId: 'g0', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] },
      {
        groupId: 'g1',
        bar: 1,
        playbackBeat: 1,
        pitches: [{ midiNote: 60, spelling: 'C4' }, { midiNote: 64, spelling: 'E4' }],
      },
      { groupId: 'g2', bar: 1, playbackBeat: 2, pitches: [{ midiNote: 67, spelling: 'G4' }] },
      { groupId: 'g3', bar: 1, playbackBeat: 3, pitches: [{ midiNote: 69, spelling: 'A4' }] },
    ];

    const ts = new FollowSession(tsGroups, 60, { timingToleranceMs: 60, chordSpreadToleranceMs: 50 });
    const native = new addon.NativeFollowRuntime(nativeGroups, 60, 60, 50);

    const steps = [
      [62, 100], // wrong, no advance
      [60, 200], // g0 complete
      [60, 300], // g1 partial
      [60, 400], // g1 duplicate
      [64, 1300], // g1 complete, late interval
    ];
    for (const [note, atMs] of steps) {
      const tsResult = ts.handleNoteOn(note, atMs);
      expect(normalizeResult(native.pushNote(note, atMs))).toEqual(normalizeResult({
        ...tsResult,
        progressIndex: ts.progress.index,
        progressTotal: ts.progress.total,
        completedCount: ts.completedCount,
      }));
    }

    // A deliberate pause makes the next interval incomparable in both.
    ts.invalidateNextInterval();
    native.invalidateNextInterval();

    const afterPause = [
      [67, 5000],
      [69, 6000],
      [71, 6100], // extra after completion
    ];
    for (const [note, atMs] of afterPause) {
      const tsResult = ts.handleNoteOn(note, atMs);
      expect(normalizeResult(native.pushNote(note, atMs))).toEqual(normalizeResult({
        ...tsResult,
        progressIndex: ts.progress.index,
        progressTotal: ts.progress.total,
        completedCount: ts.completedCount,
      }));
    }

    expect(normalizeReport(native.finish())).toEqual(normalizeReport(ts.finish()));
    expect(normalizeReport(native.finish())).toMatchObject({
      strictTiming: false,
      totalTargets: 4,
      completedTargets: 4,
      standardTargets: 2,
      wrongNoteCount: 1,
      duplicateNoteCount: 1,
      extraNoteCount: 1,
      timing: { samples: 2 },
    });
  });
});
