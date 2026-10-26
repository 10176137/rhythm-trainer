#!/usr/bin/env node
'use strict';

// Stage 3 benchmark runner: deterministic, label-driven evaluation of the
// CURRENT baseline (Rust scoring_v1 / FollowRuntime) on the synthetic dataset.
//
// Labels are never passed to the algorithm. Every case is executed twice and
// the canonical results must be byte-identical (runtime excluded).
//
// Usage:
//   node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs
//
// Outputs: out/latest.json, out/latest.csv, out/summary.md

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const require = createRequire(import.meta.url);
const addon = require(path.join(REPO, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));

const sha = (value) => createHash('sha256').update(value).digest('hex');
const round = (value, digits = 3) => (value == null || !Number.isFinite(value) ? value : Number(value.toFixed(digits)));

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function classifyInputQuality(trace) {
  const signals = trace.qualitySignals ?? {};
  if (trace.mode === 'follow') {
    return (signals.performedCount ?? trace.inputs?.length ?? 0) > 0 ? 'healthy' : 'unscorable';
  }
  if ((signals.performedCount ?? 0) === 0) return 'unscorable';
  if (signals.deviceDisconnected || signals.queueOverflow) return 'degraded';
  if (signals.noteOnMissing > 0) return 'degraded';
  if (['unknown', 'unstable', 'bad'].includes(signals.clockQuality)) return 'degraded';
  if (signals.noteOffMissing > 0 || signals.duplicates > 0 || signals.outOfOrder > 0) return 'degraded';
  return 'healthy';
}

function predictedTimelineClasses(report) {
  const classes = new Map(); // scoreEventId -> MATCH/WRONG_PITCH/MISSING/AMBIGUOUS
  for (const event of report.eventResults) {
    if (!event.scoreEventId) continue;
    if (event.result === 'AMBIGUOUS') classes.set(event.scoreEventId, 'AMBIGUOUS');
    else if (event.result === 'MATCH') classes.set(event.scoreEventId, 'MATCH');
    else if (event.result === 'WRONG_PITCH') classes.set(event.scoreEventId, 'WRONG_PITCH');
    else if (event.result === 'MISSING') classes.set(event.scoreEventId, 'MISSING');
  }
  return classes;
}

