// R2-2 offline parity CLI entry. Bundled with esbuild into
// audit-r1/spike/out/parity-runner.bundle.mjs (regenerable, gitignored):
//   cd rhythm-trainer-frontend
//   ./node_modules/.bin/esbuild ../audit-r1/spike/parity-runner.entry.mjs \
//     --bundle --platform=node --format=esm \
//     --outfile=../audit-r1/spike/out/parity-runner.bundle.mjs
//   node ../audit-r1/spike/out/parity-runner.bundle.mjs --mode=full \
//     --reportDir=../audit-r1/reports/r2-2
// Modes: full | case --caseId=X | fault [--faultId=N-PITCH-F1]
import { runParity, writeReports } from '../../rhythm-trainer-frontend/src/score-engine/parity/parity-runner.ts';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const mode = flag('mode') ?? 'full';
const reportDir = flag('reportDir') ?? '../audit-r1/reports/r2-2';

const options = mode === 'case'
  ? { mode: 'case', caseId: flag('caseId') ?? '' }
  : mode === 'fault'
    ? { mode: 'fault', ...(flag('faultId') ? { faultId: flag('faultId') } : {}) }
    : { mode: 'full' };

const result = runParity(options, { command: `parity-runner ${process.argv.slice(2).join(' ')}` });
const written = writeReports(result, reportDir);

for (const report of result.reports) {
  const status = report.summary.status.toUpperCase();
  console.log(`[${status}] ${report.caseId}: ${report.summary.categories['semantic-defect']} semantic-defect(s), ${report.summary.categories.unclassified} unclassified, ${report.summary.categories['time-rounding']} time-rounding`);
}
for (const fault of result.faultReports) {
  console.log(`[FAULT ${fault.faultId}] detected=${fault.detected} classified=${fault.classifiedCorrectly} reportFailed=${fault.reportStatus === 'fail'}`);
}
console.log(`reports written: ${written.join(', ')}`);
console.log(`exit=${result.exitCode}`);
process.exit(result.exitCode);
