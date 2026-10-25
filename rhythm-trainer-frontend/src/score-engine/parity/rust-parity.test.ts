// R2-3c: the dual-run acceptance with INDEPENDENT truth.
//
// For every frozen parity case the SAME frozen inputs (bundle fixture +
// config from the committed case index) drive THREE sides:
//   expected — the independent truth via `loadExpected` (golden-fixture
//              converter or hand-derived expected file; NEVER a live
//              pipeline output, so both pipelines can be wrong together
//              without this harness noticing);
//   ts       — the TS reference pipeline, live via buildTsCandidate;
//   rust     — the Rust planner, live via the NAPI surface
//              (buildPlanV1 + buildParityCandidateV1) and projected onto
//              the frozen ParityCandidate shape.
//
// Acceptance per case (review-hardened):
//   - BOTH candidates are diffed against the INDEPENDENT expected under the
//     frozen predicate (diffCandidates + reportPasses: semantic-defect /
//     unclassified / unsupported-behavior must all be zero);
//   - the frozen case-index `expectedOutcome` (planStatus / issueCodes /
//     fingerprintErrorCode / scopeCodes, where present) is checked against
//     BOTH sides — agreeing with each other is not enough, both must meet
//     the frozen expectation;
//   - L1: the a3 gate over the Rust plan must reproduce the TS gate
//     fingerprint byte-for-byte (or its exact frozen error code);
//   - STABILITY is proven by running each pipeline's FULL flow TWICE on the
//     frozen inputs (not by re-hashing one plan): candidate JSON identical
//     AND gate result identical;
//   - L3: computeL3Invariants re-verifies the Rust candidate's exact-integer
//     µs world.
//
// The machine-readable report (r2-3c-dual-run-report-v1 shape — the frozen
// parity-diff-report-v1 schema's rustSide is a const for the R2-2 era and
// must not be retconned) is written BEFORE the final pass/fail assertion so
// a failing run still leaves auditable JSON evidence; it carries the FULL
// diff objects (path/category/ruleRef/attribution) per case and side, plus
// contract metadata (plannerVersion, fingerprintSchemaVersion,
// timeConversion) and both sides' git SHA. Every assertion failure fails
// vitest → non-zero exit.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findRepoRoot,
  loadCaseIndex,
  loadExpected,
  loadFixtureXml,
} from './case-bundle';
import { buildTsCandidate, computeL3Invariants, type ParityCaseConfig } from './parity-candidate';
import {
  categorize,
  diffCandidates,
  reportPasses,
  type ParityCandidate,
  type ParityDiff,
} from './parity-diff';

