// R2-3h: the REAL protocol chain. This spawns the actual engine server
// (RHYTHM_PLANNER=rust) and drives it over its WebSocket: planner-status
// reveals the authority, plan-request runs the real planner-service →
// Rust NAPI → frozen fingerprint gate, and coded rejections come back as
// such. Not a stub transport: the server process, the NAPI addon and the
// fingerprint gate are all real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const PORT = 8791 + Math.floor(Math.random() * 40);
const DATA_DIR = path.join(ROOT, 'node_modules', '.cache', `r2-3h-test-${PORT}`);
const CORPUS = JSON.parse(readFileSync(
  path.join(REPO, 'audit-r1', 'fixtures', 'parity-cases', 'rust-parity-input', 'G1-base.json'), 'utf8'));
const { plannerVersion, ...CONFIG } = CORPUS.config;
void plannerVersion;

let server;
let socket;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('引擎服务') || text.includes('planner authority')) {
        // Keep reading until the listen line is out.
        if (text.includes('引擎服务')) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve();
        }
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

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Sends one message and resolves with the first reply of `replyType`
 * whose requestId matches (or the first reply of that type when no id). */
function request(ws, message, replyType, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${replyType} within 20s`)), 20000);
    const onMessage = (raw) => {
      let parsed;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      if (parsed.type !== replyType) {
        // Surface a server rejection instead of waiting for a reply that can
        // never arrive (e.g. a malformed start payload).
        if (parsed.type === 'error' && replyType !== 'error') {
          clearTimeout(timer);
          ws.off('message', onMessage);
          reject(new Error(`server error: ${parsed.message}`));
        }
        return;
      }
      if (requestId !== undefined && parsed.requestId !== requestId) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

/** Converts the Rust plan's scoreEvents to the frozen EngineScoreEvent wire
 * shape (the same one-shot µs→ms projection the browser performs). */
function engineScoreEventsFor(reply) {
  const occurrences = new Map(reply.plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  return reply.plan.scoreEvents.map((event) => {
    const occurrence = occurrences.get(event.runtimeOccurrenceId);
    if (!occurrence) throw new Error(`missing occurrence ${event.runtimeOccurrenceId}`);
    const [numerator, denominator] = String(occurrence.playbackBeat).split('/').map(Number);
    return {
      scoreEventId: event.runtimeOccurrenceId,
      measure: event.measure,
      beatPosition: numerator / denominator,
      pitch: event.pitch,
      targetOnsetMs: event.targetOnsetUs / 1000,
      targetDurationMs: event.targetDurationUs / 1000,
      partId: event.partId,
      parseConfidence: event.parseConfidence,
    };
  });
}

beforeAll(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      RHYTHM_PLANNER: 'rust',
      RHYTHM_DATA_DIR: DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(server);
  socket = await connect();
}, 40000);

afterAll(async () => {
  try { socket?.close(); } catch { /* ignore */ }
  server?.kill();
});

describe('R2-3h: plan protocol over the real engine server', () => {
  it('saves and reads untimed reading evidence through the real API', async () => {
    const payload = { id: 'api-reading-evidence', startedAtIso: '2026-10-28T00:00:00Z', finishedAtIso: '2026-10-28T00:01:00Z',
      config: { mode: 'free', task: 'practice', ranges: [{ startMidi: 60, endMidi: 71 }], notesPerEvent: 1, seed: 1, questionCount: 10 },
      source: 'virtual', questions: Array.from({ length: 10 }, () => [70]), events: [], endReason: 'ended-early' };
    const url = `http://127.0.0.1:${PORT}/api/reading-attempts`;
    const post = (body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const saved = await post(payload);
    expect(saved.status).toBe(200);
    expect((await saved.json()).record.summary.firstTryAccuracy).toBeNull();
    expect((await post(payload)).status).toBe(200);
    expect((await post({ ...payload, events: [{ type: 'note', midi: 69 }] })).status).toBe(409);
    const items = (await (await fetch(url)).json()).items;
    expect(items.filter((item) => item.id === payload.id)).toHaveLength(1);
    expect(items.find((item) => item.id === payload.id)).not.toHaveProperty('events');
    expect((await fetch(`${url}/${payload.id}`)).status).toBe(200);
    expect((await post({ ...payload, id: '../escape' })).status).toBe(400);
  });
  it('starts a verified zero-count-in plan without replacing zero with four beats', async () => {
    const plan = await request(socket, {
      type: 'plan-request', protocolVersion: 1, requestId: 'zero-count-in', mode: 'timeline',
      document: CORPUS.document, report: CORPUS.report, config: { ...CONFIG, countInUs: 0 },
    }, 'plan-response', 'zero-count-in');
    expect(plan.ok).toBe(true);
    const started = await request(socket, {
      type: 'start', protocolVersion: 1, modeId: 'score', bpm: CONFIG.bpm.numerator,
      profile: 'standard', countInBeats: 0, countInUs: 0, ticksPerQuarter: 960,
      atoms: plan.plan.atoms, scoreEvents: engineScoreEventsFor(plan),
      scoreFingerprint: plan.scoreFingerprint, playbackPlanId: plan.plan.runtimeIds.planId,
      planRequestId: plan.requestId, plannerAuthority: plan.plannerAuthority,
      plannerVersion: plan.plannerVersion, planFingerprint: plan.planFingerprint,
      hand: 'both', scoreBarCount: CORPUS.document.parts[0].measures.length,
    }, 'started');
    expect(started.countInMs).toBe(0);
    expect(started.countInBeats).toBe(0);
    await request(socket, { type: 'finish', protocolVersion: 1 }, 'report');
  });
  it('reports the server-side planner authority (single source of truth)', async () => {
    const status = await request(socket, { protocolVersion: 1, type: 'planner-status' }, 'planner-status');
    expect(status.authority).toBe('rust');
    expect(status.plannerVersion).toBe('rust-planner-1');
    expect(status.supportedModes).toEqual(['timeline', 'follow']);
  });

  it('runs the real chain for timeline AND follow and echoes the requestId + fingerprint', async () => {
    for (const mode of ['timeline', 'follow']) {
      const requestId = `plan-${mode}-1`;
      const reply = await request(socket, {
        protocolVersion: 1,
        type: 'plan-request',
        requestId,
        mode,
        document: CORPUS.document,
        report: CORPUS.report,
        config: CONFIG,
      }, 'plan-response', requestId);
      expect(reply.ok).toBe(true);
      expect(reply.requestId).toBe(requestId);
      expect(reply.plannerAuthority).toBe('rust');
      expect(reply.plannerVersion).toBe('rust-planner-1');
      expect(reply.scoreFingerprint).toBe(CORPUS.report.fingerprint);
      expect(reply.planFingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);
      expect(reply.plan.occurrences).toHaveLength(5);
      expect(reply.plan.groups).toHaveLength(5);
      expect(reply.plan.atoms).toHaveLength(5);
      expect(reply.plan.scoreEvents).toHaveLength(5);
    }
  });

  it('persists Rust planner provenance from the plan response through start to disk and history APIs', async () => {
    const requestId = 'plan-provenance';
    const plan = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId,
      mode: 'timeline',
      document: CORPUS.document,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', requestId);
    expect(plan.ok).toBe(true);
    expect(plan.planFingerprint).toMatch(/^plan-v1:sha256:[0-9a-f]{64}$/);

    const started = await request(socket, {
      protocolVersion: 1,
      type: 'start',
      modeId: 'score',
      bpm: CONFIG.bpm.numerator,
      profile: 'standard',
      countInBeats: 4,
      ticksPerQuarter: 960,
      atoms: plan.plan.atoms,
      scoreEvents: engineScoreEventsFor(plan),
      scoreFingerprint: plan.scoreFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
      planRequestId: plan.requestId,
      plannerAuthority: plan.plannerAuthority,
      plannerVersion: plan.plannerVersion,
      planFingerprint: plan.planFingerprint,
      configSnapshot: { modeId: 'score', tempo: CONFIG.bpm.numerator, hand: 'both' },
      hand: 'both',
      scoreBarCount: CORPUS.document.parts[0].measures.length,
      assisted: false,
    }, 'started');
    expect(started.targets.length).toBeGreaterThan(0);
    const last = started.targets[started.targets.length - 1];
    socket.send(JSON.stringify({ protocolVersion: 1, type: 'tick', nowMs: (last?.atMs ?? 0) + 1000 }));
    const report = await request(socket, { protocolVersion: 1, type: 'finish' }, 'report');
    expect(report.persisted).toBe(true);
    expect(report.sessionId).toBeTruthy();
    expect(report.plannerAuthority).toBe('rust');
    expect(report.plannerVersion).toBe('rust-planner-1');
    expect(report.planFingerprint).toBe(plan.planFingerprint);
    expect(report.playbackPlanId).toBe(plan.plan.runtimeIds.planId);
    expect(report.takeId).toBe(report.sessionId);

    const takeOnDisk = JSON.parse(readFileSync(
      path.join(DATA_DIR, 'takes', `${report.takeId}.json`), 'utf8'));
    expect(takeOnDisk).toMatchObject({
      takeId: report.takeId,
      score: { scoreFingerprint: plan.scoreFingerprint },
      lifecycle: { endReason: 'completed', modeId: 'score' },
      context: {
        plannerAuthority: 'rust',
        plannerVersion: 'rust-planner-1',
        planFingerprint: plan.planFingerprint,
        planRunId: plan.plan.runtimeIds.planId,
        practiceConfigSnapshot: { modeId: 'score', tempo: CONFIG.bpm.numerator, hand: 'both' },
      },
    });
    expect(takeOnDisk.assessment.timelineReport.plannerAuthority).toBe('rust');
    expect(takeOnDisk.assessment).toMatchObject({
      attemptStatus: 'completed',
      planAuthority: 'server-rust',
      planIntegrity: 'verified',
      persistenceStatus: 'persisted',
    });

    const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
    const summary = list.items.find((item) => item.sessionId === report.sessionId);
    expect(summary).toMatchObject({
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: plan.planFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
      scoreFingerprint: plan.scoreFingerprint,
    });
    const detail = await (await fetch(
      `http://127.0.0.1:${PORT}/api/sessions/${report.sessionId}`)).json();
    expect(detail).toMatchObject({
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: plan.planFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
      scoreFingerprint: plan.scoreFingerprint,
    });

    const takeList = await (await fetch(`http://127.0.0.1:${PORT}/api/takes`)).json();
    const takeSummary = takeList.items.find((item) => item.takeId === report.takeId);
    expect(takeSummary).toMatchObject({
      takeId: report.takeId,
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: plan.planFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
    });
    const takeDetail = await (await fetch(
      `http://127.0.0.1:${PORT}/api/takes/${report.takeId}`)).json();
    expect(takeDetail).toMatchObject({
      takeId: report.takeId,
      context: {
        plannerAuthority: 'rust',
        plannerVersion: 'rust-planner-1',
        planFingerprint: plan.planFingerprint,
      },
    });
  }, 30000);

  it('starts Follow from the server-issued plan and commits a Follow Take with Rust provenance', async () => {
    const requestId = 'plan-follow-start';
    const plan = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId,
      mode: 'follow',
      document: CORPUS.document,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', requestId);
    expect(plan.ok).toBe(true);

    const started = await request(socket, {
      protocolVersion: 1,
      type: 'follow-start',
      planRequestId: requestId,
      bpm: CONFIG.bpm.numerator,
      plannerAuthority: 'rust',
      scoreFingerprint: plan.scoreFingerprint,
      configSnapshot: { modeId: 'score', tempo: CONFIG.bpm.numerator, profile: 'standard' },
      modeId: 'score',
      timingToleranceMs: 60,
      chordSpreadToleranceMs: 50,
    }, 'follow-started');
    expect(started.targetSource).toBe('server-plan');
    expect(started.plannerAuthority).toBe('rust');
    expect(started.plannerVersion).toBe('rust-planner-1');
    expect(started.planFingerprint).toBe(plan.planFingerprint);
    expect(started.total).toBe(plan.plan.groups.length);

    const occurrenceById = new Map(plan.plan.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const firstGroup = plan.plan.groups[0];
    const firstPitch = occurrenceById.get(firstGroup.occurrenceIds[0]).pitch.midiNote;
    const event = await request(socket, {
      protocolVersion: 1,
      type: 'follow-note',
      note: firstPitch,
      atMs: 100,
    }, 'follow-event');
    expect(event.result.advanced).toBe(true);

    const report = await request(socket, {
      protocolVersion: 1,
      type: 'follow-finish',
    }, 'follow-report');
    expect(report.endReason).toBe('completed');
    expect(report.persisted).toBe(true);
    expect(report.report.completedTargets).toBe(1);

    const record = JSON.parse(readFileSync(
      path.join(DATA_DIR, 'takes', `${report.takeId}.json`), 'utf8'));
    expect(record).toMatchObject({
      takeId: report.takeId,
      context: {
        plannerAuthority: 'rust',
        plannerVersion: 'rust-planner-1',
        planFingerprint: plan.planFingerprint,
        planRunId: plan.plan.runtimeIds.planId,
      },
      assessment: {
        trustworthy: true,
        scoreStatus: 'FOLLOW_ONLY',
        scope: 'follow',
        strictTiming: false,
        attemptStatus: 'completed',
        planAuthority: 'server-rust',
        planIntegrity: 'verified',
        persistenceStatus: 'persisted',
      },
    });
    expect(record.assessment.timelineReport).toBeUndefined();
    expect(record.evidence.captureDiagnostics.targetSource).toBe('server-plan');

    const list = await (await fetch(`http://127.0.0.1:${PORT}/api/takes`)).json();
    expect(list.items.find((item) => item.takeId === report.takeId)).toMatchObject({
      reportKind: 'follow',
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: plan.planFingerprint,
      scoreStatus: 'FOLLOW_ONLY',
    });

    // The server-issued plan context is consumed exactly once.
    await expect(request(socket, {
      protocolVersion: 1,
      type: 'follow-start',
      planRequestId: requestId,
      bpm: CONFIG.bpm.numerator,
      plannerAuthority: 'rust',
      scoreFingerprint: plan.scoreFingerprint,
      modeId: 'score',
    }, 'follow-started')).rejects.toThrow(/不存在或已过期/);
  }, 30000);

  it('rejects a Rust start without the server-issued plan context or with forged provenance', async () => {
    const plan = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId: 'plan-context-guard',
      mode: 'timeline',
      document: CORPUS.document,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', 'plan-context-guard');
    expect(plan.ok).toBe(true);
    const baseStart = {
      protocolVersion: 1,
      type: 'start',
      modeId: 'score',
      bpm: CONFIG.bpm.numerator,
      profile: 'standard',
      countInBeats: 4,
      ticksPerQuarter: 960,
      atoms: plan.plan.atoms,
      scoreEvents: engineScoreEventsFor(plan),
      scoreFingerprint: plan.scoreFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
      plannerAuthority: 'rust',
      plannerVersion: plan.plannerVersion,
      planFingerprint: plan.planFingerprint,
      hand: 'both',
      assisted: false,
    };
    await expect(request(socket, baseStart, 'started')).rejects.toThrow(/planRequestId/);
    await expect(request(socket, {
      ...baseStart,
      planRequestId: plan.requestId,
      plannerVersion: 'client-forged-version',
    }, 'started')).rejects.toThrow(/plannerVersion/);
  });

  it('reads legacy sessions without provenance and exposes them as legacy Takes', async () => {
    const takesDir = path.join(DATA_DIR, 'takes');
    const newestTake = readdirSync(takesDir).find((name) => name.endsWith('.json'));
    expect(newestTake).toBeTruthy();
    const take = JSON.parse(readFileSync(path.join(takesDir, newestTake), 'utf8'));
    const source = take.assessment.timelineReport;
    const legacy = {
      ...source,
      sessionId: 's-old-format',
      takeId: 'take-1',
      finishedAtIso: '2020-01-01T00:00:00.000Z',
      interrupted: false,
    };
    delete legacy.plannerAuthority;
    delete legacy.plannerVersion;
    delete legacy.planFingerprint;
    delete legacy.playbackPlanId;
    writeFileSync(path.join(DATA_DIR, 'sessions', 's-old-format.json'), JSON.stringify(legacy));

    const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/s-old-format`)).json();
    expect(detail.sessionId).toBe('s-old-format');
    expect(detail.plannerAuthority).toBeUndefined();
    expect(detail.plannerVersion).toBeUndefined();
    expect(detail.planFingerprint).toBeUndefined();
    expect(detail.playbackPlanId).toBeUndefined();

    const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
    const summary = list.items.find((item) => item.sessionId === 's-old-format');
    expect(summary).toBeTruthy();
    expect(summary.plannerAuthority).toBeNull();
    expect(summary.plannerVersion).toBeNull();
    expect(summary.planFingerprint).toBeNull();
    expect(summary.playbackPlanId).toBeNull();

    const legacyTake = await (await fetch(
      `http://127.0.0.1:${PORT}/api/takes/legacy-s-old-format`)).json();
    expect(legacyTake.takeId).toBe('legacy-s-old-format');
    expect(legacyTake.legacy).toMatchObject({ source: 'sessions-json', sessionId: 's-old-format' });
    expect(legacyTake.context.plannerAuthority).toBeNull();
    expect(legacyTake.context.plannerVersion).toBeNull();
    expect(legacyTake.context.planFingerprint).toBeNull();
  });

  it('rejects a missing/invalid mode with a coded response (never a plan)', async () => {
    const requestId = 'plan-bad-mode';
    const reply = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId,
      mode: 'both',
      document: CORPUS.document,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', requestId);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('INVALID_REQUEST');
    expect(reply.plan).toBeUndefined();
  });

  it('rejects an untrusted plannerVersion and a foreign score fingerprint with frozen codes', async () => {
    const forged = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId: 'plan-forged-version',
      mode: 'timeline',
      document: CORPUS.document,
      report: CORPUS.report,
      config: { ...CONFIG, plannerVersion: 'client-forged' },
    }, 'plan-response', 'plan-forged-version');
    expect(forged.ok).toBe(false);
    expect(forged.error.code).toBe('INVALID_PLANNER_VERSION');

    const foreignReport = { ...CORPUS.report, fingerprint: 'b'.repeat(64) };
    const mismatched = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId: 'plan-foreign-score',
      mode: 'timeline',
      document: CORPUS.document,
      report: foreignReport,
      config: CONFIG,
    }, 'plan-response', 'plan-foreign-score');
    expect(mismatched.ok).toBe(false);
    expect(mismatched.error.code).toBe('DOCUMENT_REPORT_MISMATCH');
  });

  it('rejects a malformed document with DOCUMENT_VALIDATION_FAILED (fail-closed)', async () => {
    const broken = JSON.parse(JSON.stringify(CORPUS.document));
    broken.parts[0].measures[0].startBeat = { numerator: 2, denominator: 4 };
    const reply = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      requestId: 'plan-broken-doc',
      mode: 'timeline',
      document: broken,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', 'plan-broken-doc');
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('DOCUMENT_VALIDATION_FAILED');
  });

  it('rejects a request without a requestId with INVALID_REQUEST', async () => {
    const reply = await request(socket, {
      protocolVersion: 1,
      type: 'plan-request',
      mode: 'timeline',
      document: CORPUS.document,
      report: CORPUS.report,
      config: CONFIG,
    }, 'plan-response', null);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('INVALID_REQUEST');
  });

  it('keeps the scoring gateway untouched: /api/health still answers', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
  });
});
