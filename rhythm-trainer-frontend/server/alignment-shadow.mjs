'use strict';

// Research-only, opt-in offline alignment shadow for Timeline Takes.
// This module NEVER produces a user score or changes the authoritative Take.
// Only read-only N-API candidate outputs are compared against scoring_v1.
// Artifacts are additive, per-Take, and safe to omit on any failure.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ALIGNMENT_SHADOW_VERSION = 'rule-late-window-shadow-v1';
export const ALIGNMENT_SHADOW_MAX_NOTES = 2000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const PARAMETERS = Object.freeze({
  maxOnsetDeviationMs: 250,
  lateWindowRatio: 0.8,
  maxLateWindowMs: 600,
});

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}
function rawMae(pairs) {
  if (!pairs.length) return null;
  return pairs.reduce((sum, pair) => sum + Math.abs(pair.onsetErrorMs), 0) / pairs.length;
}
function byScoreId(pairs) {
  return new Map(pairs.map((pair) => [pair.scoreEventId, pair]));
}
function sortedIds(ids) {
  return [...ids].sort();
}

function validateAlignment(alignment, scoreEvents, performedNotes) {
  if (!Array.isArray(alignment?.pairs)
    || !Array.isArray(alignment?.missedScoreEventIds)
    || !Array.isArray(alignment?.extraPerformedIds)) {
    throw new Error('SHADOW_BAD_ALIGNMENT_SHAPE');
  }
  const scores = new Map(scoreEvents.map((event) => [event.scoreEventId, event]));
  const played = new Map(performedNotes.map((event) => [event.performedNoteId, event]));
  if (scores.size !== scoreEvents.length || played.size !== performedNotes.length) {
    throw new Error('SHADOW_DUPLICATE_INPUT_ID');
  }
  const pairedScores = new Set();
  const pairedPlayed = new Set();
  for (const pair of alignment.pairs) {
    const s = scores.get(pair.scoreEventId);
    const p = played.get(pair.performedNoteId);
    if (!s || !p) throw new Error('SHADOW_UNKNOWN_PAIR_ID');
    if (pairedScores.has(pair.scoreEventId) || pairedPlayed.has(pair.performedNoteId)) {
      throw new Error('SHADOW_NON_BIJECTIVE_PAIRS');
    }
    if (!Number.isFinite(pair.onsetErrorMs)
      || Math.abs(pair.onsetErrorMs - (p.onsetMs - s.targetOnsetMs)) > 1e-6) {
      throw new Error('SHADOW_REWRITTEN_ONSET');
    }
    if (pair.pitchMatched !== (s.pitch === p.pitch)) {
      throw new Error('SHADOW_PITCH_MISMATCH_FLAG');
    }
    pairedScores.add(pair.scoreEventId);
    pairedPlayed.add(pair.performedNoteId);
  }
  const misses = new Set(alignment.missedScoreEventIds);
  const extras = new Set(alignment.extraPerformedIds);
  if (misses.size !== alignment.missedScoreEventIds.length
    || extras.size !== alignment.extraPerformedIds.length) {
    throw new Error('SHADOW_DUPLICATE_UNMATCHED_ID');
  }
  for (const id of misses) if (!scores.has(id) || pairedScores.has(id)) {
    throw new Error('SHADOW_INVALID_MISS');
  }
  for (const id of extras) if (!played.has(id) || pairedPlayed.has(id)) {
    throw new Error('SHADOW_INVALID_EXTRA');
  }
  if (pairedScores.size + misses.size !== scores.size
    || pairedPlayed.size + extras.size !== played.size) {
    throw new Error('SHADOW_INCOMPLETE_PARTITION');
  }
  return {
    pairs: alignment.pairs.map((pair) => ({
      scoreEventId: pair.scoreEventId,
      performedNoteId: pair.performedNoteId,
      pitchMatched: pair.pitchMatched,
      onsetErrorMs: pair.onsetErrorMs,
      measure: pair.measure,
    })).sort((a, b) => a.scoreEventId.localeCompare(b.scoreEventId)),
    missedScoreEventIds: sortedIds(alignment.missedScoreEventIds),
    extraPerformedIds: sortedIds(alignment.extraPerformedIds),
  };
}

