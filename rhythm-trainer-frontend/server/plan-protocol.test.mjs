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

  it('persists Rust planner provenance from the plan response through start to disk and history APIs', async () => {    const requestId = 'plan-provenance';
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
      plannerAuthority: plan.plannerAuthority,
      plannerVersion: plan.plannerVersion,
      planFingerprint: plan.planFingerprint,
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

    const onDisk = JSON.parse(readFileSync(
      path.join(DATA_DIR, 'sessions', `${report.sessionId}.json`), 'utf8'));
    expect(onDisk).toMatchObject({
      plannerAuthority: 'rust',
      plannerVersion: 'rust-planner-1',
      planFingerprint: plan.planFingerprint,
      playbackPlanId: plan.plan.runtimeIds.planId,
      scoreFingerprint: plan.scoreFingerprint,
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
  }, 30000);

  it('reads legacy sessions without provenance without fabricating it', async () => {
    const sessionsDir = path.join(DATA_DIR, 'sessions');
    const newest = readdirSync(sessionsDir).find((name) => name.endsWith('.json'));
    expect(newest).toBeTruthy();
    const source = JSON.parse(readFileSync(path.join(sessionsDir, newest), 'utf8'));
    const legacy = {
      ...source,
      sessionId: 's-old-format',
      finishedAtIso: '2020-01-01T00:00:00.000Z',
    };
    delete legacy.plannerAuthority;
    delete legacy.plannerVersion;
    delete legacy.planFingerprint;
    delete legacy.playbackPlanId;
    writeFileSync(path.join(sessionsDir, 's-old-format.json'), JSON.stringify(legacy));

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
