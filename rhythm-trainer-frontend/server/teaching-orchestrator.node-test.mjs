import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeachingOrchestrator, TeachingOrchestratorError } from './teaching-orchestrator.mjs';

let tempDir;
let nowTick;
let takes;
let idSeq;
let orchestrator;

function makeTake({ takeId = 'take-1', fingerprint = 'score-fp-1', missingMeasure = null, trustworthy = true, scoreStatus = 'AVAILABLE' } = {}) {
  return {
    schemaVersion: 1,
    takeId,
    score: { scoreId: 'score-1', scoreFingerprint: fingerprint, scoreSnapshotRef: null },
    lifecycle: { endReason: 'completed', modeId: 'score' },
    context: { practiceConfigSnapshot: { tempo: 72, hand: 'right' } },
    assessment: {
      trustworthy,
      inputQuality: trustworthy ? 'healthy' : 'degraded',
      scoreStatus,
      attemptStatus: 'completed',
      timelineReport: {
        scoreStatus,
        scoreV1: {
          confidence: 'high',
          dataDegraded: false,
          eventResults: missingMeasure == null ? [] : [{
            result: 'MISSING',
            measure: missingMeasure,
            scoreEventId: `occ-${missingMeasure}-1`,
            reason: 'expected note was not matched',
          }],
          measures: [
            { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 10 },
            { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 12 },
            { measure: 3, matched: 4, missed: 0, meanAbsOnsetErrorMs: 8 },
          ],
          practiceRanges: [],
          diagnostics: [],
          pitch: { missed: missingMeasure == null ? 0 : 1, wrongPitch: 0, extra: 0 },
        },
        durations: { assessments: [] },
      },
    },
  };
}

function action(run, commandId, actionName, extra = {}) {
  return orchestrator.applyAction(run.runId, {
    commandId,
    expectedRevision: run.revision,
    action: actionName,
    ...extra,
  });
}

