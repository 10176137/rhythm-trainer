// R2-2a: offline parity runner. Executes frozen case bundles against the
// CURRENT TS pipeline, assembles ParityDiffReportV1 JSON reports and yields a
// process exit code. Usable from vitest (acceptance tests) and from the
// esbuild-bundled CLI (audit-r1/spike/parity-runner.entry.mjs). R2-2 is
// TS-side only: every report states rustSide not-implemented / not-run, and
// L1 verifies TS stability on frozen inputs — never a fake cross-language run.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCORE_ENGINE_VERSION } from '../domain/types';
import { buildTsCandidate, computeL3Invariants, fingerprintStable } from './parity-candidate';
import {
  categorize,
  diffCandidates,
  reportPasses,
} from './parity-diff';
import type { CanonicalOccurrence, ParityCandidate, ParityDiff, ParityReportV1 } from './parity-diff';
import { configFingerprint, findRepoRoot, loadCaseIndex, loadExpected, loadFixtureXml } from './case-bundle';
import type { ParityCaseBundle } from './case-bundle';

export const PARITY_COMMON_PLANNER_VERSION = 'parity-harness-1';
export const PARITY_GATE_DOC = 'audit-r1/docs/TS_RUST_PARITY_GATE_V1.md @ 838cd9b';

export interface RunnerMeta {
  gitSha: string | null;
  command: string;
  root: string;
}

