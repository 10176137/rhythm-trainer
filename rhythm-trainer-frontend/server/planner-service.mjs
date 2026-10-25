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
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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
    /** The rust generation chain. Throws coded PlannerGateError rejections —
     * there is deliberately NO TS fallback here. */
    buildRustPlan({ document, report, config }) {
      if (authority !== 'rust') {
        throw new PlannerGateError('PLANNER_PATH_DISABLED',
          `planner authority is '${authority}'; the rust planning path is not enabled`);
      }
      if (!document || !report || !config) {
        throw new PlannerGateError('INVALID_REQUEST', 'document, report and config are all required');
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
