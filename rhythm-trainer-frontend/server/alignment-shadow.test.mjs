'use strict';

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAlignmentShadow, persistAlignmentShadowOnce } from './alignment-shadow.mjs';

const dirs = [];
const inputs = () => ({
  scoreEvents: [
    { scoreEventId: 's1', pitch: 60, targetOnsetMs: 0 },
    { scoreEventId: 's2', pitch: 62, targetOnsetMs: 500 },
  ],
  performedNotes: [
    { performedNoteId: 'p1', pitch: 60, onsetMs: 0 },
    { performedNoteId: 'p2', pitch: 62, onsetMs: 800 },
  ],
  official: {
    algorithmVersion: 'scoring-v1.0.0',
    alignmentPairs: [{ scoreEventId: 's1', performedNoteId: 'p1', pitchMatched: true, onsetErrorMs: 0 }],
    missedScoreEventIds: ['s2'],
    extraPerformedIds: ['p2'],
  },
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

describe('alignment shadow comparison', () => {
  it('records recovery using real NoteIds while keeping raw onset error', () => {
    const data = inputs();
    const addon = {
      alignPerformancesCandidate(score, performed) {
        expect(score).toBe(data.scoreEvents);
        expect(performed).toBe(data.performedNotes);
        return {
          pairs: [
            { scoreEventId: 's1', performedNoteId: 'p1', pitchMatched: true, onsetErrorMs: 0 },
            { scoreEventId: 's2', performedNoteId: 'p2', pitchMatched: true, onsetErrorMs: 300 },
          ],
          missedScoreEventIds: [],
          extraPerformedIds: [],
        };
      },
    };
    const result = buildAlignmentShadow({ ...data, addon });
    expect(result.status).toBe('compared');
    expect(result.authority).toBe('diagnostic-only');
    expect(result.summary).toMatchObject({
      baselinePairs: 1, candidatePairs: 2, recoveredTargetCount: 1,
      lostTargetCount: 0, baselineMissed: 1, candidateMissed: 0,
      baselineExtra: 1, candidateExtra: 0,
    });
    expect(result.differences).toEqual([
      {
        scoreEventId: 's2',
        baseline: null,
        candidate: { performedNoteId: 'p2', pitchMatched: true, onsetErrorMs: 300 },
      },
    ]);
    // Official report is not mutated or scored again.
    expect(data.official.alignmentPairs).toHaveLength(1);
    expect(data.performedNotes[1].onsetMs).toBe(800);
  });

  it('captures candidate failures without changing official scoring', () => {
    const data = inputs();
    const result = buildAlignmentShadow({
      ...data,
      addon: { alignPerformancesCandidate() { throw new Error('candidate failed'); } },
    });
    expect(result).toMatchObject({ status: 'error', reason: 'candidate failed' });
    expect(data.official.missedScoreEventIds).toEqual(['s2']);
  });

  it('skips absent authoritative alignment and over-limit inputs', () => {
    const data = inputs();
    expect(buildAlignmentShadow({ ...data, official: {}, addon: {} }).status).toBe('skipped');
    expect(buildAlignmentShadow({
      ...data, performedNotes: Array.from({ length: 10_001 }, () => data.performedNotes[0]), addon: {},
    })).toMatchObject({ status: 'skipped', reason: 'note-count-limit' });
  });

  it('bounds large disagreements and keeps exact overall count', () => {
    const count = 150;
    const data = {
      scoreEvents: Array.from({ length: count }, (_, i) => ({ scoreEventId: `s${i}` })),
      performedNotes: Array.from({ length: count }, (_, i) => ({ performedNoteId: `p${i}` })),
      official: { alignmentPairs: [], missedScoreEventIds: [], extraPerformedIds: [] },
      addon: { alignPerformancesCandidate: () => ({
        pairs: Array.from({ length: count }, (_, i) => ({
          scoreEventId: `s${i}`, performedNoteId: `p${i}`, pitchMatched: true, onsetErrorMs: 0,
        })),
        missedScoreEventIds: [], extraPerformedIds: [],
      }) },
    };
    const result = buildAlignmentShadow(data);
    expect(result.summary).toMatchObject({
      changedTargetCount: 150, storedDiffDetails: 128, truncatedDiffDetails: true,
    });
  });
});

describe('alignment shadow sidecar persistence', () => {
  it('writes exactly one immutable file and never overwrites on retry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-shadow-'));
    dirs.push(dir);
    const shadowDir = path.join(dir, 'shadow');
    const first = persistAlignmentShadowOnce({
      dir: shadowDir, takeId: 'take-1', shadow: { status: 'compared', summary: { changedTargetCount: 1 } },
    });
    expect(first.created).toBe(true);
    const bytes = fs.readFileSync(first.file, 'utf8');
    const again = persistAlignmentShadowOnce({
      dir: shadowDir, takeId: 'take-1', shadow: { status: 'error', reason: 'should never replace' },
    });
    expect(again.created).toBe(false);
    expect(fs.readFileSync(first.file, 'utf8')).toBe(bytes);
    expect(JSON.parse(bytes)).toMatchObject({ takeId: 'take-1', status: 'compared' });
    expect(fs.readdirSync(shadowDir)).toEqual(['take-1.json']);
  });

  it('rejects unsafe identifiers and does not leave a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-shadow-'));
    dirs.push(dir);
    expect(() => persistAlignmentShadowOnce({
      dir, takeId: '../unsafe', shadow: { status: 'compared' },
    })).toThrow(/invalid takeId/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
