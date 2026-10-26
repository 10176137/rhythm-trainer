// Teaching Orchestrator V1 REST integration against the real engine server.
// The orchestrator itself is exercised by its standalone node:test file; this
// test proves the HTTP wiring, persisted LessonRun lifecycle, optimistic
// concurrency and the "only persisted Take ids are accepted" boundary.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8871 + Math.floor(Math.random() * 30);
const DATA_DIR = path.join(ROOT, 'node_modules', '.cache', `teaching-api-${PORT}`);
const BASE = `http://127.0.0.1:${PORT}`;
const FINGERPRINT = 'fp-teaching-api-v1';

let server;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('引擎服务')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (/Error|error:|失败/.test(text)) reject(new Error(text));
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

async function api(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function writeTake(takeId, fingerprint, options = {}) {
  const take = {
    schemaVersion: 1,
    takeId,
    score: { scoreId: null, scoreFingerprint: fingerprint, scoreSnapshotRef: null },
    lifecycle: {
      startedAtIso: '2026-10-26T00:00:00.000Z',
      finishedAtIso: '2026-10-26T00:01:00.000Z',
      endReason: 'completed',
      modeId: 'score',
    },
    context: {
      practiceConfigSnapshot: { modeId: 'score', tempo: 72, hand: 'right' },
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: `plan-v1:sha256:${'a'.repeat(64)}`,
      planSnapshotRef: null,
      planRunId: 'plan-teaching-api',
    },
    evidence: {
      traceRef: null,
      journalRef: null,
      pauseIntervals: [],
      captureDiagnostics: {
        inputHealth: 'healthy',
        clockMapping: { status: 'ok' },
      },
    },
    assessment: {
      trustworthy: true,
      scoreStatus: 'AVAILABLE',
      timelineReport: {
        sessionId: 'legacy-teaching-api',
        scoreStatus: 'AVAILABLE',
        scoreV1: options.followOnly ? null : {
          confidence: 'medium',
          dataDegraded: false,
          eventResults: [{
            result: 'MISSING',
            measure: 2,
            expectedPitch: 60,
            scoreEventId: 'm2-e1',
            reason: 'no_performed_note',
          }],
          measures: [{
            measure: 2,
            matched: 0,
            missed: 1,
            meanAbsOnsetErrorMs: null,
          }],
          practiceRanges: [],
          diagnostics: [],
        },
        durations: { assessments: [] },
      },
    },
    engineDiagnostics: { practiceSessionId: null, engineTakeId: takeId, takeIndex: 1, takeSnapshot: null },
  };
  if (options.followOnly) {
    take.assessment.scoreStatus = 'FOLLOW_ONLY';
    take.assessment.timelineReport = undefined;
    take.assessment.followReport = {
      strictTiming: false,
      totalTargets: 4,
      completedTargets: 2,
      standardTargets: 1,
      pendingTargetId: 'g2',
      wrongNoteCount: 0,
      extraNoteCount: 0,
      duplicateNoteCount: 0,
      timing: { samples: 1, meanSignedMs: 30, meanAbsoluteMs: 30, standardDeviationMs: 0 },
      targets: [],
    };
  }
  mkdirSync(path.join(DATA_DIR, 'takes'), { recursive: true });
  writeFileSync(path.join(DATA_DIR, 'takes', `${takeId}.json`), JSON.stringify(take), 'utf8');
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      RHYTHM_DATA_DIR: DATA_DIR,
      RHYTHM_MIDI_BACKEND: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(server);
}, 40000);

