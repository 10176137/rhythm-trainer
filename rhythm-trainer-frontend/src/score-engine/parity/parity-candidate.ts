// R2-2a/b: builds the TS-side parity candidate by running the CURRENT
// production pipeline (importer → planner → hand filter → atoms/scoreEvents)
// and projecting it into the frozen canonical shapes of R2-1 §3, plus the
// gated fingerprint (common frozen plannerVersion input) and the offline
// P1-3 invariant recheck. The result feeds parity-diff; nothing here mutates
// production behavior.
import { beatToString, rational } from '../domain/rational';
import type { RationalBeat } from '../domain/rational';
import type { PlaybackPlan } from '../domain/types';
import { importMusicXml } from '../import/musicxml-importer';
import { buildPlaybackPlan, scoreOccurrencesToEngineAtoms } from '../playback/playback-planner';
import { buildEngineScoreEvents } from '../playback/score-events';
import { filterPlaybackPlanByHand } from '../playback/reference-playback-plan';
import { assessPracticeScope, handByScoreEventIdFromMapping } from '../scope/practice-scope';
import type { HandMappingV1, PracticeHand, PracticeScopeV1 } from '../scope/practice-scope';
import { beatToMicroseconds, planFingerprintV1 } from '../contract-v1/plan-fingerprint';
import type { CanonicalAtom, CanonicalGroup, CanonicalOccurrence, CanonicalScoreEvent, ParityCandidate } from './parity-diff';

/** Frozen case-bundle configuration (R2-1 §2). All fields are explicit inputs. */
export interface ParityCaseConfig {
  partId: string;
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  repeatSelection: { kind: 'none' } | { kind: 'range-loop'; count: number };
  hand: PracticeHand;
  handMapping: HandMappingV1;
  /** Positive reduced rational BPM (R2-1 §3.5 / RF-01). */
  bpm: { numerator: number; denominator: number };
  ticksPerQuarter: number;
  /** Non-negative integer count-in in microseconds — the frozen time origin. */
  countInUs: number;
  unsupportedNotationPolicy: 'reject-strict' | 'allow-display-only';
  /** Common frozen value for both sides; per-implementation versions never enter the diff. */
  plannerVersion: string;
}

export interface TsCandidateResult {
  candidate: ParityCandidate;
  fingerprint: string | null;
  fingerprintErrorCode: string | null;
  importStatus: string;
  importStrictAllowed: boolean;
  planStrictAllowed: boolean;
  planIssues: { code: string; blocksStrict: boolean }[];
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
}

function rationalV1(numerator: number, denominator: number): { numerator: number; denominator: number } {
  const reduced = rational(numerator, denominator);
  return { numerator: reduced.numerator, denominator: reduced.denominator };
}

function bpmRationalV1(config: ParityCaseConfig): { numerator: number; denominator: number } {
  return rationalV1(config.bpm.numerator, config.bpm.denominator);
}

/** countInBeats = CountInUs × bpmNum / (60_000_000 × bpmDen), exact rational (R2-1 §2/§3.5). */
export function countInBeatsRational(config: ParityCaseConfig): { numerator: number; denominator: number } {
  return rational(config.countInUs * config.bpm.numerator, 60_000_000 * config.bpm.denominator);
}

/** Legacy bridge: the float countInBeats the current TS API consumes (R2-1 §2). */
export function countInBeatsFloat(config: ParityCaseConfig): number {
  return (config.countInUs * (config.bpm.numerator / config.bpm.denominator)) / 60_000_000;
}

/** Canonical µs conversion = the frozen time-conversion-v1 BigInt formula. */
function beatToUs(beat: RationalBeat, config: ParityCaseConfig): number {
  return beatToMicroseconds(
    rationalV1(beat.numerator, beat.denominator),
    bpmRationalV1(config),
  );
}

