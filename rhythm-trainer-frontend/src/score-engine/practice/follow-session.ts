import { toNumber } from '../domain/rational';
import type { Pitch, PlaybackGroup } from '../domain/types';

export interface FollowTargetResult {
  targetId: string;
  bar: number;
  expectedPitches: readonly string[];
  matchedPitches: readonly string[];
  wrongNotes: readonly { midiNote: number; atMs: number }[];
  duplicateNotes: number;
  completed: boolean;
  /** Pitch/order and relative timing were within the configured tolerance. */
  standard: boolean;
  firstCorrectAtMs: number | null;
  completionAtMs: number | null;
  chordSpreadMs: number | null;
  /** Actual IOI minus the score's notated IOI at the chosen BPM. */
  intervalErrorMs: number | null;
  intervalJudged: boolean;
}

export interface FollowTimingSummary {
  samples: number;
  meanSignedMs: number | null;
  meanAbsoluteMs: number | null;
  standardDeviationMs: number | null;
}

export interface FollowReport {
  /** Follow mode is deliberately not a fixed-clock strict score. */
  strictTiming: false;
  totalTargets: number;
  completedTargets: number;
  standardTargets: number;
  pendingTargetId: string | null;
  wrongNoteCount: number;
  extraNoteCount: number;
  duplicateNoteCount: number;
  timing: FollowTimingSummary;
  targets: readonly FollowTargetResult[];
}

export interface FollowNoteResult {
  kind: 'correct' | 'partial' | 'wrong' | 'duplicate' | 'complete' | 'extra';
  targetId: string | null;
  advanced: boolean;
  expectedPitches: readonly string[];
  remainingPitches: readonly string[];
  completedTarget?: FollowTargetResult;
  report?: FollowReport;
}

export interface FollowSessionOptions {
  timingToleranceMs?: number;
  chordSpreadToleranceMs?: number;
}

interface MutableTargetResult extends Omit<FollowTargetResult, 'matchedPitches' | 'wrongNotes'> {
  matchedPitches: string[];
  wrongNotes: { midiNote: number; atMs: number }[];
}

/**
 * Self-paced score follower used by the "跟手等待" sub-mode.
 *
 * The cursor NEVER advances on a timer. It advances only when the current
 * target's full pitch set has been played. Pitch/order correctness and relative
 * IOI against the notated durations are recorded for each target; this is not a
 * fixed-clock strict score and must not be mixed with the Rust fixed-timeline
 * report.
 */
export class FollowSession {
  readonly bpm: number;
  private readonly groups: readonly PlaybackGroup[];
  private readonly timingToleranceMs: number;
  private readonly chordSpreadToleranceMs: number;
  private readonly targetResults: MutableTargetResult[] = [];
  private currentIndex = 0;
  private matched = new Set<number>();
  private matchedNames: string[] = [];
  private wrongNotes: { midiNote: number; atMs: number }[] = [];
  private duplicateNotes = 0;
  private firstCorrectAtMs: number | null = null;
  private previousFirstCorrectAtMs: number | null = null;
  private previousPlaybackBeat = 0;
  private extraNoteCount = 0;

  constructor(groups: readonly PlaybackGroup[], bpm: number, options: FollowSessionOptions = {}) {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('BPM 需在 20–300 之间');
    this.groups = groups;
    this.bpm = bpm;
    this.timingToleranceMs = options.timingToleranceMs ?? 60;
    this.chordSpreadToleranceMs = options.chordSpreadToleranceMs ?? 50;
  }

  get currentGroup(): PlaybackGroup | null {
    return this.groups[this.currentIndex] ?? null;
  }

  get completedCount(): number {
    return this.targetResults.filter((target) => target.completed).length;
  }

  get isComplete(): boolean {
    return this.currentIndex >= this.groups.length;
  }

  get progress(): { index: number; total: number } {
    return { index: this.currentIndex, total: this.groups.length };
  }

  private expectedPitches(group: PlaybackGroup): (Pitch & { midiNote: number })[] {
    return group.pitches.filter((pitch): pitch is Pitch & { midiNote: number } => pitch.midiNote !== null);
  }

