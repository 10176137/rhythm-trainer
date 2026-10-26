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

// ---------------------------------------------------------------------------
// Strategy table: fixed Take inputs -> one decision, stable across calls with
// the same policyVersion. Covers the TS->Node migration evidence matrix.

function strategyTake({ takeId, missing = [], wrong = [], extra = [], durations = [], measures = [], confidence = 'high', dataDegraded = false, trustworthy = true, inputQuality = 'healthy', endReason = 'completed', followOnly = false }) {
  return {
    schemaVersion: 1,
    takeId,
    score: { scoreId: 'score-1', scoreFingerprint: 'score-fp-1', scoreSnapshotRef: null },
    lifecycle: { endReason, modeId: 'score' },
    context: { practiceConfigSnapshot: { tempo: 80, hand: 'both' } },
    assessment: {
      trustworthy,
      inputQuality,
      attemptStatus: endReason === 'interrupted' ? 'interrupted' : 'completed',
      persistenceStatus: 'persisted',
      scoreStatus: followOnly ? 'FOLLOW_ONLY' : 'AVAILABLE',
      ...(followOnly ? {
        followReport: {
          strictTiming: false, totalTargets: 4, completedTargets: 2, standardTargets: 1,
          pendingTargetId: 'g2', wrongNoteCount: 0, extraNoteCount: 0, duplicateNoteCount: 0,
          timing: { samples: 1, meanSignedMs: 20, meanAbsoluteMs: 20, standardDeviationMs: 0 },
          targets: [],
        },
      } : {}),
      ...(!followOnly ? {
        timelineReport: {
          scoreStatus: 'AVAILABLE',
          scoreV1: {
            confidence,
            dataDegraded,
            eventResults: [
              ...missing.map(measure => ({ result: 'MISSING', measure, scoreEventId: `m${measure}-e1`, reason: 'no_performed_note' })),
              ...wrong.map(measure => ({ result: 'WRONG_PITCH', measure, scoreEventId: `m${measure}-e2`, reason: 'pitch_mismatch' })),
              ...extra.map(measure => ({ result: 'EXTRA', measure, scoreEventId: `m${measure}-x1`, reason: 'extra' })),
            ],
            measures: measures.length ? measures : [
              { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 10 },
              { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 12 },
            ],
            practiceRanges: [],
            diagnostics: [],
          },
          durations: { assessments: durations },
        },
      } : {}),
    },
  };
}

