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
//              (buildParityCandidateV1) and projected onto the frozen
//              ParityCandidate shape.
// Both candidates are diffed against the INDEPENDENT expected under the
// frozen predicate (diffCandidates + reportPasses: semantic-defect /
// unclassified / unsupported-behavior must all be zero). L1: the a3 gate
// over the Rust plan must reproduce the TS gate fingerprint byte-for-byte
// (or its exact frozen error code on the blocked case), and both sides must
// be stable across runs. L3: computeL3Invariants re-verifies the Rust
// candidate's exact-integer µs world.
//
// A machine-readable report (r2-3c-dual-run-report-v1 shape — the frozen
// parity-diff-report-v1 schema's rustSide is a const for the R2-2 era and
// must not be retconned) is written when GENERATE_R2C_REPORT=1; the
// acceptance assertions run on EVERY invocation and a semantic or
// unclassified difference fails vitest → non-zero exit.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

interface CaseOutcome {
  caseId: string;
  l1: {
    status: 'pass' | 'fail';
    tsFingerprint: string | null;
    rustFingerprint: string | null;
    fingerprintErrorCode: string | null;
    stableAcrossRuns: boolean;
    note: string;
  };
  l2: Record<'tsVsExpected' | 'rustVsExpected', { pass: boolean; diffCount: number; categories: Record<string, number> }>;
  l3: { status: 'pass' | 'fail'; scoreEventCount: number; invariants: Array<{ check: string; status: string }> };
  blocked: { isBlockedCase: boolean; errorCode: string | null };
}

function rustHeadSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const index = loadCaseIndex(root);
const bundles = [...index.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));

function runRust(config: ParityCaseConfig, document: unknown, report: unknown): { result: RustParityResult; plan: unknown } {
  const documentJson = JSON.stringify(document);
  const reportJson = JSON.stringify(report);
  const configJson = JSON.stringify(config);
  const result = JSON.parse(native.buildParityCandidateV1(documentJson, reportJson, configJson)) as RustParityResult;
  const plan = JSON.parse(native.buildPlanV1(documentJson, reportJson, configJson));
  return { result, plan };
}