function compare(base, candidate) {
  const b = byScoreId(base.pairs);
  const c = byScoreId(candidate.pairs);
  const changes = [];
  for (const id of sortedIds(new Set([...b.keys(), ...c.keys()]))) {
    const oldPair = b.get(id) ?? null;
    const newPair = c.get(id) ?? null;
    if (oldPair?.performedNoteId === newPair?.performedNoteId
      && oldPair?.pitchMatched === newPair?.pitchMatched) continue;
    changes.push({
      scoreEventId: id,
      kind: !oldPair ? 'RECOVERED' : !newPair ? 'LOST' : 'REASSIGNED',
      baselinePerformedNoteId: oldPair?.performedNoteId ?? null,
      candidatePerformedNoteId: newPair?.performedNoteId ?? null,
    });
  }
  return {
    changedTargets: changes,
    recovered: changes.filter((c) => c.kind === 'RECOVERED').length,
    lost: changes.filter((c) => c.kind === 'LOST').length,
    reassigned: changes.filter((c) => c.kind === 'REASSIGNED').length,
    missedDelta: candidate.missedScoreEventIds.length - base.missedScoreEventIds.length,
    extraDelta: candidate.extraPerformedIds.length - base.extraPerformedIds.length,
    baselineRawOnsetMaeMs: rawMae(base.pairs),
    candidateRawOnsetMaeMs: rawMae(candidate.pairs),
  };
}

function traceDigest(fsImpl, traceDir, traceInfo) {
  const id = traceInfo?.traceId;
  if (!traceDir || !SAFE_ID.test(String(id ?? '')) || traceInfo.persistenceDegraded) return null;
  try {
    return hash(fsImpl.readFileSync(path.join(traceDir, id + '.jsonl')));
  } catch {
    return null;
  }
}

/**
 * Build a versioned, evidence-bearing research artifact.
 * The candidate runs only after V1 produced its frozen official report.
 * Never interpret an improvement in this diff as a change in user score.
 */
