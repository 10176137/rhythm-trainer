import { compareBeat, multiplyBeat } from '../domain/rational';
import type {
  PlaybackGroup,
  PlaybackOccurrence,
  PlaybackPlan,
  TempoMap,
} from '../domain/types';
import { buildTempoMap } from './tempo-map';

export type PlaybackHand = 'left' | 'right' | 'both';

export interface ReferencePlaybackVoice {
  /** Stable per-occurrence ID. Repeated pitches must never share a voice. */
  voiceId: string;
  occurrenceId: string;
  scoreEventId: string;
  midiNote: number;
  velocity: number;
  /** Session-relative onset, including count-in. */
  atMs: number;
  /** Target duration from the occurrence's musical duration. */
  durationMs: number;
}

export interface ReferencePlaybackNote {
  /** Stable target/group ID shared with the score plan. */
  eventId: string;
  groupId: string;
  occurrenceIds: string[];
  scoreEventIds: string[];
  atMs: number;
  durationMs: number;
  bar: number;
  beat: number;
  staffNumbers: number[];
  voiceIds: string[];
  /** Score events to highlight while this target is current. */
  activeScoreEventIds: string[];
  voices: ReferencePlaybackVoice[];
}

export interface ReferencePlaybackPlanIssue {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  blocksPlayback: boolean;
}

export interface ReferencePlaybackPlan {
  /** Derived from PlaybackPlan.planId; includes the hand scope. */
  planId: string;
  sourcePlanId: string;
  scoreFingerprint: string;
  bpm: number;
  countInMs: number;
  hand: PlaybackHand;
  range: PlaybackPlan['range'];
  notes: ReferencePlaybackNote[];
  /** Last audio end in session-relative ms, including count-in. */
  lastEndMs: number;
  issues: ReferencePlaybackPlanIssue[];
  strictAllowed: boolean;
}

export interface BuildReferencePlaybackPlanOptions {
  bpm: number;
  countInBeats: number;
  hand: PlaybackHand;
  /** scoreEventId -> hand. Required unless hand === 'both'. */
  handByScoreEventId?: ReadonlyMap<string, Exclude<PlaybackHand, 'both'>>;
  velocity?: number;
}

export interface ReferencePlaybackPlanResult {
  plan?: ReferencePlaybackPlan;
  /** The hand-filtered PlaybackPlan used for atoms and the score view. */
  scopedPlan?: PlaybackPlan;
  /** Non-blocking issues that still need to be visible. */
  issues: ReferencePlaybackPlanIssue[];
  strictAllowed: boolean;
}

export class ReferencePlaybackPlanError extends Error {
  constructor(
    readonly code: 'missing_hand' | 'missing_pitch' | 'empty_plan' | 'invalid_tempo',
    message: string,
  ) {
    super(message);
    this.name = 'ReferencePlaybackPlanError';
  }
}

/**
 * Filters a planned occurrence timeline by hand without changing the musical
 * facts. A group that contains both hands is reduced to the selected hand's
 * occurrences, its pitches, its IDs and its longest selected duration.
 *
 * This is the boundary between "practice scope" (which targets the user must
 * play) and the target plan. It must be applied before atoms and audio are
 * built, otherwise the score view and the engine can disagree about the target
 * count. Playback-only hand muting is a separate future concern.
 */