function rustFingerprint(recordDocument: unknown, recordReport: unknown, plan: unknown, config: ParityCaseConfig): { fingerprint: string | null; errorCode: string | null } {
  try {
    const fingerprint = native.planFingerprintV1Gate(
      JSON.stringify(recordDocument),
      JSON.stringify(recordReport),
      JSON.stringify(plan),
      JSON.stringify(config),
    );
    return { fingerprint, errorCode: null };
  } catch (error) {
    // NAPI rejections carry "<CODE>: <message>" — the frozen ContractError code.
    const message = error instanceof Error ? error.message : String(error);
    return { fingerprint: null, errorCode: message.split(':')[0]?.trim() ?? 'UNKNOWN' };
  }
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
    const { xml, fileName } = loadFixtureXml(root, bundle);
    const expected = loadExpected(root, bundle);

    // TS side, live.
    const ts = buildTsCandidate(xml, fileName, config);
    // Rust side, live via NAPI.
    const imported = { document: null as unknown, report: null as unknown };
    {
      // The corpus record froze the V1 document/report pair for this fixture;
      // the Rust planner consumes exactly those frozen instances.
      const record = JSON.parse(readFileSync(
        join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', `${caseId}.json`), 'utf8'));
      imported.document = record.document;
      imported.report = record.report;
    }
    const { result: rust, plan } = runRust(config, imported.document, imported.report);
    const rustGate = rustFingerprint(imported.document, imported.report, plan, config);
    const rustGateAgain = rustFingerprint(imported.document, imported.report, plan, config);

    const tsVsExpected = diffAgainstExpected(expected, ts.candidate);
    const rustVsExpected = diffAgainstExpected(expected, rust.candidate);

    const invariants = computeL3Invariants(rust.candidate, config);
    const l3Pass = invariants.every((check) => check.status === 'pass');

    const isBlocked = ts.fingerprintErrorCode !== null;
    // Determinism: the Rust gate must give the SAME result on a second run
    // (same fingerprint when passing, same code when rejecting).
    const stable = isBlocked
      ? rustGate.errorCode !== null && rustGate.errorCode === rustGateAgain.errorCode
      : rustGate.fingerprint !== null && rustGate.fingerprint === rustGateAgain.fingerprint;

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

    it(`${caseId}: L1 fingerprint + L3 invariants + planner metadata`, () => {
      // L1: cross-language fingerprint equality (or the same frozen error).
      expect(rustGate.errorCode).toBe(ts.fingerprintErrorCode);
      if (isBlocked) {
        expect(rustGate.fingerprint).toBeNull();
      } else {
        expect(rustGate.fingerprint).toBe(ts.fingerprint);
      }
      // Stability across runs on the Rust side.
      expect(stable, 'rust gate result must be deterministic across runs').toBe(true);
      // L3: exact-integer invariant recheck over the Rust candidate.
      expect(l3Pass, `invariants: ${JSON.stringify(invariants)}`).toBe(true);
      // Planner-domain metadata (corpus-frozen TS meta vs live Rust meta).
      expect(rust.meta.planStrictAllowed).toBe(record0Meta(caseId).planStrictAllowed);
      expect(rust.meta.planIssues).toEqual(record0Meta(caseId).planIssues);
      expect(rust.meta.scopeCodes).toEqual(record0Meta(caseId).scopeCodes);
      expect(rust.meta.missingEventIds).toEqual(record0Meta(caseId).missingEventIds);
      expect(rust.meta.atomIssueCodes).toEqual(record0Meta(caseId).atomIssueCodes);
    });

    outcomes.push({
      caseId,
      l1: {
        status: rustGate.errorCode === ts.fingerprintErrorCode
          && (isBlocked || rustGate.fingerprint === ts.fingerprint) ? 'pass' : 'fail',
        tsFingerprint: ts.fingerprint,
        rustFingerprint: rustGate.fingerprint,
        fingerprintErrorCode: rustGate.errorCode,
        stableAcrossRuns: stable,
        note: 'rust gate (NAPI) vs ts gate (live) on the same frozen inputs; expected side is the independent truth',
      },
      l2: {
        tsVsExpected: { pass: tsVsExpected.pass, diffCount: tsVsExpected.diffCount, categories: tsVsExpected.categories },
        rustVsExpected: { pass: rustVsExpected.pass, diffCount: rustVsExpected.diffCount, categories: rustVsExpected.categories },
      },
      l3: {
        status: l3Pass ? 'pass' : 'fail',
        scoreEventCount: rust.candidate.scoreEvents.length,
        invariants: invariants.map(({ check, status }) => ({ check, status })),
      },
      blocked: { isBlockedCase: isBlocked, errorCode: rustGate.errorCode },
    });
  }

  // NAPI failure-chain checks: contract errors must stay code-identifiable
  // across the Node boundary (not generic opaque errors).
  it('NAPI rejections keep the frozen ContractError code identifiable', () => {
    const malformed = (() => { try { native.buildPlanV1('{not json', '{}', '{}'); return 'no-error'; } catch (error) { return String(error instanceof Error ? error.message : error); } })();
    expect(malformed.split(':')[0]?.trim()).toBe('SCHEMA_VIOLATION');

    // A semantically invalid config must surface its frozen code, too.
    const record = JSON.parse(readFileSync(
      join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G1-base.json'), 'utf8'));
    const badConfig = { ...record.config, bpm: { numerator: 400, denominator: 1 } };
    let badConfigMessage = 'no-error';
    try {
      native.buildPlanV1(JSON.stringify(record.document), JSON.stringify(record.report), JSON.stringify(badConfig));
    } catch (error) {
      badConfigMessage = String(error instanceof Error ? error.message : error);
    }
    expect(badConfigMessage.split(':')[0]?.trim()).toBe('INVALID_BPM');

    // The blocked empty plan keeps its frozen payload rejection code.
    const blockedRecord = JSON.parse(readFileSync(
      join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G3-range-m2.json'), 'utf8'));
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

  // Machine-readable dual-run report (auditable, repeatable). Written only
  // when GENERATE_R2C_REPORT=1; the acceptance assertions above run always.
  it('summarizes the dual run and emits the auditable report', () => {
    expect(outcomes).toHaveLength(15);
    const failing = outcomes.filter((outcome) => outcome.l1.status !== 'pass'
      || !outcome.l2.tsVsExpected.pass || !outcome.l2.rustVsExpected.pass
      || outcome.l3.status !== 'pass');
    expect(failing, `failing cases: ${failing.map((outcome) => outcome.caseId).join(', ') || 'none'}`).toEqual([]);

    const summary = {
      cases: outcomes.length,
      fingerprintPasses: outcomes.filter((outcome) => outcome.l1.status === 'pass').length,
      semanticDiffTotal: Object.values(outcomes)
        .flatMap((outcome) => [outcome.l2.tsVsExpected, outcome.l2.rustVsExpected])
        .reduce((total, side) => total + (side.categories['semantic-defect'] ?? 0), 0),
      unclassifiedTotal: Object.values(outcomes)
        .flatMap((outcome) => [outcome.l2.tsVsExpected, outcome.l2.rustVsExpected])
        .reduce((total, side) => total + (side.categories['unclassified'] ?? 0), 0),
      unsupportedTotal: Object.values(outcomes)
        .flatMap((outcome) => [outcome.l2.tsVsExpected, outcome.l2.rustVsExpected])
        .reduce((total, side) => total + (side.categories['unsupported-behavior'] ?? 0), 0),
      allPass: failing.length === 0,
    };
    expect(summary.semanticDiffTotal).toBe(0);
    expect(summary.unclassifiedTotal).toBe(0);
    expect(summary.unsupportedTotal).toBe(0);
    expect(summary.allPass).toBe(true);

    if (process.env.GENERATE_R2C_REPORT === '1') {
      const report = {
        schemaVersion: 'r2-3c-dual-run-report-v1',
        // meta-only fields (never feed comparisons).
        generatedAt: new Date().toISOString(),
        command: 'GENERATE_R2C_REPORT=1 npx vitest run src/score-engine/parity/rust-parity.test.ts',
        sides: {
          expected: {
            kind: 'independent truth via loadExpected (golden-fixture converter / hand-derived expected files)',
            ref: 'audit-r1/fixtures/parity-cases/index.json + expected/golden refs',
          },
          ts: { kind: 'candidate', pipeline: 'buildTsCandidate (live)', plannerVersion: 'parity-harness-1' },
          rust: {
            kind: 'candidate', pipeline: 'build_plan_v1 via NAPI buildParityCandidateV1 (live)',
            plannerVersion: 'parity-harness-1', gitSha: rustHeadSha(),
          },
        },
        cases: outcomes,
        summary,
        boundary: {
          productionAuthoritySwitch: 'FORBIDDEN until TS_RUST_PARITY_GATE_V1 §8 seven-evidence package is complete',
          note: 'R2-3c proves the dual-run link, not the migration gate',
        },
      };
      const reportDir = join(root, 'audit-r1', 'reports', 'r2-3');
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(join(reportDir, 'r2-3c-dual-run-report.json'),
        `${JSON.stringify(report, null, 1)}\n`);
    }
  });
});

/** Corpus-frozen planner metadata per case (recorded at generation time). */
function record0Meta(caseId: string): {
  planStrictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
} {
  const record = JSON.parse(readFileSync(
    join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', `${caseId}.json`), 'utf8'));
  return record.meta;
}