export function buildAlignmentShadow({
  takeId, scoreEvents, performedNotes, baselineReport, alignCandidate,
  scoreFingerprint = null, planFingerprint = null, traceInfo = null,
  traceDir = null, captureDiagnostics = null, codeSha = null,
  maxNotes = ALIGNMENT_SHADOW_MAX_NOTES, fsImpl = fs,
}) {
  if (!SAFE_ID.test(String(takeId ?? ''))) throw new Error('SHADOW_INVALID_TAKE_ID');
  const inputsOk = Array.isArray(scoreEvents) && Array.isArray(performedNotes);
  const validBudget = Number.isSafeInteger(maxNotes) && maxNotes > 0;
  if (!validBudget) throw new Error('SHADOW_BAD_BUDGET');
  const input = {
    scoreNoteCount: inputsOk ? scoreEvents.length : null,
    performedNoteCount: inputsOk ? performedNotes.length : null,
    normalizedInputSha256: inputsOk ? hash(JSON.stringify({ scoreEvents, performedNotes })) : null,
    traceId: traceInfo?.traceId ?? null,
    traceSha256: traceDigest(fsImpl, traceDir, traceInfo),
    traceDropped: traceInfo?.dropped ?? null,
    tracePersistenceDegraded: traceInfo?.persistenceDegraded ?? null,
    clockMappingStatus: captureDiagnostics?.clockMapping?.status ?? 'unknown',
    inputHealth: captureDiagnostics?.inputHealth ?? 'unknown',
    officialScoreStatus: captureDiagnostics?.scoreStatus ?? 'UNAVAILABLE',
  };
  const out = {
    schemaVersion: 1,
    scope: 'timeline-posthoc-research',
    takeId,
    algorithmVersion: ALIGNMENT_SHADOW_VERSION,
    baselineAlgorithmVersion: baselineReport?.algorithmVersion ?? null,
    scoringPolicyVersion: 'none-shadow-only',
    parameters: PARAMETERS,
    parameterFingerprint: hash(JSON.stringify(PARAMETERS)),
    sourceCodeSha: codeSha ?? null,
    scoreFingerprint,
    planFingerprint,
    input,
    status: 'UNAVAILABLE',
    reasonCode: null,
    baseline: null,
    candidate: null,
    comparison: null,
  };
  if (!inputsOk || !Array.isArray(baselineReport?.alignmentPairs)) {
    out.reasonCode = 'MISSING_SCORE_INPUT';
    return out;
  }
  if (scoreEvents.length > maxNotes || performedNotes.length > maxNotes) {
    out.reasonCode = 'RESOURCE_LIMIT';
    return out;
  }
  if (scoreEvents.length === 0 || performedNotes.length === 0) {
    out.status = 'INSUFFICIENT';
    out.reasonCode = 'EMPTY_INPUT';
    return out;
  }
  if (typeof alignCandidate !== 'function') {
    out.reasonCode = 'CANDIDATE_ADDON_UNAVAILABLE';
    return out;
  }
  try {
    const base = validateAlignment({
      pairs: baselineReport.alignmentPairs,
      missedScoreEventIds: baselineReport.missedScoreEventIds,
      extraPerformedIds: baselineReport.extraPerformedIds,
    }, scoreEvents, performedNotes);
    const candidate = validateAlignment(
      alignCandidate(scoreEvents, performedNotes), scoreEvents, performedNotes,
    );
    out.baseline = base;
    out.candidate = candidate;
    out.comparison = compare(base, candidate);
    const degraded = input.inputHealth !== 'healthy'
      || input.clockMappingStatus !== 'ok'
      || input.traceDropped !== 0
      || input.tracePersistenceDegraded === true
      || input.traceSha256 === null
      || !out.sourceCodeSha;
    if (input.officialScoreStatus === 'INSUFFICIENT_DATA') {
      out.status = 'INSUFFICIENT';
      out.reasonCode = 'OFFICIAL_SCORE_INSUFFICIENT';
    } else if (input.officialScoreStatus === 'INVALID'
      || input.officialScoreStatus === 'UNAVAILABLE') {
      out.status = 'UNAVAILABLE';
      out.reasonCode = 'OFFICIAL_SCORE_NOT_AVAILABLE';
    } else {
      out.status = degraded || input.officialScoreStatus !== 'AVAILABLE' ? 'DEGRADED' : 'AVAILABLE';
      out.reasonCode = out.status === 'DEGRADED' ? 'EVIDENCE_QUALITY_LIMITED' : null;
    }
  } catch (error) {
    out.status = 'INVALID';
    out.reasonCode = 'ALIGNMENT_COMPARISON_INVALID';
    out.diagnostic = String(error?.message ?? error).slice(0, 240);
  }
  return out;
}

/** Atomic, immutable, independent artifact. A failed sidecar cannot fail a Take. */
export function persistAlignmentShadow({ assessmentsDir, artifact, fsImpl = fs }) {
  if (!SAFE_ID.test(String(artifact?.takeId ?? ''))) throw new Error('SHADOW_INVALID_TAKE_ID');
  const takeId = artifact.takeId;
  const relativeRef = 'assessments/' + takeId + '/offline-alignment-shadow-v1.json';
  const dir = path.join(assessmentsDir, takeId);
  const dest = path.join(dir, 'offline-alignment-shadow-v1.json');
  const payload = JSON.stringify(artifact, null, 2);
  fsImpl.mkdirSync(dir, { recursive: true });
  if (fsImpl.existsSync(dest)) {
    if (fsImpl.readFileSync(dest, 'utf8') !== payload) {
      throw new Error('SHADOW_IMMUTABLE_CONFLICT');
    }
    return { ref: relativeRef, created: false };
  }
  const tmp = dest + '.tmp';
  try {
    const fd = fsImpl.openSync(tmp, 'w');
    try {
      fsImpl.writeFileSync(fd, payload, 'utf8');
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(tmp, dest);
    return { ref: relativeRef, created: true };
  } catch (error) {
    try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}
