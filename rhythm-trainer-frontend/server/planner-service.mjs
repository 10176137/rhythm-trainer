// R2-3g: the server-side Rust planner generation chain (execution
// architecture ADR R2-3f, option A). One module owns the whole path:
//
//   request validation -> trusted plannerVersion -> build_plan_v1 ->
//   plan_fingerprint_v1_gate (same inputs, exactly once) -> response
//   assembly (plan + plannerVersion + plannerAuthority + planFingerprint)
//
// plus the two session guards (timeline / follow) the strict-practice
// launch must pass. The rust path is DISABLED unless the authority is
// explicitly 'rust' (env RHYTHM_PLANNER, default 'rts'); a failed or
// disabled Rust path NEVER falls back to the TS planner — the caller
// receives a coded rejection instead of a plan.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Native-ESM-safe module directory resolution (review finding 1):
// __dirname does not exist in ESM; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const native = require(path.join(ROOT, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

/** Server-trusted planner version (GAP-3): used for plan generation, the
 * fingerprint gate and trace records — never echoed from the client. */
export const RUST_PLANNER_VERSION = 'rust-planner-1';

const AUTHORITIES = ['rts', 'rust'];

export class PlannerGateError extends Error {
  constructor(code, details) {
    super(`${code}: ${details ?? ''}`);
    this.name = 'PlannerGateError';
    this.code = code;
    this.details = details ?? '';
  }
}

/** Resolves the planner authority: explicit argument wins, then the
 * RHYTHM_PLANNER env var, then the frozen default 'rts'. Unknown values are
 * a coded rejection (fail-closed), never a silent choice. */
export function resolvePlannerAuthority(explicit) {
  const value = explicit ?? process.env.RHYTHM_PLANNER ?? 'rts';
  if (!AUTHORITIES.includes(value)) {
    throw new PlannerGateError('INVALID_PLANNER_AUTHORITY',
      `RHYTHM_PLANNER must be rts|rust, got '${value}'`);
  }
  return value;
}

function parseJson(text, field) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PlannerGateError('INVALID_REQUEST', `${field} is not valid JSON: ${error.message}`);
  }
}

/** Timeline guard: ALL conditions below must hold before session.begin.
 * A failure accumulates a coded rejection — nothing is patched, guessed or
 * rounded to make the plan usable. */
export function assertTimelineUsable(response) {
  const failures = [];
  if (response.strictAllowed !== true) failures.push('planStrictAllowed');
  if ((response.scopeCodes ?? []).length > 0) failures.push(`scopeCodes:${response.scopeCodes.join('|')}`);
  if ((response.missingEventIds ?? []).length > 0) failures.push(`missingEventIds:${response.missingEventIds.length}`);
  if ((response.atomIssueCodes ?? []).length > 0) failures.push(`atomIssueCodes:${response.atomIssueCodes.join('|')}`);

  const plan = response.plan ?? {};
  const occurrences = plan.occurrences ?? [];
  const groups = plan.groups ?? [];
  const atoms = plan.atoms ?? [];
  const scoreEvents = plan.scoreEvents ?? [];

  if (atoms.length === 0) failures.push('atoms:empty');
  if (atoms.length !== groups.length) failures.push(`atoms:count ${atoms.length}!=groups ${groups.length}`);
  if (scoreEvents.length !== occurrences.length) failures.push(`scoreEvents:count ${scoreEvents.length}!=occurrences ${occurrences.length}`);

  // scoreEvents ↔ occurrences identity, count and measure coverage.
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const eventIds = new Set(scoreEvents.map((event) => event.runtimeOccurrenceId));
  if (eventIds.size !== occurrences.length
    || occurrences.some((occurrence) => !eventIds.has(occurrence.occurrenceId))) {
    failures.push('scoreEvents:identity');
  }
  const measureSet = new Set(scoreEvents.map((event) => event.measure));
  const barSet = new Set(atoms.map((atom) => atom.bar));
  if (measureSet.size !== barSet.size || [...barSet].some((bar) => !measureSet.has(bar))) {
    failures.push('scoreEvents:measureCoverage');
  }

  if (typeof response.planFingerprint !== 'string'
    || !/^plan-v1:sha256:[0-9a-f]{64}$/.test(response.planFingerprint)) {
    failures.push('planFingerprint:missing');
  }
  if (failures.length > 0) {
    throw new PlannerGateError('TIMELINE_PLAN_REJECTED', failures.join('; '));
  }
  return true;
}

/** Follow guard: only what follow actually consumes (groups/occurrences
 * integrity + strict allowance + scope/missing). Atoms and scoreEvents are
 * NOT follow dependencies and deliberately not checked here. */
