// R2-3d: the §8 migration-evidence harness (E1/E2/E4-B/E5 live here; E3/E4-A
// live in the Rust evidence test, E4-C in the normative validators + existing
// acceptance-c suites). The E6 report is written BEFORE the final verdict
// assertion so a failing run still leaves auditable JSON, then the suite
// fails → non-zero exit. E7 renders the gate matrix; a NOT-RUN or failing
// item forces BLOCKED.
//
// Frozen inputs only: case index, golden/expected files, vectors, the
// rust-parity-input corpus. The real-score fixture arrives via
// RHYTHM_REAL_SCORE_PATH (gitignored third-party file) — its provenance,
// sha256 and the executed-vs-skip distinction are recorded as evidence.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  findRepoRoot,
  loadCaseIndex,
  loadExpected,
  loadFixtureXml,
} from './case-bundle';
import { buildTsCandidate, computeL3Invariants, countInBeatsRational, type ParityCaseConfig } from './parity-candidate';
import {
  categorize,
  diffCandidates,
  reportPasses,
  type ParityCandidate,
  type ParityDiff,
} from './parity-diff';
import { goldenToExpected } from './case-bundle';
import { importMusicXml } from '../import/musicxml-importer';
import {
  planFingerprintV1,
  projectScoreDocumentV1,
  validateScoreDocumentV1,
} from '../contract-v1/plan-fingerprint';
import { buildPlaybackPlan } from '../playback/playback-planner';

const require = createRequire(import.meta.url);
const root = findRepoRoot();
const native = require(join(root, 'rhythm-trainer-core-v0.2', 'bindings', 'node')) as {
  buildPlanV1(documentJson: string, reportJson: string, configJson: string): string;
  buildParityCandidateV1(documentJson: string, reportJson: string, configJson: string): string;
  planFingerprintV1Gate(documentJson: string, reportJson: string, planJson: string, configJson: string): string;
  validateCandidateScoreEventsJson(eventsJson: string, atomBars?: number[] | null, prescriptionRange?: number[] | null): string | null;
  canonicalBytesJson(payloadJson: string): string;
  computePlanFingerprintV1Json(payloadJson: string): string;
};

const REPORT_DIR = join(root, 'audit-r1', 'reports', 'r2-3');
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
function headSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared frozen inputs
// ---------------------------------------------------------------------------

const index = loadCaseIndex(root);
const bundles = [...index.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));

function corpus(caseId: string): { document: unknown; report: unknown; config: unknown; meta: Record<string, unknown> } {
  return JSON.parse(readFileSync(
    join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', `${caseId}.json`), 'utf8'));
}

interface RustMeta {
  planStrictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
}

function rustFull(config: ParityCaseConfig, document: unknown, report: unknown): { candidate: ParityCandidate; meta: RustMeta } {
  return JSON.parse(native.buildParityCandidateV1(
    JSON.stringify(document), JSON.stringify(report), JSON.stringify(config)));
}

function rustCandidate(config: ParityCaseConfig, document: unknown, report: unknown): ParityCandidate {
  return rustFull(config, document, report).candidate;
}

/** Expected-outcome checks for ONE side against the frozen case-index entry. */
function outcomeChecks(
  expectedOutcome: { planStatus: 'strict' | 'blocked'; issueCodes?: string[]; fingerprintErrorCode?: string; scopeCodes?: string[] },
  side: { planStrictAllowed: boolean; planIssues: Array<{ code: string }>; scopeCodes: string[]; fingerprintErrorCode: string | null },
): { planStatusMatch: boolean; issueCodesMatch: boolean | null; fingerprintErrorCodeMatch: boolean | null; scopeCodesMatch: boolean | null } {
  const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
  return {
    planStatusMatch: side.planStrictAllowed === (expectedOutcome.planStatus === 'strict'),
    issueCodesMatch: expectedOutcome.issueCodes
      ? sameSet(side.planIssues.map((issue) => issue.code), expectedOutcome.issueCodes)
      : null,
    fingerprintErrorCodeMatch: expectedOutcome.fingerprintErrorCode !== undefined
      ? side.fingerprintErrorCode === expectedOutcome.fingerprintErrorCode
      : side.fingerprintErrorCode === null,
    scopeCodesMatch: expectedOutcome.scopeCodes
      ? sameSet(side.scopeCodes, expectedOutcome.scopeCodes)
      : null,
  };
}

// ---------------------------------------------------------------------------
// E1 — G1–G5 against the hand-derived golden truth, FIELD BY FIELD
// ---------------------------------------------------------------------------

interface FieldCheck { path: string; expected: unknown; actual: unknown; equal: boolean }

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === null || value === undefined || typeof value !== 'object') {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix, []);
    value.forEach((entry, i) => flatten(entry, `${prefix}.${i}`, out));
    return;
  }
  for (const [key, entry] of Object.entries(value)) flatten(entry, `${prefix}.${key}`, out);
}

