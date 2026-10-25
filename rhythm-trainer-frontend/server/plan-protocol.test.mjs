// R2-3h: the REAL protocol chain. This spawns the actual engine server
// (RHYTHM_PLANNER=rust) and drives it over its WebSocket: planner-status
// reveals the authority, plan-request runs the real planner-service →
// Rust NAPI → frozen fingerprint gate, and coded rejections come back as
// such. Not a stub transport: the server process, the NAPI addon and the
// fingerprint gate are all real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
const PORT = 8791 + Math.floor(Math.random() * 40);
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
      if (parsed.type !== replyType) return;
      if (requestId !== undefined && parsed.requestId !== requestId) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

beforeAll(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      RHYTHM_PLANNER: 'rust',
      RHYTHM_DATA_DIR: path.join(ROOT, 'node_modules', '.cache', `r2-3h-test-${PORT}`),
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
