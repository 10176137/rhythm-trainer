#!/usr/bin/env node
// 5000/10000-note scalability benchmark for the READ-ONLY Rust candidate.
// Research-only. This script does not calculate official scores or mutate Takes.
// Run after rebuilding rhythm-trainer-core-v0.2/bindings/node native addon.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const addonDir = process.env.RHYTHM_CORE_ADDON_DIR
  || path.resolve(here, '../../../rhythm-trainer-core-v0.2/bindings/node');
const addon = require(addonDir);
if (typeof addon.alignPerformancesCandidate !== 'function') {
  throw new Error('rebuild N-API addon: alignPerformancesCandidate missing');
}
function makeCase(n, shifted = false) {
  const score = [], performed = [];
  for (let i = 0; i < n; i++) {
    const targetOnsetMs = 3000 + i * 400;
    const pitch = 48 + (i % 24);
    score.push({
      scoreEventId: 's' + i, measure: Math.floor(i / 16) + 1,
      beatPosition: i, pitch, targetOnsetMs, targetDurationMs: 200,
      partId: 'P1', parseConfidence: 1,
    });
    performed.push({
      performedNoteId: 'p' + i, pitch,
      onsetMs: targetOnsetMs + (shifted && i >= 100 ? 300 : 0),
      releaseMs: targetOnsetMs + (shifted && i >= 100 ? 300 : 0) + 200,
      pairingStatus: 'complete',
    });
  }
  return { score, performed };
}
function fingerprint(output) {
  return createHash('sha256').update(JSON.stringify(output)).digest('hex');
}
function quantile(values, q) {
  const copy = [...values].sort((a, b) => a - b);
  return copy[Math.ceil(q * copy.length) - 1];
}
const result = {
  benchmark: 'alignment-shadow-scaling-v1',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scoringPathChanged: false,
  cases: [],
};
for (const n of [5000, 10000]) {
  for (const shifted of [false, true]) {
    const data = makeCase(n, shifted);
    const timingsMs = [];
    const hashes = [];
    // Warm up native code and heap allocations once; then collect 10 runs.
    addon.alignPerformancesCandidate(data.score, data.performed);
    const rssBefore = process.memoryUsage().rss;
    for (let run = 0; run < 10; run++) {
      const t = performance.now();
      const output = addon.alignPerformancesCandidate(data.score, data.performed);
      timingsMs.push(performance.now() - t);
      hashes.push(fingerprint(output));
    }
    const rssAfter = process.memoryUsage().rss;
    result.cases.push({
      scoreNotes: n, performedNotes: n, case: shifted ? 'phase-300ms' : 'clean',
      p50Ms: quantile(timingsMs, 0.5),
      p95Ms: quantile(timingsMs, 0.95),
      p99Ms: quantile(timingsMs, 0.99),
      maxRssIncreaseBytes: Math.max(0, rssAfter - rssBefore),
      deterministic: hashes.every((x) => x === hashes[0]),
      resultSha256: hashes[0],
      rawTimingsMs: timingsMs,
    });
  }
}
console.log(JSON.stringify(result, null, 2));