function timelineResult(trace, labels) {
  const started = performance.now();
  // NAPI's Option<f64> does not accept an explicit null in this runtime;
  // omit the field entirely for missing-release notes.
  const performed = trace.performed.map((note) => {
    const { releaseMs, ...rest } = note;
    return releaseMs == null ? rest : note;
  });
  const report = addon.scorePerformance(trace.scoreEvents, performed);
  const runtimeMs = performance.now() - started;

  const expectedPairs = new Map(labels.expected.pairs.map((pair) => [pair.scoreEventId, pair]));
  const predictedPairs = new Map(report.alignmentPairs.map((pair) => [pair.scoreEventId, pair]));
  const predictedClasses = predictedTimelineClasses(report);

  let intersection = 0;
  let pitchClassCorrect = 0;
  let onsetDeltaMax = 0;
  let onsetDeltaSum = 0;
  const perMeasure = new Map();
  const bumpMeasure = (measure, key, amount = 1) => {
    const entry = perMeasure.get(measure) ?? { total: 0, errors: 0 };
    entry[key] += amount;
    perMeasure.set(measure, entry);
  };

  for (const [scoreEventId, expected] of expectedPairs) {
    const predicted = predictedPairs.get(scoreEventId);
    const target = trace.scoreEvents.find((event) => event.scoreEventId === scoreEventId);
    bumpMeasure(target?.measure ?? 0, 'total');
    if (predicted && predicted.performedNoteId === expected.performedNoteId) {
      intersection += 1;
      const expectedClass = expected.pitchMatched ? 'MATCH' : 'WRONG_PITCH';
      const predictedClass = predicted.pitchMatched ? 'MATCH' : 'WRONG_PITCH';
      if (expectedClass === predictedClass) pitchClassCorrect += 1;
      else bumpMeasure(target?.measure ?? 0, 'errors');
      const delta = Math.abs((predicted.onsetErrorMs ?? 0) - expected.onsetErrorMs);
      onsetDeltaMax = Math.max(onsetDeltaMax, delta);
      onsetDeltaSum += delta;
    } else {
      bumpMeasure(target?.measure ?? 0, 'errors');
    }
  }

  let missedCorrect = 0;
  for (const scoreEventId of labels.expected.missedScoreEventIds) {
    if (predictedClasses.get(scoreEventId) === 'MISSING') missedCorrect += 1;
    if (!predictedPairs.has(scoreEventId)) {
      const target = trace.scoreEvents.find((event) => event.scoreEventId === scoreEventId);
      bumpMeasure(target?.measure ?? 0, 'total');
      bumpMeasure(target?.measure ?? 0, 'errors');
    }
  }
  let extraCorrect = 0;
  const predictedExtras = new Set(report.extraPerformedIds);
  for (const performedNoteId of labels.expected.extraPerformedIds) {
    if (predictedExtras.has(performedNoteId)) extraCorrect += 1;
  }

  const expectedClassCount = expectedPairs.size + labels.expected.missedScoreEventIds.length + labels.expected.extraPerformedIds.length;
  const classCorrect = pitchClassCorrect + missedCorrect + extraCorrect;
  // Unassessable targets are excluded from precision/recall/class denominators:
  // the algorithm cannot know that missing input was not a user miss.
  const unassessable = new Set(labels.expected.unassessableScoreEventIds ?? []);

  const predictedPairCount = predictedPairs.size;
  const labelPairCount = expectedPairs.size;
  const precision = predictedPairCount === 0 ? (labelPairCount === 0 ? 1 : 0) : intersection / predictedPairCount;
  const recall = labelPairCount === 0 ? 1 : intersection / labelPairCount;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const quality = classifyInputQuality(trace);
  const qualityCorrect = quality === labels.expected.inputQuality;

  return {
    caseId: trace.caseId,
    mode: 'timeline',
    scenario: trace.scenario,
    tags: labels.expected.notes ? [] : [],
    expected: {
      pairs: labelPairCount,
      missed: labels.expected.missedScoreEventIds.length,
      extra: labels.expected.extraPerformedIds.length,
      unassessable: unassessable.size,
      inputQuality: labels.expected.inputQuality,
      assessable: labels.expected.assessable,
    },
    predicted: {
      pairs: predictedPairCount,
      missed: report.missedScoreEventIds.length,
      extra: report.extraPerformedIds.length,
      classes: Object.fromEntries(predictedClasses),
      algorithmVersion: report.algorithmVersion,
      confidence: report.confidence,
      dataDegraded: report.dataDegraded,
    },
    metrics: {
      pairingPrecision: round(precision),
      pairingRecall: round(recall),
      pairingF1: round(f1),
      classAccuracy: round(expectedClassCount === 0 ? 1 : classCorrect / expectedClassCount),
      onsetMaeVsLabel: round(intersection === 0 ? null : onsetDeltaSum / intersection),
      onsetMaxDeltaVsLabel: round(onsetDeltaMax),
      pitchCorrect: report.pitch.correct,
      pitchWrong: report.pitch.wrongPitch,
      pitchMissed: report.pitch.missed,
      pitchExtra: report.pitch.extra,
      quality,
      qualityCorrect,
      perMeasure: Object.fromEntries([...perMeasure.entries()].map(([measure, entry]) => [measure, {
        total: entry.total,
        errors: entry.errors,
        errorRate: round(entry.total === 0 ? null : entry.errors / entry.total),
      }])),
    },
    mismatches: {
      pairs: [...expectedPairs.keys()].filter((id) => !predictedPairs.has(id)),
      missed: labels.expected.missedScoreEventIds.filter((id) => predictedClasses.get(id) !== 'MISSING'),
      extra: labels.expected.extraPerformedIds.filter((id) => !predictedExtras.has(id)),
      onsetDeltas: [...expectedPairs.entries()]
        .map(([id, expected]) => {
          const predicted = predictedPairs.get(id);
          if (!predicted) return { scoreEventId: id, expected: expected.onsetErrorMs, predicted: null };
          return {
            scoreEventId: id,
            expected: expected.onsetErrorMs,
            predicted: predicted.onsetErrorMs,
            delta: round(Math.abs(predicted.onsetErrorMs - expected.onsetErrorMs)),
          };
        })
        .filter((entry) => entry.delta != null && entry.delta > 0),
    },
    runtimeMs: round(runtimeMs),
  };
}

