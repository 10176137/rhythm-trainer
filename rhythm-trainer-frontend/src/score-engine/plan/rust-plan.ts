// R2-3h: deterministic projection of the Rust PlannerOutput onto the existing
// front-end consumption types (ADR R2-3f §5). EVERYTHING here is a pure
// function of the server response — no TS planner call, no re-clustering by
// time or pitch, no second hand filter, no atom/scoreEvent regeneration and
// exactly ONE us -> ms division (the frozen GAP-5 rule).
import type {
  PlaybackGroup,
  PlaybackOccurrence,
  PlaybackPlan,
  Pitch,
} from '../domain/types';
import type { RationalBeat } from '../domain/rational';
import type { EngineAtom, EngineScoreEvent } from '../../types/engine';

/** Wire shapes as the Rust planner service emits them (JSON). */
export interface RustPitch {
  step: string;
  alter: number;
  octave: number;
  midiNote: number | null;
  spelling: string;
}

export interface RustLocator {
  partId: string;
  measureOrdinal: number;
  sourceOrdinal: number;
  voiceId?: string;
}

export interface RustOccurrence {
  occurrenceId: string;
  scoreEventId: string;
  locator: RustLocator;
  passIndex: number;
  playbackBeat: string;
  durationBeat: string;
  measureOrdinal: number;
  bar: number;
  beatInMeasure: string;
  staffNumber: number;
  voiceId: string;
  pitch: RustPitch | null;
  isTieOnset: boolean;
  playbackIndex: number;
}

export interface RustGroup {
  passIndex: number;
  playbackBeat: string;
  members: RustLocator[];
  pitches: string[];
  bar: number;
  beatInMeasure: string;
  staffNumbers: number[];
  voiceIds: string[];
  durationBeat: string;
  occurrenceIds: string[];
  scoreEventIds: string[];
}

export interface RustAtom {
  startTick: number;
  durationTicks: number;
  bar: number;
  beat: number;
}

export interface RustScoreEvent {
  locator: RustLocator;
  passIndex: number;
  measure: number;
  pitch: number;
  targetOnsetUs: number;
  targetDurationUs: number;
  partId: string;
  parseConfidence: number;
  runtimeOccurrenceId: string;
}

export interface RustPlannerOutput {
  scoreFingerprint: string;
  occurrences: RustOccurrence[];
  groups: RustGroup[];
  atoms: RustAtom[];
  scoreEvents: RustScoreEvent[];
  runtimeIds: { planId: string; occurrenceIds: string[]; groupIds: string[] };
  planStrictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict?: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
}

/** The `plan-response` payload the server returns (ok === true). */
export interface RustPlanResponse {
  requestId: string;
  ok: true;
  plannerAuthority: 'rust';
  plannerVersion: string;
  planFingerprint: string;
  scoreFingerprint: string;
  strictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict?: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
  plan: RustPlannerOutput;
}

export type PlanMode = 'timeline' | 'follow';

export class RustPlanRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RustPlanRejected';
  }
}

/** Parses a reduced canonical "n/d" beat. Rejects anything else — the
 * canonical text is authoritative and must never be silently coerced. */
export function parseBeat(text: string, context: string): RationalBeat {
  const match = /^(-?\d+)\/([1-9]\d*)$/.exec(text);
  if (!match) {
    throw new RustPlanRejected('PLAN_SHAPE_INVALID', `${context}: malformed rational "${text}"`);
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RustPlanRejected('PLAN_SHAPE_INVALID', `${context}: rational out of the safe range`);
  }
  return { numerator, denominator };
}

function toPitch(pitch: RustPitch | null): Pitch | undefined {
  if (pitch === null) return undefined;
  // midiNote === null means "not representable in the MIDI model": the
  // canonical shape maps it to no pitch (the service already rejects such
  // plans for strict/timeline use via invalid_target_pitch).
  if (pitch.midiNote === null) return undefined;
  return {
    step: pitch.step as Pitch['step'],
    alter: pitch.alter,
    octave: pitch.octave,
    midiNote: pitch.midiNote,
    spelling: pitch.spelling,
  };
}

