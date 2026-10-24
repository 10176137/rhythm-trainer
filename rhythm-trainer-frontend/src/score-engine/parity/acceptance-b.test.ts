// R2-2c acceptance class B: candidate-output fault injection
// (TS_RUST_PARITY_GATE_V1 §6 B). The frozen bundle and golden stay untouched;
// only ONE side's candidate output is mutated. Each fault must be detected at
// the exact field path, classified semantic-defect, and produce a failing
// report — if the comparator ignored the path, these assertions would fail.
import { describe, expect, it } from 'vitest';
import { FAULT_SPECS, runCase, runFault, runParity } from './parity-runner';
import { findRepoRoot, loadCaseIndex } from './case-bundle';

const ROOT = findRepoRoot();
const META = { root: ROOT, gitSha: null, command: 'acceptance-b' };

describe('acceptance B: the six frozen fault injections', () => {
  for (const spec of FAULT_SPECS) {
    it(`${spec.faultId} (${spec.caseId}): ${spec.description}`, () => {
      const report = runFault(META, spec);
      expect(report.detected).toBe(true);
      expect(report.classifiedCorrectly).toBe(true);
      // Meta-proof (task card §6/B): the semantic-defect MUST sit on the
      // frozen expected path — a comparator that ignored this field would
      // leave report.diffs without this entry and fail here.
      expect(report.diffs.some(
        (diff) => diff.category === 'semantic-defect' && diff.path.startsWith(spec.expectedPathPrefix),
      )).toBe(true);
      // The mutated comparison must FAIL the report (non-zero exit).
      expect(report.reportStatus).toBe('fail');
    });
  }

  it('all six faults together yield a caught-and-failed batch (fault MODE semantics)', () => {
    const result = runParity({ mode: 'fault' }, META);
    // Fault mode runs ONLY the injected faults; no case reports are produced.
    expect(result.reports).toHaveLength(0);
    expect(result.faultReports).toHaveLength(6);
    // The batch "passes" iff every fault was CAUGHT (detected + classified +
    // the mutated comparison failed). That is the opposite of the faults
    // sneaking through as clean parity.
    expect(result.exitCode).toBe(0);
    for (const fault of result.faultReports) {
      expect(fault.detected && fault.classifiedCorrectly && fault.reportStatus === 'fail').toBe(true);
    }
  });

  it('an unknown faultId FAILS instead of exiting 0 vacuously (2nd review §一.1)', () => {
    expect(() => runParity({ mode: 'fault', faultId: 'N-DOES-NOT-EXIST' }, META))
      .toThrow(/faultId not found/);
  });

  it('layer statuses stay truthful: an L2-only failure leaves L1/L3 as pass (3rd review)', () => {
    const index = loadCaseIndex(META.root);
    const base = index.cases.find((entry) => entry.caseId === 'G3-range-m2');
    if (!base) throw new Error('G3-range-m2 missing');
    // A wrong EXPECTED issue code makes only L2's expected-outcome check fail;
    // L1 (fingerprint matches the real gate code) and L3 (empty-plan invariants
    // + n/a wire) must keep reporting their own truthful pass.
    const bundle = { ...base, expectedOutcome: { ...base.expectedOutcome, issueCodes: ['not_a_real_code'] } };
    const report = runCase(bundle, META);
    expect(report.l1.status).toBe('pass');
    expect(report.l2.status).toBe('fail');
    expect(report.l3.status).toBe('pass');
    expect(report.summary.pass).toBe(false);
  });

  it('fault injection leaves the frozen bundle and golden untouched (no self-upgrade)', () => {
    // Run faults, then re-run a clean full pass: everything must still PASS —
    // proving the mutated outputs were never written back as expectations.
    const faults = runParity({ mode: 'fault' }, META);
    expect(faults.faultReports.every((f) => f.detected)).toBe(true);
    const clean = runParity({ mode: 'full' }, META);
    expect(clean.reports.every((report) => report.summary.pass)).toBe(true);
    expect(clean.exitCode).toBe(0);
  });
});