function followResult(trace, labels) {
  const started = performance.now();
  const runtime = new addon.NativeFollowRuntime(
    trace.groups,
    trace.config.bpm,
    trace.config.timingToleranceMs,
    trace.config.chordSpreadToleranceMs,
  );
  const inputs = [...trace.inputs].sort((a, b) => a.atMs - b.atMs);
  let pauseInvalidated = false;
  const kinds = [];
  const intervalJudged = [];
  for (const input of inputs) {
    if (!pauseInvalidated && trace.pauseAtMs != null && input.atMs >= trace.pauseAtMs) {
      runtime.invalidateNextInterval();
      pauseInvalidated = true;
    }
    const result = runtime.pushNote(input.midiNote, input.atMs);
    kinds.push(result.kind);
    if (result.completedTarget) intervalJudged.push(!!result.completedTarget.intervalJudged);
  }
  const report = runtime.finish();
  const runtimeMs = performance.now() - started;

  const expected = labels.expected;
  const kindMatches = expected.kinds.reduce((sum, kind, index) => sum + (kinds[index] === kind ? 1 : 0), 0);
  const countFields = ['completedTargets', 'standardTargets', 'wrongNoteCount', 'extraNoteCount', 'duplicateNoteCount', 'pendingTargetId'];
  const countMismatches = countFields.filter((field) => (report[field] ?? null) !== (expected[field] ?? null));
  const intervalMismatches = expected.intervalJudged
    .map((value, index) => (intervalJudged[index] === value ? null : { index, expected: value, actual: intervalJudged[index] ?? null }))
    .filter(Boolean);
  const quality = classifyInputQuality(trace);

  return {
    caseId: trace.caseId,
    mode: 'follow',
    scenario: trace.scenario,
    expected,
    predicted: {
      kinds,
      intervalJudged,
      completedTargets: report.completedTargets,
      standardTargets: report.standardTargets,
      wrongNoteCount: report.wrongNoteCount,
      extraNoteCount: report.extraNoteCount,
      duplicateNoteCount: report.duplicateNoteCount,
      pendingTargetId: report.pendingTargetId,
      totalTargets: report.totalTargets,
    },
    metrics: {
      kindAccuracy: round(expected.kinds.length === 0 ? 1 : kindMatches / expected.kinds.length),
      countMismatches,
      intervalMismatches,
      quality,
      qualityCorrect: quality === expected.inputQuality,
    },
    runtimeMs: round(runtimeMs),
  };
}

function canonicalize(result) {
  const clone = JSON.parse(JSON.stringify(result));
  delete clone.runtimeMs;
  return clone;
}

function validateLabels(trace, labels) {
  const expected = labels.expected;
  if (trace.mode === 'follow') {
    if (!Array.isArray(expected.kinds) || expected.kinds.length !== trace.inputs.length) {
      throw new Error(`${trace.caseId}: follow labels kinds do not match inputs`);
    }
    if (!Array.isArray(expected.intervalJudged) || expected.intervalJudged.length > expected.kinds.length) {
      throw new Error(`${trace.caseId}: follow intervalJudged is invalid`);
    }
    return;
  }
  const scoreEvents = new Map(trace.scoreEvents.map((event) => [event.scoreEventId, event]));
  const performed = new Map(trace.performed.map((note) => [note.performedNoteId, note]));
  const pairedScore = new Set();
  const pairedPerformed = new Set();
  for (const pair of expected.pairs) {
    const scoreEvent = scoreEvents.get(pair.scoreEventId);
    const note = performed.get(pair.performedNoteId);
    if (!scoreEvent || !note) throw new Error(`${trace.caseId}: label pair references unknown ids`);
    if (pairedScore.has(pair.scoreEventId) || pairedPerformed.has(pair.performedNoteId)) {
      throw new Error(`${trace.caseId}: label pair is not 1:1`);
    }
    pairedScore.add(pair.scoreEventId);
    pairedPerformed.add(pair.performedNoteId);
    if (pair.pitchMatched !== (scoreEvent.pitch === note.pitch)) {
      throw new Error(`${trace.caseId}: label pitchMatched disagrees with raw events`);
    }
    const onsetError = note.onsetMs - scoreEvent.targetOnsetMs;
    if (Math.abs(onsetError - pair.onsetErrorMs) > 1e-6) {
      throw new Error(`${trace.caseId}: label onsetErrorMs disagrees with raw events`);
    }
  }
  const unassessable = new Set(expected.unassessableScoreEventIds ?? []);
  for (const scoreEventId of expected.missedScoreEventIds) {
    if (!scoreEvents.has(scoreEventId) || pairedScore.has(scoreEventId) || unassessable.has(scoreEventId)) {
      throw new Error(`${trace.caseId}: invalid missed label ${scoreEventId}`);
    }
  }
  for (const performedNoteId of expected.extraPerformedIds) {
    if (!performed.has(performedNoteId) || pairedPerformed.has(performedNoteId)) {
      throw new Error(`${trace.caseId}: invalid extra label ${performedNoteId}`);
    }
  }
  for (const scoreEventId of unassessable) {
    if (!scoreEvents.has(scoreEventId) || pairedScore.has(scoreEventId) || expected.missedScoreEventIds.includes(scoreEventId)) {
      throw new Error(`${trace.caseId}: invalid unassessable label ${scoreEventId}`);
    }
  }
}