function toCanonicalOccurrence(occurrence: {
  sourcePartId: string;
  sourceMeasureOrdinal: number;
  sourceOrdinal: number;
  voiceId?: string;
  passIndex: number;
  playbackBeat: RationalBeat;
  durationBeat: RationalBeat;
  measureOrdinal: number;
  bar: number;
  beatInMeasure: RationalBeat;
  staffNumber: number;
  pitch?: { step: string; alter: number; octave: number; midiNote: number | null; spelling: string };
  isTieOnset: boolean;
  playbackIndex: number;
}): CanonicalOccurrence {
  return {
    locator: {
      partId: occurrence.sourcePartId,
      measureOrdinal: occurrence.sourceMeasureOrdinal,
      sourceOrdinal: occurrence.sourceOrdinal,
      voiceId: occurrence.voiceId,
    },
    passIndex: occurrence.passIndex,
    playbackBeat: beatToString(occurrence.playbackBeat),
    durationBeat: beatToString(occurrence.durationBeat),
    measureOrdinal: occurrence.measureOrdinal,
    bar: occurrence.bar,
    beatInMeasure: beatToString(occurrence.beatInMeasure),
    staffNumber: occurrence.staffNumber,
    voiceId: occurrence.voiceId ?? '1',
    pitch: occurrence.pitch && occurrence.pitch.midiNote != null
      ? {
        step: occurrence.pitch.step,
        alter: occurrence.pitch.alter,
        octave: occurrence.pitch.octave,
        midiNote: occurrence.pitch.midiNote,
        spelling: occurrence.pitch.spelling,
      }
      : null,
    isTieOnset: occurrence.isTieOnset,
    playbackIndex: occurrence.playbackIndex,
  };
}