function fieldChecks(expected: unknown, actual: unknown, layer: string): FieldCheck[] {
  const expectedLeaves = new Map<string, unknown>();
  const actualLeaves = new Map<string, unknown>();
  flatten(expected, layer, expectedLeaves);
  flatten(actual, layer, actualLeaves);
  const checks: FieldCheck[] = [];
  for (const [path, want] of expectedLeaves) {
    const got = actualLeaves.get(path);
    checks.push({ path, expected: want, actual: got === undefined ? '<missing>' : got, equal: JSON.stringify(want) === JSON.stringify(got) });
  }
  for (const [path, got] of actualLeaves) {
    if (!expectedLeaves.has(path)) {
      checks.push({ path, expected: '<absent>', actual: got, equal: false });
    }
  }
  return checks;
}

// ---------------------------------------------------------------------------
// E2 — the §7 regression matrix, executed live for BOTH pipelines
// ---------------------------------------------------------------------------

interface CaseResult {
  caseId: string;
  l1FingerprintMatch: boolean;
  tsFingerprint: string | null;
  rustFingerprint: string | null;
  fingerprintErrorCode: string | null;
  tsVsExpected: { pass: boolean; diffCount: number; categories: Record<string, number>; diffs: ParityDiff[] };
  rustVsExpected: { pass: boolean; diffCount: number; categories: Record<string, number>; diffs: ParityDiff[] };
  l3InvariantsPass: boolean;
  l3Invariants: Array<{ check: string; status: string }>;
  expectedOutcome: {
    frozen: { planStatus: 'strict' | 'blocked'; issueCodes?: string[]; fingerprintErrorCode?: string; scopeCodes?: string[] };
    ts: ReturnType<typeof outcomeChecks>;
    rust: ReturnType<typeof outcomeChecks>;
    allMatch: boolean;
  };
  semanticPoints: string[];
}

const SEMANTIC_POINT_MAP: Record<string, string[]> = {
  'G1-base': ['§7 hand truth G1 (manual golden)'],
  'G2-base': ['§7 hand truth G2 (manual golden)'],
  'G3-base': ['§7 hand truth G3 (tie)'],
  'G4-base': ['§7 hand truth G4'],
  'G5-base': ['§7 G5 non-4/4 row'],
  'G1-A5-range-m2': ['§7 G1+A5: range re-basing (m2)'],
  'G1-A10-loop-x2': ['§7 G1+A10: range-loop ×2 (pass offset, unique occurrenceId per pass)'],
  'G1-A10-loop-x3': ['§7 G1+A10: range-loop ×3'],
  'G3-range-m2': ['§7 G3 tie × range edge: tie START OUTSIDE range — continuation emits no occurrence, no re-anchor'],
  'G6-A3-base': ['§7 G2 chord × hand row: same-onset chord, hand=both', '§7 A3 backup double-staff'],
  'G6-A3-hand-left': ['§7 G1+A5: hand left (group members/duration reduced)'],
  'G6-A3-hand-right': ['§7 G1+A5: hand right'],
  'A4-multivoice': ['§7 A4: multi-voice same onset'],
  'A9-mixed-duration': ['§7 A9: same onset, mixed durations (group = longest member)'],
  'G1-rational-bpm': ['§7 vectors row: non-integer rational BPM (175/2) parity side'],
};

// ---------------------------------------------------------------------------
// E5 — real-score regression (executed, never counted as pass when skipped)
// ---------------------------------------------------------------------------

const REAL_SCORE_PATH = process.env.RHYTHM_REAL_SCORE_PATH
  ?? join(root, 'score-latest.musicxml');
const REAL_SCORE_PROVENANCE = {
  note: 'Third-party OMR score, gitignored by policy; NOT committed. Present in the author local workspace only.',
  localPathUsed: REAL_SCORE_PATH,
  acquisition: 'Local third-party file retained from the R1 audit runs; not distributable via the repository.',
};

interface E5Result {
  executed: boolean;
  reason?: string;
  filePath?: string;
  fileSha256?: string;
  fileSizeBytes?: number;
  /** Direct measure count from the IMPORTED SCORE (not derived from the plan). */
  importedMeasureCount?: number;
  counts?: { measures: number; occurrences: number; groups: number; atoms: number; scoreEvents: number };
  capabilities?: string[];
  capabilitiesExact?: boolean;
  rustFingerprintStable?: boolean;
  rustFingerprint?: string | null;
  tsFingerprintEqual?: boolean;
  /** Full TS↔Rust candidate diff (frozen predicate; zero tolerance on µs). */
  l2?: { pass: boolean; diffCount: number; categories: Record<string, number>; diffs: ParityDiff[] };
  /** L3 exact-integer invariants over the Rust real-score candidate. */
  l3?: { pass: boolean; invariants: Array<{ check: string; status: string }> };
}

// ---------------------------------------------------------------------------
// The evidence suite
// ---------------------------------------------------------------------------

let e1Checks: FieldCheck[] = [];
let e1AllExact = true;
const e2Results: CaseResult[] = [];
const e4BFaults: Array<{ faultId: string; detected: boolean; classifiedCorrectly: boolean; pathPrefixOk: boolean; reportFails: boolean; diffs: ParityDiff[] }> = [];
let e5Result: E5Result = { executed: false, reason: 'not executed yet' };