function runAll(manifest) {
  const results = [];
  for (const entry of manifest.cases) {
    const tracePath = path.join(__dirname, entry.trace);
    const labelPath = path.join(__dirname, entry.labels);
    if (!existsSync(tracePath) || !existsSync(labelPath)) {
      throw new Error(`missing trace/labels for ${entry.caseId}`);
    }
    const trace = readJson(tracePath);
    const labels = readJson(labelPath);
    if (trace.caseId !== entry.caseId || labels.caseId !== entry.caseId) {
      throw new Error(`case id mismatch for ${entry.caseId}`);
    }
    validateLabels(trace, labels);
    const result = trace.mode === 'timeline'
      ? timelineResult(trace, labels)
      : followResult(trace, labels);
    result.scenario = entry.scenario;
    result.tags = entry.tags;
    results.push(result);
  }
  return results;
}

function aggregate(results) {
  const timeline = results.filter((result) => result.mode === 'timeline');
  const follow = results.filter((result) => result.mode === 'follow');
  const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    timeline: {
      cases: timeline.length,
      macro: {
        pairingPrecision: round(mean(timeline.map((result) => result.metrics.pairingPrecision))),
        pairingRecall: round(mean(timeline.map((result) => result.metrics.pairingRecall))),
        pairingF1: round(mean(timeline.map((result) => result.metrics.pairingF1))),
        classAccuracy: round(mean(timeline.map((result) => result.metrics.classAccuracy))),
        onsetMaeVsLabel: round(mean(timeline.map((result) => result.metrics.onsetMaeVsLabel).filter((value) => value != null))),
      },
      casesWithPairingErrors: timeline.filter((result) => result.metrics.pairingF1 < 1).map((result) => result.caseId),
      casesWithClassErrors: timeline.filter((result) => result.metrics.classAccuracy < 1).map((result) => result.caseId),
      qualityAccuracy: round(mean(timeline.map((result) => result.metrics.qualityCorrect ? 1 : 0))),
    },
    follow: {
      cases: follow.length,
      macro: {
        kindAccuracy: round(mean(follow.map((result) => result.metrics.kindAccuracy))),
        casesWithCountErrors: follow.filter((result) => result.metrics.countMismatches.length > 0).length,
        casesWithIntervalErrors: follow.filter((result) => result.metrics.intervalMismatches.length > 0).length,
        qualityAccuracy: round(mean(follow.map((result) => result.metrics.qualityCorrect ? 1 : 0))),
      },
    },
    runtimeMs: round(results.reduce((sum, result) => sum + result.runtimeMs, 0)),
  };
}

function toCsv(results) {
  const header = [
    'caseId', 'mode', 'scenario', 'pairingPrecision', 'pairingRecall', 'pairingF1',
    'classAccuracy', 'onsetMaeVsLabel', 'kindAccuracy', 'quality', 'qualityCorrect', 'runtimeMs',
  ];
  const rows = results.map((result) => {
    const metrics = result.metrics;
    return [
      result.caseId,
      result.mode,
      result.scenario,
      metrics.pairingPrecision ?? '',
      metrics.pairingRecall ?? '',
      metrics.pairingF1 ?? '',
      metrics.classAccuracy ?? '',
      metrics.onsetMaeVsLabel ?? '',
      metrics.kindAccuracy ?? '',
      metrics.quality ?? '',
      metrics.qualityCorrect ?? '',
      result.runtimeMs ?? '',
    ];
  });
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n';
}