function advanceToGuidedPractice(run) {
  run = action(run, 'begin-1', 'begin');
  run = action(run, 'complete-intro', 'complete-step');
  return run;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-teaching-'));
  nowTick = 0;
  idSeq = 0;
  takes = new Map();
  orchestrator = new TeachingOrchestrator({
    dir: tempDir,
    readTake: (id) => takes.get(id) ?? null,
    now: () => new Date(Date.UTC(2026, 9, 26, 0, 0, nowTick++)).toISOString(),
    id: () => `lesson-test-${++idSeq}`,
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('creates a lesson run with UI-ready steps and a Node-authored practice request', () => {
  const run = orchestrator.createRun({
    scoreFingerprint: 'score-fp-1', scoreBarCount: 8, bpm: 72, hand: 'right', referenceAvailable: false,
  });
  assert.equal(run.status, 'ready');
  assert.equal(run.currentStep.kind, 'study_score');
  assert.deepEqual(run.availableActions.map(item => item.action), ['begin', 'abandon']);

  let active = action(run, 'begin-1', 'begin');
  active = action(active, 'complete-intro', 'complete-step');
  assert.equal(active.currentStep.kind, 'guided_practice');
  assert.equal(active.currentStep.practiceRequest.modeId, 'score');
  assert.equal(active.currentStep.practiceRequest.advanceMode, 'timeline');
  assert.equal(active.currentStep.practiceRequest.loopStartBar, 1);
  assert.equal(active.currentStep.practiceRequest.loopEndBar, 4);
});

test('uses persisted Take evidence to create a focused-practice step without accepting a client report', () => {
  takes.set('take-missing', makeTake({ takeId: 'take-missing', missingMeasure: 2 }));
  let run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 8, bpm: 80, hand: 'both' });
  run = advanceToGuidedPractice(run);
  run = action(run, 'record-missing', 'record-take', { takeId: 'take-missing' });

  assert.equal(run.currentStep.kind, 'focused_practice');
  assert.deepEqual(run.currentStep.measureRange, { startMeasure: 2, endMeasure: 2 });
  assert.equal(run.currentStep.tempoBpm, 65);
  assert.equal(run.latestDecision.action, 'focus_range');
  assert.equal(run.latestDecision.sourceTakeId, 'take-missing');
  assert.equal(run.latestDecision.prescription.ruleId, 'MISSING_NOTES_V1');
  assert.equal(run.takeRefs.length, 1);
  // Stored lesson state contains only a Take reference, not a copied Take/report.
  const persisted = JSON.parse(fs.readFileSync(path.join(tempDir, `${run.runId}.json`), 'utf8'));
  assert.deepEqual(persisted.takeRefs.map(item => item.takeId), ['take-missing']);
  assert.equal(JSON.stringify(persisted).includes('scoreV1'), false);
});

test('refuses a Take whose score fingerprint differs from this lesson', () => {
  takes.set('take-wrong-score', makeTake({ takeId: 'take-wrong-score', fingerprint: 'another-score' }));
  let run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  run = advanceToGuidedPractice(run);
  assert.throws(
    () => action(run, 'wrong-score-command', 'record-take', { takeId: 'take-wrong-score' }),
    error => error instanceof TeachingOrchestratorError && error.code === 'SCORE_FINGERPRINT_MISMATCH',
  );
});

test('does not diagnose learner skill from an untrustworthy Take', () => {
  takes.set('take-degraded', makeTake({ takeId: 'take-degraded', missingMeasure: 2, trustworthy: false }));
  let run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  run = advanceToGuidedPractice(run);
  run = action(run, 'degraded-attempt', 'record-take', { takeId: 'take-degraded' });
  assert.equal(run.status, 'awaiting_evidence');
  assert.equal(run.currentStep.kind, 'guided_practice');
  assert.equal(run.latestDecision.action, 'check_input');
  assert.equal(run.latestDecision.prescription, undefined);
  assert.equal(run.availableActions.some(item => item.action === 'retry-current-step'), true);
});

test('idempotent command replay does not attach the same Take twice', () => {
  takes.set('take-clean', makeTake({ takeId: 'take-clean' }));
  let run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  run = advanceToGuidedPractice(run);
  const request = {
    commandId: 'once-only', expectedRevision: run.revision, action: 'record-take', takeId: 'take-clean',
  };
  run = orchestrator.applyAction(run.runId, request);
  const replay = orchestrator.applyAction(run.runId, request);
  assert.equal(replay.duplicateCommand, true);
  assert.equal(replay.takeRefs.length, 1);
  assert.equal(replay.decisions.length, 1);
});


test('failed independent transfer remains pending and can be retried after focused practice', () => {
  takes.set('take-guide-clean', makeTake({ takeId: 'take-guide-clean' }));
  takes.set('take-independent-miss', makeTake({ takeId: 'take-independent-miss', missingMeasure: 2 }));
  takes.set('take-focus-clean', makeTake({ takeId: 'take-focus-clean' }));
  let run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  run = advanceToGuidedPractice(run);
  run = action(run, 'guide-clean', 'record-take', { takeId: 'take-guide-clean' });
  assert.equal(run.currentStep.kind, 'independent_performance');
  run = action(run, 'independent-miss', 'record-take', { takeId: 'take-independent-miss' });
  assert.equal(run.currentStep.kind, 'focused_practice');
  run = action(run, 'focus-clean', 'record-take', { takeId: 'take-focus-clean' });
  assert.equal(run.status, 'in_progress');
  assert.equal(run.currentStep.kind, 'independent_performance');
  assert.equal(run.currentStep.status, 'active');
});

test('optimistic revision rejects concurrent stale actions', () => {
  const run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  action(run, 'begin-once', 'begin');
  assert.throws(
    () => orchestrator.applyAction(run.runId, {
      commandId: 'stale', expectedRevision: run.revision, action: 'begin',
    }),
    error => error instanceof TeachingOrchestratorError && error.code === 'STALE_TEACHING_REVISION',
  );
});

test('reloads lesson progress from disk with the same run ID and revision', () => {
  const run = orchestrator.createRun({ scoreFingerprint: 'score-fp-1', scoreBarCount: 4 });
  const fresh = new TeachingOrchestrator({ dir: tempDir, readTake: id => takes.get(id) ?? null });
  const reloaded = fresh.getRun(run.runId);
  assert.equal(reloaded.runId, run.runId);
  assert.equal(reloaded.revision, run.revision);
  assert.equal(reloaded.currentStepId, run.currentStepId);
});
