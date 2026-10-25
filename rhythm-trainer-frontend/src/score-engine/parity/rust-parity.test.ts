// R2-3c: the dual-run acceptance. For every frozen parity case the SAME
// frozen inputs (ScoreDocumentV1 + ImportReportV1 + config from
// rust-parity-input/) drive BOTH sides: the TS candidate below was frozen at
// corpus-generation time; the Rust candidate is produced LIVE through the
// NAPI surface (buildParityCandidateV1). The Rust candidate feeds the
// existing `diffCandidates` comparator against the TS expected candidate,
// under the frozen acceptance predicate (parity-diff reportPasses:
// semantic-defect / unclassified / unsupported-behavior must all be zero).
// L1: the a3 gate over the Rust plan must reproduce the TS gate fingerprint
// byte-for-byte (or its exact frozen error code on the blocked case).
// Planner-domain metadata (issues/scope/misses/atom blockers/strict flag)
// is asserted against the corpus meta so the two pipelines agree beyond the
// canonical shapes.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './case-bundle';
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

interface CorpusRecord {
  caseId: string;
  document: unknown;
  report: unknown;
  config: unknown;
  expectedCandidate: ParityCandidate;
  meta: {
    fingerprint: string | null;
    fingerprintErrorCode: string | null;
    planStrictAllowed: boolean;
    planIssues: Array<{ code: string; blocksStrict: boolean }>;
    scopeCodes: string[];
    missingEventIds: string[];
    atomIssueCodes: string[];
  };
}

const corpusDir = join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input');
const files = readdirSync(corpusDir).filter((file) => file.endsWith('.json')).sort();
const records: CorpusRecord[] = files.map((file) =>
  JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusRecord);

function buildRust(record: CorpusRecord): { candidateJson: RustParityResult; plan: unknown } {
  const documentJson = JSON.stringify(record.document);
  const reportJson = JSON.stringify(record.report);
  const configJson = JSON.stringify(record.config);
  const candidateJson = JSON.parse(
    native.buildParityCandidateV1(documentJson, reportJson, configJson),
  ) as RustParityResult;
  const plan = JSON.parse(native.buildPlanV1(documentJson, reportJson, configJson));
  return { candidateJson, plan };
}

describe('R2-3c: Rust planner dual-run against the frozen TS truth', () => {
  it('covers all 15 frozen parity cases', () => {
    expect(files).toHaveLength(15);
  });

  for (const record of records) {
    const caseId = record.caseId;

    it(`${caseId}: rust candidate is accepted by diffCandidates (frozen predicate)`, () => {
      const { candidateJson } = buildRust(record);
      expect(candidateJson.candidate.side).toBe('rust-planner');
      expect(candidateJson.candidate.kind).toBe('candidate');
      const diffs = diffCandidates(record.expectedCandidate, candidateJson.candidate);
      const categories = categorize(diffs);
      expect(
        reportPasses(categories),
        `${caseId}: diffs (${JSON.stringify(categories)}):\n${JSON.stringify(diffs, null, 1)}`,
      ).toBe(true);
    });

    it(`${caseId}: planner metadata matches the TS pipeline`, () => {
      const { candidateJson } = buildRust(record);
      expect(candidateJson.meta.planStrictAllowed).toBe(record.meta.planStrictAllowed);
      expect(candidateJson.meta.planIssues).toEqual(record.meta.planIssues);
      expect(candidateJson.meta.scopeCodes).toEqual(record.meta.scopeCodes);
      expect(candidateJson.meta.missingEventIds).toEqual(record.meta.missingEventIds);
      expect(candidateJson.meta.atomIssueCodes).toEqual(record.meta.atomIssueCodes);
    });

    it(`${caseId}: L1 — the a3 gate over the rust plan reproduces the TS fingerprint`, () => {
      const { plan } = buildRust(record);
      try {
        const fingerprint = native.planFingerprintV1Gate(
          JSON.stringify(record.document),
          JSON.stringify(record.report),
          JSON.stringify(plan),
          JSON.stringify(record.config),
        );
        expect(record.meta.fingerprintErrorCode).toBeNull();
        expect(fingerprint).toBe(record.meta.fingerprint);
      } catch (error) {
        // Blocked cases fail closed with "<CODE>: <message>" — the code must
        // equal the TS gate's frozen rejection code exactly.
        const message = error instanceof Error ? error.message : String(error);
        const code = message.split(':')[0]?.trim();
        expect(record.meta.fingerprintErrorCode, `unexpected rejection: ${message}`).toBeTruthy();
        expect(code).toBe(record.meta.fingerprintErrorCode);
      }
    });
  }
});