export function currentGitSha(root: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function runCase(bundle: ParityCaseBundle, meta: RunnerMeta): ParityReportV1 {
  // The bundle carries the common frozen plannerVersion explicitly (schema-
  // required); per-implementation version strings never enter the diff.
  const config = bundle.config;
  const { xml, fileName } = loadFixtureXml(meta.root, bundle);
  const expected = loadExpected(meta.root, bundle);
  // fileName keeps the real fixture extension — the importer's extension gate
  // rejects decorated names (unsupported_extension).
  const result = buildTsCandidate(xml, fileName, config);
  const diffs = diffCandidates(expected, result.candidate);
  // Expected-outcome agreement (blocked plans, scope codes) is part of L2.
  const outcomeDiffs: ParityDiff[] = checkExpectedOutcome(bundle, result);
  const allDiffs = [...diffs, ...outcomeDiffs].sort((a, b) => a.path.localeCompare(b.path));
  const categories = categorize(allDiffs);
  const p13 = computeL3Invariants(result.candidate, config);
  const l3Ok = p13.every((check) => check.status === 'pass');
  // Wire compatibility reports ITS OWN track only: semantic defects on the
  // wireMs paths — never the whole-report category count (which would couple
  // L3 to unrelated L2 outcome diffs).
  const wireSemanticCount = diffs.filter(
    (diff) => diff.path.startsWith('wireMs[') && diff.category === 'semantic-defect',
  ).length;
  const wireCompatible = result.candidate.wireMs
    ? (wireSemanticCount === 0 ? 'pass' : 'fail')
    : 'not-applicable';
  const stable = fingerprintStable(xml, fileName, config);

  // Each layer reports ITS OWN status (2nd review §一.1: layered evidence must
  // not distort — an L1 failure must not mark a clean-diff L2 as fail):
  //   L1 = fingerprint presence/expected-error AND stability across runs;
  //   L2 = diff categories clean (incl. expected-outcome agreement);
  //   L3 = P1-3 invariants green AND wire compatibility not failing.
  let l1Fingerprint: 'pass' | 'fail';
  if (bundle.expectedOutcome.planStatus === 'blocked') {
    const wantFpError = bundle.expectedOutcome.fingerprintErrorCode;
    l1Fingerprint = wantFpError
      ? (result.fingerprintErrorCode === wantFpError ? 'pass' : 'fail')
      : (result.fingerprint === null ? 'pass' : 'fail');
  } else {
    l1Fingerprint = result.fingerprint !== null ? 'pass' : 'fail';
  }
  const l1Status: 'pass' | 'fail' = l1Fingerprint === 'pass' && stable ? 'pass' : 'fail';
  const l2Status: 'pass' | 'fail' = reportPasses(categories) ? 'pass' : 'fail';
  const l3Status: 'pass' | 'fail' = l3Ok && wireCompatible !== 'fail' ? 'pass' : 'fail';
  // Case pass = the conjunction of the three self-reported layers
  // (R2-1 §4: "L1 equal ∧ L2 clean ∧ L3 green") — never the summary alone.
  const pass = l1Status === 'pass' && l2Status === 'pass' && l3Status === 'pass';

  return {
    schemaVersion: 1,
    caseId: bundle.caseId,
    fixture: { path: bundle.fixture.path, sha256: bundle.fixture.sha256 },
    configSha256: configFingerprint(config),
    sides: {
      expected: { kind: expected.kind, source: bundle.expected.ref },
      candidate: {
        kind: 'ts-legacy-reference',
        gitSha: meta.gitSha,
        plannerVersion: config.plannerVersion,
        engineVersion: SCORE_ENGINE_VERSION,
      },
    },
    rustSide: 'not-implemented / not-run',
    l1: {
      status: l1Status,
      fingerprint: result.fingerprint,
      fingerprintErrorCode: result.fingerprintErrorCode,
      stableAcrossRuns: stable,
      note: 'TS-side only: stability of the frozen input under the gated fingerprint. TS↔Rust L1 equality is deferred to R2-3.',
    },
    l2: {
      status: l2Status,
      occurrenceCount: result.candidate.occurrences.length,
      groupCount: result.candidate.groups.length,
      diffCount: allDiffs.length,
    },
    l3: {
      status: l3Status,
      atomCount: result.candidate.atoms.length,
      scoreEventCount: result.candidate.scoreEvents.length,
      wireCompatibility: wireCompatible,
      p1_3Invariants: p13,
    },
    summary: { status: pass ? 'pass' : 'fail', categories, pass },
    diffs: allDiffs,
    meta: {
      generatedAt: new Date().toISOString(),
      gitSha: meta.gitSha,
      command: meta.command,
      timeConversionVersion: 'time-conversion-v1',
      fingerprintSchemaVersion: 1,
      parityGateDoc: PARITY_GATE_DOC,
    },
  };
}

interface CaseRunLite {
  fingerprint: string | null;
  fingerprintErrorCode: string | null;
  planIssues: { code: string; blocksStrict: boolean }[];
  scopeCodes: string[];
}

function checkExpectedOutcome(bundle: ParityCaseBundle, result: CaseRunLite): ParityDiff[] {
  const outcomeDiffs: ParityDiff[] = [];
  const rule = 'TS_RUST_PARITY_GATE_V1 §6 (expected outcome)';
  const push = (path: string, left: unknown, right: unknown) =>
    outcomeDiffs.push({ path, category: 'semantic-defect', ruleRef: rule, left, right });
  if (bundle.expectedOutcome.planStatus === 'blocked') {
    for (const code of bundle.expectedOutcome.issueCodes ?? []) {
      if (!result.planIssues.some((issue) => issue.code === code)) {
        push(`outcome.issueCodes[${code}]`, 'expected', 'missing');
      }
    }
    const wantFpError = bundle.expectedOutcome.fingerprintErrorCode;
    if (wantFpError && result.fingerprintErrorCode !== wantFpError) {
      push('outcome.fingerprintErrorCode', wantFpError, result.fingerprintErrorCode);
    }
  } else if (result.planIssues.some((issue) => issue.blocksStrict)) {
    push('outcome.planStatus', 'strict', 'blocked');
  }
  for (const code of bundle.expectedOutcome.scopeCodes ?? []) {
    if (!result.scopeCodes.includes(code)) push(`outcome.scopeCodes[${code}]`, 'expected', 'missing');
  }
  return outcomeDiffs;
}

// ---------------------------------------------------------------------------
// B-class fault injection (frozen six; R2-1 §6 B).
// ---------------------------------------------------------------------------

export interface FaultSpec {
  faultId: string;
  caseId: string;
  description: string;
  mutate: (candidate: ParityCandidate) => void;
  /** The diff path prefix that MUST appear with category semantic-defect. */
  expectedPathPrefix: string;
}

const cloneCandidate = (candidate: ParityCandidate): ParityCandidate =>
  JSON.parse(JSON.stringify(candidate)) as ParityCandidate;

export const FAULT_SPECS: FaultSpec[] = [
  {
    faultId: 'N-PITCH-F1',
    caseId: 'G1-base',
    description: 'neighbour pitch injected into one occurrence',
    mutate(candidate) {
      const pitch = candidate.occurrences[0].pitch;
      if (pitch) pitch.midiNote += 1;
    },
    expectedPathPrefix: 'occurrences[P1:m1:e1:v1:p0].pitch.midiNote',
  },
  {
    faultId: 'N-COUNT-F1',
    caseId: 'G3-base',
    description: 'tie continuation emitted as an independent occurrence',
    mutate(candidate) {
      const onset = candidate.occurrences[0];
      candidate.occurrences.push({
        ...JSON.parse(JSON.stringify(onset)) as CanonicalOccurrence,
        locator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 1, voiceId: '1' },
        playbackBeat: '2/1',
        durationBeat: '2/1',
        bar: 2,
        measureOrdinal: 2,
        beatInMeasure: '0/1',
        isTieOnset: false,
        playbackIndex: 1,
      });
    },
    expectedPathPrefix: 'occurrences[P1:m2:e1:v1:p0].presence',
  },
  {
    faultId: 'N-COUNT-F2',
    caseId: 'G1-base',
    description: 'rest promoted into the target plan',
    mutate(candidate) {
      candidate.occurrences.push({
        locator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 2, voiceId: '1' },
        passIndex: 0,
        playbackBeat: '6/1',
        durationBeat: '2/1',
        measureOrdinal: 2,
        bar: 2,
        beatInMeasure: '2/1',
        staffNumber: 1,
        voiceId: '1',
        pitch: null,
        isTieOnset: false,
        playbackIndex: candidate.occurrences.length,
      });
    },
    expectedPathPrefix: 'occurrences[P1:m2:e2:v1:p0].presence',
  },
  {
    faultId: 'N-COUNT-F3',
    caseId: 'G2-base',
    description: 'one occurrence silently dropped',
    mutate(candidate) {
      candidate.occurrences.pop();
    },
    expectedPathPrefix: 'occurrences[P1:m1:e4:v1:p0].presence',
  },
  {
    faultId: 'N-COUNT-F4',
    caseId: 'A4-multivoice',
    description: 'same-onset different-voice group wrongly split (group loses a member)',
    mutate(candidate) {
      const group = candidate.groups[0];
      group.members = group.members.slice(0, 1);
      group.pitches = group.pitches.slice(0, 1);
      group.voiceIds = group.voiceIds.slice(0, 1);
    },
    expectedPathPrefix: 'groups[p0@0/1].members',
  },
  {
    faultId: 'N-COV-F1',
    caseId: 'G1-base',
    description: 'an entire measure of targets lost from the candidate',
    mutate(candidate) {
      candidate.occurrences = candidate.occurrences.filter((o) => o.bar !== 2);
      candidate.groups = candidate.groups.filter((g) => g.bar !== 2);
      candidate.atoms = candidate.atoms.filter((a) => a.bar !== 2);
      candidate.scoreEvents = candidate.scoreEvents.filter((e) => e.measure !== 2);
    },
    expectedPathPrefix: 'occurrences[P1:m2:e1:v1:p0].presence',
  },
];

