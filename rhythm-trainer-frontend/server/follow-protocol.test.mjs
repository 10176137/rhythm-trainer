// Closed-loop Follow acceptance against the REAL engine server:
//   follow-start -> follow-note* -> follow-report -> one Take on disk
// plus duplicate finalization, API readback, hardware (mock MIDI) routing,
// legacy history compatibility and interrupted finalization.
//
// The default planner authority here is rts, so this exercises the production
// default launch path: the browser projects the plan and the server still owns
// the Rust FollowRuntime and the Take finalizer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const require = createRequire(import.meta.url);
const addon = require(path.join(REPO, 'rhythm-trainer-core-v0.2', 'bindings', 'node'));
const PORT = 8841 + Math.floor(Math.random() * 30);
const DATA_DIR = path.join(ROOT, 'node_modules', '.cache', `follow-protocol-${PORT}`);
const TAKES_DIR = path.join(DATA_DIR, 'takes');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

const GROUPS = [
  { groupId: 'g1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] },
  {
    groupId: 'g2',
    bar: 1,
    playbackBeat: 1,
    // Both hands can notate the same key at one onset (unison). Follow asks
    // for C4 once; the group still counts as one target.
    pitches: [
      { midiNote: 60, spelling: 'C4' },
      { midiNote: 60, spelling: 'C4' },
      { midiNote: 64, spelling: 'E4' },
    ],
  },
  { groupId: 'g3', bar: 2, playbackBeat: 2, pitches: [{ midiNote: 67, spelling: 'G4' }] },
];

let server;
let client;

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

class WsClient {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiters = [];
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'error') {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`server error: ${message.message}`));
          return;
        }
      }
      const index = this.waiters.findIndex((waiter) => waiter.match(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.queue.push(message);
    });
  }

  send(message) {
    this.ws.send(JSON.stringify({ protocolVersion: 1, ...message }));
  }

  waitFor(type, predicate = () => true, timeoutMs = 8000) {
    const match = (message) => message.type === type && predicate(message);
    const index = this.queue.findIndex(match);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`no ${type} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer });
    });
  }
}

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new WsClient(ws);
}

async function syncClock(target) {
  for (let index = 0; index < 5; index += 1) {
    const id = `clock-${index}`;
    target.send({ type: 'clock-ping', id, clientSendPerfMs: performance.now() });
    const pong = await target.waitFor('clock-pong', (message) => message.id === id);
    target.send({
      type: 'clock-sample',
      id: pong.id,
      clientReceivePerfMs: performance.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return target.waitFor('clock-status');
}

function takeFiles() {
  if (!existsSync(TAKES_DIR)) return [];
  return readdirSync(TAKES_DIR).filter((name) => name.endsWith('.json'));
}

async function apiJson(urlPath) {
  const response = await fetch(`http://127.0.0.1:${PORT}${urlPath}`);
  const body = response.status === 404 ? null : await response.json();
  return { status: response.status, body };
}

async function startFollow(groups = GROUPS, options = {}) {
  const started = await new Promise(async (resolve, reject) => {
    try {
      client.send({
        type: 'follow-start',
        groups,
        bpm: 60,
        plannerAuthority: 'rts',
        plannerVersion: 'rts-test',
        scoreFingerprint: 'score-follow-test',
        scoreId: null,
        configSnapshot: { modeId: 'score', tempo: 60, profile: 'standard' },
        startedAtIso: new Date().toISOString(),
        basePerfMs: performance.now(),
        modeId: 'score',
        timingToleranceMs: 60,
        chordSpreadToleranceMs: 50,
        ...options,
      });
      resolve(await client.waitFor('follow-started'));
    } catch (error) {
      reject(error);
    }
  });
  return started;
}

async function note(noteNumber, atMs) {
  client.send({ type: 'follow-note', note: noteNumber, atMs });
  return client.waitFor('follow-event', (message) => message.note === noteNumber && message.atMs === atMs);
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      RHYTHM_PLANNER: 'rts',
      RHYTHM_MIDI_BACKEND: 'mock',
      RHYTHM_DATA_DIR: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(server);
  client = await connect();
}, 40000);

