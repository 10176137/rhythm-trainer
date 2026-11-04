'use strict';

// Research-only alignment comparison. No scores, metrics or report fields are
// recomputed here; the immutable scoring_v1 report remains authoritative.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const ALIGNMENT_SHADOW_VERSION = 'alignment-shadow-v1';
const MAX_NOTE_COUNT = 10_000;
const MAX_DIFF_DETAILS = 128;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const hashJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function pairsByTarget(pairs) {
  const byId = new Map();
  for (const pair of pairs) {
    if (!pair || typeof pair.scoreEventId !== 'string' || typeof pair.performedNoteId !== 'string') {
      throw new Error('invalid alignment pair');
    }
    if (byId.has(pair.scoreEventId)) throw new Error('duplicate score event in alignment');
    byId.set(pair.scoreEventId, {
      performedNoteId: pair.performedNoteId,
      pitchMatched: pair.pitchMatched === true,
      onsetErrorMs: Number(pair.onsetErrorMs),
    });
  }
  return byId;
}

function sortedUnique(values) {
  return [...new Set(values ?? [])].sort();
}

/**
 * Use exactly the same adjusted scoreEvents and admitted performedNotes that
 * scoring_v1 just consumed. A failure is evidence, not a Take failure.
 */
export function buildAlignmentShadow({ scoreEvents, performedNotes, official, addon, maxDiffDetails = MAX_DIFF_DETAILS }) {
  const base = {
    schemaVersion: 1,
    shadowVersion: ALIGNMENT_SHADOW_VERSION,
    mode: 'timeline',
    authority: 'diagnostic-only',
    baselineAlgorithmVersion: official?.algorithmVersion ?? 'scoring-v1.0.0',
    candidateAlgorithmVersion: 'alignment-candidate-v2',
    input: {
      scoreCount: Array.isArray(scoreEvents) ? scoreEvents.length : null,
      performedCount: Array.isArray(performedNotes) ? performedNotes.length : null,
      // This digest describes the exact scoring input, not the raw packet stream.
      scoringInputSha256: hashJson({ scoreEvents, performedNotes }),
      timeDomain: 'session-ms-after-admission-and-pause-adjustment',
    },
  };
  if (!Array.isArray(scoreEvents) || !Array.isArray(performedNotes)
    || !Array.isArray(official?.alignmentPairs)
    || !Array.isArray(official?.missedScoreEventIds)
    || !Array.isArray(official?.extraPerformedIds)) {
    return { ...base, status: 'skipped', reason: 'missing-official-alignment-or-inputs' };
  }
  if (scoreEvents.length > MAX_NOTE_COUNT || performedNotes.length > MAX_NOTE_COUNT) {
    return { ...base, status: 'skipped', reason: 'note-count-limit', limit: MAX_NOTE_COUNT };
  }
  const started = performance.now();
  try {
    if (typeof addon?.alignPerformancesCandidate !== 'function') {
      throw new Error('alignPerformancesCandidate unavailable');
    }
    const candidate = addon.alignPerformancesCandidate(scoreEvents, performedNotes);
    const baseline = pairsByTarget(official.alignmentPairs);
    const trial = pairsByTarget(candidate.pairs ?? []);
    const targetIds = sortedUnique(scoreEvents.map((x) => x.scoreEventId));
    if (targetIds.length !== scoreEvents.length) throw new Error('duplicate score IDs in scoring inputs');
    const differences = [];
    let changedTargetCount = 0;
    let recoveredTargetCount = 0;
    let lostTargetCount = 0;
    for (const targetId of targetIds) {
      const before = baseline.get(targetId) ?? null;
      const after = trial.get(targetId) ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      changedTargetCount += 1;
      if (!before && after) recoveredTargetCount += 1;
      if (before && !after) lostTargetCount += 1;
      if (differences.length < Math.max(0, Math.min(MAX_DIFF_DETAILS, maxDiffDetails))) {
        differences.push({ scoreEventId: targetId, baseline: before, candidate: after });
      }
    }
    const baselineMiss = sortedUnique(official.missedScoreEventIds);
    const candidateMiss = sortedUnique(candidate.missedScoreEventIds);
    const baselineExtra = sortedUnique(official.extraPerformedIds);
    const candidateExtra = sortedUnique(candidate.extraPerformedIds);
    return {
      ...base,
      status: 'compared',
      runtimeMs: Number((performance.now() - started).toFixed(3)),
      summary: {
        changedTargetCount,
        recoveredTargetCount,
        lostTargetCount,
        baselinePairs: baseline.size,
        candidatePairs: trial.size,
        baselineMissed: baselineMiss.length,
        candidateMissed: candidateMiss.length,
        baselineExtra: baselineExtra.length,
        candidateExtra: candidateExtra.length,
        totalDiffDetails: changedTargetCount,
        storedDiffDetails: differences.length,
        truncatedDiffDetails: changedTargetCount > differences.length,
      },
      alignmentHashes: {
        baseline: hashJson({ pairs: [...baseline].sort(), missed: baselineMiss, extra: baselineExtra }),
        candidate: hashJson({ pairs: [...trial].sort(), missed: candidateMiss, extra: candidateExtra }),
      },
      differences,
    };
  } catch (error) {
    return { ...base, status: 'error', reason: String(error?.message ?? error).slice(0, 500) };
  }
}

/**
 * Write an independent observation file only after authoritative Take commit.
 * Hard-linking a fully written temporary file is exclusive: retries/duplicate
 * finalization cannot overwrite an existing sidecar.
 */
export function persistAlignmentShadowOnce({ dir, takeId, shadow, fsImpl = fs }) {
  if (!SAFE_ID.test(takeId)) throw new Error('invalid takeId for shadow');
  const file = path.join(dir, `${takeId}.json`);
  if (fsImpl.existsSync(file)) return { created: false, file };
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${takeId}.${process.pid}.tmp`);
  try {
    const fd = fsImpl.openSync(tmp, 'wx');
    try {
      fsImpl.writeFileSync(fd, JSON.stringify({ ...shadow, takeId }, null, 2), 'utf8');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    try {
      fsImpl.linkSync(tmp, file);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return { created: false, file };
    }
    return { created: true, file };
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch { /* temp may not exist */ }
  }
}