export function filterPlaybackPlanByHand(
  plan: PlaybackPlan,
  hand: PlaybackHand,
  handByScoreEventId?: ReadonlyMap<string, Exclude<PlaybackHand, 'both'>>,
): { plan: PlaybackPlan; missingEventIds: string[] } {
  if (hand === 'both') return { plan, missingEventIds: [] };
  if (!handByScoreEventId) {
    throw new ReferencePlaybackPlanError('missing_hand', '单手播放需要 scoreEventId -> hand 映射');
  }

  const missing = new Set<string>();
  const occurrenceById = new Map<string, PlaybackOccurrence>();
  for (const occurrence of plan.occurrences) occurrenceById.set(occurrence.occurrenceId, occurrence);

  const selectedOccurrences: PlaybackOccurrence[] = [];
  const groups: PlaybackGroup[] = [];
  for (const group of plan.groups) {
    const selected: PlaybackOccurrence[] = [];
    for (const occurrenceId of group.occurrenceIds) {
      const occurrence = occurrenceById.get(occurrenceId);
      if (!occurrence) {
        missing.add(occurrenceId);
        continue;
      }
      const occurrenceHand = handByScoreEventId.get(occurrence.scoreEventId);
      if (!occurrenceHand) {
        missing.add(occurrence.scoreEventId);
        continue;
      }
      if (occurrenceHand === hand) selected.push(occurrence);
    }
    if (!selected.length) continue;

    selectedOccurrences.push(...selected);
    const longest = selected.reduce(
      (value, occurrence) => compareBeat(occurrence.durationBeat, value) > 0 ? occurrence.durationBeat : value,
      selected[0].durationBeat,
    );
    const pitches = selected.flatMap((occurrence) => occurrence.pitch ? [occurrence.pitch] : []);
    groups.push({
      groupId: group.groupId,
      playbackBeat: group.playbackBeat,
      occurrenceIds: selected.map((occurrence) => occurrence.occurrenceId),
      scoreEventIds: selected.map((occurrence) => occurrence.scoreEventId),
      pitches,
      bar: group.bar,
      beatInMeasure: group.beatInMeasure,
      staffNumbers: [...new Set(selected.map((occurrence) => occurrence.staffNumber))].sort((a, b) => a - b),
      voiceIds: [...new Set(selected.map((occurrence) => occurrence.voiceId ?? '1'))].sort(),
      durationBeat: longest,
    });
  }

  return {
    plan: {
      ...plan,
      planId: `${plan.planId}:hand=${hand}`,
      occurrences: selectedOccurrences,
      groups,
    },
    missingEventIds: [...missing],
  };
}

/**
 * Builds the single source of truth for reference audio, the score cursor and
 * the engine atom conversion. Times include the count-in, exactly like the
 * Rust target schedule's at_ms domain.
 */