/** Rust occurrence -> PlaybackOccurrence (field-by-field, ADR §5.1). */
export function toPlaybackOccurrence(occurrence: RustOccurrence): PlaybackOccurrence {
  return {
    occurrenceId: occurrence.occurrenceId,
    scoreEventId: occurrence.scoreEventId,
    sourcePartId: occurrence.locator.partId,
    sourceMeasureOrdinal: occurrence.locator.measureOrdinal,
    sourceOrdinal: occurrence.locator.sourceOrdinal,
    playbackIndex: occurrence.playbackIndex,
    passIndex: occurrence.passIndex,
    measureOrdinal: occurrence.measureOrdinal,
    playbackBeat: parseBeat(occurrence.playbackBeat, 'occurrence.playbackBeat'),
    beatInMeasure: parseBeat(occurrence.beatInMeasure, 'occurrence.beatInMeasure'),
    bar: occurrence.bar,
    staffNumber: occurrence.staffNumber,
    ...(occurrence.locator.voiceId !== undefined ? { voiceId: occurrence.locator.voiceId } : {}),
    ...(() => {
      const pitch = toPitch(occurrence.pitch);
      return pitch ? { pitch } : {};
    })(),
    durationBeat: parseBeat(occurrence.durationBeat, 'occurrence.durationBeat'),
    // chordGroupId is deliberately omitted: the Rust planner does not emit it
    // and no production consumer reads it (ADR §5.1 — optional extension).
    isTieOnset: occurrence.isTieOnset,
  };
}

/**
 * Rust groups -> PlaybackGroups with the occurrenceId<->group alignment
 * asserted (ADR §5.2). `pitches` strings are restored to full Pitch objects
 * through the member-locator index — never by re-clustering.
 */
export function toPlaybackGroups(
  plan: RustPlannerOutput,
  occurrences: readonly PlaybackOccurrence[],
): PlaybackGroup[] {
  const { groupIds } = plan.runtimeIds;
  if (groupIds.length !== plan.groups.length) {
    throw new RustPlanRejected('PLAN_SHAPE_INVALID',
      `runtimeIds.groupIds (${groupIds.length}) != groups (${plan.groups.length})`);
  }
  const byOccurrenceId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return plan.groups.map((group, index) => {
    if (group.occurrenceIds.length !== group.members.length
      || group.occurrenceIds.length !== group.scoreEventIds.length) {
      throw new RustPlanRejected('PLAN_SHAPE_INVALID',
        `group ${index}: occurrenceIds/members/scoreEventIds must pair 1:1`);
    }
    const members = group.occurrenceIds.map((occurrenceId, memberIndex) => {
      const occurrence = byOccurrenceId.get(occurrenceId);
      if (!occurrence) {
        throw new RustPlanRejected('PLAN_SHAPE_INVALID', `group ${index}: dangling occurrence ${occurrenceId}`);
      }
      const expected = group.members[memberIndex];
      if (`${occurrence.sourcePartId}:m${occurrence.sourceMeasureOrdinal}:e${occurrence.sourceOrdinal}:v${occurrence.voiceId ?? ''}`
        !== `${expected.partId}:m${expected.measureOrdinal}:e${expected.sourceOrdinal}:v${expected.voiceId ?? ''}`) {
        throw new RustPlanRejected('PLAN_SHAPE_INVALID', `group ${index}: member locator mismatch`);
      }
      return { occurrence, scoreEventId: group.scoreEventIds[memberIndex] };
    });
    // `pitches` (spelling strings) are only a cross-check: the authoritative
    // Pitch objects come from the member occurrences, in member order.
    const pitches = members
      .map(({ occurrence }) => occurrence.pitch)
      .filter((pitch): pitch is Pitch => pitch !== undefined);
    const expectedSpellings = group.pitches.join(',');
    const actualSpellings = pitches.map((pitch) => pitch.spelling).join(',');
    if (expectedSpellings !== actualSpellings) {
      throw new RustPlanRejected('PLAN_SHAPE_INVALID', `group ${index}: pitch list mismatch`);
    }
    for (const { occurrence, scoreEventId } of members) {
      if (occurrence.scoreEventId !== scoreEventId) {
        throw new RustPlanRejected('PLAN_SHAPE_INVALID', `group ${index}: scoreEventId mismatch`);
      }
    }
    return {
      groupId: groupIds[index],
      playbackBeat: parseBeat(group.playbackBeat, 'group.playbackBeat'),
      occurrenceIds: [...group.occurrenceIds],
      scoreEventIds: [...group.scoreEventIds],
      pitches,
      bar: group.bar,
      beatInMeasure: parseBeat(group.beatInMeasure, 'group.beatInMeasure'),
      staffNumbers: [...group.staffNumbers],
      voiceIds: [...group.voiceIds],
      durationBeat: parseBeat(group.durationBeat, 'group.durationBeat'),
    };
  });
}