export function assertFollowUsable(response) {
  const failures = [];
  if (response.strictAllowed !== true) failures.push('planStrictAllowed');
  if ((response.scopeCodes ?? []).length > 0) failures.push(`scopeCodes:${response.scopeCodes.join('|')}`);
  if ((response.missingEventIds ?? []).length > 0) failures.push(`missingEventIds:${response.missingEventIds.length}`);

  const plan = response.plan ?? {};
  const occurrences = plan.occurrences ?? [];
  const groups = plan.groups ?? [];
  if (groups.length === 0) failures.push('groups:empty');
  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.occurrenceId));
  if (occurrenceIds.size !== occurrences.length) failures.push('occurrences:identity');
  for (const group of groups) {
    if (group.occurrenceIds.length !== group.members.length
      || group.occurrenceIds.length !== group.scoreEventIds.length) {
      failures.push(`groups:${group.playbackBeat}:member-count`);
    }
    for (const occurrenceId of group.occurrenceIds) {
      if (!occurrenceIds.has(occurrenceId)) failures.push(`groups:${group.playbackBeat}:dangling-occurrence`);
    }
  }
  if (typeof response.planFingerprint !== 'string'
    || !/^plan-v1:sha256:[0-9a-f]{64}$/.test(response.planFingerprint)) {
    failures.push('planFingerprint:missing');
  }
  if (failures.length > 0) {
    throw new PlannerGateError('FOLLOW_PLAN_REJECTED', failures.join('; '));
  }
  return true;
}

/** Frozen GAP-5 rule: canonical integer microseconds -> wire milliseconds,
 * one division, no rounding, no second conversion. */
export function usToMs(canonicalUs) {
  return canonicalUs / 1000;
}