afterAll(async () => {
  try { client?.ws.close(); } catch { /* ignore */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('Follow Take closed loop (default rts launch)', () => {
  it('advances only on the server runtime and commits exactly one Follow Take', async () => {
    const started = await startFollow();
    expect(started.targetSource).toBe('client-plan-projection');
    expect(started.plannerAuthority).toBe('rts');
    expect(started.planFingerprint).toBeNull();
    expect(started.total).toBe(3);

    const wrong = await note(62, 100);
    expect(wrong.result).toMatchObject({ kind: 'wrong', advanced: false });
    expect(wrong.result.remainingPitches).toEqual(['C4']);

    const first = await note(60, 200);
    expect(first.result).toMatchObject({ kind: 'correct', advanced: true });
    expect(first.progress).toMatchObject({ index: 1, total: 3, completed: 1 });

    const partial = await note(60, 300);
    expect(partial.result).toMatchObject({ kind: 'partial', advanced: false });
    expect(partial.result.remainingPitches).toEqual(['E4']);

    const duplicate = await note(60, 400);
    expect(duplicate.result).toMatchObject({ kind: 'duplicate', advanced: false });

    const chord = await note(64, 1300);
    expect(chord.result).toMatchObject({ kind: 'correct', advanced: true });
    expect(chord.result.completedTarget).toMatchObject({ standard: false });

    const finalEvent = await note(67, 2400);
    expect(finalEvent.result).toMatchObject({ kind: 'complete', advanced: true });
    const report = await client.waitFor('follow-report');
    expect(report.report).toMatchObject({
      strictTiming: false,
      totalTargets: 3,
      completedTargets: 3,
      standardTargets: 0,
      wrongNoteCount: 1,
      duplicateNoteCount: 1,
      extraNoteCount: 0,
    });
    expect(report.report.timing.samples).toBe(2);
    expect(report.report.targets[1].expectedPitches).toEqual(['C4', 'E4']);
    expect(report.endReason).toBe('completed');
    expect(report.persisted).toBe(true);
    const takeId = report.takeId;

    // A duplicate completion must return the SAME Take and create no second file.
    client.send({ type: 'follow-finish' });
    const duplicateReport = await client.waitFor('follow-report');
    expect(duplicateReport.takeId).toBe(takeId);
    expect(takeFiles()).toHaveLength(1);

    const record = JSON.parse(readFileSync(path.join(TAKES_DIR, `${takeId}.json`), 'utf8'));
    expect(record).toMatchObject({
      takeId,
      lifecycle: { endReason: 'completed', modeId: 'score', startedAtIso: expect.any(String) },
      context: {
        plannerAuthority: 'rts',
        plannerVersion: 'rts-test',
        planFingerprint: null,
        planRunId: null,
        practiceConfigSnapshot: { modeId: 'score', tempo: 60, profile: 'standard' },
      },
      assessment: {
        trustworthy: true,
        scoreStatus: 'FOLLOW_ONLY',
        scope: 'follow',
        strictTiming: false,
      },
      engineDiagnostics: { practiceSessionId: null },
    });
    expect(record.assessment.timelineReport).toBeUndefined();
    expect(record.assessment.followReport.targets).toHaveLength(3);
    expect(record.evidence.captureDiagnostics).toMatchObject({
      mode: 'follow',
      targetSource: 'client-plan-projection',
    });
    expect(record.score.scoreFingerprint).toBe('score-follow-test');
    expect(record.evidence.followGroups).toHaveLength(3);
    expect(record.evidence.followGroups[1].pitches).toEqual([
      { midiNote: 60, spelling: 'C4' },
      { midiNote: 64, spelling: 'E4' },
    ]);
    expect(record.evidence.followBpm).toBe(60);
    expect(record.evidence.followInputs).toHaveLength(6);
    expect(record.evidence.followInputsTruncated).toBe(false);

    // Replay the recorded normalized schedule + input stream deterministically.
    const replay = new addon.NativeFollowRuntime(
      record.evidence.followGroups,
      record.evidence.followBpm,
      record.evidence.followTimingToleranceMs,
      record.evidence.followChordSpreadToleranceMs,
    );
    for (const input of record.evidence.followInputs) {
      replay.pushNote(input.midiNote, input.atMs);
    }
    const replayReport = replay.finish();
    const storedReport = record.assessment.followReport;
    expect({
      totalTargets: replayReport.totalTargets,
      completedTargets: replayReport.completedTargets,
      standardTargets: replayReport.standardTargets,
      wrongNoteCount: replayReport.wrongNoteCount,
      extraNoteCount: replayReport.extraNoteCount,
      duplicateNoteCount: replayReport.duplicateNoteCount,
      timingSamples: replayReport.timing.samples,
      targets: replayReport.targets.map((target) => [
        target.targetId,
        target.standard,
        target.intervalErrorMs ?? null,
        target.chordSpreadMs ?? null,
      ]),
    }).toEqual({
      totalTargets: storedReport.totalTargets,
      completedTargets: storedReport.completedTargets,
      standardTargets: storedReport.standardTargets,
      wrongNoteCount: storedReport.wrongNoteCount,
      extraNoteCount: storedReport.extraNoteCount,
      duplicateNoteCount: storedReport.duplicateNoteCount,
      timingSamples: storedReport.timing.samples,
      targets: storedReport.targets.map((target) => [
        target.targetId,
        target.standard,
        target.intervalErrorMs,
        target.chordSpreadMs,
      ]),
    });

    const list = await apiJson('/api/takes');
    expect(list.status).toBe(200);
    const summary = list.body.items.find((item) => item.takeId === takeId);
    expect(summary).toMatchObject({
      takeId,
      reportKind: 'follow',
      scoreStatus: 'FOLLOW_ONLY',
      endReason: 'completed',
      trustworthy: true,
      bpm: 60,
      targetCount: 3,
      followCompletedTargets: 3,
      followStandardTargets: 0,
      followWrongNoteCount: 1,
      followDuplicateNoteCount: 1,
      followTimingSamples: 2,
    });
    expect(summary.perfectCount).toBe(0);
    expect(summary.goodCount).toBe(0);

    const detail = await apiJson(`/api/takes/${takeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.assessment.followReport.completedTargets).toBe(3);
    expect(detail.body.assessment.timelineReport).toBeUndefined();

    // Follow must NOT be flattened into a fake Timeline session.
    const legacyShape = await apiJson(`/api/sessions/${takeId}`);
    expect(legacyShape.status).toBe(404);
  }, 30000);

  it('pauses without accepting notes and resumes with interval invalidation', async () => {
    const started = await startFollow([
      { groupId: 'p1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] },
      { groupId: 'p2', bar: 1, playbackBeat: 1, pitches: [{ midiNote: 62, spelling: 'D4' }] },
    ]);
    await note(60, 100);

    client.send({ type: 'follow-pause', atMs: 200 });
    await client.waitFor('follow-paused');
    const pausedNote = client.waitFor('error');
    client.send({ type: 'follow-note', note: 62, atMs: 250 });
    await expect(pausedNote).rejects.toThrow(/暂停/);

    client.send({ type: 'follow-resume', atMs: 300 });
    await client.waitFor('follow-resumed');
    const second = await note(62, 400);
    expect(second.result).toMatchObject({ kind: 'complete', advanced: true });
    expect(second.result.completedTarget).toMatchObject({ intervalJudged: false });

    const report = await client.waitFor('follow-report');
    expect(report.report.timing.samples).toBe(0);
    const record = JSON.parse(readFileSync(
      path.join(TAKES_DIR, `${report.takeId}.json`), 'utf8'));
    expect(record.evidence.pauseIntervals).toEqual([{ startMs: 200, endMs: 300 }]);
    expect(record.evidence.followInputs).toHaveLength(2);
    expect(record.evidence.followInputsTruncated).toBe(false);
    expect(record.takeId).toBe(started.takeId);
  }, 20000);

  it('routes hardware Note On through the server runtime (mock MIDI)', async () => {
    client.send({ type: 'midi-connect', deviceId: 'mock:0' });
    await client.waitFor('midi-status', (message) => message.connected === true);
    await syncClock(client);

    const started = await startFollow(
      [{ groupId: 'hw1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 72, spelling: 'C5' }] }],
    );
    expect(started.total).toBe(1);

    client.send({ type: 'midi-test-note', bytes: [0x90, 72, 96] });
    const event = await client.waitFor('follow-event', (message) => message.note === 72);
    expect(event.result).toMatchObject({ kind: 'complete', advanced: true });
    const report = await client.waitFor('follow-report');
    expect(report.endReason).toBe('completed');
    expect(report.report.completedTargets).toBe(1);
    expect(takeFiles()).toHaveLength(3);
  }, 30000);

  it('keeps legacy sessions readable and exposes them as legacy Takes', async () => {
    const legacy = {
      schemaVersion: 1,
      sessionId: 's-legacy-follow-test',
      finishedAtIso: '2020-01-01T00:00:00.000Z',
      modeId: 'score',
      bpm: 80,
      profile: 'standard',
      interrupted: false,
      report: {
        trustworthy: true,
        targetCount: 1,
        stats: {
          perfectCount: 1,
          goodCount: 0,
          missCount: 0,
          extraCount: 0,
          targetHitRate: 1,
          meanSignedMs: 0,
          meanAbsoluteMs: 0,
        },
      },
      scoreFingerprint: 'score-legacy',
    };
    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeFileSync(path.join(SESSIONS_DIR, 's-legacy-follow-test.json'), JSON.stringify(legacy), 'utf8');

    const sessions = await apiJson('/api/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.items.some((item) => item.sessionId === 's-legacy-follow-test')).toBe(true);

    const takes = await apiJson('/api/takes');
    const legacySummary = takes.body.items.find((item) => item.takeId === 'legacy-s-legacy-follow-test');
    expect(legacySummary).toMatchObject({
      reportKind: 'timeline',
      legacySessionId: 's-legacy-follow-test',
      scoreFingerprint: 'score-legacy',
    });

    const legacyTake = await apiJson('/api/takes/legacy-s-legacy-follow-test');
    expect(legacyTake.status).toBe(200);
    expect(legacyTake.body.takeId).toBe('legacy-s-legacy-follow-test');
    expect(legacyTake.body.legacy).toMatchObject({ source: 'sessions-json', sessionId: 's-legacy-follow-test' });
    expect(legacyTake.body.assessment.timelineReport.sessionId).toBe('s-legacy-follow-test');
  }, 20000);

  it('commits an interrupted Follow Take when the connection drops (never a completed fake)', async () => {
    const started = await startFollow([
      { groupId: 'drop1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] },
      { groupId: 'drop2', bar: 1, playbackBeat: 1, pitches: [{ midiNote: 62, spelling: 'D4' }] },
    ]);
    await note(60, 50).catch(() => null);
    client.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const list = await apiJson('/api/takes');
    const dropped = list.body.items.find((item) => item.takeId === started.takeId);
    expect(dropped).toMatchObject({
      reportKind: 'follow',
      endReason: 'interrupted',
      trustworthy: false,
      scoreStatus: 'FOLLOW_ONLY',
    });
    const record = JSON.parse(readFileSync(path.join(TAKES_DIR, `${started.takeId}.json`), 'utf8'));
    expect(record.lifecycle.endReason).toBe('interrupted');
    expect(record.assessment.trustworthy).toBe(false);
    expect(record.assessment.followReport.completedTargets).toBe(1);
  }, 20000);
});
