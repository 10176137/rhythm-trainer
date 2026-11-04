'use strict';

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAlignmentShadow, persistAlignmentShadow } from './alignment-shadow.mjs';
import { TakeFinalizationService } from './take-finalization.mjs';

const dirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-shadow-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const scoreEvents = [
  { scoreEventId: 's1', pitch: 60, targetOnsetMs: 0, measure: 1 },
  { scoreEventId: 's2', pitch: 62, targetOnsetMs: 500, measure: 1 },
];
const performedNotes = [
  { performedNoteId: 'p1', pitch: 60, onsetMs: 0, pairingStatus: 'complete' },
  { performedNoteId: 'p2', pitch: 62, onsetMs: 800, pairingStatus: 'complete' },
];
const pair1 = { scoreEventId: 's1', performedNoteId: 'p1', pitchMatched: true, onsetErrorMs: 0, measure: 1 };
const pair2 = { scoreEventId: 's2', performedNoteId: 'p2', pitchMatched: true, onsetErrorMs: 300, measure: 1 };
const baseline = {
  algorithmVersion: 'scoring-v1.0.0',
  alignmentPairs: [pair1],
  missedScoreEventIds: ['s2'],
  extraPerformedIds: ['p2'],
};
const candidate = {
  pairs: [pair1, pair2],
  missedScoreEventIds: [],
  extraPerformedIds: [],
};
function invoke(dir, overrides = {}) {
  const traceInfo = { traceId: 'trace-1', dropped: 0, persistenceDegraded: false };
  const traceDir = path.join(dir, 'traces');
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(path.join(traceDir, 'trace-1.jsonl'), '{"raw":"original"}\n');
  return buildAlignmentShadow({
    takeId: 'take-1',
    scoreEvents,
    performedNotes,
    baselineReport: baseline,
    alignCandidate: () => candidate,
    traceInfo,
    traceDir,
    captureDiagnostics: { inputHealth: 'healthy', scoreStatus: 'AVAILABLE', clockMapping: { status: 'ok' } },
    scoreFingerprint: 'frozen-score',
    planFingerprint: 'frozen-plan',
    codeSha: '9b5ae66',
    ...overrides,
  });
}

describe('offline alignment research shadow', () => {
  it('recovers a late note but preserves the raw +300ms error and V1 evidence', () => {
    const dir = tmp();
    const originalScore = JSON.stringify(scoreEvents);
    const originalPerformed = JSON.stringify(performedNotes);
    const originalBaseline = JSON.stringify(baseline);
    const spy = vi.fn(() => candidate);
    const art = invoke(dir, { alignCandidate: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(art.status).toBe('AVAILABLE');
    expect(art.scoringPolicyVersion).toBe('none-shadow-only');
    expect(art.comparison).toMatchObject({
      recovered: 1, lost: 0, reassigned: 0, missedDelta: -1, extraDelta: -1,
      baselineRawOnsetMaeMs: 0, candidateRawOnsetMaeMs: 150,
    });
    expect(art.candidate.pairs[1].onsetErrorMs).toBe(300);
    expect(art.input.traceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(art.input.normalizedInputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(scoreEvents)).toBe(originalScore);
    expect(JSON.stringify(performedNotes)).toBe(originalPerformed);
    expect(JSON.stringify(baseline)).toBe(originalBaseline);
  });

  it('atomically persists once and refuses to silently overwrite a different artifact', () => {
    const dir = tmp();
    const art = invoke(dir);
    const dest = path.join(dir, 'assessments');
    const result = persistAlignmentShadow({ assessmentsDir: dest, artifact: art });
    expect(result).toMatchObject({
      ref: 'assessments/take-1/offline-alignment-shadow-v1.json',
      created: true,
    });
    const same = persistAlignmentShadow({ assessmentsDir: dest, artifact: art });
    expect(same.created).toBe(false);
    const file = path.join(dest, 'take-1', 'offline-alignment-shadow-v1.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(art);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['offline-alignment-shadow-v1.json']);
    expect(() => persistAlignmentShadow({
      assessmentsDir: dest, artifact: { ...art, scoreFingerprint: 'changed' },
    })).toThrow('SHADOW_IMMUTABLE_CONFLICT');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).scoreFingerprint).toBe('frozen-score');
  });

  it('marks wrong candidate onset and non-bijective pairs INVALID instead of returning a trusted result', () => {
    const dir = tmp();
    const rewritten = invoke(dir, {
      alignCandidate: () => ({ ...candidate, pairs: [pair1, { ...pair2, onsetErrorMs: 0 }] }),
    });
    expect(rewritten.status).toBe('INVALID');
    expect(rewritten.reasonCode).toBe('ALIGNMENT_COMPARISON_INVALID');
    expect(rewritten.diagnostic).toContain('SHADOW_REWRITTEN_ONSET');

    const reused = invoke(dir, {
      alignCandidate: () => ({
        pairs: [pair1, { ...pair2, performedNoteId: 'p1', pitchMatched: false, onsetErrorMs: -500 }],
        missedScoreEventIds: [],
        extraPerformedIds: ['p2'],
      }),
    });
    expect(reused.status).toBe('INVALID');
    expect(reused.diagnostic).toContain('SHADOW_NON_BIJECTIVE_PAIRS');
  });

  it('keeps poor input evidence degraded; cannot masquerade as a trusted Take score', () => {
    const dir = tmp();
    const art = invoke(dir, {
      traceInfo: { traceId: 'missing', dropped: 8, persistenceDegraded: true },
      captureDiagnostics: { inputHealth: 'degraded', scoreStatus: 'DEGRADED', clockMapping: { status: 'unscorable' } },
    });
    expect(art.status).toBe('DEGRADED');
    expect(art.input.traceSha256).toBeNull();
    expect(art.input.traceDropped).toBe(8);
    expect(art.candidate.pairs).toHaveLength(2);
  });

  it('does not run candidates past resource limits or when NAPI is missing', () => {
    const dir = tmp();
    const called = vi.fn(() => candidate);
    const bounded = invoke(dir, { maxNotes: 1, alignCandidate: called });
    expect(bounded.status).toBe('UNAVAILABLE');
    expect(bounded.reasonCode).toBe('RESOURCE_LIMIT');
    expect(called).not.toHaveBeenCalled();

    const missing = invoke(dir, { alignCandidate: null });
    expect(missing.status).toBe('UNAVAILABLE');
    expect(missing.reasonCode).toBe('CANDIDATE_ADDON_UNAVAILABLE');
    const empty = invoke(dir, { performedNotes: [] });
    expect(empty.status).toBe('INSUFFICIENT');
  });

  it('an independent shadow write failure does not block Take finalization', () => {
    const dir = tmp();
    const artifact = invoke(dir);
    const blocked = path.join(dir, 'assessments-blocked');
    fs.writeFileSync(blocked, 'not a directory');
    expect(() => persistAlignmentShadow({ assessmentsDir: blocked, artifact })).toThrow();
    const finalizer = new TakeFinalizationService({ takesDir: path.join(dir, 'takes') });
    const official = {
      schemaVersion: 1, takeId: 'take-1',
      assessment: { scoreStatus: 'AVAILABLE', timelineReport: { scoreV1: { overall: 81 } } },
    };
    const result = finalizer.finalize(official);
    expect(result.persisted).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'takes', 'take-1.json')))).toEqual(official);
  });
});