/** Parses a reduced "n/d" canonical beat into {numerator, denominator}. */
function parseBeatText(text, field) {
  const match = /^(-?\d+)\/([1-9]\d*)$/.exec(String(text));
  if (!match) throw new PlannerGateError('PLAN_SHAPE_INVALID', `${field}: malformed rational '${text}'`);
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

const beatJson = (beat) => JSON.stringify(beat);
const bpmJsonOf = (bpm) => JSON.stringify(bpm);

/**
 * Deep timeline verification (review finding 2) against the plan's OWN
 * trusted generation config, using the frozen Rust time primitive:
 *  - scoreEvent.runtimeOccurrenceId <-> occurrence bijection;
 *  - targetOnsetUs === countInUs + beatToMicroseconds(playbackBeat, bpm);
 *  - targetDurationUs === beatToMicroseconds(durationBeat, bpm);
 *  - every group's atom startTick/durationTicks === playbackBeat/durationBeat
 *    scaled onto the ticksPerQuarter grid, exactly;
 *  - no duplicate/missing/unmappable events.
 * Runs on the SERVER path (verifyPlanIntegrity) before a plan is released —
 * not only in tests. Any failure is a coded rejection; nothing is rounded,
 * patched or degraded.
 */
export function verifyTimelineSemantics(plan, config, nativeModule = native) {
  const failures = [];
  const bpmText = bpmJsonOf(config.bpm);
  const us = (beatText, field) => {
    try {
      return nativeModule.beatToMicrosecondsJson(beatJson(parseBeatText(beatText, field)), bpmText);
    } catch (error) {
      failures.push(`${field}:time-primitive:${error.message.split(':')[0]}`);
      return null;
    }
  };
  const beatTicks = (beatText, field) => {
    const { numerator, denominator } = parseBeatText(beatText, field);
    const scaled = numerator * config.ticksPerQuarter;
    if (scaled % denominator !== 0) {
      // Off-grid durations are the planner's OWN tick_grid_rounding case:
      // the atom is legitimately MISSING and atomIssueCodes already rejects
      // strict practice. Record it as informational, not a hard mismatch.
      failures.push(`${field}:off-grid`);
      return null;
    }
    return scaled / denominator;
  };

  const occurrences = plan.occurrences ?? [];
  const scoreEvents = plan.scoreEvents ?? [];
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const seenEventIds = new Set();

  if (scoreEvents.length !== occurrences.length) {
    failures.push(`scoreEvents:count:${scoreEvents.length}!=${occurrences.length}`);
  }
  for (const event of scoreEvents) {
    if (seenEventIds.has(event.runtimeOccurrenceId)) failures.push(`scoreEvents:duplicate:${event.runtimeOccurrenceId}`);
    seenEventIds.add(event.runtimeOccurrenceId);
    const occurrence = occurrenceById.get(event.runtimeOccurrenceId);
    if (!occurrence) {
      failures.push(`scoreEvents:dangling:${event.runtimeOccurrenceId}`);
      continue;
    }
    const expectedOnset = us(occurrence.playbackBeat, `occurrence[${occurrence.occurrenceId}].playbackBeat`);
    if (expectedOnset !== null && event.targetOnsetUs !== config.countInUs + expectedOnset) {
      failures.push(`scoreEvents[${event.runtimeOccurrenceId}].targetOnsetUs:${event.targetOnsetUs}!=${config.countInUs + expectedOnset}`);
    }
    const expectedDuration = us(occurrence.durationBeat, `occurrence[${occurrence.occurrenceId}].durationBeat`);
    if (expectedDuration !== null && event.targetDurationUs !== expectedDuration) {
      failures.push(`scoreEvents[${event.runtimeOccurrenceId}].targetDurationUs:${event.targetDurationUs}!=${expectedDuration}`);
    }
  }
  for (const occurrence of occurrences) {
    if (!seenEventIds.has(occurrence.occurrenceId)) failures.push(`scoreEvents:missing:${occurrence.occurrenceId}`);
  }

  // Group <-> atom: exactly one atom per group, ticks exact. This layer is
  // enforced only when the planner itself reports NO atom issues — when
  // atomIssueCodes is non-empty the affected atoms are legitimately missing
  // and strict practice is already rejected via the atom-issue guard; the
  // verifier must not turn that planner-honest state into a different error.
  const groups = plan.groups ?? [];
  const atoms = plan.atoms ?? [];
  const atomIssues = plan.atomIssueCodes ?? [];
  if (atomIssues.length === 0) {
    if (atoms.length !== groups.length) failures.push(`atoms:count:${atoms.length}!=${groups.length}`);
    const seenAtomBeats = new Set();
    for (const atom of atoms) {
      const matched = groups.find((group) => {
        const start = beatTicks(group.playbackBeat, 'group.playbackBeat');
        const duration = beatTicks(group.durationBeat, 'group.durationBeat');
        return start === atom.startTick && duration === atom.durationTicks && group.bar === atom.bar;
      });
      if (!matched) {
        failures.push(`atom[startTick=${atom.startTick}]:no-exact-group`);
      } else {
        const groupKey = `${matched.passIndex}@${matched.playbackBeat}`;
        if (seenAtomBeats.has(groupKey)) failures.push(`atom:duplicate-group:${groupKey}`);
        seenAtomBeats.add(groupKey);
      }
    }
    if (atoms.length === groups.length) {
      for (const group of groups) {
        const groupKey = `${group.passIndex}@${group.playbackBeat}`;
        if (!seenAtomBeats.has(groupKey)) failures.push(`atom:missing-group:${groupKey}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new PlannerGateError('TIMELINE_SEMANTICS_REJECTED', failures.slice(0, 8).join('; '));
  }
  return true;
}

/**
 * Follow cross-reference verification (review finding 3) between group
 * occurrenceIds / scoreEventIds / members and the occurrences array.
 * Atoms/scoreEvents stay OUT of the follow gate (not consumed).
 */
export function verifyFollowCrossReferences(plan) {
  const failures = [];
  const occurrences = plan.occurrences ?? [];
  const groups = plan.groups ?? [];
  const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const locatorKey = (locator) => `${locator.partId}:m${locator.measureOrdinal}:e${locator.sourceOrdinal}:v${locator.voiceId ?? ''}`;
  const referenced = new Map(); // occurrenceId -> count

  for (const group of groups) {
    const label = `group[${group.passIndex}@${group.playbackBeat}]`;
    if (group.occurrenceIds.length !== group.members.length
      || group.occurrenceIds.length !== group.scoreEventIds.length) {
      failures.push(`${label}:member-count`);
    }
    const within = new Set();
    for (let index = 0; index < group.occurrenceIds.length; index += 1) {
      const occurrenceId = group.occurrenceIds[index];
      if (within.has(occurrenceId)) failures.push(`${label}:duplicate-ref:${occurrenceId}`);
      within.add(occurrenceId);
      const occurrence = occurrenceById.get(occurrenceId);
      if (!occurrence) {
        failures.push(`${label}:dangling:${occurrenceId}`);
        continue;
      }
      referenced.set(occurrenceId, (referenced.get(occurrenceId) ?? 0) + 1);
      if (occurrence.scoreEventId !== group.scoreEventIds[index]) {
        failures.push(`${label}:scoreEventId-mismatch:${group.scoreEventIds[index]}!=${occurrence.scoreEventId}`);
      }
      if (locatorKey(group.members[index]) !== locatorKey(occurrence.locator)) {
        failures.push(`${label}:locator-mismatch`);
      }
    }
  }
  for (const occurrence of occurrences) {
    const count = referenced.get(occurrence.occurrenceId) ?? 0;
    if (count === 0) failures.push(`occurrence:unreferenced:${occurrence.occurrenceId}`);
    if (count > 1) failures.push(`occurrence:multi-referenced:${occurrence.occurrenceId}x${count}`);
  }
  if (failures.length > 0) {
    throw new PlannerGateError('FOLLOW_CROSSREF_REJECTED', failures.slice(0, 8).join('; '));
  }
  return true;
}

/**
 * Creates the planner service bound to one authority. The default authority
 * comes from RHYTHM_PLANNER (default 'rts') — the rust path is disabled
 * unless explicitly selected, and the existing TS path / free play are
 * untouched by this module.
 */
export function createPlannerService({ authority = resolvePlannerAuthority(), nativeModule = native } = {}) {
  if (!AUTHORITIES.includes(authority)) {
    throw new PlannerGateError('INVALID_PLANNER_AUTHORITY', `authority must be rts|rust, got '${authority}'`);
  }
  return {
    authority,
    /** The rust generation chain. `mode` is REQUIRED and must be exactly
     * 'timeline' | 'follow' — the consumption mode decides which deep
     * verifier runs; it is never guessed or defaulted (review F1).
     * Throws coded PlannerGateError rejections — there is deliberately NO
     * TS fallback here. */
    buildRustPlan({ document, report, config, mode }) {
      if (authority !== 'rust') {
        throw new PlannerGateError('PLANNER_PATH_DISABLED',
          `planner authority is '${authority}'; the rust planning path is not enabled`);
      }
      if (!document || !report || !config) {
        throw new PlannerGateError('INVALID_REQUEST', 'document, report and config are all required');
      }
      if (mode !== 'timeline' && mode !== 'follow') {
        throw new PlannerGateError('INVALID_REQUEST',
          `mode must be 'timeline' or 'follow' (the consumption mode is explicit, never inferred), got '${mode}'`);
      }
      // Multi-part strict planning is NOT verified for the Rust planner:
      // reject explicitly instead of returning a plan that may mix parts.
      if (Array.isArray(document.parts) && document.parts.length > 1) {
        throw new PlannerGateError('MULTI_PART_PLANNER_UNSUPPORTED',
          `the rust planner is verified for single-part scores only (got ${document.parts.length} parts)`);
      }
      // plannerVersion allow-list: the client value is rejected unless it
      // matches the server-trusted version; a missing value is filled with
      // the trusted one. Plan generation, the fingerprint gate and the
      // response all use this ONE version.
      if (config.plannerVersion !== undefined && config.plannerVersion !== RUST_PLANNER_VERSION) {
        throw new PlannerGateError('INVALID_PLANNER_VERSION',
          `untrusted plannerVersion '${config.plannerVersion}'; the server only accepts '${RUST_PLANNER_VERSION}'`);
      }
      const trustedConfig = { ...config, plannerVersion: RUST_PLANNER_VERSION };

      const documentJson = JSON.stringify(document);
      const reportJson = JSON.stringify(report);
      const configJson = JSON.stringify(trustedConfig);

      // Step 1: build the canonical plan (document gate + C-12 + planning).
      const plan = JSON.parse(nativeModule.buildPlanV1(documentJson, reportJson, configJson));
      // Step 1b: mode-scoped deep verification against the SAME trusted
      // config, via the SAME injected native module (review F1):
      //  - timeline consumes atoms+scoreEvents -> verifyTimelineSemantics;
      //  - follow consumes groups/occurrences only -> verifyFollowCrossRefs;
      //    failures of unconsumed timeline fields never reject a follow plan.
      if (mode === 'timeline') {
        verifyTimelineSemantics(plan, trustedConfig, nativeModule);
      } else {
        verifyFollowCrossReferences(plan);
      }
      // Step 2: the SEPARATE frozen fingerprint gate over the verbatim plan
      // with the SAME inputs — exactly once, success required.
      const planFingerprint = nativeModule.planFingerprintV1Gate(
        documentJson, reportJson, JSON.stringify(plan), configJson);
      // Step 3: response assembly — plan + trusted version + authority +
      // fingerprint + the planner-domain metadata the launch guards consume.
      return {
        plannerVersion: RUST_PLANNER_VERSION,
        plannerAuthority: 'rust',
        planFingerprint,
        scoreFingerprint: plan.scoreFingerprint,
        strictAllowed: plan.planStrictAllowed === true,
        planIssues: plan.planIssues ?? [],
        scopeCodes: plan.scopeCodes ?? [],
        missingEventIds: plan.missingEventIds ?? [],
        atomIssueCodes: plan.atomIssueCodes ?? [],
        plan,
      };
    },
  };
}