function toMarkdown(manifest, results, aggregateResult, metadata) {
  const lines = [];
  lines.push('# Alignment benchmark v1 — baseline summary');
  lines.push('');
  lines.push(`- Generated: ${metadata.generatedAt}`);
  lines.push(`- Git SHA: \`${metadata.gitSha ?? 'unknown'}\``);
  lines.push(`- Dataset: \`${manifest.datasetVersion}\` (${manifest.counts.timeline} timeline, ${manifest.counts.follow} follow)`);
  lines.push(`- Baseline: Rust \`${results.find((result) => result.mode === 'timeline')?.predicted.algorithmVersion ?? 'unknown'}\` / FollowRuntime`);
  lines.push(`- Deterministic (two runs): **${metadata.deterministic ? 'yes' : 'NO'}**`);
  lines.push('');
  lines.push('## Aggregate (Timeline)');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(aggregateResult.timeline.macro)) lines.push(`| ${key} | ${value ?? '—'} |`);
  lines.push(`| quality accuracy | ${aggregateResult.timeline.qualityAccuracy ?? '—'} |`);
  lines.push('');
  lines.push('## Aggregate (Follow)');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  for (const [key, value] of Object.entries(aggregateResult.follow.macro)) lines.push(`| ${key} | ${value ?? '—'} |`);
  lines.push('');
  lines.push('## Timeline cases');
  lines.push('');
  lines.push('| Case | Precision | Recall | F1 | Class acc. | Onset ∆ (ms) | Quality |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const result of results.filter((entry) => entry.mode === 'timeline')) {
    lines.push(`| ${result.caseId} | ${result.metrics.pairingPrecision} | ${result.metrics.pairingRecall} | ${result.metrics.pairingF1} | ${result.metrics.classAccuracy} | ${result.metrics.onsetMaeVsLabel ?? '—'} | ${result.metrics.quality}${result.metrics.qualityCorrect ? '' : ' ❌'} |`);
  }
  lines.push('');
  lines.push('## Follow cases');
  lines.push('');
  lines.push('| Case | Kind acc. | Count errors | Interval errors |');
  lines.push('|---|---|---|---|');
  for (const result of results.filter((entry) => entry.mode === 'follow')) {
    lines.push(`| ${result.caseId} | ${result.metrics.kindAccuracy} | ${result.metrics.countMismatches.join(', ') || '—'} | ${result.metrics.intervalMismatches.length} |`);
  }
  lines.push('');
  lines.push('## Known baseline failures (expected evidence, not harness failure)');
  lines.push('');
  const failures = results.filter((result) => (
    result.mode === 'timeline'
      ? result.metrics.pairingF1 < 1 || result.metrics.classAccuracy < 1
      : result.metrics.kindAccuracy < 1 || result.metrics.countMismatches.length > 0
  ));
  if (failures.length === 0) lines.push('- none');
  else for (const result of failures) lines.push(`- \`${result.caseId}\` — ${result.scenario}`);
  lines.push('');
  lines.push('Labels are independent of the implementation; a low score is a benchmark observation, not a gate failure at Stage 3.');
  return `${lines.join('\n')}\n`;
}

function main() {
  if (!existsSync(MANIFEST_PATH)) throw new Error('manifest.json not found; run generate-cases.mjs first');
  const manifest = readJson(MANIFEST_PATH);
  mkdirSync(OUT_DIR, { recursive: true });

  const first = runAll(manifest);
  const second = runAll(manifest);
  const firstCanonical = JSON.stringify(first.map(canonicalize));
  const secondCanonical = JSON.stringify(second.map(canonicalize));
  const deterministic = firstCanonical === secondCanonical;
  const generatedAt = new Date().toISOString();
  const metadata = {
    generatedAt,
    gitSha: gitSha(),
    node: process.version,
    deterministic,
    runHashes: [sha(firstCanonical), sha(secondCanonical)],
    datasetManifestSha256: sha(JSON.stringify(manifest)),
  };
  const aggregateResult = aggregate(first);
  const output = {
    schemaVersion: 1,
    benchmarkVersion: 'alignment-bench-run-v1',
    datasetVersion: manifest.datasetVersion,
    ...metadata,
    aggregate: aggregateResult,
    runs: [
      { hash: metadata.runHashes[0], cases: first },
      { hash: metadata.runHashes[1], cases: second },
    ],
  };

  const jsonPath = path.join(OUT_DIR, 'latest.json');
  writeFileSync(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(OUT_DIR, 'latest.csv'), toCsv(first), 'utf8');
  writeFileSync(path.join(OUT_DIR, 'summary.md'), toMarkdown(manifest, first, aggregateResult, metadata), 'utf8');
  console.log(`wrote ${jsonPath}`);
  console.log(`deterministic=${deterministic} timelineF1=${aggregateResult.timeline.macro.pairingF1} followKindAccuracy=${aggregateResult.follow.macro.kindAccuracy}`);
  if (!deterministic) process.exitCode = 1;
}

main();