/** Rust atoms -> EngineAtom. `kind` is a CONSTANT 'note' (the planner only
 * produces note atoms; ADR §5.3). Never rounded, never regenerated. */
export function toEngineAtoms(atoms: readonly RustAtom[]): EngineAtom[] {
  return atoms.map((atom) => ({
    startTick: atom.startTick,
    durationTicks: atom.durationTicks,
    kind: 'note',
    bar: atom.bar,
    beat: atom.beat,
  }));
}

/** Rust canonical microseconds -> the frozen wire milliseconds with exactly
 * ONE division (GAP-5). `beatPosition` is derived from the paired occurrence's
 * canonical playbackBeat (ADR §5.4), not from milliseconds. */
export function toEngineScoreEvents(
  plan: RustPlannerOutput,
  occurrences: readonly PlaybackOccurrence[],
): EngineScoreEvent[] {
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return plan.scoreEvents.map((event) => {
    const occurrence = occurrenceById.get(event.runtimeOccurrenceId);
    if (!occurrence) {
      throw new RustPlanRejected('PLAN_SHAPE_INVALID',
        `scoreEvent ${event.runtimeOccurrenceId}: no matching occurrence`);
    }
    return {
      scoreEventId: event.runtimeOccurrenceId,
      measure: event.measure,
      beatPosition: occurrence.playbackBeat.numerator / occurrence.playbackBeat.denominator,
      pitch: event.pitch,
      targetOnsetMs: event.targetOnsetUs / 1000,
      targetDurationMs: event.targetDurationUs / 1000,
      partId: event.partId,
      parseConfidence: event.parseConfidence,
    };
  });
}

/** Range span of the selected measures — the same deterministic sum the TS
 * planner used (measure.durationBeat over the range). The browser owns the
 * document, so this is presentation-level reconstruction, not planning. */
export function rangeSpanFromDocument(
  measures: ReadonlyArray<{ ordinal: number; startBeat: RationalBeat; durationBeat: RationalBeat }>,
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number },
): { rangeStartBeat: RationalBeat; rangeDurationBeat: RationalBeat } {
  const selected = measures.filter((measure) => (
    measure.ordinal >= range.startMeasureOrdinal && measure.ordinal <= range.endMeasureOrdinal
  ));
  if (selected.length === 0) {
    throw new RustPlanRejected('PLAN_SHAPE_INVALID', 'range selects no measures in the document');
  }
  let duration: RationalBeat = { numerator: 0, denominator: 1 };
  for (const measure of selected) duration = addBeats(duration, measure.durationBeat);
  return { rangeStartBeat: selected[0].startBeat, rangeDurationBeat: duration };
}

/** Rebuilds the PlaybackPlan shape the reference-playback/highlight code
 * consumes, from the Rust plan + the request's own range parameters. */