afterAll(() => {
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('Teaching Orchestrator REST integration', () => {
  it('creates a run, advances steps, records a persisted Take, and returns a prescription', async () => {
    const created = await api('POST', '/api/teaching/runs', {
      scoreFingerprint: FINGERPRINT,
      scoreBarCount: 8,
      bpm: 72,
      hand: 'right',
      startMeasure: 1,
      endMeasure: 8,
      goal: 'learn-score',
      referenceAvailable: false,
      profile: 'standard',
      durationPolicy: 'disabled',
      feedback: 'live',
    });
    expect(created.status).toBe(201);
    expect(created.json.ok).toBe(true);
    const run = created.json.run;
    expect(run).toMatchObject({
      schemaVersion: 1,
      status: 'ready',
      revision: 0,
      scoreFingerprint: FINGERPRINT,
      currentStepId: 'understand-score',
    });
    expect(run.steps.map((step) => step.kind)).toEqual([
      'study_score',
      'guided_practice',
      'independent_performance',
    ]);
    expect(run.availableActions.map((action) => action.action)).toEqual(['begin', 'abandon']);

    const read = await api('GET', `/api/teaching/runs/${run.runId}`);
    expect(read.status).toBe(200);
    expect(read.json.run.runId).toBe(run.runId);

    const begin = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-begin',
      expectedRevision: 0,
      action: 'begin',
    });
    expect(begin.status).toBe(200);
    expect(begin.json.run).toMatchObject({
      status: 'in_progress',
      revision: 1,
      currentStepId: 'understand-score',
    });

    const studyDone = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-study-done',
      expectedRevision: 1,
      action: 'complete-step',
    });
    expect(studyDone.status).toBe(200);
    expect(studyDone.json.run.currentStepId).toBe('guided-practice');
    expect(studyDone.json.run.currentStep.practiceRequest).toMatchObject({
      scoreFingerprint: FINGERPRINT,
      modeId: 'score',
      advanceMode: 'timeline',
      tempo: 72,
      hand: 'right',
      loopStartBar: 1,
      loopEndBar: 4,
      loopEnabled: true,
    });

    writeTake('take-teaching-api', FINGERPRINT);
    const recorded = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-record-take',
      expectedRevision: 2,
      action: 'record-take',
      takeId: 'take-teaching-api',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json.run.revision).toBe(3);
    expect(recorded.json.run.takeRefs).toEqual([{
      takeId: 'take-teaching-api',
      stepRunId: 'guided-practice',
      addedAtIso: expect.any(String),
    }]);
    expect(recorded.json.run.latestDecision).toMatchObject({
      action: 'focus_range',
      reasonCode: 'REMEDIATION_REQUIRED',
      sourceTakeId: 'take-teaching-api',
      policyVersion: 'teaching-policy-v1',
    });
    expect(recorded.json.run.latestDecision.prescription).toMatchObject({
      ruleId: 'MISSING_NOTES_V1',
      problemType: 'missing-notes',
      measureRange: { startMeasure: 2, endMeasure: 2 },
      recommendedBpm: 60,
      recommendedHand: 'right',
      recommendedMode: 'loop',
      status: 'EXECUTABLE',
    });
    expect(recorded.json.run.currentStep).toMatchObject({
      kind: 'focused_practice',
      tempoBpm: 60,
      measureRange: { startMeasure: 2, endMeasure: 2 },
    });

    // A replay with the same commandId is idempotent even with a stale revision.
    const replay = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-record-take',
      expectedRevision: 0,
      action: 'record-take',
      takeId: 'take-teaching-api',
    });
    expect(replay.status).toBe(200);
    expect(replay.json.run.duplicateCommand).toBe(true);
    expect(replay.json.run.revision).toBe(3);

    const stale = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-stale',
      expectedRevision: 2,
      action: 'retry-current-step',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE_TEACHING_REVISION');

    writeTake('take-wrong-score', 'fp-other-score');
    const mismatch = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-wrong-take',
      expectedRevision: 3,
      action: 'record-take',
      takeId: 'take-wrong-score',
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error.code).toBe('SCORE_FINGERPRINT_MISMATCH');

    writeTake('take-pending-retry', FINGERPRINT);
    const pendingPath = path.join(DATA_DIR, 'takes', 'take-pending-retry.json');
    const pendingTake = JSON.parse(readFileSync(pendingPath, 'utf8'));
    pendingTake.assessment.persistenceStatus = 'pending-retry';
    writeFileSync(pendingPath, JSON.stringify(pendingTake), 'utf8');
    const notPersisted = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-pending-take',
      expectedRevision: 3,
      action: 'record-take',
      takeId: 'take-pending-retry',
    });
    expect(notPersisted.status).toBe(409);
    expect(notPersisted.json.error.code).toBe('TAKE_NOT_PERSISTED');

    const abandoned = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-abandon',
      expectedRevision: 3,
      action: 'abandon',
    });
    expect(abandoned.status).toBe(200);
    expect(abandoned.json.run.status).toBe('abandoned');

    const terminal = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd-after-end',
      expectedRevision: 4,
      action: 'retry-current-step',
    });
    expect(terminal.status).toBe(409);
    expect(terminal.json.error.code).toBe('TEACHING_RUN_TERMINAL');
  }, 30000);

  it('routes a Follow-only Take to the evidence-insufficient path instead of inventing a score', async () => {
    const created = await api('POST', '/api/teaching/runs', {
      scoreFingerprint: FINGERPRINT,
      scoreBarCount: 4,
      bpm: 72,
      hand: 'both',
      startMeasure: 1,
      endMeasure: 4,
      referenceAvailable: false,
    });
    expect(created.status).toBe(201);
    const run = created.json.run;
    await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd2-begin',
      expectedRevision: 0,
      action: 'begin',
    });
    await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd2-study',
      expectedRevision: 1,
      action: 'complete-step',
    });

    writeTake('take-follow-only', FINGERPRINT, { followOnly: true });
    const recorded = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'cmd2-follow',
      expectedRevision: 2,
      action: 'record-take',
      takeId: 'take-follow-only',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json.run.status).toBe('awaiting_evidence');
    expect(recorded.json.run.latestDecision).toMatchObject({
      action: 'collect_more_evidence',
      reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE',
      evidenceRefs: [],
    });
    expect(recorded.json.run.latestDecision.prescription).toBeUndefined();
  }, 20000);

  it('starts a lesson from a persisted Take (from-take) with server-side diagnosis', async () => {
    writeTake('take-from-take', FINGERPRINT);
    const created = await api('POST', '/api/teaching/runs/from-take', {
      takeId: 'take-from-take',
      scoreFingerprint: FINGERPRINT,
      scoreBarCount: 8,
      bpm: 72,
      hand: 'right',
    });
    expect(created.status).toBe(201);
    const run = created.json.run;
    expect(run).toMatchObject({
      status: 'ready',
      revision: 0,
      scoreFingerprint: FINGERPRINT,
      sourceTakeId: 'take-from-take',
      currentStepId: 'understand-score',
    });
    expect(run.latestDecision).toBeNull();

    // Begin, complete the study step, then record the SAME take as the first
    // guided attempt: the server runs findRemediation itself.
    await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'ft-begin', expectedRevision: 0, action: 'begin',
    });
    await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'ft-study', expectedRevision: 1, action: 'complete-step',
    });
    const recorded = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'ft-record', expectedRevision: 2, action: 'record-take', takeId: 'take-from-take',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json.run.latestDecision).toMatchObject({
      action: 'focus_range',
      reasonCode: 'REMEDIATION_REQUIRED',
      sourceTakeId: 'take-from-take',
    });
    expect(recorded.json.run.latestDecision.prescription).toMatchObject({
      ruleId: 'MISSING_NOTES_V1',
      measureRange: { startMeasure: 2, endMeasure: 2 },
    });
    // GET must expose the same latestDecision as applyAction.
    const read = await api('GET', `/api/teaching/runs/${run.runId}`);
    expect(read.json.run.latestDecision).toEqual(recorded.json.run.latestDecision);
  }, 30000);

  it('rejects from-take for missing, unpersisted, or mismatched Takes', async () => {
    const missing = await api('POST', '/api/teaching/runs/from-take', {
      takeId: 'take-does-not-exist',
    });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('TAKE_NOT_FOUND');

    writeTake('take-ft-pending', FINGERPRINT);
    const pendingPath = path.join(DATA_DIR, 'takes', 'take-ft-pending.json');
    const pendingTake = JSON.parse(readFileSync(pendingPath, 'utf8'));
    pendingTake.assessment.persistenceStatus = 'pending-retry';
    writeFileSync(pendingPath, JSON.stringify(pendingTake), 'utf8');
    const pending = await api('POST', '/api/teaching/runs/from-take', {
      takeId: 'take-ft-pending',
    });
    expect(pending.status).toBe(409);
    expect(pending.json.error.code).toBe('TAKE_NOT_PERSISTED');

    writeTake('take-ft-other', 'fp-someone-else');
    const mismatch = await api('POST', '/api/teaching/runs/from-take', {
      takeId: 'take-ft-other',
      scoreFingerprint: FINGERPRINT,
    });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json.error.code).toBe('SCORE_FINGERPRINT_MISMATCH');
  }, 20000);

  it('serves the versioned lesson catalog for the workspace picker', async () => {
    const listed = await api('GET', '/api/teaching/lessons');
    expect(listed.status).toBe(200);
    expect(listed.json.ok).toBe(true);
    expect(listed.json.schemaVersion).toBe(1);
    expect(listed.json.lessons).toHaveLength(8);
    const ids = listed.json.lessons.map((lesson) => lesson.lessonId);
    expect(new Set(ids).size).toBe(8);
    for (const lesson of listed.json.lessons) {
      expect(lesson).toMatchObject({
        lessonId: expect.any(String),
        version: expect.any(Number),
        title: expect.any(String),
        difficulty: expect.any(String),
      });
      expect(lesson.explainScript.explanation.length).toBeGreaterThan(20);
      expect(Object.keys(lesson.coachingByPhase)).toEqual(
        ['hand-single-1', 'hand-single-2', 'hands-together', 'pass-check'],
      );
      expect(lesson.learningObjectives.length).toBeGreaterThan(0);
    }
    expect(ids).toContain('steady-beat-hands');
    expect(ids).toContain('transfer-review');

    const method = await api('POST', '/api/teaching/lessons');
    expect(method.status).toBe(405);
    expect(method.json.error.code).toBe('METHOD_NOT_ALLOWED');
  }, 20000);

  it('runs a lesson with the hands progression and lesson-authored feedback', async () => {
    const created = await api('POST', '/api/teaching/runs', {
      scoreFingerprint: FINGERPRINT,
      scoreBarCount: 8,
      bpm: 72,
      startMeasure: 1,
      endMeasure: 8,
      lessonId: 'steady-beat-hands',
      firstHand: 'left',
    });
    expect(created.status).toBe(201);
    const run = created.json.run;
    expect(run.templateVersion).toBe('hands-progression-v1');
    expect(run.lessonId).toBe('steady-beat-hands');
    expect(run.firstHand).toBe('left');
    expect(run.steps.map((step) => step.stepRunId)).toEqual([
      'understand-score', 'hand-1', 'hand-2', 'hands-together', 'pass-check',
    ]);
    expect(run.steps.slice(1).map((step) => [step.hands, step.tempoBpm])).toEqual([
      ['left', 55], ['right', 55], ['both', 60], ['both', 72],
    ]);
    expect(run.steps.at(-1).kind).toBe('independent_performance');
    expect(run.lesson).toMatchObject({
      lessonId: 'steady-beat-hands',
      title: expect.any(String),
      transferNote: expect.any(String),
    });

    // Unknown lesson or invalid first hand are coded 400s, not silent fallbacks.
    const unknownLesson = await api('POST', '/api/teaching/runs', {
      scoreFingerprint: FINGERPRINT, scoreBarCount: 8, lessonId: 'no-such-lesson',
    });
    expect(unknownLesson.status).toBe(400);
    expect(unknownLesson.json.error.code).toBe('INVALID_LESSON');
    const unknownHand = await api('POST', '/api/teaching/runs', {
      scoreFingerprint: FINGERPRINT, scoreBarCount: 8,
      lessonId: 'steady-beat-hands', firstHand: 'middle',
    });
    expect(unknownHand.status).toBe(400);
    expect(unknownHand.json.error.code).toBe('INVALID_HAND');

    await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'lp-begin', expectedRevision: 0, action: 'begin',
    });
    const studyDone = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'lp-study', expectedRevision: 1, action: 'complete-step',
    });
    expect(studyDone.json.run.currentStepId).toBe('hand-1');
    expect(studyDone.json.run.currentStep.practiceRequest).toMatchObject({
      tempo: 55,
      hand: 'left',
      loopStartBar: 1,
      loopEndBar: 8,
    });

    writeTake('take-lesson-hand-1', FINGERPRINT);
    const recorded = await api('POST', `/api/teaching/runs/${run.runId}/actions`, {
      commandId: 'lp-record', expectedRevision: 2, action: 'record-take', takeId: 'take-lesson-hand-1',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.json.run.latestDecision).toMatchObject({
      action: 'focus_range',
      reasonCode: 'REMEDIATION_REQUIRED',
      prescription: { ruleId: 'MISSING_NOTES_V1', measureRange: { startMeasure: 2, endMeasure: 2 } },
    });
    expect(recorded.json.run.latestDecision.learnerFeedback).toMatchObject({
      source: 'lesson',
      message: expect.any(String),
      nextAction: expect.any(String),
    });
  }, 30000);

  it('rejects malformed bodies and unsupported methods with coded errors', async () => {
    const bad = await fetch(`${BASE}/api/teaching/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('INVALID_JSON');

    const method = await api('GET', '/api/teaching/runs');
    expect(method.status).toBe(405);
    expect(method.json.error.code).toBe('METHOD_NOT_ALLOWED');

    const missing = await api('GET', '/api/teaching/runs/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe('TEACHING_RUN_NOT_FOUND');
  }, 20000);
});