  handleNoteOn(midiNote: number, atMs: number): FollowNoteResult {
    if (this.isComplete) {
      this.extraNoteCount += 1;
      return { kind: 'extra', targetId: null, advanced: false, expectedPitches: [], remainingPitches: [] };
    }
    const group = this.currentGroup!;
    const expected = this.expectedPitches(group);
    if (!expected.length) throw new Error('当前目标没有可映射的 MIDI 音高');
    const expectedNames = expected.map((pitch) => pitch.spelling);
    const expectedMidi = expected.map((pitch) => pitch.midiNote);
    if (!expectedMidi.includes(midiNote)) {
      this.wrongNotes.push({ midiNote, atMs });
      return {
        kind: 'wrong',
        targetId: group.groupId,
        advanced: false,
        expectedPitches: expectedNames,
        remainingPitches: expectedNames.filter((_, index) => !this.matched.has(expectedMidi[index])),
      };
    }
    if (this.matched.has(midiNote)) {
      this.duplicateNotes += 1;
      return {
        kind: 'duplicate',
        targetId: group.groupId,
        advanced: false,
        expectedPitches: expectedNames,
        remainingPitches: expectedNames.filter((_, index) => !this.matched.has(expectedMidi[index])),
      };
    }

    if (this.firstCorrectAtMs === null) this.firstCorrectAtMs = atMs;
    this.matched.add(midiNote);
    this.matchedNames.push(expected[expectedMidi.indexOf(midiNote)].spelling);
    const remainingPitches = expectedNames.filter((_, index) => !this.matched.has(expectedMidi[index]));

    if (this.matched.size < expected.length) {
      return {
        kind: 'partial',
        targetId: group.groupId,
        advanced: false,
        expectedPitches: expectedNames,
        remainingPitches,
      };
    }

    const firstCorrectAtMs = this.firstCorrectAtMs;
    const chordSpreadMs = firstCorrectAtMs === null ? null : atMs - firstCorrectAtMs;
    let intervalErrorMs: number | null = null;
    let intervalJudged = false;
    if (this.previousFirstCorrectAtMs !== null) {
      const expectedGapMs = (toNumber(group.playbackBeat) - this.previousPlaybackBeat) * (60_000 / this.bpm);
      const actualGapMs = firstCorrectAtMs! - this.previousFirstCorrectAtMs;
      intervalErrorMs = actualGapMs - expectedGapMs;
      intervalJudged = true;
    }
    const clean = this.wrongNotes.length === 0;
    const spreadOk = chordSpreadMs === null || chordSpreadMs <= this.chordSpreadToleranceMs;
    const timingOk = !intervalJudged || Math.abs(intervalErrorMs!) <= this.timingToleranceMs;
    const result: MutableTargetResult = {
      targetId: group.groupId,
      bar: group.bar,
      expectedPitches: expectedNames,
      matchedPitches: [...this.matchedNames],
      wrongNotes: [...this.wrongNotes],
      duplicateNotes: this.duplicateNotes,
      completed: true,
      standard: clean && spreadOk && timingOk,
      firstCorrectAtMs,
      completionAtMs: atMs,
      chordSpreadMs,
      intervalErrorMs,
      intervalJudged,
    };
    this.targetResults.push(result);
    this.previousFirstCorrectAtMs = firstCorrectAtMs;
    this.previousPlaybackBeat = toNumber(group.playbackBeat);

    this.currentIndex += 1;
    this.matched = new Set();
    this.matchedNames = [];
    this.wrongNotes = [];
    this.duplicateNotes = 0;
    this.firstCorrectAtMs = null;

    return {
      kind: this.isComplete ? 'complete' : 'correct',
      targetId: group.groupId,
      advanced: true,
      expectedPitches: expectedNames,
      remainingPitches: [],
      completedTarget: result,
      ...(this.isComplete ? { report: this.buildReport() } : {}),
    };
  }

  /** After a deliberate pause, the next interval is not comparable. */
  invalidateNextInterval(): void {
    this.previousFirstCorrectAtMs = null;
  }

  finish(): FollowReport {
    return this.buildReport();
  }

  private buildReport(): FollowReport {
    const completed = this.targetResults.filter((target) => target.completed);
    const timingSamples = completed
      .filter((target) => target.intervalJudged && target.wrongNotes.length === 0 && target.intervalErrorMs !== null)
      .map((target) => target.intervalErrorMs!);
    const meanSigned = timingSamples.length
      ? timingSamples.reduce((sum, value) => sum + value, 0) / timingSamples.length
      : null;
    const meanAbsolute = timingSamples.length
      ? timingSamples.reduce((sum, value) => sum + Math.abs(value), 0) / timingSamples.length
      : null;
    const variance = timingSamples.length && meanSigned !== null
      ? timingSamples.reduce((sum, value) => sum + (value - meanSigned) ** 2, 0) / timingSamples.length
      : null;
    return {
      strictTiming: false,
      totalTargets: this.groups.length,
      completedTargets: completed.length,
      standardTargets: completed.filter((target) => target.standard).length,
      pendingTargetId: this.currentGroup?.groupId ?? null,
      wrongNoteCount: this.targetResults.reduce((sum, target) => sum + target.wrongNotes.length, 0) + this.wrongNotes.length,
      extraNoteCount: this.extraNoteCount,
      duplicateNoteCount: this.targetResults.reduce((sum, target) => sum + target.duplicateNotes, 0) + this.duplicateNotes,
      timing: {
        samples: timingSamples.length,
        meanSignedMs: meanSigned,
        meanAbsoluteMs: meanAbsolute,
        standardDeviationMs: variance === null ? null : Math.sqrt(variance),
      },
      targets: this.targetResults.map((target) => ({
        ...target,
        matchedPitches: [...target.matchedPitches],
        wrongNotes: [...target.wrongNotes],
      })),
    };
  }
}