export interface FaultReport {
  faultId: string;
  caseId: string;
  detected: boolean;
  classifiedCorrectly: boolean;
  pathFound: boolean;
  reportStatus: 'pass' | 'fail';
  diffs: ParityDiff[];
}

export function runFault(meta: RunnerMeta, spec: FaultSpec): FaultReport {
  const index = loadCaseIndex(meta.root);
  const bundle = index.cases.find((entry) => entry.caseId === spec.caseId);
  if (!bundle) throw new Error(`fault ${spec.faultId}: case ${spec.caseId} not found`);
  const config = bundle.config;
  const { xml, fileName } = loadFixtureXml(meta.root, bundle);
  const expected = loadExpected(meta.root, bundle);
  const base = buildTsCandidate(xml, fileName, config);
  const mutated = cloneCandidate(base.candidate);
  spec.mutate(mutated);
  // Fault injection compares ONLY at L2 (candidate structure vs golden);
  // wire/µs tracks are irrelevant for detecting a structural fault.
  const diffs = diffCandidates(expected, { ...mutated, wireMs: undefined }, { compareWireMs: false });
  const wanted = diffs.filter(
    (diff) => diff.category === 'semantic-defect' && diff.path.startsWith(spec.expectedPathPrefix),
  );
  const pass = reportPasses(categorize(diffs));
  return {
    faultId: spec.faultId,
    caseId: spec.caseId,
    detected: diffs.length > 0,
    classifiedCorrectly: wanted.length > 0,
    pathFound: wanted.length > 0,
    reportStatus: pass ? 'pass' : 'fail',
    diffs,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type RunnerMode =
  | { mode: 'full' }
  | { mode: 'case'; caseId: string }
  | { mode: 'fault'; faultId?: string };

export interface RunResult {
  exitCode: number;
  reports: ParityReportV1[];
  faultReports: FaultReport[];
}

export function runParity(options: RunnerMode, meta?: Partial<RunnerMeta>): RunResult {
  const root = meta?.root ?? findRepoRoot();
  const runnerMeta: RunnerMeta = {
    root,
    gitSha: meta?.gitSha ?? currentGitSha(root),
    command: meta?.command ?? `parity-runner ${JSON.stringify(options)}`,
  };
  const index = loadCaseIndex(root);
  // Fault mode runs ONLY the requested fault injections — never the regular
  // cases (2nd review §一.1: an unknown faultId used to degrade to "run
  // everything / nothing" and could exit 0 without testing the asked fault).
  const cases = options.mode === 'case'
    ? index.cases.filter((entry) => entry.caseId === options.caseId)
    : options.mode === 'fault'
      ? []
      : index.cases;
  if (options.mode === 'case' && cases.length === 0) {
    throw new Error(`caseId not found: ${options.caseId}`);
  }
  const reports = cases.map((bundle) => runCase(bundle, runnerMeta));
  const faultSpecs = options.mode === 'fault' && options.faultId
    ? FAULT_SPECS.filter((spec) => spec.faultId === options.faultId)
    : FAULT_SPECS;
  if (options.mode === 'fault' && faultSpecs.length === 0) {
    // A requested-but-unknown fault must FAIL, never exit 0 vacuously.
    throw new Error(`faultId not found: ${options.faultId}`);
  }
  const faultReports = options.mode === 'fault' || options.mode === 'full'
    ? faultSpecs.map((spec) => runFault(runnerMeta, spec))
    : [];

  // An empty fault batch would make every() vacuously true; guard it so a
  // fault run that executed zero faults can never report success.
  const faultsAllCaught = faultReports.length > 0
    && faultReports.every((fault) => fault.detected && fault.classifiedCorrectly && fault.reportStatus === 'fail');
  const exitCode = reports.every((report) => report.summary.pass) && faultsAllCaught
    ? 0 : 1;
  return { exitCode, reports, faultReports };
}

export function writeReports(result: RunResult, reportDir: string): string[] {
  mkdirSync(reportDir, { recursive: true });
  const written: string[] = [];
  for (const report of result.reports) {
    const file = join(reportDir, `${report.caseId}.report.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  if (result.faultReports.length) {
    const file = join(reportDir, 'fault-injection.report.json');
    writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, faults: result.faultReports }, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  return written;
}
