// R2-2c acceptance class B: candidate-output fault injection
// (TS_RUST_PARITY_GATE_V1 §6 B). The frozen bundle and golden stay untouched;
// only ONE side's candidate output is mutated. Each fault must be detected at
// the exact field path, classified semantic-defect, and produce a failing
// report — if the comparator ignored the path, these assertions would fail.
import { describe, expect, it } from 'vitest';
import { FAULT_SPECS, runFault, runParity } from './parity-runner';
import { findRepoRoot } from './case-bundle';

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
    expect(result.faultReports).toHaveLength(6);
    // The batch "passes" iff every fault was CAUGHT (detected + classified +
    // the mutated comparison failed). That is the opposite of the faults
    // sneaking through as clean parity.
    expect(result.exitCode).toBe(0);
    for (const fault of result.faultReports) {
      expect(fault.detected && fault.classifiedCorrectly && fault.reportStatus === 'fail').toBe(true);
    }
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
