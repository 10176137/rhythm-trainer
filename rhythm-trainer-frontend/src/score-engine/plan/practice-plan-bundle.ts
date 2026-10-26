// PracticePlanBundleV1: the single, validated standard answer for one launch.
//
// This is an INTERNAL additive DTO. It does not change the frozen
// ScoreDocumentV1 / planFingerprintV1 / EngineScoreEvent wire shapes. Both the
// Rust plan and the legacy rts projection are projected into this bundle, and
// every launch consumer (atoms, scoreEvents, Follow groups) must pass the same
// integrity gate before a Take may start.
//
// Time is canonical microseconds (time-conversion-v1: exact rational, round
// half up) and includes the one count-in value. Milliseconds only appear at the
// frozen EngineScoreEvent boundary, divided exactly once.

import { rational, toNumber, type RationalBeat } from '../domain/rational';
import type {
  ImportReport,
  PlaybackOccurrence,
  PlaybackPlan,
  RepeatSelection,
  ScoreDocument,
} from '../domain/types';
import type { HandMappingV1, PracticeHand } from '../scope/practice-scope';
import { beatToMicroseconds, planFingerprintV1 } from '../contract-v1/plan-fingerprint';
import { scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import type { EngineAtom, EngineScoreEvent } from '../../types/engine';
import type { RustPlanResponse } from './rust-plan';

export const PRACTICE_PLAN_BUNDLE_SCHEMA_VERSION = 1;
export const TIME_ROUNDING_POLICY_VERSION = 'time-conversion-v1';

export type PlanPhase = 'config' | 'occurrence' | 'group' | 'atom' | 'scoreEvent' | 'fingerprint';

export interface PlanIntegrityIssue {
  code: string;
  severity: 'error' | 'warning';
  blocking: boolean;
  phase: PlanPhase;
  entityId: string | null;
  reason: string;
}

export interface PlanIntegrityReport {
  schemaVersion: 1;
  ok: boolean;
  checks: string[];
  issues: PlanIntegrityIssue[];
}

export interface PracticeConfigSnapshotV1 {
  modeId: string;
  advanceMode: 'timeline' | 'follow';
  bpm: RationalBeat;
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  repeatSelection: RepeatSelection;
  hand: PracticeHand;
  handMapping: HandMappingV1;
  countInUs: number;
  countInBeats: RationalBeat;
  ticksPerQuarter: number;
  unsupportedNotationPolicy: 'reject-strict' | 'allow-display-only';
  plannerVersion: string;
}

export interface ExpectedOccurrenceV1 {
  occurrenceId: string;
  sourceScoreEventId: string;
  groupId: string | null;
  sourcePartId: string;
  sourceMeasureOrdinal: number;
  sourceOrdinal: number;
  voiceId?: string;
  passIndex: number;
  playbackIndex: number;
  measureOrdinal: number;
  bar: number;
  playbackBeat: RationalBeat;
  beatInMeasure: RationalBeat;
  durationBeat: RationalBeat;
  staffNumber: number;
  midiNote: number | null;
  spelling: string | null;
  isTieOnset: boolean;
  targetOnsetUs: number;
  targetDurationUs: number;
}

export interface ExpectedOnsetGroupV1 {
  groupId: string;
  passIndex: number;
  bar: number;
  playbackBeat: RationalBeat;
  beatInMeasure: RationalBeat;
  durationBeat: RationalBeat;
  occurrenceIds: string[];
  sourceScoreEventIds: string[];
  pitches: number[];
  targetOnsetUs: number;
  targetDurationUs: number;
}

export interface RealtimeTargetV1 {
  groupId: string;
  startTick: number;
  durationTicks: number;
  bar: number;
  beat: number;
}

export interface ExpectedScoreEventV1 {
  scoreEventId: string;
  occurrenceId: string;
  sourceScoreEventId: string | null;
  measure: number;
  pitch: number;
  targetOnsetUs: number;
  targetDurationUs: number;
  partId: string;
  parseConfidence: number;
  passIndex: number;
  locator: {
    partId: string;
    measureOrdinal: number;
    sourceOrdinal: number;
    voiceId?: string;
  };
}

export interface PracticePlanBundleV1 {
  schemaVersion: 1;
  planId: string;
  planFingerprint: string;
  scoreFingerprint: string;
  authority: 'rust-planner' | 'rts-projection';
  plannerVersion: string;
  config: PracticeConfigSnapshotV1;
  timebase: {
    ticksPerQuarter: number;
    countInUs: number;
    countInBeats: RationalBeat;
    sessionTimeUnit: 'microsecond';
    roundingPolicyVersion: string;
  };
  occurrences: ExpectedOccurrenceV1[];
  groups: ExpectedOnsetGroupV1[];
  atoms: RealtimeTargetV1[];
  scoreEvents: ExpectedScoreEventV1[];
  integrityReport: PlanIntegrityReport;
}

export interface BundleConfigInput {
  modeId: string;
  advanceMode: 'timeline' | 'follow';
  bpm: { numerator: number; denominator: number };
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  repeatSelection: RepeatSelection;
  hand: PracticeHand;
  handMapping: HandMappingV1;
  countInUs: number;
  ticksPerQuarter: number;
  unsupportedNotationPolicy: 'reject-strict' | 'allow-display-only';
  plannerVersion: string;
}

export interface BundleFingerprintInput {
  document: ScoreDocument;
  report: ImportReport;
  partId: string;
}

export class PlanBundleRejected extends Error {
  constructor(readonly code: string, readonly issues: PlanIntegrityIssue[]) {
    super(`${code}: ${issues.slice(0, 4).map((issue) => `${issue.code}(${issue.entityId ?? '-'})`).join('; ')}`);
    this.name = 'PlanBundleRejected';
  }
}

export interface RustBundleInput {
  response: RustPlanResponse;
  plan: PlaybackPlan;
  config: BundleConfigInput;
  fingerprint: BundleFingerprintInput;
}

export interface PlaybackBundleInput {
  plan: PlaybackPlan;
  config: BundleConfigInput;
  fingerprint: BundleFingerprintInput;
}

// ---------------------------------------------------------------------------
// Time helpers

function normalizeBeat(value: RationalBeat): RationalBeat {
  return rational(value.numerator, value.denominator);
}

function safeTimes(beat: RationalBeat, duration: RationalBeat, bpm: RationalBeat, countInUs: number): {
  targetOnsetUs: number;
  targetDurationUs: number;
} {
  return {
    targetOnsetUs: countInUs + beatToMicroseconds(normalizeBeat(beat), bpm),
    targetDurationUs: beatToMicroseconds(normalizeBeat(duration), bpm),
  };
}

/** Ticks are quarter-note ticks; convert with the same round-half-up policy. */
function ticksToMicroseconds(ticks: number, ticksPerQuarter: number, bpm: RationalBeat): number {
  const numerator = BigInt(ticks) * 60_000_000n * BigInt(bpm.denominator);
  const denominator = BigInt(ticksPerQuarter) * BigInt(bpm.numerator);
  return Number((numerator + denominator / 2n) / denominator);
}

function countInBeatsFor(countInUs: number, bpm: RationalBeat): RationalBeat {
  const numerator = countInUs * bpm.numerator;
  if (!Number.isSafeInteger(numerator)) {
    throw new Error('count-in beat product exceeds safe integers');
  }
  const denominator = 60_000_000 * bpm.denominator;
  if (!Number.isSafeInteger(denominator)) {
    throw new Error('count-in beat denominator exceeds safe integers');
  }
  return rational(numerator, denominator);
}

function partIdFor(occurrence: Pick<PlaybackOccurrence, 'staffNumber' | 'voiceId'>): string {
  return `staff-${occurrence.staffNumber}:voice-${occurrence.voiceId ?? '1'}`;
}

function normalizeConfig(input: BundleConfigInput): PracticeConfigSnapshotV1 {
  if (!Number.isSafeInteger(input.bpm.numerator) || !Number.isSafeInteger(input.bpm.denominator)
    || input.bpm.denominator <= 0 || input.bpm.numerator <= 0) {
    throw new Error('BPM 必须是正的安全整数有理数');
  }
  const bpm = rational(input.bpm.numerator, input.bpm.denominator);
  if (bpm.numerator < 20 * bpm.denominator || bpm.numerator > 300 * bpm.denominator) {
    throw new Error('BPM 需在 20–300 之间');
  }
  if (!Number.isSafeInteger(input.countInUs) || input.countInUs < 0) {
    throw new Error('countInUs 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(input.ticksPerQuarter) || input.ticksPerQuarter <= 0) {
    throw new Error('ticksPerQuarter 必须是正整数');
  }
  return {
    modeId: input.modeId,
    advanceMode: input.advanceMode,
    bpm,
    range: { ...input.range },
    repeatSelection: input.repeatSelection,
    hand: input.hand,
    handMapping: input.handMapping,
    countInUs: input.countInUs,
    countInBeats: countInBeatsFor(input.countInUs, bpm),
    ticksPerQuarter: input.ticksPerQuarter,
    unsupportedNotationPolicy: input.unsupportedNotationPolicy,
    plannerVersion: input.plannerVersion,
  };
}

// ---------------------------------------------------------------------------
// Projection

function buildOccurrences(
  plan: PlaybackPlan,
  config: PracticeConfigSnapshotV1,
): { occurrences: ExpectedOccurrenceV1[]; groupIdByOccurrence: Map<string, string> } {
  const groupIdByOccurrence = new Map<string, string>();
  for (const group of plan.groups) {
    for (const occurrenceId of group.occurrenceIds) {
      if (!groupIdByOccurrence.has(occurrenceId)) groupIdByOccurrence.set(occurrenceId, group.groupId);
    }
  }
  const occurrences = plan.occurrences.map((occurrence) => {
    const times = safeTimes(occurrence.playbackBeat, occurrence.durationBeat, config.bpm, config.countInUs);
    return {
      occurrenceId: occurrence.occurrenceId,
      sourceScoreEventId: occurrence.scoreEventId,
      groupId: groupIdByOccurrence.get(occurrence.occurrenceId) ?? null,
      sourcePartId: occurrence.sourcePartId,
      sourceMeasureOrdinal: occurrence.sourceMeasureOrdinal,
      sourceOrdinal: occurrence.sourceOrdinal,
      ...(occurrence.voiceId !== undefined ? { voiceId: occurrence.voiceId } : {}),
      passIndex: occurrence.passIndex,
      playbackIndex: occurrence.playbackIndex,
      measureOrdinal: occurrence.measureOrdinal,
      bar: occurrence.bar,
      playbackBeat: normalizeBeat(occurrence.playbackBeat),
      beatInMeasure: normalizeBeat(occurrence.beatInMeasure),
      durationBeat: normalizeBeat(occurrence.durationBeat),
      staffNumber: occurrence.staffNumber,
      midiNote: occurrence.pitch?.midiNote ?? null,
      spelling: occurrence.pitch?.spelling ?? null,
      isTieOnset: occurrence.isTieOnset,
      targetOnsetUs: times.targetOnsetUs,
      targetDurationUs: times.targetDurationUs,
    };
  });
  return { occurrences, groupIdByOccurrence };
}

function buildGroups(
  plan: PlaybackPlan,
  occurrences: readonly ExpectedOccurrenceV1[],
  config: PracticeConfigSnapshotV1,
): ExpectedOnsetGroupV1[] {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return plan.groups.map((group) => {
    const members = group.occurrenceIds
      .map((id) => byId.get(id))
      .filter((occurrence): occurrence is ExpectedOccurrenceV1 => occurrence !== undefined);
    const times = safeTimes(group.playbackBeat, group.durationBeat, config.bpm, config.countInUs);
    return {
      groupId: group.groupId,
      passIndex: group.occurrenceIds
        .map((id) => byId.get(id)?.passIndex)
        .find((value): value is number => value !== undefined) ?? 0,
      bar: group.bar,
      playbackBeat: normalizeBeat(group.playbackBeat),
      beatInMeasure: normalizeBeat(group.beatInMeasure),
      durationBeat: normalizeBeat(group.durationBeat),
      occurrenceIds: [...group.occurrenceIds],
      sourceScoreEventIds: members.map((member) => member.sourceScoreEventId),
      pitches: members
        .map((member) => member.midiNote)
        .filter((pitch): pitch is number => pitch !== null),
      targetOnsetUs: times.targetOnsetUs,
      targetDurationUs: members.reduce((longest, member) => Math.max(longest, member.targetDurationUs), 0),
    };
  });
}

function toTarget(atom: {
  startTick: number;
  durationTicks: number;
  bar: number;
  beat: number;
}): RealtimeTargetV1 {
  return {
    groupId: '',
    startTick: atom.startTick,
    durationTicks: atom.durationTicks,
    bar: atom.bar,
    beat: atom.beat,
  };
}

function scoreEventsFromOccurrences(
  occurrences: readonly ExpectedOccurrenceV1[],
): ExpectedScoreEventV1[] {
  return occurrences
    .filter((occurrence): occurrence is ExpectedOccurrenceV1 & { midiNote: number } => occurrence.midiNote !== null)
    .map((occurrence) => ({
      scoreEventId: occurrence.occurrenceId,
      occurrenceId: occurrence.occurrenceId,
      sourceScoreEventId: occurrence.sourceScoreEventId,
      measure: occurrence.bar,
      pitch: occurrence.midiNote,
      targetOnsetUs: occurrence.targetOnsetUs,
      targetDurationUs: occurrence.targetDurationUs,
      partId: partIdFor(occurrence),
      parseConfidence: 1,
      passIndex: occurrence.passIndex,
      locator: {
        partId: occurrence.sourcePartId,
        measureOrdinal: occurrence.sourceMeasureOrdinal,
        sourceOrdinal: occurrence.sourceOrdinal,
        ...(occurrence.voiceId !== undefined ? { voiceId: occurrence.voiceId } : {}),
      },
    }))
    .sort((a, b) => a.targetOnsetUs - b.targetOnsetUs || a.scoreEventId.localeCompare(b.scoreEventId));
}

function scoreEventsFromRust(
  response: RustPlanResponse,
  occurrences: readonly ExpectedOccurrenceV1[],
): ExpectedScoreEventV1[] {
  const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return response.plan.scoreEvents.map((event) => {
    const occurrence = byId.get(event.runtimeOccurrenceId);
    return {
      scoreEventId: event.runtimeOccurrenceId,
      occurrenceId: event.runtimeOccurrenceId,
      sourceScoreEventId: occurrence?.sourceScoreEventId ?? null,
      measure: event.measure,
      pitch: event.pitch,
      targetOnsetUs: event.targetOnsetUs,
      targetDurationUs: event.targetDurationUs,
      partId: event.partId,
      parseConfidence: event.parseConfidence,
      passIndex: event.passIndex,
      locator: {
        partId: event.locator.partId,
        measureOrdinal: event.locator.measureOrdinal,
        sourceOrdinal: event.locator.sourceOrdinal,
        ...(event.locator.voiceId !== undefined ? { voiceId: event.locator.voiceId } : {}),
      },
    };
  });
}

function computeFingerprint(
  plan: PlaybackPlan,
  config: PracticeConfigSnapshotV1,
  fingerprint: BundleFingerprintInput,
): { fingerprint: string | null; error: string | null } {
  try {
    return {
      fingerprint: planFingerprintV1({
        document: fingerprint.document,
        report: fingerprint.report,
        plan,
        plannerVersion: config.plannerVersion,
        partId: fingerprint.partId,
        range: config.range,
        hand: config.hand,
        handMapping: config.handMapping,
        repeatSelection: config.repeatSelection,
        bpm: { numerator: config.bpm.numerator, denominator: config.bpm.denominator },
        ticksPerQuarter: config.ticksPerQuarter,
        countInBeats: { numerator: config.countInBeats.numerator, denominator: config.countInBeats.denominator },
      }),
      error: null,
    };
  } catch (error) {
    return { fingerprint: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function assemble(
  input: {
    plan: PlaybackPlan;
    config: PracticeConfigSnapshotV1;
    authority: 'rust-planner' | 'rts-projection';
    planId: string;
    planFingerprint: string;
    scoreFingerprint: string;
    plannerVersion: string;
    atoms: RealtimeTargetV1[];
    scoreEvents: ExpectedScoreEventV1[];
    extraIssues: PlanIntegrityIssue[];
    expectedPlanFingerprint: string | null;
    expectedScoreFingerprint: string | null;
  },
): PracticePlanBundleV1 {
  const { occurrences } = buildOccurrences(input.plan, input.config);
  const groups = buildGroups(input.plan, occurrences, input.config);
  const bundle: PracticePlanBundleV1 = {
    schemaVersion: PRACTICE_PLAN_BUNDLE_SCHEMA_VERSION,
    planId: input.planId,
    planFingerprint: input.planFingerprint,
    scoreFingerprint: input.scoreFingerprint,
    authority: input.authority,
    plannerVersion: input.plannerVersion,
    config: input.config,
    timebase: {
      ticksPerQuarter: input.config.ticksPerQuarter,
      countInUs: input.config.countInUs,
      countInBeats: input.config.countInBeats,
      sessionTimeUnit: 'microsecond',
      roundingPolicyVersion: TIME_ROUNDING_POLICY_VERSION,
    },
    occurrences,
    groups,
    atoms: input.atoms,
    scoreEvents: input.scoreEvents,
    integrityReport: { schemaVersion: 1, ok: false, checks: [], issues: [] },
  };
  bundle.integrityReport = validatePracticePlanBundle(bundle, {
    expectedPlanFingerprint: input.expectedPlanFingerprint,
    expectedScoreFingerprint: input.expectedScoreFingerprint,
    extraIssues: input.extraIssues,
  });
  return bundle;
}

// ---------------------------------------------------------------------------
// Builders

export function buildPracticePlanBundleFromRust(input: RustBundleInput): PracticePlanBundleV1 {
  const config = normalizeConfig(input.config);
  const { occurrences } = buildOccurrences(input.plan, config);
  const computed = computeFingerprint(input.plan, config, input.fingerprint);
  const extraIssues: PlanIntegrityIssue[] = [];
  if (computed.error) {
    extraIssues.push(issue('PLAN_FINGERPRINT_UNAVAILABLE', 'fingerprint', null,
      `无法重算计划指纹：${computed.error}`));
  } else if (computed.fingerprint !== input.response.planFingerprint) {
    extraIssues.push(issue('PLAN_FINGERPRINT_MISMATCH', 'fingerprint', null,
      `服务端指纹 ${input.response.planFingerprint} 与本地重算 ${computed.fingerprint} 不一致`));
  }
  if (input.response.scoreFingerprint !== input.plan.scoreFingerprint) {
    extraIssues.push(issue('PLAN_SCORE_FINGERPRINT_MISMATCH', 'fingerprint', null,
      `响应 scoreFingerprint ${input.response.scoreFingerprint} 与 PlaybackPlan ${input.plan.scoreFingerprint} 不一致`));
  }
  if (input.response.plan.runtimeIds.planId !== input.plan.planId) {
    extraIssues.push(issue('PLAN_ID_MISMATCH', 'config', input.response.plan.runtimeIds.planId,
      `响应 planId 与 PlaybackPlan planId 不一致`));
  }
  if (input.response.plan.atomIssueCodes.length > 0 && config.advanceMode === 'timeline') {
    extraIssues.push(issue('PLAN_ATOM_GRID', 'atom', null,
      `Rust 原子无法无损落在 tick 网格：${input.response.plan.atomIssueCodes.join(',')}`));
  }
  const atoms = input.response.plan.atoms.map((atom, index) => ({
    ...toTarget(atom),
    groupId: input.response.plan.runtimeIds.groupIds[index] ?? '',
  }));
  return assemble({
    plan: input.plan,
    config,
    authority: 'rust-planner',
    planId: input.response.plan.runtimeIds.planId,
    planFingerprint: input.response.planFingerprint,
    scoreFingerprint: input.response.scoreFingerprint,
    plannerVersion: input.response.plannerVersion,
    atoms,
    scoreEvents: scoreEventsFromRust(input.response, occurrences),
    extraIssues,
    expectedPlanFingerprint: computed.fingerprint,
    expectedScoreFingerprint: input.plan.scoreFingerprint,
  });
}

export function buildPracticePlanBundleFromPlayback(input: PlaybackBundleInput): PracticePlanBundleV1 {
  const config = normalizeConfig(input.config);
  const { occurrences } = buildOccurrences(input.plan, config);
  const atomResult = scoreOccurrencesToEngineAtoms(input.plan, config.ticksPerQuarter);
  const atomBlocking = config.advanceMode === 'timeline';
  const extraIssues: PlanIntegrityIssue[] = atomResult.issues
    .filter((item) => item.blocksStrict || item.severity === 'error')
    .map((item) => issue('PLAN_ATOM_GRID', 'atom', null, item.message, atomBlocking));
  if (atomBlocking && atomResult.issues.some((item) => item.blocksStrict)) {
    extraIssues.push(issue('PLAN_ATOM_BLOCKED', 'atom', null, '目标无法无损转换为 tick 网格'));
  }
  const computed = computeFingerprint(input.plan, config, input.fingerprint);
  if (computed.error) {
    extraIssues.push(issue('PLAN_FINGERPRINT_UNAVAILABLE', 'fingerprint', null,
      `无法计算计划指纹：${computed.error}`));
  }
  const atoms = atomResult.atoms.map((atom, index) => ({
    ...toTarget(atom),
    groupId: input.plan.groups[index]?.groupId ?? '',
  }));
  return assemble({
    plan: input.plan,
    config,
    authority: 'rts-projection',
    planId: input.plan.planId,
    planFingerprint: computed.fingerprint ?? '',
    scoreFingerprint: input.plan.scoreFingerprint,
    plannerVersion: config.plannerVersion,
    atoms,
    scoreEvents: scoreEventsFromOccurrences(occurrences),
    extraIssues,
    expectedPlanFingerprint: computed.fingerprint,
    expectedScoreFingerprint: input.plan.scoreFingerprint,
  });
}

// ---------------------------------------------------------------------------
// Validation

function issue(
  code: string,
  phase: PlanPhase,
  entityId: string | null,
  reason: string,
  blocking = true,
): PlanIntegrityIssue {
  return {
    code,
    phase,
    entityId,
    reason,
    blocking,
    severity: blocking ? 'error' : 'warning',
  };
}

export interface ValidateBundleOptions {
  expectedPlanFingerprint?: string | null;
  expectedScoreFingerprint?: string | null;
  extraIssues?: PlanIntegrityIssue[];
}

export function validatePracticePlanBundle(
  bundle: PracticePlanBundleV1,
  options: ValidateBundleOptions = {},
): PlanIntegrityReport {
  const issues: PlanIntegrityIssue[] = [...(options.extraIssues ?? [])];
  const checks: string[] = [];
  const blocking = (code: string, phase: PlanPhase, entityId: string | null, reason: string) => {
    issues.push(issue(code, phase, entityId, reason));
  };
  const warning = (code: string, phase: PlanPhase, entityId: string | null, reason: string) => {
    issues.push(issue(code, phase, entityId, reason, false));
  };
  const follow = bundle.config?.advanceMode === 'follow';

  // --- config / timebase ---------------------------------------------------
  checks.push('config.schemaVersion');
  if (bundle.schemaVersion !== PRACTICE_PLAN_BUNDLE_SCHEMA_VERSION) {
    blocking('PLAN_SCHEMA_VERSION', 'config', null, `bundle schemaVersion ${String(bundle.schemaVersion)}`);
  }
  checks.push('config.identity');
  if (!bundle.planId) blocking('PLAN_ID_MISSING', 'config', null, 'planId 为空');
  if (!bundle.plannerVersion) blocking('PLAN_VERSION_MISSING', 'config', null, 'plannerVersion 为空');
  if (bundle.authority !== 'rust-planner' && bundle.authority !== 'rts-projection') {
    blocking('PLAN_AUTHORITY_INVALID', 'config', null, `unknown authority ${String(bundle.authority)}`);
  }
  checks.push('config.fingerprint-format');
  if (!/^plan-v1:sha256:[0-9a-f]{64}$/.test(bundle.planFingerprint)) {
    blocking('PLAN_FINGERPRINT_FORMAT', 'fingerprint', null, `invalid planFingerprint "${bundle.planFingerprint}"`);
  }
  if (typeof bundle.scoreFingerprint !== 'string' || bundle.scoreFingerprint === '') {
    blocking('PLAN_SCORE_FINGERPRINT_MISSING', 'fingerprint', null, 'scoreFingerprint 为空');
  }
  if (options.expectedPlanFingerprint && bundle.planFingerprint !== options.expectedPlanFingerprint) {
    blocking('PLAN_FINGERPRINT_MISMATCH', 'fingerprint', null,
      `bundle fingerprint ${bundle.planFingerprint} != expected ${options.expectedPlanFingerprint}`);
  }
  if (options.expectedScoreFingerprint && bundle.scoreFingerprint !== options.expectedScoreFingerprint) {
    blocking('PLAN_SCORE_FINGERPRINT_MISMATCH', 'fingerprint', null,
      `bundle scoreFingerprint ${bundle.scoreFingerprint} != expected ${options.expectedScoreFingerprint}`);
  }

  checks.push('config.bpm');
  const bpm = safeRational(bundle.config?.bpm);
  if (!bpm || bpm.numerator <= 0 || bpm.denominator <= 0) {
    blocking('PLAN_BPM_INVALID', 'config', null, 'BPM 有理数非法');
  } else if (bpm.numerator < 20 * bpm.denominator || bpm.numerator > 300 * bpm.denominator) {
    blocking('PLAN_BPM_RANGE', 'config', null, `BPM ${bpm.numerator}/${bpm.denominator} 超出 20–300`);
  }
  checks.push('config.countIn');
  if (!Number.isSafeInteger(bundle.config?.countInUs) || bundle.config.countInUs < 0) {
    blocking('PLAN_COUNT_IN_INVALID', 'config', null, 'countInUs 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(bundle.config?.ticksPerQuarter) || bundle.config.ticksPerQuarter <= 0) {
    blocking('PLAN_TICKS_INVALID', 'config', null, 'ticksPerQuarter 必须是正整数');
  }
  if (bpm && Number.isSafeInteger(bundle.config?.countInUs)) {
    try {
      const expectedCountIn = countInBeatsFor(bundle.config.countInUs, bpm);
      const actual = safeRational(bundle.config.countInBeats);
      if (!actual || actual.numerator !== expectedCountIn.numerator || actual.denominator !== expectedCountIn.denominator) {
        blocking('PLAN_COUNT_IN_BEATS_MISMATCH', 'config', null,
          `countInBeats ${actual?.numerator ?? '?'}/${actual?.denominator ?? '?'} != ${expectedCountIn.numerator}/${expectedCountIn.denominator}`);
      }
      if (bundle.timebase?.countInUs !== bundle.config.countInUs
        || bundle.timebase?.ticksPerQuarter !== bundle.config.ticksPerQuarter
        || bundle.timebase?.roundingPolicyVersion !== TIME_ROUNDING_POLICY_VERSION) {
        blocking('PLAN_TIMEBASE_MISMATCH', 'config', null, 'timebase 与 config 不一致');
      }
    } catch (error) {
      blocking('PLAN_COUNT_IN_BEATS_INVALID', 'config', null, String(error instanceof Error ? error.message : error));
    }
  }
  checks.push('config.range');
  const start = bundle.config?.range?.startMeasureOrdinal;
  const end = bundle.config?.range?.endMeasureOrdinal;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    blocking('PLAN_RANGE_INVALID', 'config', null, `非法小节范围 ${String(start)}–${String(end)}`);
  }
  checks.push('config.repeatSelection');
  const repeat = bundle.config?.repeatSelection;
  if (!repeat || (repeat.kind !== 'none' && repeat.kind !== 'range-loop')) {
    blocking('PLAN_REPEAT_INVALID', 'config', null, 'repeatSelection 形状非法');
  } else if (repeat.kind === 'range-loop'
    && (!Number.isSafeInteger(repeat.count) || repeat.count < 1 || repeat.count > 32)) {
    blocking('PLAN_REPEAT_COUNT', 'config', null, `range-loop count ${String(repeat.count)} 超出 1..=32`);
  }

  // --- occurrences ---------------------------------------------------------
  checks.push('occurrence.identity');
  const occurrences = Array.isArray(bundle.occurrences) ? bundle.occurrences : [];
  const occurrenceById = new Map<string, ExpectedOccurrenceV1>();
  for (const occurrence of occurrences) {
    if (!occurrence?.occurrenceId) {
      blocking('PLAN_OCCURRENCE_ID', 'occurrence', null, 'occurrenceId 为空');
      continue;
    }
    if (occurrenceById.has(occurrence.occurrenceId)) {
      blocking('PLAN_OCCURRENCE_DUPLICATE', 'occurrence', occurrence.occurrenceId,
        `occurrenceId ${occurrence.occurrenceId} 重复`);
      continue;
    }
    occurrenceById.set(occurrence.occurrenceId, occurrence);
  }
  checks.push('occurrence.times');
  for (const occurrence of occurrences) {
    const id = occurrence.occurrenceId;
    if (!Number.isSafeInteger(occurrence.passIndex) || occurrence.passIndex < 0) {
      blocking('PLAN_PASS_INDEX', 'occurrence', id, 'passIndex 非法');
    }
    if (!Number.isSafeInteger(occurrence.playbackIndex) || occurrence.playbackIndex < 0) {
      blocking('PLAN_PLAYBACK_INDEX', 'occurrence', id, 'playbackIndex 非法');
    }
    if (!Number.isSafeInteger(occurrence.bar) || occurrence.bar < 1) {
      blocking('PLAN_BAR_INVALID', 'occurrence', id, 'bar 非法');
    }
    if (!Number.isSafeInteger(occurrence.measureOrdinal) || occurrence.measureOrdinal < 1) {
      blocking('PLAN_MEASURE_INVALID', 'occurrence', id, 'measureOrdinal 非法');
    }
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && (occurrence.measureOrdinal < start || occurrence.measureOrdinal > end)) {
      blocking('PLAN_OCCURRENCE_OUT_OF_RANGE', 'occurrence', id,
        `measureOrdinal ${occurrence.measureOrdinal} 不在选区 ${start}–${end}`);
    }
    if (occurrence.midiNote !== null
      && (!Number.isSafeInteger(occurrence.midiNote) || occurrence.midiNote < 0 || occurrence.midiNote > 127)) {
      blocking('PLAN_PITCH_INVALID', 'occurrence', id, `midiNote ${String(occurrence.midiNote)} 非法`);
    }
    if (occurrence.midiNote === null) {
      blocking('PLAN_PITCH_MISSING', 'occurrence', id, '目标没有可评分的 MIDI pitch');
    }
    if (!Number.isSafeInteger(occurrence.staffNumber) || occurrence.staffNumber < 1) {
      blocking('PLAN_STAFF_INVALID', 'occurrence', id, 'staffNumber 非法');
    }
    if (bpm && Number.isSafeInteger(bundle.config?.countInUs)) {
      try {
        const expected = safeTimes(occurrence.playbackBeat, occurrence.durationBeat, bpm, bundle.config.countInUs);
        if (expected.targetOnsetUs !== occurrence.targetOnsetUs) {
          blocking('PLAN_OCCURRENCE_ONSET_MISMATCH', 'occurrence', id,
            `onset ${occurrence.targetOnsetUs} != countIn+beat ${expected.targetOnsetUs}`);
        }
        if (expected.targetDurationUs !== occurrence.targetDurationUs) {
          blocking('PLAN_OCCURRENCE_DURATION_MISMATCH', 'occurrence', id,
            `duration ${occurrence.targetDurationUs} != beat ${expected.targetDurationUs}`);
        }
        if (expected.targetDurationUs <= 0) {
          blocking('PLAN_OCCURRENCE_DURATION_INVALID', 'occurrence', id, 'duration 必须为正');
        }
      } catch (error) {
        blocking('PLAN_OCCURRENCE_TIME_INVALID', 'occurrence', id,
          String(error instanceof Error ? error.message : error));
      }
    }
  }

  // --- groups --------------------------------------------------------------
  checks.push('group.identity');
  const groups = Array.isArray(bundle.groups) ? bundle.groups : [];
  const groupById = new Map<string, ExpectedOnsetGroupV1>();
  for (const group of groups) {
    if (!group?.groupId) {
      blocking('PLAN_GROUP_ID', 'group', null, 'groupId 为空');
      continue;
    }
    if (groupById.has(group.groupId)) {
      blocking('PLAN_GROUP_DUPLICATE', 'group', group.groupId, `groupId ${group.groupId} 重复`);
      continue;
    }
    groupById.set(group.groupId, group);
  }
  const groupByOccurrence = new Map<string, string>();
  checks.push('group.membership');
  for (const group of groups) {
    const ids = Array.isArray(group.occurrenceIds) ? group.occurrenceIds : [];
    if (ids.length === 0) blocking('PLAN_GROUP_EMPTY', 'group', group.groupId, '组没有成员');
    if (!Array.isArray(group.sourceScoreEventIds) || group.sourceScoreEventIds.length !== ids.length) {
      blocking('PLAN_GROUP_SCOREEVENT_PAIRING', 'group', group.groupId,
        'sourceScoreEventIds 与 occurrenceIds 数量不一致');
    }
    const seen = new Set<string>();
    for (const occurrenceId of ids) {
      if (seen.has(occurrenceId)) {
        blocking('PLAN_GROUP_MEMBER_DUPLICATE', 'group', group.groupId,
          `成员 ${occurrenceId} 在同一组重复`);
        continue;
      }
      seen.add(occurrenceId);
      if (!occurrenceById.has(occurrenceId)) {
        blocking('PLAN_GROUP_MEMBER_DANGLING', 'group', group.groupId, `成员 ${occurrenceId} 不存在`);
        continue;
      }
      if (groupByOccurrence.has(occurrenceId)) {
        blocking('PLAN_OCCURRENCE_MULTI_GROUP', 'group', group.groupId,
          `成员 ${occurrenceId} 同时属于 ${groupByOccurrence.get(occurrenceId)}`);
      } else {
        groupByOccurrence.set(occurrenceId, group.groupId);
      }
      const occurrence = occurrenceById.get(occurrenceId)!;
      if (occurrence.groupId !== group.groupId) {
        blocking('PLAN_OCCURRENCE_GROUP_MISMATCH', 'occurrence', occurrenceId,
          `occurrence.groupId ${String(occurrence.groupId)} != ${group.groupId}`);
      }
      if (occurrence.bar !== group.bar) {
        blocking('PLAN_GROUP_BAR_MISMATCH', 'group', group.groupId,
          `成员 ${occurrenceId} 的 bar ${occurrence.bar} != ${group.bar}`);
      }
      if (compareBeats(occurrence.playbackBeat, group.playbackBeat) !== 0) {
        blocking('PLAN_GROUP_BEAT_MISMATCH', 'group', group.groupId,
          `成员 ${occurrenceId} 的 playbackBeat 与组不一致`);
      }
      if (occurrence.passIndex !== group.passIndex) {
        blocking('PLAN_GROUP_PASS_MISMATCH', 'group', group.groupId,
          `成员 ${occurrenceId} 的 passIndex ${occurrence.passIndex} != ${group.passIndex}`);
      }
    }
  }
  for (const occurrence of occurrences) {
    if (!groupByOccurrence.has(occurrence.occurrenceId)) {
      blocking('PLAN_OCCURRENCE_GROUP_MISSING', 'occurrence', occurrence.occurrenceId, '不属于任何目标组');
    }
  }
  checks.push('group.times');
  for (const group of groups) {
    const members = group.occurrenceIds
      .map((id) => occurrenceById.get(id))
      .filter((occurrence): occurrence is ExpectedOccurrenceV1 => occurrence !== undefined);
    if (bpm && Number.isSafeInteger(bundle.config?.countInUs)) {
      try {
        const expected = safeTimes(group.playbackBeat, group.durationBeat, bpm, bundle.config.countInUs);
        if (expected.targetOnsetUs !== group.targetOnsetUs) {
          blocking('PLAN_GROUP_ONSET_MISMATCH', 'group', group.groupId,
            `onset ${group.targetOnsetUs} != countIn+beat ${expected.targetOnsetUs}`);
        }
        const durationFromBeat = beatToMicroseconds(normalizeBeat(group.durationBeat), bpm);
        if (durationFromBeat !== group.targetDurationUs) {
          blocking('PLAN_GROUP_DURATION_BEAT_MISMATCH', 'group', group.groupId,
            `组时长 ${group.targetDurationUs} != durationBeat ${durationFromBeat}`);
        }
      } catch (error) {
        blocking('PLAN_GROUP_TIME_INVALID', 'group', group.groupId,
          String(error instanceof Error ? error.message : error));
      }
    }
    const longestMember = members.reduce((longest, member) => Math.max(longest, member.targetDurationUs), 0);
    if (group.targetDurationUs !== longestMember) {
      blocking('PLAN_GROUP_DURATION_MISMATCH', 'group', group.groupId,
        `组时长 ${group.targetDurationUs} != 最长成员 ${longestMember}`);
    }
    const memberPitches = members
      .map((member) => member.midiNote)
      .filter((pitch): pitch is number => pitch !== null);
    if (memberPitches.length !== group.pitches.length
      || memberPitches.some((pitch, index) => pitch !== group.pitches[index])) {
      blocking('PLAN_GROUP_PITCH_MISMATCH', 'group', group.groupId, '组音高列表与成员不一致');
    }
    const memberSourceIds = members.map((member) => member.sourceScoreEventId);
    if (memberSourceIds.length !== group.sourceScoreEventIds.length
      || memberSourceIds.some((id, index) => id !== group.sourceScoreEventIds[index])) {
      blocking('PLAN_GROUP_SOURCE_ID_MISMATCH', 'group', group.groupId, 'sourceScoreEventIds 与成员不一致');
    }
  }
  checks.push('group.order');
  for (let index = 1; index < groups.length; index += 1) {
    const previous = groups[index - 1];
    const current = groups[index];
    if (compareBeats(current.playbackBeat, previous.playbackBeat) < 0) {
      blocking('PLAN_GROUP_ORDER', 'group', current.groupId, 'playbackBeat 顺序倒退');
    }
    if (current.targetOnsetUs < previous.targetOnsetUs) {
      blocking('PLAN_GROUP_ORDER', 'group', current.groupId, '目标 onset 顺序倒退');
    }
  }

  // --- atoms (Timeline strict; Follow does not consume them) ---------------
  if (follow) {
    checks.push('atom.skipped-follow');
    warning('PLAN_ATOM_UNUSED_FOLLOW', 'atom', null,
      'Follow 只消费目标组；原子仅作为同一计划的派生证据记录，不参与推进');
  } else {
    checks.push('atom.alignment');
    const atoms = Array.isArray(bundle.atoms) ? bundle.atoms : [];
    if (atoms.length !== groups.length) {
      blocking('PLAN_ATOM_COUNT', 'atom', null, `atoms ${atoms.length} != groups ${groups.length}`);
    }
    const ticksPerQuarter = bundle.config?.ticksPerQuarter;
    if (bpm && Number.isSafeInteger(ticksPerQuarter) && ticksPerQuarter > 0) {
      const limit = Math.min(atoms.length, groups.length);
      for (let index = 0; index < limit; index += 1) {
        const atom = atoms[index];
        const group = groups[index];
        if (atom.groupId && group.groupId && atom.groupId !== group.groupId) {
          blocking('PLAN_ATOM_GROUP_MISMATCH', 'atom', atom.groupId,
            `atom.groupId ${atom.groupId} != group ${group.groupId}`);
        }
        if (!Number.isSafeInteger(atom.startTick) || atom.startTick < 0
          || !Number.isSafeInteger(atom.durationTicks) || atom.durationTicks <= 0) {
          blocking('PLAN_ATOM_TICKS', 'atom', atom.groupId || null, 'startTick/durationTicks 非法');
          continue;
        }
        if (atom.bar !== group.bar) {
          blocking('PLAN_ATOM_BAR', 'atom', atom.groupId || null, `atom.bar ${atom.bar} != ${group.bar}`);
        }
        let atomOnset: number;
        let atomDuration: number;
        try {
          atomOnset = bundle.config.countInUs + ticksToMicroseconds(atom.startTick, ticksPerQuarter, bpm);
          atomDuration = ticksToMicroseconds(atom.durationTicks, ticksPerQuarter, bpm);
        } catch (error) {
          blocking('PLAN_ATOM_TICKS', 'atom', atom.groupId || null,
            String(error instanceof Error ? error.message : error));
          continue;
        }
        if (atomOnset !== group.targetOnsetUs) {
          blocking('PLAN_ATOM_ONSET_MISMATCH', 'atom', atom.groupId || null,
            `atom onset ${atomOnset} != group ${group.targetOnsetUs}`);
        }
        if (atomDuration !== group.targetDurationUs) {
          blocking('PLAN_ATOM_DURATION_MISMATCH', 'atom', atom.groupId || null,
            `atom duration ${atomDuration} != group ${group.targetDurationUs}`);
        }
      }
    }
  }

  // --- scoreEvents ---------------------------------------------------------
  checks.push('scoreEvent.binding');
  const scoreEvents = Array.isArray(bundle.scoreEvents) ? bundle.scoreEvents : [];
  const eventsByOccurrence = new Map<string, ExpectedScoreEventV1[]>();
  const eventIds = new Set<string>();
  for (const event of scoreEvents) {
    if (!event?.scoreEventId) {
      blocking('PLAN_SCOREEVENT_ID', 'scoreEvent', null, 'scoreEventId 为空');
      continue;
    }
    if (eventIds.has(event.scoreEventId)) {
      blocking('PLAN_SCOREEVENT_DUPLICATE', 'scoreEvent', event.scoreEventId, 'scoreEventId 重复');
    }
    eventIds.add(event.scoreEventId);
    if (!event.occurrenceId || !occurrenceById.has(event.occurrenceId)) {
      blocking('PLAN_SCOREEVENT_DANGLING', 'scoreEvent', event.scoreEventId,
        `occurrence ${String(event.occurrenceId)} 不存在`);
      continue;
    }
    const list = eventsByOccurrence.get(event.occurrenceId) ?? [];
    list.push(event);
    eventsByOccurrence.set(event.occurrenceId, list);
  }
  for (const occurrence of occurrences) {
    const list = eventsByOccurrence.get(occurrence.occurrenceId) ?? [];
    if (list.length === 0) {
      blocking('PLAN_SCOREEVENT_MISSING', 'scoreEvent', occurrence.occurrenceId, '可评分 occurrence 没有 scoreEvent');
      continue;
    }
    if (list.length > 1) {
      blocking('PLAN_SCOREEVENT_EXTRA', 'scoreEvent', occurrence.occurrenceId,
        `occurrence 对应 ${list.length} 个 scoreEvent`);
      continue;
    }
    const event = list[0];
    if (event.pitch !== occurrence.midiNote) {
      blocking('PLAN_SCOREEVENT_PITCH', 'scoreEvent', event.scoreEventId,
        `scoreEvent pitch ${event.pitch} != occurrence ${String(occurrence.midiNote)}`);
    }
    if (event.measure !== occurrence.bar) {
      blocking('PLAN_SCOREEVENT_MEASURE', 'scoreEvent', event.scoreEventId,
        `scoreEvent measure ${event.measure} != ${occurrence.bar}`);
    }
    if (event.targetOnsetUs !== occurrence.targetOnsetUs) {
      blocking('PLAN_SCOREEVENT_ONSET', 'scoreEvent', event.scoreEventId,
        `scoreEvent onset ${event.targetOnsetUs} != ${occurrence.targetOnsetUs}`);
    }
    if (event.targetDurationUs !== occurrence.targetDurationUs) {
      blocking('PLAN_SCOREEVENT_DURATION', 'scoreEvent', event.scoreEventId,
        `scoreEvent duration ${event.targetDurationUs} != ${occurrence.targetDurationUs}`);
    }
    if (event.partId !== partIdFor(occurrence)) {
      blocking('PLAN_SCOREEVENT_PART', 'scoreEvent', event.scoreEventId,
        `scoreEvent partId ${event.partId} != ${partIdFor(occurrence)}`);
    }
    if (!Number.isFinite(event.parseConfidence) || event.parseConfidence < 0 || event.parseConfidence > 1) {
      blocking('PLAN_SCOREEVENT_CONFIDENCE', 'scoreEvent', event.scoreEventId, 'parseConfidence 非法');
    }
    if (event.passIndex !== occurrence.passIndex) {
      blocking('PLAN_SCOREEVENT_PASS', 'scoreEvent', event.scoreEventId,
        `scoreEvent passIndex ${event.passIndex} != ${occurrence.passIndex}`);
    }
    if (event.sourceScoreEventId !== occurrence.sourceScoreEventId) {
      blocking('PLAN_SCOREEVENT_SOURCE_ID', 'scoreEvent', event.scoreEventId,
        `sourceScoreEventId ${String(event.sourceScoreEventId)} != ${occurrence.sourceScoreEventId}`);
    }
    const locator = event.locator;
    if (!locator
      || locator.partId !== occurrence.sourcePartId
      || locator.measureOrdinal !== occurrence.sourceMeasureOrdinal
      || locator.sourceOrdinal !== occurrence.sourceOrdinal
      || (locator.voiceId ?? undefined) !== (occurrence.voiceId ?? undefined)) {
      blocking('PLAN_SCOREEVENT_LOCATOR', 'scoreEvent', event.scoreEventId, 'scoreEvent locator 与 occurrence 不一致');
    }
  }

  return {
    schemaVersion: 1,
    ok: !issues.some((item) => item.blocking),
    checks,
    issues,
  };
}

export function assertPracticePlanBundle(bundle: PracticePlanBundleV1): PracticePlanBundleV1 {
  const report = bundle.integrityReport ?? validatePracticePlanBundle(bundle);
  if (!report.ok) {
    throw new PlanBundleRejected('PLAN_BUNDLE_REJECTED', report.issues.filter((item) => item.blocking));
  }
  return bundle;
}

// ---------------------------------------------------------------------------
// Frozen wire adaptation (exactly one µs -> ms division)

export function engineAtomsFromBundle(bundle: PracticePlanBundleV1): EngineAtom[] {
  return bundle.atoms.map((atom) => ({
    startTick: atom.startTick,
    durationTicks: atom.durationTicks,
    kind: 'note' as const,
    bar: atom.bar,
    beat: atom.beat,
  }));
}

export function engineScoreEventsFromBundle(bundle: PracticePlanBundleV1): EngineScoreEvent[] {
  const occurrences = new Map(bundle.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return bundle.scoreEvents.map((event) => {
    const occurrence = occurrences.get(event.occurrenceId);
    if (!occurrence) {
      throw new PlanBundleRejected('PLAN_SCOREEVENT_DANGLING', [
        issue('PLAN_SCOREEVENT_DANGLING', 'scoreEvent', event.scoreEventId, 'scoreEvent 没有对应 occurrence'),
      ]);
    }
    return {
      scoreEventId: event.scoreEventId,
      measure: event.measure,
      beatPosition: toNumber(occurrence.playbackBeat),
      pitch: event.pitch,
      targetOnsetMs: event.targetOnsetUs / 1000,
      targetDurationMs: event.targetDurationUs / 1000,
      partId: event.partId,
      parseConfidence: event.parseConfidence,
    };
  });
}

// ---------------------------------------------------------------------------

function safeRational(value: RationalBeat | undefined | null): RationalBeat | null {
  if (!value || !Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator)
    || value.denominator <= 0) {
    return null;
  }
  return rational(value.numerator, value.denominator);
}

function compareBeats(a: RationalBeat, b: RationalBeat): number {
  return a.numerator * b.denominator - b.numerator * a.denominator;
}
