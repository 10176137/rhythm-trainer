#!/usr/bin/env node
'use strict';

// Research performance gate, not a production benchmark result.
// Each (size, scenario) runs in a separate Node process with a hard timeout.
// Usage: node audit-r1/benchmarks/alignment-v2/run-performance.mjs
// Prerequisite: rebuild the Rust N-API addon from the CURRENT branch.
// Results are written to out/performance-local.json (never a fabricated PASS).

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUTPUT = path.join(HERE, 'out', 'performance-local.json');
const TIMEOUT_MS = 120_000;

function makeFixture(n, phaseMs) {
  const scoreEvents = [];
  const performedNotes = [];
  for (let i = 0; i < n; i++) {
    const onset = 3000 + i * 750;
    const pitch = 48 + (i % 60);
    scoreEvents.push({
      scoreEventId: `s${i}`,
      measure: Math.floor(i / 4) + 1,
      beatPosition: i * 1.5,
      pitch,
      targetOnsetMs: onset,
      targetDurationMs: 500,
      partId: 'P1',
      parseConfidence: 1,
    });
    const performedOnset = onset + (i === 0 ? 0 : phaseMs);
    performedNotes.push({
      performedNoteId: `p${i}`,
      pitch,
      onsetMs: performedOnset,
      releaseMs: performedOnset + 500,
      pairingStatus: 'complete',
    });
  }
  return { scoreEvents, performedNotes };
}

function runWorker(n, phaseMs) {
  const require = createRequire(import.meta.url);
  const addon = require(path.join(REPO, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));
  const data = makeFixture(n, phaseMs);
  const startOfficial = performance.now();
  const official = addon.scorePerformance(data.scoreEvents, data.performedNotes);
  const officialMs = performance.now() - startOfficial;
  const startCandidate = performance.now();
  const candidate = addon.alignPerformancesCandidate(data.scoreEvents, data.performedNotes);
  const candidateMs = performance.now() - startCandidate;
  const expected = new Map(data.scoreEvents.map((s, i) => [s.scoreEventId, `p${i}`]));
  const wrong = candidate.pairs.filter((p) => expected.get(p.scoreEventId) !== p.performedNoteId || !p.pitchMatched);
  const clean = candidate.pairs.length === n && wrong.length === 0
    && candidate.missedScoreEventIds.length === 0 && candidate.extraPerformedIds.length === 0;
  return {
    size: n,
    phaseMs,
    status: clean ? 'pass' : 'incorrect-pairing',
    candidatePaired: candidate.pairs.length,
    mismatchedPairs: wrong.length,
    missed: candidate.missedScoreEventIds.length,
    extra: candidate.extraPerformedIds.length,
    officialPaired: official.alignmentPairs?.length ?? null,
    officialMs: Number(officialMs.toFixed(2)),
    candidateMs: Number(candidateMs.toFixed(2)),
    rssMb: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  };
}

if (process.argv[2] === '--worker') {
  const n = Number(process.argv[3]);
  const phase = Number(process.argv[4]);
  try {
    process.stdout.write(JSON.stringify(runWorker(n, phase)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ size: n, phaseMs: phase, status: 'error', error: String(error?.stack ?? error) }) + '\n');
    process.exitCode = 1;
  }
} else {
  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); } catch { /* missing git metadata */ }
  const cases = [];
  for (const size of [5000, 10000]) {
    for (const phaseMs of [0, 300]) {
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', String(size), String(phaseMs)], {
        cwd: REPO, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024,
      });
      let result;
      try { result = JSON.parse((run.stdout ?? '').trim()); } catch {
        result = { size, phaseMs, status: run.error?.code === 'ETIMEDOUT' ? 'timeout' : 'error',
          error: String(run.error?.message ?? run.stderr ?? 'missing worker output').slice(0, 500) };
      }
      cases.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const report = {
    benchmarkVersion: 'alignment-v2-performance-v1',
    gitSha: head,
    createdAtIso: new Date().toISOString(),
    device: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
    timeoutMs: TIMEOUT_MS,
    status: cases.every((c) => c.status === 'pass') ? 'pass' : 'needs-investigation',
    cases,
    note: 'Synthetic identity and performance only; this does not establish real-device accuracy or scoring reliability.',
  };
  mkdirSync(path.dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved: ${OUTPUT} (${report.status})`);
}