// E4-C: the four frozen normative codes + the fail-closed structural
// rejection, EXECUTED LIVE through the Rust NAPI validator. The class-C
// verdict is computed from these results — never asserted from text.
interface ClassCCase { id: string; expectedCode: string; actualCode: string | null; pass: boolean }
let classCCases: ClassCCase[] = [];
let classCAllPass = false;

// E4-V: every committed vector recomputed by the Rust implementation through
// the NAPI primitives, byte-exact against the frozen expectations.
interface ClassVVector { vector: string; canonicalMatch: boolean; fingerprintMatch: boolean; pass: boolean }
let classVVectors: ClassVVector[] = [];
let classVAllPass = false;

beforeAll(() => {
  // ----- E1: G1–G5 golden truth, field by field, against the Rust pipeline.
  const goldenIds = ['G1', 'G2', 'G3', 'G4', 'G5'];
  e1Checks = [];
  e1AllExact = true;
  for (const goldenId of goldenIds) {
    const goldenPath = join(root, 'audit-r1', 'fixtures', 'golden', `${goldenId.toLowerCase()}.expected.json`);
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
    const expected = goldenToExpected(golden);
    const record = corpus(`${goldenId}-base`);
    const config = record.config as ParityCaseConfig;
    const actual = rustCandidate(config, record.document, record.report);

    const layers: Array<[string, unknown, unknown]> = [
      ['occurrences', expected.occurrences, actual.occurrences],
      ['groups', expected.groups, actual.groups],
      ['atoms', expected.atoms, actual.atoms],
      // runtimeOccurrenceId is a candidate-only runtime key (parity-diff:
      // "never compared") — the golden truth never carries it, so it is
      // stripped from the actual side before the field-by-field comparison.
      ['scoreEvents', expected.scoreEvents, actual.scoreEvents.map((event: { runtimeOccurrenceId?: string }) => {
        const { runtimeOccurrenceId, ...rest } = event;
        void runtimeOccurrenceId;
        return rest;
      })],
    ];
    const perCase: FieldCheck[] = [];
    for (const [layer, want, got] of layers) {
      perCase.push(...fieldChecks(want, got, layer));
    }
    // Structural counts against the golden header fields.
    perCase.push({
      path: 'plan.occurrenceCount', expected: golden.plan.occurrences.length,
      actual: actual.occurrences.length, equal: golden.plan.occurrences.length === actual.occurrences.length,
    });
    perCase.push({
      path: 'plan.groupCount', expected: golden.plan.groups.length,
      actual: actual.groups.length, equal: golden.plan.groups.length === actual.groups.length,
    });
    perCase.push({
      path: 'measures.count', expected: golden.measures.length,
      actual: (record.document as { parts: Array<{ measures: unknown[] }> }).parts[0].measures.length,
      equal: golden.measures.length
        === (record.document as { parts: Array<{ measures: unknown[] }> }).parts[0].measures.length,
    });
    e1Checks.push(...perCase);
    e1AllExact &&= perCase.every((check) => check.equal);
  }

  // ----- E2: all 15 frozen cases, BOTH pipelines, live.
  for (const bundle of bundles) {
    const config = bundle.config as ParityCaseConfig;
    const expected = loadExpected(root, bundle);
    const { xml, fileName } = loadFixtureXml(root, bundle);
    const record = corpus(bundle.caseId);

    const ts = buildTsCandidate(xml, fileName, config);
    const rust = rustFull(config, record.document, record.report);

    const tsDiff = diffCandidates(expected, ts.candidate);
    const rustDiff = diffCandidates(expected, rust.candidate);
    const tsCategories = categorize(tsDiff);
    const rustCategories = categorize(rustDiff);

    // L1: cross-language fingerprint (or frozen rejection code).
    let rustErrorCode: string | null = null;
    let rustFingerprint: string | null = null;
    try {
      const plan = JSON.parse(native.buildPlanV1(
        JSON.stringify(record.document), JSON.stringify(record.report), JSON.stringify(config)));
      rustFingerprint = native.planFingerprintV1Gate(
        JSON.stringify(record.document), JSON.stringify(record.report),
        JSON.stringify(plan), JSON.stringify(config));
    } catch (error) {
      rustErrorCode = (error instanceof Error ? error.message : String(error)).split(':')[0]?.trim() ?? 'UNKNOWN';
    }
    const l1Match = rustErrorCode !== null
      ? rustErrorCode === ts.fingerprintErrorCode
      : ts.fingerprintErrorCode === null && rustFingerprint === ts.fingerprint;

    const invariants = computeL3Invariants(rust.candidate, config);
    const tsOutcome = outcomeChecks(bundle.expectedOutcome, {
      planStrictAllowed: ts.planStrictAllowed,
      planIssues: ts.planIssues,
      scopeCodes: ts.scopeCodes,
      fingerprintErrorCode: ts.fingerprintErrorCode,
    });
    const rustOutcome = outcomeChecks(bundle.expectedOutcome, {
      planStrictAllowed: rust.meta.planStrictAllowed,
      planIssues: rust.meta.planIssues,
      scopeCodes: rust.meta.scopeCodes,
      fingerprintErrorCode: rustErrorCode,
    });    e2Results.push({
      caseId: bundle.caseId,
      l1FingerprintMatch: l1Match,
      tsFingerprint: ts.fingerprint,
      rustFingerprint,
      fingerprintErrorCode: rustErrorCode,
      tsVsExpected: {
        pass: reportPasses(tsCategories), diffCount: tsDiff.length,
        categories: tsCategories, diffs: tsDiff,
      },
      rustVsExpected: {
        pass: reportPasses(rustCategories), diffCount: rustDiff.length,
        categories: rustCategories, diffs: rustDiff,
      },
      l3InvariantsPass: invariants.every((check) => check.status === 'pass'),
      l3Invariants: invariants.map(({ check, status }) => ({ check, status })),
      expectedOutcome: {
        frozen: bundle.expectedOutcome,
        ts: tsOutcome,
        rust: rustOutcome,
        allMatch: tsOutcome.planStatusMatch && rustOutcome.planStatusMatch
          && tsOutcome.issueCodesMatch !== false && rustOutcome.issueCodesMatch !== false
          && tsOutcome.fingerprintErrorCodeMatch !== false && rustOutcome.fingerprintErrorCodeMatch !== false
          && tsOutcome.scopeCodesMatch !== false && rustOutcome.scopeCodesMatch !== false,
      },
      semanticPoints: SEMANTIC_POINT_MAP[bundle.caseId] ?? [],
    });
  }

  // ----- E4-B: the six frozen faults injected into the RUST candidate.
  const faults: Array<{ faultId: string; caseId: string; mutate: (candidate: ParityCandidate) => void; expectedPathPrefix: string }> = [
    {
      faultId: 'N-PITCH-F1', caseId: 'G1-base',
      mutate(candidate) {
        const pitch = candidate.occurrences[0].pitch;
        if (pitch) pitch.midiNote += 1;
      },
      expectedPathPrefix: 'occurrences[P1:m1:e1:v1:p0].pitch.midiNote',
    },
    {
      faultId: 'N-COUNT-F1', caseId: 'G3-base',
      mutate(candidate) {
        const onset = JSON.parse(JSON.stringify(candidate.occurrences[0]));
        candidate.occurrences.push({
          ...onset,
          locator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 1, voiceId: '1' },
          playbackBeat: '2/1', durationBeat: '2/1', bar: 2, measureOrdinal: 2,
          beatInMeasure: '0/1', isTieOnset: false, playbackIndex: 1,
        });
      },
      expectedPathPrefix: 'occurrences[P1:m2:e1:v1:p0].presence',
    },
    {
      faultId: 'N-COUNT-F2', caseId: 'G1-base',
      mutate(candidate) {
        candidate.occurrences.push({
          locator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 2, voiceId: '1' },
          passIndex: 0, playbackBeat: '6/1', durationBeat: '2/1', measureOrdinal: 2, bar: 2,
          beatInMeasure: '2/1', staffNumber: 1, voiceId: '1', pitch: null,
          isTieOnset: false, playbackIndex: candidate.occurrences.length,
        });
      },
      expectedPathPrefix: 'occurrences[P1:m2:e2:v1:p0].presence',
    },
    {
      faultId: 'N-COUNT-F3', caseId: 'G2-base',
      mutate(candidate) { candidate.occurrences.pop(); },
      expectedPathPrefix: 'occurrences[P1:m1:e4:v1:p0].presence',
    },
    {
      faultId: 'N-COUNT-F4', caseId: 'A4-multivoice',
      mutate(candidate) {
        const group = candidate.groups[0];
        group.members = group.members.slice(0, 1);
        group.pitches = group.pitches.slice(0, 1);
        group.voiceIds = group.voiceIds.slice(0, 1);
      },
      expectedPathPrefix: 'groups[p0@0/1].members',
    },
    {
      faultId: 'N-COV-F1', caseId: 'G1-base',
      mutate(candidate) {
        candidate.occurrences = candidate.occurrences.filter((o) => o.bar !== 2);
        candidate.groups = candidate.groups.filter((g) => g.bar !== 2);
        candidate.atoms = candidate.atoms.filter((a) => a.bar !== 2);
        candidate.scoreEvents = candidate.scoreEvents.filter((e) => e.measure !== 2);
      },
      expectedPathPrefix: 'occurrences[P1:m2:e1:v1:p0].presence',
    },
  ];
  for (const spec of faults) {
    const expected = loadExpected(root, index.cases.find((entry) => entry.caseId === spec.caseId)!);
    const record = corpus(spec.caseId);
    const candidate = rustCandidate(record.config as ParityCaseConfig, record.document, record.report);
    spec.mutate(candidate);
    const diffs: ParityDiff[] = diffCandidates(expected, candidate);
    const categories = categorize(diffs);
    e4BFaults.push({
      faultId: spec.faultId,
      detected: diffs.length > 0,
      classifiedCorrectly: (categories['semantic-defect'] ?? 0) > 0,
      pathPrefixOk: diffs.some((diff) => diff.category === 'semantic-defect' && diff.path.startsWith(spec.expectedPathPrefix)),
      reportFails: !reportPasses(categories),
      diffs,
    });
  }

  // ----- E4-C: the frozen normative-code matrix EXECUTED through the Rust
  // NAPI validator (candidate-output layer produces the codes from day one).
  {
    const cleanList = [{ scoreEventId: 'a', pitch: 60, measure: 1, targetDurationMs: 750 }];
    const clean = JSON.stringify(cleanList);
    const cases: Array<{ id: string; events: string; atomBars?: number[] | null; range?: number[] | null; expectedCode: string }> = [
      { id: 'N-ID-C1 duplicate_target_id', events: JSON.stringify([...cleanList, { scoreEventId: 'a', pitch: 62, measure: 2, targetDurationMs: 750 }]), expectedCode: 'duplicate_target_id' },
      { id: 'N-PITCH-C1 invalid_target_pitch (pitch 128)', events: JSON.stringify([{ scoreEventId: 'a', pitch: 128, measure: 1, targetDurationMs: 750 }]), expectedCode: 'invalid_target_pitch' },
      { id: 'N-PITCH-C1 invalid_target_pitch (duration 0)', events: JSON.stringify([{ scoreEventId: 'a', pitch: 60, measure: 1, targetDurationMs: 0 }]), expectedCode: 'invalid_target_pitch' },
      { id: 'N-COV-C1 measure_coverage_mismatch', events: clean, atomBars: [1, 2], expectedCode: 'measure_coverage_mismatch' },
      { id: 'N-COV-C2 target_outside_prescription_range', events: JSON.stringify([{ scoreEventId: 'a', pitch: 60, measure: 9, targetDurationMs: 750 }]), range: [1, 2], expectedCode: 'target_outside_prescription_range' },
      { id: 'fail-closed structural rejection (non-array)', events: JSON.stringify('not an array'), expectedCode: 'invalid_target_pitch' },
    ];
    classCCases = cases.map((testCase) => {
      const actualCode = native.validateCandidateScoreEventsJson(testCase.events, testCase.atomBars ?? null, testCase.range ?? null);
      return { id: testCase.id, expectedCode: testCase.expectedCode, actualCode, pass: actualCode === testCase.expectedCode };
    });
    // A clean candidate must produce NO code (null) — also part of the matrix.
    const cleanRun = native.validateCandidateScoreEventsJson(clean, null, null);
    classCCases.push({ id: 'clean candidate accepted', expectedCode: '<null>', actualCode: cleanRun, pass: cleanRun === null });
    classCAllPass = classCCases.length >= 6 && classCCases.every((testCase) => testCase.pass);
  }

  // ----- E4-V: every committed vector recomputed through the Rust NAPI
  // primitives, byte-exact against the frozen expectations.
  {
    const vectors = JSON.parse(readFileSync(
      new URL('../../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json', import.meta.url), 'utf8')).vectors as Record<string, { payload: unknown; expectedCanonical: string; expectedFingerprint: string }>;
    classVVectors = Object.entries(vectors).map(([name, vector]) => {
      const payloadJson = JSON.stringify(vector.payload);
      const canonicalMatch = native.canonicalBytesJson(payloadJson) === vector.expectedCanonical;
      const fingerprintMatch = native.computePlanFingerprintV1Json(payloadJson) === vector.expectedFingerprint;
      return { vector: name, canonicalMatch, fingerprintMatch, pass: canonicalMatch && fingerprintMatch };
    });
    classVAllPass = classVVectors.length === 6 && classVVectors.every((vector) => vector.pass);
  }

  // ----- E5: real-score regression (executed; skip is recorded as NOT RUN).
  if (existsSync(REAL_SCORE_PATH)) {
    const raw = readFileSync(REAL_SCORE_PATH, 'utf8');
    const imported = importMusicXml(raw, { fileName: 'real-score.musicxml' });
    if (imported.scoreDocument) {
      const projected = projectScoreDocumentV1(imported.scoreDocument, imported.importReport);
      const documentIssues = validateScoreDocumentV1(projected.dto);
      expect(documentIssues, 'real-score V1 projection must be clean').toEqual([]);
      const config: ParityCaseConfig = {
        partId: 'P1',
        range: { startMeasureOrdinal: 1, endMeasureOrdinal: 113 },
        repeatSelection: { kind: 'none' },
        hand: 'both',
        handMapping: {
          schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user',
          parts: [{ partId: 'P1', staves: [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }] }],
        },
        // 2,000,000 µs = exactly 3 beats @ 90 BPM — integer on BOTH sides.
        bpm: { numerator: 90, denominator: 1 },
        ticksPerQuarter: 960,
        countInUs: 2_000_000,
        unsupportedNotationPolicy: 'reject-strict',
        plannerVersion: 'parity-harness-1',
      };
      const documentJson = JSON.stringify(projected.dto);
      const reportJson = JSON.stringify(imported.importReport);
      const configJson = JSON.stringify(config);
      const plan1 = JSON.parse(native.buildPlanV1(documentJson, reportJson, configJson));
      const plan2 = JSON.parse(native.buildPlanV1(documentJson, reportJson, configJson));
      const fingerprint1 = native.planFingerprintV1Gate(documentJson, reportJson, JSON.stringify(plan1), configJson);
      const fingerprint2 = native.planFingerprintV1Gate(documentJson, reportJson, JSON.stringify(plan2), configJson);
      // TS fingerprint over the TS-side full pipeline on the SAME fixture.
      const tsPlan = buildPlaybackPlan(imported.scoreDocument, {
        range: config.range,
        repeatSelection: config.repeatSelection,
        unsupportedNotationPolicy: config.unsupportedNotationPolicy,
      }).plan!;
      const tsFingerprint = planFingerprintV1({
        document: imported.scoreDocument,
        report: imported.importReport,
        plan: tsPlan,
        plannerVersion: config.plannerVersion,
        partId: config.partId,
        range: config.range,
        hand: config.hand,
        handMapping: config.handMapping,
        repeatSelection: config.repeatSelection,
        bpm: config.bpm,
        ticksPerQuarter: config.ticksPerQuarter,
        countInBeats: countInBeatsRational(config),
      });
      e5Result = {
        executed: true,
        filePath: REAL_SCORE_PATH,
        fileSha256: sha256(raw),
        fileSizeBytes: Buffer.byteLength(raw),
        // Direct count from the IMPORTED SCORE, not from plan outputs.
        importedMeasureCount: imported.scoreDocument.parts[0].measures.length,
        counts: {
          measures: imported.scoreDocument.parts[0].measures.length,
          occurrences: plan1.occurrences.length,
          groups: plan1.groups.length,
          atoms: plan1.atoms.length,
          scoreEvents: plan1.scoreEvents.length,
        },
        capabilities: imported.importReport.capabilities.slice().sort(),
        capabilitiesExact: JSON.stringify(imported.importReport.capabilities.slice().sort())
          === JSON.stringify(['chords', 'multi_staff', 'multi_voice', 'ties', 'tuplets']),
        rustFingerprintStable: fingerprint1 === fingerprint2,
        rustFingerprint: fingerprint1,
        tsFingerprintEqual: fingerprint1 === tsFingerprint,
      };
      // L2: the full TS↔Rust candidate diff on the real score (frozen
      // predicate — any semantic/unclassified difference fails) and L3:
      // exact-integer invariants over the Rust candidate.
      const tsRun = buildTsCandidate(raw, 'real-score.musicxml', config);
      const rust = rustCandidate(config, projected.dto, imported.importReport);
      const realScoreDiffs = diffCandidates(tsRun.candidate, rust);
      const realScoreCategories = categorize(realScoreDiffs);
      const realScoreInvariants = computeL3Invariants(rust, config);
      e5Result.l2 = {
        pass: reportPasses(realScoreCategories) && realScoreDiffs.length === 0,
        diffCount: realScoreDiffs.length,
        categories: realScoreCategories,
        diffs: realScoreDiffs,
      };
      e5Result.l3 = {
        pass: realScoreInvariants.every((check) => check.status === 'pass'),
        invariants: realScoreInvariants.map(({ check, status }) => ({ check, status })),
      };
    } else {
      e5Result = { executed: false, reason: 'real score failed to import' };
    }
  } else {
    e5Result = { executed: false, reason: 'RHYTHM_REAL_SCORE_PATH fixture absent in this environment' };
  }
});