export function buildTsCandidate(xml: string, fileName: string, config: ParityCaseConfig): TsCandidateResult {
  const imported = importMusicXml(xml, { fileName });
  const document = imported.scoreDocument;
  if (!document) throw new Error(`fixture did not import: ${imported.importReport.status}`);
  const report = imported.importReport;

  const planResult = buildPlaybackPlan(document, {
    range: config.range,
    repeatSelection: config.repeatSelection,
    unsupportedNotationPolicy: config.unsupportedNotationPolicy,
  });
  if (!planResult.plan) throw new Error(`no playback plan: ${planResult.issues.map((i) => i.code).join(', ')}`);
  let plan: PlaybackPlan = planResult.plan;

  const scopeCodes: string[] = [];
  let missingEventIds: string[] = [];
  if (config.hand !== 'both') {
    const scope: PracticeScopeV1 = {
      schemaVersion: 1,
      partId: config.partId,
      range: config.range,
      hand: config.hand,
      handMapping: config.handMapping,
    };
    scopeCodes.push(...assessPracticeScope(document, scope).codes);
    const handMap = handByScoreEventIdFromMapping(document, scope);
    const filtered = filterPlaybackPlanByHand(plan, config.hand, handMap);
    plan = filtered.plan;
    missingEventIds = filtered.missingEventIds;
  }

  const atomResult = scoreOccurrencesToEngineAtoms(plan, config.ticksPerQuarter);
  const wireEvents = buildEngineScoreEvents(
    plan,
    config.bpm.numerator / config.bpm.denominator,
    countInBeatsFloat(config),
  );

  const occurrenceById = new Map(plan.occurrences.map((o) => [o.occurrenceId, o]));
  const groups: CanonicalGroup[] = plan.groups.map((group) => {
    const members = group.occurrenceIds.map((id) => occurrenceById.get(id)).filter((o) => o != null);
    return {
      passIndex: members.length ? members[0].passIndex : 0,
      playbackBeat: beatToString(group.playbackBeat),
      members: members.map((m) => ({
        partId: m.sourcePartId,
        measureOrdinal: m.sourceMeasureOrdinal,
        sourceOrdinal: m.sourceOrdinal,
        voiceId: m.voiceId,
      })),
      pitches: group.pitches.map((p) => p.spelling),
      bar: group.bar,
      beatInMeasure: beatToString(group.beatInMeasure),
      staffNumbers: [...group.staffNumbers],
      voiceIds: [...group.voiceIds],
      durationBeat: beatToString(group.durationBeat),
    };
  });

  const atoms: CanonicalAtom[] = atomResult.atoms.map((atom) => ({
    startTick: atom.startTick,
    durationTicks: atom.durationTicks,
    bar: atom.bar,
    beat: atom.beat,
  }));

  const scoreEvents: CanonicalScoreEvent[] = plan.occurrences.map((occurrence) => ({
    locator: {
      partId: occurrence.sourcePartId,
      measureOrdinal: occurrence.sourceMeasureOrdinal,
      sourceOrdinal: occurrence.sourceOrdinal,
      voiceId: occurrence.voiceId,
    },
    passIndex: occurrence.passIndex,
    measure: occurrence.bar,
    pitch: occurrence.pitch?.midiNote ?? -1,
    targetOnsetUs: config.countInUs + beatToUs(occurrence.playbackBeat, config),
    targetDurationUs: beatToUs(occurrence.durationBeat, config),
    partId: `staff-${occurrence.staffNumber}:voice-${occurrence.voiceId ?? '1'}`,
    parseConfidence: 1,
    runtimeOccurrenceId: occurrence.occurrenceId,
  }));

  // Gated fingerprint with the COMMON frozen plannerVersion (R2-1 §2). Empty
  // plans legitimately fail here with EMPTY_PLAN; that is recorded, not thrown.
  let fingerprint: string | null = null;
  let fingerprintErrorCode: string | null = null;
  try {
    fingerprint = planFingerprintV1({
      document,
      report,
      plan,
      plannerVersion: config.plannerVersion,
      partId: config.partId,
      range: config.range,
      hand: config.hand,
      handMapping: config.handMapping,
      repeatSelection: config.repeatSelection,
      bpm: bpmRationalV1(config),
      ticksPerQuarter: config.ticksPerQuarter,
      countInBeats: countInBeatsRational(config),
    });
  } catch (error) {
    fingerprintErrorCode = (error as { code?: string }).code ?? 'UNKNOWN';
  }

  const candidate: ParityCandidate = {
    side: 'ts-legacy-reference',
    kind: 'candidate',
    occurrences: plan.occurrences.map((occurrence) => toCanonicalOccurrence(occurrence)),
    groups,
    atoms,
    scoreEvents,
    runtimeIds: {
      planId: plan.planId,
      occurrenceIds: plan.occurrences.map((o) => o.occurrenceId),
      groupIds: plan.groups.map((g) => g.groupId),
    },
    wireMs: wireEvents.map((event) => ({
      scoreEventId: event.scoreEventId,
      beatPosition: event.beatPosition,
      targetOnsetMs: event.targetOnsetMs,
      targetDurationMs: event.targetDurationMs,
    })),
  };

  return {
    candidate,
    fingerprint,
    fingerprintErrorCode,
    importStatus: report.status,
    importStrictAllowed: report.strictAllowed,
    planStrictAllowed: planResult.strictAllowed,
    planIssues: planResult.issues.map((issue) => ({ code: issue.code, blocksStrict: issue.blocksStrict })),
    scopeCodes,
    missingEventIds,
    atomIssueCodes: atomResult.issues.map((issue) => issue.code),
  };
}

/** Re-runs the fingerprint on the same frozen inputs; L1 stability evidence. */
export function fingerprintStable(xml: string, fileName: string, config: ParityCaseConfig): boolean {
  const first = buildTsCandidate(xml, fileName, config);
  const second = buildTsCandidate(xml, fileName, config);
  if (first.fingerprint !== null || second.fingerprint !== null) {
    return first.fingerprint !== null && first.fingerprint === second.fingerprint;
  }
  // Blocked plans never reach a hash: stability = deterministic rejection
  // with the SAME gate error code on both runs.
  return first.fingerprintErrorCode !== null
    && first.fingerprintErrorCode === second.fingerprintErrorCode;
}