const STRATEGY_CASES = [
  {
    name: 'missing notes -> focus_range with MISSING_NOTES_V1',
    take: { takeId: 's-missing', missing: [2] },
    expect: { action: 'focus_range', reasonCode: 'REMEDIATION_REQUIRED', ruleId: 'MISSING_NOTES_V1', problemType: 'missing-notes', range: { startMeasure: 2, endMeasure: 2 } },
  },
  {
    name: 'wrong pitch -> focus_range with PITCH_ERRORS_V1',
    take: { takeId: 's-wrong', wrong: [3] },
    expect: { action: 'focus_range', reasonCode: 'REMEDIATION_REQUIRED', ruleId: 'PITCH_ERRORS_V1', problemType: 'pitch-errors' },
  },
  {
    name: 'extra notes -> focus_range with EXTRA_NOTES_V1',
    take: { takeId: 's-extra', extra: [1] },
    expect: { action: 'focus_range', reasonCode: 'REMEDIATION_REQUIRED', ruleId: 'EXTRA_NOTES_V1', problemType: 'extra-notes' },
  },
  {
    name: 'valid duration deviations -> focus_range with DURATION_V1',
    take: {
      takeId: 's-duration',
      measures: [{ measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 10 }],
      durations: [
        { bar: 1, quality: 'ok', result: 'too_short', durationErrorMs: -180, actualKeyDownMs: 300, nominalDurationMs: 480, targetId: 'd1' },
        { bar: 1, quality: 'ok', result: 'too_long', durationErrorMs: 200, actualKeyDownMs: 700, nominalDurationMs: 480, targetId: 'd2' },
        { bar: 1, quality: 'ok', result: 'within_tolerance', durationErrorMs: 5, actualKeyDownMs: 485, nominalDurationMs: 480, targetId: 'd3' },
      ],
    },
    expect: { action: 'focus_range', reasonCode: 'REMEDIATION_REQUIRED', ruleId: 'DURATION_V1', problemType: 'duration' },
  },
  {
    name: 'local onset outlier -> focus_range with LOCAL_ONSET_V1',
    take: {
      takeId: 's-onset',
      measures: [
        { measure: 1, matched: 4, missed: 0, meanAbsOnsetErrorMs: 12 },
        { measure: 2, matched: 4, missed: 0, meanAbsOnsetErrorMs: 90 },
      ],
    },
    expect: { action: 'focus_range', reasonCode: 'REMEDIATION_REQUIRED', ruleId: 'LOCAL_ONSET_V1', problemType: 'local-onset' },
  },
  {
    name: 'low confidence -> collect_more_evidence, never a prescription',
    take: { takeId: 's-lowconf', missing: [2], confidence: 'low' },
    expect: { action: 'collect_more_evidence', reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE', ruleId: null },
  },
  {
    name: 'degraded data -> collect_more_evidence',
    take: { takeId: 's-degraded', missing: [2], dataDegraded: true },
    expect: { action: 'collect_more_evidence', reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE', ruleId: null },
  },
  {
    name: 'untrusted input -> check_input',
    take: { takeId: 's-untrusted', missing: [2], trustworthy: false, inputQuality: 'degraded' },
    expect: { action: 'check_input', reasonCode: 'INPUT_OR_ATTEMPT_UNTRUSTED', ruleId: null },
  },
  {
    name: 'interrupted attempt -> check_input',
    take: { takeId: 's-interrupted', missing: [2], endReason: 'interrupted' },
    expect: { action: 'check_input', reasonCode: 'INPUT_OR_ATTEMPT_UNTRUSTED', ruleId: null },
  },
  {
    name: 'Follow-only Take -> collect_more_evidence (never scored as Timeline)',
    take: { takeId: 's-follow', followOnly: true },
    expect: { action: 'collect_more_evidence', reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE', ruleId: null },
  },
  {
    name: 'clean report -> advance',
    take: { takeId: 's-clean' },
    expect: { action: 'advance', reasonCode: 'NO_TARGETED_REMEDIATION', ruleId: null },
  },
];

for (const strategyCase of STRATEGY_CASES) {
  test(`strategy: ${strategyCase.name}`, () => {
    takes.set(strategyCase.take.takeId, strategyTake(strategyCase.take));
    const run = orchestrator.createRunFromTake({ takeId: strategyCase.take.takeId, scoreBarCount: 4, bpm: 80 });
    const begun = action(run, 'st-begin', 'begin');
    const studied = action(begun, 'st-study', 'complete-step');
    const recorded = action(studied, 'st-record', 'record-take', { takeId: strategyCase.take.takeId });
    const decision = recorded.latestDecision;
    assert.equal(decision.action, strategyCase.expect.action, decision.reason);
    assert.equal(decision.reasonCode, strategyCase.expect.reasonCode);
    if (strategyCase.expect.ruleId) {
      assert.equal(decision.prescription.ruleId, strategyCase.expect.ruleId);
      assert.equal(decision.prescription.problemType, strategyCase.expect.problemType);
      if (strategyCase.expect.range) {
        assert.deepEqual(decision.prescription.measureRange, strategyCase.expect.range);
      }
    } else {
      assert.equal(decision.prescription, undefined);
    }
    // Same input, same policyVersion, same decision (modulo random ids).
    const second = (() => {
      const other = new TeachingOrchestrator({
        dir: tempDir,
        readTake: id => takes.get(id) ?? null,
        now: () => new Date(Date.UTC(2026, 9, 26, 12, 0, 0)).toISOString(),
        id: () => 'lesson-replay-check',
      });
      const r = other.createRunFromTake({ takeId: strategyCase.take.takeId, scoreBarCount: 4, bpm: 80 });
      const b = action(r, 'st2-begin', 'begin');
      const s = action(b, 'st2-study', 'complete-step');
      return action(s, 'st2-record', 'record-take', { takeId: strategyCase.take.takeId }).latestDecision;
    })();
    assert.equal(second.action, decision.action);
    assert.equal(second.reasonCode, decision.reasonCode);
    assert.equal(second.prescription?.ruleId, decision.prescription?.ruleId);
    assert.equal(second.prescription?.recommendedBpm, decision.prescription?.recommendedBpm);
    assert.equal(second.prescription?.measureRange?.startMeasure ?? null,
      decision.prescription?.measureRange?.startMeasure ?? null);
  });
}

test('missing measure mapping in event results keeps diagnosis conservative', () => {
  takes.set('s-nomeasure', strategyTake({
    takeId: 's-nomeasure',
    missing: [999], // measure beyond the report/score bounds
  }));
  const run = orchestrator.createRunFromTake({ takeId: 's-nomeasure', scoreBarCount: 4 });
  const begun = action(run, 'nm-begin', 'begin');
  const studied = action(begun, 'nm-study', 'complete-step');
  const recorded = action(studied, 'nm-record', 'record-take', { takeId: 's-nomeasure' });
  // Out-of-range measures are not valid targets; no prescription is invented.
  assert.equal(['collect_more_evidence', 'advance'].includes(recorded.latestDecision.action), true);
});

test('from-take rejects unpersisted and foreign Takes', () => {
  takes.set('ft-pending', { ...strategyTake({ takeId: 'ft-pending', missing: [2] }), assessment: { ...strategyTake({ takeId: 'ft-pending' }).assessment, persistenceStatus: 'pending-retry' } });
  assert.throws(
    () => orchestrator.createRunFromTake({ takeId: 'ft-pending' }),
    error => error instanceof TeachingOrchestratorError && error.code === 'TAKE_NOT_PERSISTED',
  );
  assert.throws(
    () => orchestrator.createRunFromTake({ takeId: 'take-unknown' }),
    error => error instanceof TeachingOrchestratorError && error.code === 'TAKE_NOT_FOUND',
  );
  takes.set('ft-other', strategyTake({ takeId: 'ft-other', missing: [2] }));
  takes.set('ft-other', { ...takes.get('ft-other'), score: { scoreId: 'score-1', scoreFingerprint: 'fp-someone-else', scoreSnapshotRef: null } });
  assert.throws(
    () => orchestrator.createRunFromTake({ takeId: 'ft-other', scoreFingerprint: 'score-fp-1' }),
    error => error instanceof TeachingOrchestratorError && error.code === 'SCORE_FINGERPRINT_MISMATCH',
  );
});