export function buildReferencePlaybackPlan(
  sourcePlan: PlaybackPlan,
  options: BuildReferencePlaybackPlanOptions,
): ReferencePlaybackPlanResult {
  const issues: ReferencePlaybackPlanIssue[] = [];
  if (!Number.isFinite(options.bpm) || options.bpm < 20 || options.bpm > 300) {
    throw new ReferencePlaybackPlanError('invalid_tempo', `BPM 需在 20–300 之间，收到 ${String(options.bpm)}`);
  }
  if (!Number.isFinite(options.countInBeats) || options.countInBeats < 0) {
    throw new ReferencePlaybackPlanError('invalid_tempo', 'countInBeats 必须是非负数');
  }

  const { plan, missingEventIds } = filterPlaybackPlanByHand(
    sourcePlan,
    options.hand,
    options.handByScoreEventId,
  );
  if (missingEventIds.length) {
    throw new ReferencePlaybackPlanError(
      'missing_hand',
      `无法确定 ${missingEventIds.length} 个目标的手别（例如 ${missingEventIds[0]}），已阻止参考播放`,
    );
  }

  let tempoMap: TempoMap;
  try {
    tempoMap = buildTempoMap({ bpm: options.bpm, timeOrigin: 'playback-start' });
  } catch (error) {
    throw new ReferencePlaybackPlanError(
      'invalid_tempo',
      error instanceof Error ? error.message : String(error),
    );
  }

  const countInMs = options.countInBeats * (60_000 / options.bpm);
  const occurrenceById = new Map(plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const velocity = options.velocity ?? 0.72;
  const notes: ReferencePlaybackNote[] = [];

  for (const group of plan.groups) {
    const atMs = countInMs + tempoMap.beatToMs(group.playbackBeat);
    const voices: ReferencePlaybackVoice[] = [];
    for (const occurrenceId of group.occurrenceIds) {
      const occurrence = occurrenceById.get(occurrenceId);
      if (!occurrence) {
        issues.push({
          code: 'missing_occurrence',
          severity: 'error',
          message: `目标 ${group.groupId} 引用了不存在的 occurrence ${occurrenceId}`,
          blocksPlayback: true,
        });
        continue;
      }
      const midiNote = occurrence.pitch?.midiNote;
      if (midiNote == null || !Number.isFinite(midiNote)) {
        issues.push({
          code: 'missing_pitch',
          severity: 'error',
          message: `目标 ${occurrenceId} 缺少可播放的 MIDI pitch`,
          blocksPlayback: true,
        });
        continue;
      }
      voices.push({
        voiceId: occurrence.occurrenceId,
        occurrenceId: occurrence.occurrenceId,
        scoreEventId: occurrence.scoreEventId,
        midiNote,
        velocity,
        atMs,
        durationMs: tempoMap.beatToMs(occurrence.durationBeat),
      });
    }
    if (!voices.length) continue;
    const groupDurationMs = voices.reduce((value, voice) => Math.max(value, voice.durationMs), 0);
    notes.push({
      eventId: group.groupId,
      groupId: group.groupId,
      occurrenceIds: [...group.occurrenceIds],
      scoreEventIds: [...group.scoreEventIds],
      atMs,
      durationMs: groupDurationMs,
      bar: group.bar,
      beat: group.beatInMeasure.numerator / group.beatInMeasure.denominator + 1,
      staffNumbers: [...group.staffNumbers],
      voiceIds: [...group.voiceIds],
      activeScoreEventIds: [...group.scoreEventIds],
      voices,
    });
  }

  notes.sort((a, b) => a.atMs - b.atMs || a.eventId.localeCompare(b.eventId));
  if (!notes.length) {
    throw new ReferencePlaybackPlanError('empty_plan', '所选范围没有可播放的目标音符');
  }

  const blocking = issues.some((issue) => issue.blocksPlayback);
  const passes = sourcePlan.repeatSelection.kind === 'range-loop' ? sourcePlan.repeatSelection.count : 1;
  const playbackDurationBeat = multiplyBeat(sourcePlan.rangeDurationBeat, passes);
  const rangeEndMs = countInMs + tempoMap.beatToMs(playbackDurationBeat);
  const lastEndMs = Math.max(
    notes.reduce((value, note) => Math.max(value, note.atMs + note.durationMs), 0),
    rangeEndMs,
  );
  return {
    plan: {
      planId: plan.planId,
      sourcePlanId: sourcePlan.planId,
      scoreFingerprint: sourcePlan.scoreFingerprint,
      bpm: options.bpm,
      countInMs,
      hand: options.hand,
      range: sourcePlan.range,
      notes,
      lastEndMs,
      issues,
      strictAllowed: !blocking && sourcePlan.strictAllowed,
    },
    scopedPlan: plan,
    issues,
    strictAllowed: !blocking && sourcePlan.strictAllowed,
  };
}

/**
 * Validates the implicit index contract between the reference plan and the
 * Rust targets. A mismatch means the player must not claim it is playing the
 * same timeline as the scorer.
 */
export function validateReferencePlanAgainstTargets(
  plan: ReferencePlaybackPlan,
  targets: readonly { atMs: number; bar: number | null }[],
  toleranceMs = 4,
): string[] {
  const issues: string[] = [];
  if (targets.length !== plan.notes.length) {
    issues.push(`参考播放 ${plan.notes.length} 个目标，引擎 ${targets.length} 个目标`);
  }
  const count = Math.min(targets.length, plan.notes.length);
  for (let index = 0; index < count; index += 1) {
    const note = plan.notes[index];
    const target = targets[index];
    if (Math.abs(note.atMs - target.atMs) > toleranceMs) {
      issues.push(`目标 ${index} 时间不一致：播放 ${note.atMs.toFixed(2)}ms，引擎 ${target.atMs.toFixed(2)}ms`);
      if (issues.length >= 4) break;
    }
    if (target.bar != null && note.bar !== target.bar) {
      issues.push(`目标 ${index} 小节不一致：播放 ${note.bar}，引擎 ${target.bar}`);
      if (issues.length >= 4) break;
    }
  }
  return issues;
}