// ---------------------------------------------------------------------------
// Offline P1-3 invariant recheck (R2-1 §4 L3; exact — no 0.5 ms tolerance).
// ---------------------------------------------------------------------------

export interface InvariantCheck {
  check: string;
  status: 'pass' | 'fail';
  detail?: string;
}

export function computeL3Invariants(candidate: ParityCandidate, config: ParityCaseConfig): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  const beatOfTick = (tick: number) => rational(tick, config.ticksPerQuarter);
  const parseBeatText = (text: string) => rational(Number(text.split('/')[0]), Number(text.split('/')[1]));

  // 1. Each onset group maps to exactly one note atom (same onset µs set).
  const groupOnsetUs = candidate.groups.map((group) =>
    config.countInUs + beatToUs(parseBeatText(group.playbackBeat), config));
  const atomOnsetUs = candidate.atoms.map((atom) =>
    config.countInUs + beatToUs(beatOfTick(atom.startTick), config));
  const groupSet = [...new Set(groupOnsetUs)].sort((a, b) => a - b).join(',');
  const atomSet = [...new Set(atomOnsetUs)].sort((a, b) => a - b).join(',');
  checks.push({
    check: 'onset-group set == atom onset set (exact µs)',
    status: groupSet === atomSet ? 'pass' : 'fail',
    detail: `groups=[${groupSet}] atoms=[${atomSet}]`,
  });

  // 2. Atom nominal duration (tick grid) equals its group's LONGEST member.
  const durationsByGroupKey = new Map<string, number[]>();
  for (const group of candidate.groups) {
    durationsByGroupKey.set(`${group.passIndex}@${group.playbackBeat}`, []);
  }
  for (const occurrence of candidate.occurrences) {
    durationsByGroupKey.get(`${occurrence.passIndex}@${occurrence.playbackBeat}`)
      ?.push(beatToUs(parseBeatText(occurrence.durationBeat), config));
  }
  let durationsOk = candidate.groups.length === candidate.atoms.length;
  const atomsByOnsetUs = new Map(atomOnsetUs.map((us, index) => [us, candidate.atoms[index]]));
  candidate.groups.forEach((group, index) => {
    const onsetUs = groupOnsetUs[index];
    const atom = atomsByOnsetUs.get(onsetUs);
    if (!atom) {
      durationsOk = false;
      return;
    }
    const longest = Math.max(...(durationsByGroupKey.get(`${group.passIndex}@${group.playbackBeat}`) ?? [0]), 0);
    const nominal = beatToUs(beatOfTick(atom.durationTicks), config);
    if (nominal !== longest) durationsOk = false;
  });
  checks.push({
    check: 'atom nominal duration == longest member duration (exact µs)',
    status: durationsOk ? 'pass' : 'fail',
  });

  // 3. Measure coverage: scoreEvents measures == atom bars.
  const measureSet = [...new Set(candidate.scoreEvents.map((e) => e.measure))].sort((a, b) => a - b).join(',');
  const barSet = [...new Set(candidate.atoms.map((a) => a.bar))].sort((a, b) => a - b).join(',');
  checks.push({
    check: 'scoreEvents measure set == atom bar set',
    status: measureSet === barSet ? 'pass' : 'fail',
    detail: `scoreEvents=[${measureSet}] atoms=[${barSet}]`,
  });

  // 4. Tick grid: integer ticks ≥ 0 / ≥ 1 — the builder already refuses
  //    non-divisible beats (tick_grid_rounding); this re-verifies the shape.
  const gridOk = candidate.atoms.every((atom) =>
    Number.isInteger(atom.startTick) && atom.startTick >= 0
    && Number.isInteger(atom.durationTicks) && atom.durationTicks >= 1);
  checks.push({ check: 'atom ticks are exact integers on the PPQ grid', status: gridOk ? 'pass' : 'fail' });

  return checks;
}
