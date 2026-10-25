// R2-3b evidence generator (NOT a regular test): when run with
// GENERATE_RUST_PARITY_INPUTS=1 it freezes, per parity case, the TS-projected
// ScoreDocumentV1 + ImportReportV1 inputs and the full TS candidate (the
// production pipeline's canonical projection) into
// audit-r1/fixtures/parity-cases/rust-parity-input/{caseId}.json — the
// byte-frozen corpus the Rust build_plan_v1 acceptance test consumes. Without
// the env flag the suite skips; golden files, expected files and the case
// index are read-only here — this only WRITES the new input directory.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTsCandidate, type ParityCaseConfig } from './parity-candidate';
import { findRepoRoot, loadCaseIndex, loadFixtureXml } from './case-bundle';
import {
  projectScoreDocumentV1,
  validateScoreDocumentV1,
} from '../contract-v1/plan-fingerprint';
import { importMusicXml } from '../import/musicxml-importer';

const enabled = process.env.GENERATE_RUST_PARITY_INPUTS === '1';

describe.skipIf(!enabled)('rust parity input generator (R2-3b corpus)', () => {
  it('freezes V1 document + report + TS candidate per parity case', () => {
    const root = findRepoRoot();
    const index = loadCaseIndex(root);
    const outDir = join(root, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input');
    mkdirSync(outDir, { recursive: true });
    for (const bundle of index.cases) {
      const { xml, fileName } = loadFixtureXml(root, bundle);
      const imported = importMusicXml(xml, { fileName });
      const document = imported.scoreDocument;
      if (!document) throw new Error(`${bundle.caseId}: fixture did not import`);
      const projected = projectScoreDocumentV1(document, imported.importReport);
      const documentIssues = validateScoreDocumentV1(projected.dto);
      expect(documentIssues, `${bundle.caseId}: projected V1 document must be clean`).toEqual([]);
      const ts = buildTsCandidate(xml, fileName, bundle.config as ParityCaseConfig);
      const record = {
        caseId: bundle.caseId,
        config: bundle.config,
        document: projected.dto,
        report: imported.importReport,
        expectedCandidate: ts.candidate,
        meta: {
          fingerprint: ts.fingerprint,
          fingerprintErrorCode: ts.fingerprintErrorCode,
          importStatus: ts.importStatus,
          importStrictAllowed: ts.importStrictAllowed,
          planStrictAllowed: ts.planStrictAllowed,
          planIssues: ts.planIssues,
          scopeCodes: ts.scopeCodes,
          missingEventIds: ts.missingEventIds,
          atomIssueCodes: ts.atomIssueCodes,
        },
      };
      writeFileSync(join(outDir, `${bundle.caseId}.json`), `${JSON.stringify(record, null, 1)}\n`);
    }
  });
});