// ---------------------------------------------------------------------------
// Assertions + the E6 report (written BEFORE the verdict) + E7 matrix
// ---------------------------------------------------------------------------

describe('R2-3d §8 migration evidence', () => {
  it('E1: G1–G5 golden truth holds field-by-field for the Rust pipeline', () => {
    expect(e1Checks.length).toBeGreaterThan(100);
    const mismatches = e1Checks.filter((check) => !check.equal);
    expect(mismatches, `mismatched fields:\n${JSON.stringify(mismatches, null, 1)}`).toEqual([]);
    expect(e1AllExact).toBe(true);
  });

  it('E2: all 15 frozen cases pass L1+L2+L3 for BOTH pipelines with semantic mapping', () => {
    expect(e2Results).toHaveLength(15);
    const failing = e2Results.filter((result) => !result.l1FingerprintMatch
      || !result.tsVsExpected.pass || !result.rustVsExpected.pass || !result.l3InvariantsPass);
    expect(failing, `failing: ${JSON.stringify(failing)}`).toEqual([]);
    expect(e2Results.every((result) => result.semanticPoints.length > 0)).toBe(true);
  });

  it('E4-B: all six frozen faults injected into the RUST candidate are caught, classified, path-exact', () => {
    expect(e4BFaults).toHaveLength(6);
    for (const fault of e4BFaults) {
      expect(fault.detected, `${fault.faultId}: detected`).toBe(true);
      expect(fault.classifiedCorrectly, `${fault.faultId}: semantic-defect`).toBe(true);
      expect(fault.pathPrefixOk, `${fault.faultId}: path ${fault.faultId}`).toBe(true);
      expect(fault.reportFails, `${fault.faultId}: report fails`).toBe(true);
    }
  });

  it('writes the E6 migration-evidence report and the E7 gate matrix BEFORE the verdict', () => {
    const rustEvidence = JSON.parse(readFileSync(
      join(REPORT_DIR, 'r2-3d-rust-evidence.json'), 'utf8'));
    const e2AllPass = e2Results.every((result) => result.l1FingerprintMatch
      && result.tsVsExpected.pass && result.rustVsExpected.pass && result.l3InvariantsPass
      && result.expectedOutcome.allMatch);
    const e4bAllPass = e4BFaults.every((fault) => fault.detected && fault.classifiedCorrectly
      && fault.pathPrefixOk && fault.reportFails && fault.diffs.length > 0);
    const e5Pass = e5Result.executed === true
      && e5Result.importedMeasureCount === 113
      && e5Result.capabilitiesExact === true
      && e5Result.rustFingerprintStable === true
      && e5Result.tsFingerprintEqual === true
      && e5Result.counts?.measures === 113
      && e5Result.counts?.occurrences === 1579
      && e5Result.counts?.groups === 1018
      && e5Result.counts?.atoms === 1018
      && e5Result.counts?.scoreEvents === 1579
      && e5Result.l2?.pass === true
      && e5Result.l3?.pass === true;

    const items = [
      {
        id: 'E1', name: 'G1–G5 manual golden truth, field-exact',
        status: e1AllExact && e1Checks.length > 0 ? 'PASS' : 'FAIL',
        evidence: 'audit-r1/reports/r2-3/r2-3d-e1-golden-exact.json',
        detail: `${e1Checks.length} field checks across G1–G5 (occurrences/groups/atoms/scoreEvents/counts)`,
      },
      {
        id: 'E2', name: '§7 extension matrix, every case L1+L2+L3 both pipelines',
        status: e2AllPass ? 'PASS' : 'FAIL',
        evidence: 'embedded below (cases[].e2) + rust-parity.test.ts',
        detail: '15 cases; semantic point mapping recorded per case',
      },
      {
        id: 'E3', name: 'committed vectors byte-exact under the independent Rust implementation',
        status: rustEvidence.allByteExact && rustEvidence.rationalBpmVectorPresent ? 'PASS' : 'FAIL',
        evidence: 'audit-r1/reports/r2-3/r2-3d-rust-evidence.json (vectors[]); cargo test contract_v1_vectors',
        detail: `${rustEvidence.vectors.length} vectors incl. V-rational-bpm`,
      },
      {
        id: 'E4', name: '§6 P8 acceptance A/B/C/V executed — ALL FOUR classes computed from live results',
        // E4 passes only when A, B, C and V ALL executed AND passed. C and V
        // verdicts come from the live NAPI executions above (review finding:
        // a missing or failed class must BLOCK, never fall back to text).
        status: rustEvidence.classA?.length >= 12
          && rustEvidence.classA?.every((item: { fingerprintChanged: boolean; expected: string }) =>
            item.fingerprintChanged === (item.expected === 'changed'))
          && e4bAllPass
          && classCAllPass
          && classVAllPass ? 'PASS' : 'FAIL',
        evidence: 'A: r2-3d-rust-evidence.json classA[]; B: e4.classB[] (captured diffs); C: e4.classC[] (live Rust NAPI validator); V: e4.classV[] (live Rust NAPI byte-exact)',
        detail: `A: ${rustEvidence.classA?.length ?? 0} items; B: ${e4BFaults.length} rust-candidate injections; C: ${classCCases.length} normative-code cases (allPass=${classCAllPass}); V: ${classVVectors.length} vectors via NAPI (allPass=${classVAllPass})`,
      },
      {
        id: 'E5', name: 'real-score regression (executed, not skipped)',
        status: e5Pass ? 'PASS' : (e5Result.executed ? 'FAIL' : 'BLOCKED'),
        evidence: 'audit-r1/reports/r2-3/r2-3d-e5-real-score-result.json',
        detail: e5Result.executed
          ? `executed; sha256=${e5Result.fileSha256}; provenance recorded (gitignored local third-party file — NOT independently re-runnable on GitHub)`
          : `NOT RUN: ${e5Result.reason}`,
      },
      {
        id: 'E6', name: 'this report: per-case diffs, versions, both-side SHAs, fail-evidence-on-disk',
        // E6 passes ONLY if the archived content is structurally complete
        // (review finding 2): per-case full diff arrays on BOTH comparison
        // directions, frozen expectedOutcome verdicts, E4-B captured diffs,
        // E5 real-score L2/L3 — and the E4-C/E4-V live results must be
        // present and passing (review finding: E4 must cover ALL FOUR
        // classes from computed results, never text placeholders).
        status: e2Results.length === 15
          && e2Results.every((result) => Array.isArray(result.tsVsExpected.diffs)
            && Array.isArray(result.rustVsExpected.diffs)
            && Array.isArray(result.l3Invariants)
            && result.expectedOutcome.allMatch)
          && e4BFaults.every((fault) => Array.isArray(fault.diffs) && fault.diffs.length > 0)
          && (e5Result.l2 ? Array.isArray(e5Result.l2.diffs) : e5Result.executed === false)
          && classCCases.length >= 6 && classCAllPass
          && classVVectors.length === 6 && classVAllPass
          ? 'PASS' : 'FAIL',
        evidence: 'audit-r1/reports/r2-3/r2-3d-migration-evidence-v1.json',
        detail: 'written before the verdict; failing runs keep their evidence; structural completeness is verified, not assumed',
      },
    ];
    const blocked = items.filter((item) => item.status === 'BLOCKED');
    const allPass = items.every((item) => item.status === 'PASS');
    const e7 = {
      items: items.map(({ id, name, status, evidence, detail }) => ({ id, name, status, evidence, detail })),
      verdict: allPass && blocked.length === 0 ? 'READY_FOR_SEPARATE_SWITCH_REVIEW' : 'BLOCKED',
      note: 'E7 only audits the gate; the production-authority switch itself requires a SEPARATE user approval. E5 being environment-dependent (gitignored fixture) is recorded, not hidden.',
    };

    const report = {
      schemaVersion: 'r2-3d-migration-evidence-v1',
      generatedAt: new Date().toISOString(),
      command: 'npx vitest run src/score-engine/parity/r2-3d-evidence.test.ts (+ cargo test contract_v1_r23d_evidence, acceptance suites)',
      verifiedCodeSha: headSha(),
      sides: {
        ts: { pipeline: 'buildTsCandidate (live)', plannerVersion: 'parity-harness-1', gitSha: headSha() },
        rust: { pipeline: 'build_plan_v1 via NAPI (live)', plannerVersion: 'parity-harness-1', gitSha: headSha() },
        note: 'single repo: one commit pins both TS and Rust sources',
      },
      contract: {
        plannerVersion: 'parity-harness-1',
        fingerprintSchemaVersion: 1,
        timeConversion: 'time-conversion-v1',
        parityGateDoc: 'audit-r1/docs/TS_RUST_PARITY_GATE_V1.md @ 29d7e6ea7f858d76adc7f21a223cd791dc2b3d74',
      },
      e1: { checks: e1Checks, allExact: e1AllExact },
      e2: { cases: e2Results, allPass: e2AllPass },
      e3: { vectors: rustEvidence.vectors, allByteExact: rustEvidence.allByteExact },
      e4: {
        classA: rustEvidence.classA,
        classB: e4BFaults,
        classC: {
          cases: classCCases,
          allPass: classCAllPass,
          channel: 'live Rust NAPI validator (validateCandidateScoreEventsJson)',
        },
        classV: {
          vectors: classVVectors,
          allPass: classVAllPass,
          channel: 'live Rust NAPI primitives (canonicalBytesJson / computePlanFingerprintV1Json)',
          suite: 'acceptance-v.test.ts (EXECUTED_RUST_BYTE_EXACT)',
        },
      },
      e5: { ...e5Result, provenance: REAL_SCORE_PROVENANCE },
      e7,
      summary: {
        e1Checks: e1Checks.length,
        e2Cases: e2Results.length,
        e4bFaults: e4BFaults.length,
        e5Executed: e5Result.executed,
        verdict: e7.verdict,
      },
      boundary: {
        productionAuthoritySwitch: 'NOT performed and NOT authorized by this evidence package (separate review required)',
        mainMerge: 'FORBIDDEN',
      },
    };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, 'r2-3d-migration-evidence-v1.json'), `${JSON.stringify(report, null, 1)}\n`);
    // E1 detail evidence (field-by-field) as its own auditable file.
    writeFileSync(join(REPORT_DIR, 'r2-3d-e1-golden-exact.json'),
      `${JSON.stringify({ schemaVersion: 'r2-3d-e1-golden-exact-v1', checks: e1Checks, allExact: e1AllExact }, null, 1)}\n`);
    writeFileSync(join(REPORT_DIR, 'r2-3d-e5-real-score-result.json'),
      `${JSON.stringify({ ...e5Result, provenance: REAL_SCORE_PROVENANCE }, null, 1)}\n`);

    // THE VERDICT — after the evidence is on disk.
    expect(items.filter((item) => item.status === 'FAIL'), `failing items: ${JSON.stringify(items.filter((item) => item.status === 'FAIL'))}`).toEqual([]);
    expect(blocked, `blocked items: ${JSON.stringify(blocked)}`).toEqual([]);
    expect(e7.verdict).toBe('READY_FOR_SEPARATE_SWITCH_REVIEW');
  });
});