export function toPlaybackPlan(
  response: RustPlanResponse,
  request: {
    range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
    repeatSelection: { kind: 'none' } | { kind: 'range-loop'; count: number };
    rangeStartBeat: RationalBeat;
    rangeDurationBeat: RationalBeat;
  },
): { plan: PlaybackPlan; occurrences: PlaybackOccurrence[]; groups: PlaybackGroup[] } {
  const occurrences = response.plan.occurrences.map(toPlaybackOccurrence);
  const groups = toPlaybackGroups(response.plan, occurrences);
  return {
    plan: {
      planId: response.plan.runtimeIds.planId,
      scoreFingerprint: response.scoreFingerprint,
      range: request.range,
      repeatSelection: request.repeatSelection,
      occurrences,
      groups,
      strictAllowed: response.strictAllowed,
      issues: response.planIssues.map((issue) => ({
        // Planner issue codes are a superset of the importer codes; the
        // reference-playback layer only reads severity/message/blocksStrict.
        code: issue.code as never,
        severity: 'warning' as const,
        message: issue.code,
        blocksStrict: issue.blocksStrict === true,
      })),
      rangeStartBeat: request.rangeStartBeat,
      rangeDurationBeat: request.rangeDurationBeat,
    },
    occurrences,
    groups,
  };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function addBeats(a: RationalBeat, b: RationalBeat): RationalBeat {
  const numerator = a.numerator * b.denominator + b.numerator * a.denominator;
  const denominator = a.denominator * b.denominator;
  const factor = gcd(numerator, denominator);
  return { numerator: numerator / factor, denominator: denominator / factor };
}

/**
 * Timeline launch gate (mirrors the server-side strict guard; the browser
 * re-checks because a response could otherwise be mis-wired). Throws a coded
 * rejection — nothing is patched or rounded.
 */
export function assertTimelineResponseUsable(response: RustPlanResponse): void {
  const failures: string[] = [];
  if (response.strictAllowed !== true) failures.push('planStrictAllowed');
  if (response.scopeCodes.length > 0) failures.push(`scopeCodes:${response.scopeCodes.join('|')}`);
  if (response.missingEventIds.length > 0) failures.push(`missingEventIds:${response.missingEventIds.length}`);
  if (response.atomIssueCodes.length > 0) failures.push(`atomIssueCodes:${response.atomIssueCodes.join('|')}`);
  const { atoms, groups, occurrences, scoreEvents } = response.plan;
  if (atoms.length === 0) failures.push('atoms:empty');
  if (atoms.length !== groups.length) failures.push(`atoms:count ${atoms.length}!=groups ${groups.length}`);
  if (scoreEvents.length !== occurrences.length) failures.push(`scoreEvents:count ${scoreEvents.length}!=occurrences ${occurrences.length}`);
  const measureSet = new Set(scoreEvents.map((event) => event.measure));
  const barSet = new Set(atoms.map((atom) => atom.bar));
  if (measureSet.size !== barSet.size || [...barSet].some((bar) => !measureSet.has(bar))) {
    failures.push('scoreEvents:measureCoverage');
  }
  if (!/^plan-v1:sha256:[0-9a-f]{64}$/.test(response.planFingerprint)) failures.push('planFingerprint');
  if (failures.length > 0) {
    throw new RustPlanRejected('TIMELINE_PLAN_REJECTED', failures.join('; '));
  }
}

/** Follow launch gate: only what follow consumes (groups/occurrences), never
 * atoms/scoreEvents (F1 boundary). */
export function assertFollowResponseUsable(response: RustPlanResponse): void {  const failures: string[] = [];
  if (response.strictAllowed !== true) failures.push('planStrictAllowed');
  if (response.scopeCodes.length > 0) failures.push(`scopeCodes:${response.scopeCodes.join('|')}`);
  if (response.missingEventIds.length > 0) failures.push(`missingEventIds:${response.missingEventIds.length}`);
  const { groups, occurrences } = response.plan;
  if (groups.length === 0) failures.push('groups:empty');
  const ids = new Set(occurrences.map((occurrence) => occurrence.occurrenceId));
  if (ids.size !== occurrences.length) failures.push('occurrences:identity');
  for (const group of groups) {
    for (const occurrenceId of group.occurrenceIds) {
      if (!ids.has(occurrenceId)) failures.push(`groups:dangling:${occurrenceId}`);
    }
  }
  if (!/^plan-v1:sha256:[0-9a-f]{64}$/.test(response.planFingerprint)) failures.push('planFingerprint');
  if (failures.length > 0) {
    throw new RustPlanRejected('FOLLOW_PLAN_REJECTED', failures.join('; '));
  }
}

/**
 * Response binding decision (R2-3h requirement: wrong requestId, wrong
 * scoreFingerprint and stale responses must never be applied). Pure so the
 * engineBridge and the tests share ONE rule.
 */
export type PlanResponseBinding =
  | { action: 'drop'; reason: 'no-request-id' | 'unknown-or-settled' }
  | { action: 'reject'; code: string; message: string }
  | { action: 'accept'; response: RustPlanResponse };

export function bindPlanResponse(
  message: {
    requestId?: string | null;
    ok?: boolean;
    scoreFingerprint?: string;
    error?: { code?: string; message?: string };
  } & Record<string, unknown>,
  pending: { scoreFingerprint: string } | null,
): PlanResponseBinding {
  const requestId = typeof message.requestId === 'string' ? message.requestId : null;
  if (!requestId) return { action: 'drop', reason: 'no-request-id' };
  if (!pending) return { action: 'drop', reason: 'unknown-or-settled' };
  if (message.ok !== true) {
    return {
      action: 'reject',
      code: message.error?.code ?? 'PLAN_FAILED',
      message: message.error?.message ?? '计划生成失败',
    };
  }
  if (message.scoreFingerprint !== pending.scoreFingerprint) {
    return {
      action: 'reject',
      code: 'PLAN_RESPONSE_MISMATCH',
      message: '响应的曲谱指纹与本次请求不一致，已丢弃',
    };
  }
  return { action: 'accept', response: message as unknown as RustPlanResponse };
}