const require = createRequire(import.meta.url);
const root = findRepoRoot();
// The hand-maintained NAPI loader (bindings/node/index.js) — the same module
// the production engine server loads. R2-3c exports are additive.
const native = require(join(root, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

interface RustParityResult {
  candidate: ParityCandidate;
  meta: {
    planStrictAllowed: boolean;
    planIssues: Array<{ code: string; blocksStrict: boolean }>;
    scopeCodes: string[];
    missingEventIds: string[];
    atomIssueCodes: string[];
  };
}

interface ExpectedOutcome {
  planStatus: 'strict' | 'blocked';
  issueCodes?: string[];
  fingerprintErrorCode?: string;
  scopeCodes?: string[];
}

interface CaseOutcome {
  caseId: string;
  l1: {
    status: 'pass' | 'fail';
    tsFingerprint: string | null;
    rustFingerprint: string | null;
    fingerprintErrorCode: string | null;
    stableAcrossRuns: boolean;
    stability: {
      tsCandidateIdentical: boolean;
      tsGateIdentical: boolean;
      rustCandidateIdentical: boolean;
      rustPlanIdentical: boolean;
      rustGateIdentical: boolean;
    };
    note: string;
  };
  l2: {
    tsVsExpected: { pass: boolean; diffCount: number; categories: Record<string, number>; diffs: ParityDiff[] };
    rustVsExpected: { pass: boolean; diffCount: number; categories: Record<string, number>; diffs: ParityDiff[] };
  };
  l3: { status: 'pass' | 'fail'; scoreEventCount: number; invariants: Array<{ check: string; status: string }> };
  expectedOutcome: {
    planStatus: 'strict' | 'blocked';
    planStatusMatch: boolean;
    issueCodesMatch: boolean | null;
    fingerprintErrorCodeMatch: boolean | null;
    scopeCodesMatch: boolean | null;
  };
  blocked: { isBlockedCase: boolean; errorCode: string | null };
}

function headSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const index = loadCaseIndex(root);
const bundles = [...index.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));

interface RustRun {
  candidate: ParityCandidate;
  meta: RustParityResult['meta'];
  plan: unknown;
  fingerprint: string | null;
  errorCode: string | null;
}

/** ONE full Rust pipeline run: build plan + candidate projection + gate. */
function runRustFull(config: ParityCaseConfig, document: unknown, report: unknown): RustRun {
  const documentJson = JSON.stringify(document);
  const reportJson = JSON.stringify(report);
  const configJson = JSON.stringify(config);
  const projected = JSON.parse(native.buildParityCandidateV1(documentJson, reportJson, configJson)) as RustParityResult;
  const plan = JSON.parse(native.buildPlanV1(documentJson, reportJson, configJson));
  let fingerprint: string | null = null;
  let errorCode: string | null = null;
  try {
    fingerprint = native.planFingerprintV1Gate(documentJson, reportJson, JSON.stringify(plan), configJson);
  } catch (error) {
    // NAPI rejections carry "<CODE>: <message>" — the frozen ContractError code.
    const message = error instanceof Error ? error.message : String(error);
    errorCode = message.split(':')[0]?.trim() ?? 'UNKNOWN';
  }
  return { candidate: projected.candidate, meta: projected.meta, plan, fingerprint, errorCode };
}

function diffAgainstExpected(expected: ParityCandidate, candidate: ParityCandidate) {
  const diffs = diffCandidates(expected, candidate);
  const categories = categorize(diffs);
  return { pass: reportPasses(categories), diffCount: diffs.length, categories, diffs };
}

describe('R2-3c: TS and Rust pipelines vs INDEPENDENT expected truth', () => {
  it('covers all 15 frozen parity cases', () => {
    expect(bundles).toHaveLength(15);
  });

  const outcomes: CaseOutcome[] = [];

  for (const bundle of bundles) {
    const caseId = bundle.caseId;
    const config = bundle.config as ParityCaseConfig;
    const expectedOutcome = bundle.expectedOutcome as ExpectedOutcome;
    const { xml, fileName } = loadFixtureXml(root, bundle);
    const expected = loadExpected(root, bundle);

    // The frozen V1 document/report pair for this fixture (the Rust planner
    // consumes exactly these instances; the TS pipeline re-imports the XML).
    const record = JSON.parse(readCorpus(caseId));
    const tsRun1 = buildTsCandidate(xml, fileName, config);
    const tsRun2 = buildTsCandidate(xml, fileName, config);
    const rustRun1 = runRustFull(config, record.document, record.report);
    const rustRun2 = runRustFull(config, record.document, record.report);

    const tsVsExpected = diffAgainstExpected(expected, tsRun1.candidate);
    const rustVsExpected = diffAgainstExpected(expected, rustRun1.candidate);
    const invariants = computeL3Invariants(rustRun1.candidate, config);
    const l3Pass = invariants.every((check) => check.status === 'pass');

    // STABILITY: two FULL pipeline runs each — candidates byte-identical and
    // gate results identical (review finding 3: re-hashing one plan is not
    // planner stability).
    const stability = {
      tsCandidateIdentical:
        JSON.stringify(tsRun1.candidate) === JSON.stringify(tsRun2.candidate),
      tsGateIdentical:
        tsRun1.fingerprint === tsRun2.fingerprint
        && tsRun1.fingerprintErrorCode === tsRun2.fingerprintErrorCode,
      rustCandidateIdentical:
        JSON.stringify(rustRun1.candidate) === JSON.stringify(rustRun2.candidate),
      rustPlanIdentical: JSON.stringify(rustRun1.plan) === JSON.stringify(rustRun2.plan),
      rustGateIdentical:
        rustRun1.fingerprint === rustRun2.fingerprint
        && rustRun1.errorCode === rustRun2.errorCode,
    };
    const stableAcrossRuns = Object.values(stability).every(Boolean);

    const isBlocked = tsRun1.fingerprintErrorCode !== null;
    const l1Pass = rustRun1.errorCode === tsRun1.fingerprintErrorCode
      && (isBlocked || rustRun1.fingerprint === tsRun1.fingerprint);

    // Frozen expectedOutcome checks — BOTH sides must meet the case index.
    const planStatusMatch = tsRun1.planStrictAllowed === (expectedOutcome.planStatus === 'strict')
      && rustRun1.meta.planStrictAllowed === (expectedOutcome.planStatus === 'strict');
    const issueCodesMatch = expectedOutcome.issueCodes
      ? sameCodeSet(tsRun1.planIssues.map((issue) => issue.code), expectedOutcome.issueCodes)
        && sameCodeSet(rustRun1.meta.planIssues.map((issue) => issue.code), expectedOutcome.issueCodes)
      : null;
    const fingerprintErrorCodeMatch = expectedOutcome.fingerprintErrorCode !== undefined
      ? tsRun1.fingerprintErrorCode === expectedOutcome.fingerprintErrorCode
        && rustRun1.errorCode === expectedOutcome.fingerprintErrorCode
      : tsRun1.fingerprintErrorCode === null && rustRun1.errorCode === null;
    const scopeCodesMatch = expectedOutcome.scopeCodes
      ? sameOrderInsensitive(tsRun1.scopeCodes, expectedOutcome.scopeCodes)
        && sameOrderInsensitive(rustRun1.meta.scopeCodes, expectedOutcome.scopeCodes)
      : null;

    it(`${caseId}: TS pipeline matches the independent expected (frozen predicate)`, () => {
      expect(
        tsVsExpected.pass,
        `${caseId}: TS vs expected (${JSON.stringify(tsVsExpected.categories)}):\n${JSON.stringify(tsVsExpected.diffs, null, 1)}`,
      ).toBe(true);
    });

    it(`${caseId}: Rust candidate matches the independent expected (frozen predicate)`, () => {
      expect(
        rustVsExpected.pass,
        `${caseId}: Rust vs expected (${JSON.stringify(rustVsExpected.categories)}):\n${JSON.stringify(rustVsExpected.diffs, null, 1)}`,
      ).toBe(true);
    });

    it(`${caseId}: L1 fingerprint + full-run stability + L3 invariants`, () => {
      // L1: cross-language fingerprint equality (or the same frozen error).
      expect(rustRun1.errorCode).toBe(tsRun1.fingerprintErrorCode);
      if (isBlocked) {
        expect(rustRun1.fingerprint).toBeNull();
      } else {
        expect(rustRun1.fingerprint).toBe(tsRun1.fingerprint);
      }
      // Full-pipeline determinism on both sides.
      expect(stableAcrossRuns, `stability: ${JSON.stringify(stability)}`).toBe(true);
      // L3: exact-integer invariant recheck over the Rust candidate.
      expect(l3Pass, `invariants: ${JSON.stringify(invariants)}`).toBe(true);
    });

    it(`${caseId}: frozen expectedOutcome holds for BOTH pipelines`, () => {
      expect(planStatusMatch, `planStatus ${expectedOutcome.planStatus}`).toBe(true);
      expect(issueCodesMatch, `issueCodes ${JSON.stringify(expectedOutcome.issueCodes ?? null)}`).not.toBe(false);
      expect(fingerprintErrorCodeMatch, `fingerprintErrorCode ${expectedOutcome.fingerprintErrorCode ?? null}`).not.toBe(false);
      expect(scopeCodesMatch, `scopeCodes ${JSON.stringify(expectedOutcome.scopeCodes ?? null)}`).not.toBe(false);
      // Planner-domain metadata still matches the corpus-frozen TS meta.
      expect(rustRun1.meta.planIssues).toEqual(record0Meta(caseId).planIssues);
      expect(rustRun1.meta.scopeCodes).toEqual(record0Meta(caseId).scopeCodes);
      expect(rustRun1.meta.missingEventIds).toEqual(record0Meta(caseId).missingEventIds);
      expect(rustRun1.meta.atomIssueCodes).toEqual(record0Meta(caseId).atomIssueCodes);
    });

    outcomes.push({
      caseId,
      l1: {
        status: l1Pass ? 'pass' : 'fail',
        tsFingerprint: tsRun1.fingerprint,
        rustFingerprint: rustRun1.fingerprint,
        fingerprintErrorCode: rustRun1.errorCode,
        stableAcrossRuns,
        stability,
        note: 'both pipelines executed TWICE in full; stability = identical candidates/plans AND identical gate results',
      },
      l2: {
        tsVsExpected: {
          pass: tsVsExpected.pass, diffCount: tsVsExpected.diffCount,
          categories: tsVsExpected.categories, diffs: tsVsExpected.diffs,
        },
        rustVsExpected: {
          pass: rustVsExpected.pass, diffCount: rustVsExpected.diffCount,
          categories: rustVsExpected.categories, diffs: rustVsExpected.diffs,
        },
      },
      l3: {
        status: l3Pass ? 'pass' : 'fail',
        scoreEventCount: rustRun1.candidate.scoreEvents.length,
        invariants: invariants.map(({ check, status }) => ({ check, status })),
      },
      expectedOutcome: {
        planStatus: expectedOutcome.planStatus,
        planStatusMatch,
        issueCodesMatch,
        fingerprintErrorCodeMatch,
        scopeCodesMatch,
      },
      blocked: { isBlockedCase: isBlocked, errorCode: rustRun1.errorCode },
    });
  }

  // NAPI failure-chain checks: contract errors must stay code-identifiable
  // across the Node boundary (not generic opaque errors).
  it('NAPI rejections keep the frozen ContractError code identifiable', () => {
    const malformed = (() => { try { native.buildPlanV1('{not json', '{}', '{}'); return 'no-error'; } catch (error) { return String(error instanceof Error ? error.message : error); } })();
    expect(malformed.split(':')[0]?.trim()).toBe('SCHEMA_VIOLATION');

    const record = JSON.parse(readCorpus('G1-base'));
    const badConfig = { ...record.config, bpm: { numerator: 400, denominator: 1 } };
    let badConfigMessage = 'no-error';
    try {
      native.buildPlanV1(JSON.stringify(record.document), JSON.stringify(record.report), JSON.stringify(badConfig));
    } catch (error) {
      badConfigMessage = String(error instanceof Error ? error.message : error);
    }
    expect(badConfigMessage.split(':')[0]?.trim()).toBe('INVALID_BPM');

    const blockedRecord = JSON.parse(readCorpus('G3-range-m2'));
    const plan = JSON.parse(native.buildPlanV1(
      JSON.stringify(blockedRecord.document), JSON.stringify(blockedRecord.report), JSON.stringify(blockedRecord.config)));
    let blockedMessage = 'no-error';
    try {
      native.planFingerprintV1Gate(
        JSON.stringify(blockedRecord.document), JSON.stringify(blockedRecord.report),
        JSON.stringify(plan), JSON.stringify(blockedRecord.config));
    } catch (error) {
      blockedMessage = String(error instanceof Error ? error.message : error);
    }
    expect(blockedMessage.split(':')[0]?.trim()).toBe('PAYLOAD_VALIDATION_FAILED');
  });

  // The report is WRITTEN BEFORE the final pass/fail assertion (review
  // finding 1): a failing run must still leave auditable JSON evidence with
  // the full field-level diffs, then fail vitest → non-zero exit.
  it('writes the auditable dual-run report, then asserts the frozen verdict', () => {
    expect(outcomes).toHaveLength(15);
    const failing = outcomes.filter((outcome) => outcome.l1.status !== 'pass'
      || !outcome.l2.tsVsExpected.pass || !outcome.l2.rustVsExpected.pass
      || outcome.l3.status !== 'pass'
      || !outcome.expectedOutcome.planStatusMatch
      || outcome.expectedOutcome.issueCodesMatch === false
      || outcome.expectedOutcome.fingerprintErrorCodeMatch === false
      || outcome.expectedOutcome.scopeCodesMatch === false
      || !outcome.l1.stableAcrossRuns);

    const sha = headSha();
    const report = {
      schemaVersion: 'r2-3c-dual-run-report-v1',
      // meta-only fields (never feed comparisons).
      generatedAt: new Date().toISOString(),
      command: 'npx vitest run src/score-engine/parity/rust-parity.test.ts',
      sides: {
        expected: {
          kind: 'independent truth via loadExpected (golden-fixture converter / hand-derived expected files)',
          ref: 'audit-r1/fixtures/parity-cases/index.json + expected/golden refs',
        },
        ts: {
          kind: 'candidate', pipeline: 'buildTsCandidate (live, run twice for stability)',
          plannerVersion: 'parity-harness-1', gitSha: sha,
          gitShaNote: 'single repo: TS and Rust sources are pinned by the same commit',
        },
        rust: {
          kind: 'candidate', pipeline: 'build_plan_v1 + build_parity_candidate_v1 via NAPI (live, run twice for stability)',
          plannerVersion: 'parity-harness-1', gitSha: sha,
          gitShaNote: 'single repo: TS and Rust sources are pinned by the same commit',
        },
      },
      contract: {
        // Frozen contract metadata (case index ruleVersions; the report-shape
        // version above is NOT a contract version).
        plannerVersion: 'parity-harness-1',
        fingerprintSchemaVersion: bundles[0]?.ruleVersions.fingerprintSchemaVersion ?? null,
        timeConversion: bundles[0]?.ruleVersions.timeConversion ?? null,
        parityGateDoc: bundles[0]?.ruleVersions.parityGateDoc ?? null,
      },
      cases: outcomes,
      summary: {
        cases: outcomes.length,
        fingerprintPasses: outcomes.filter((outcome) => outcome.l1.status === 'pass').length,
        stabilityPasses: outcomes.filter((outcome) => outcome.l1.stableAcrossRuns).length,
        semanticDiffTotal: flatL2(outcomes)
          .reduce((total, side) => total + (side.categories['semantic-defect'] ?? 0), 0),
        unclassifiedTotal: flatL2(outcomes)
          .reduce((total, side) => total + (side.categories['unclassified'] ?? 0), 0),
        unsupportedTotal: flatL2(outcomes)
          .reduce((total, side) => total + (side.categories['unsupported-behavior'] ?? 0), 0),
        allPass: failing.length === 0,
      },
      boundary: {
        productionAuthoritySwitch: 'FORBIDDEN until TS_RUST_PARITY_GATE_V1 §8 seven-evidence package is complete',
        note: 'R2-3c proves the dual-run link, not the migration gate',
      },
    };
    const reportDir = join(root, 'audit-r1', 'reports', 'r2-3');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'r2-3c-dual-run-report.json'),
      `${JSON.stringify(report, null, 1)}\n`);

    // AFTER the report is on disk: the frozen verdict.
    expect(failing, `failing cases: ${failing.map((outcome) => outcome.caseId).join(', ') || 'none'}`).toEqual([]);
    expect(report.summary.semanticDiffTotal).toBe(0);
    expect(report.summary.unclassifiedTotal).toBe(0);
    expect(report.summary.unsupportedTotal).toBe(0);
    expect(report.summary.allPass).toBe(true);
  });
});

function flatL2(outcomes: CaseOutcome[]) {
  return outcomes.flatMap((outcome) => [outcome.l2.tsVsExpected, outcome.l2.rustVsExpected]);
}

function sameCodeSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().join(',') === [...expected].sort().join(',');
}

function sameOrderInsensitive(actual: string[], expected: string[]): boolean {
  return sameCodeSet(actual, expected);
}

/** Corpus-frozen planner metadata per case (recorded at generation time). */
function record0Meta(caseId: string): {
  planStrictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
} {
  const record = JSON.parse(readCorpus(caseId));
  return record.meta;
}

function readCorpus(caseId: string): string {
  // Lazy import keeps the corpus reader next to its only callers above.
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return readFileSync(join(
    root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', `${caseId}.json`), 'utf8');
}
