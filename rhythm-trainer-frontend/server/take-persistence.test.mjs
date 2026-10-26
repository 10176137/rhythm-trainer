// Take persistence fault injection against the REAL engine server (Timeline
// and Follow).
//
// Covers the Stage 1 requirement: a failed write must keep the frozen draft,
// report persisted=false (never a fake "saved"), and allow an idempotent retry
// with the same takeId — including after the finishing connection closed.
// Timeline retry also proves the mastery side effect runs exactly once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8871 + Math.floor(Math.random() * 20);
const DATA_DIR = path.join(ROOT, 'node_modules', '.cache', `take-persistence-${PORT}`);
const TAKES_DIR = path.join(DATA_DIR, 'takes');

let server;
let client;

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    const onData = (chunk) => {
      if (String(chunk).includes('引擎服务')) {
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

async function startAndComplete() {
  client.send({
    type: 'follow-start',
    groups: [{ groupId: 'p1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] }],
    bpm: 60,
    plannerAuthority: 'rts',
    plannerVersion: 'rts-test',
    scoreFingerprint: 'score-persist-test',
    scoreId: null,
    modeId: 'score',
    startedAtIso: new Date().toISOString(),
    basePerfMs: performance.now(),
  });
  const started = await client.waitFor('follow-started');
  client.send({ type: 'follow-note', note: 60, atMs: 100 });
  const report = await client.waitFor('follow-report');
  return { started, report };
}

async function startTimelineAndFinish() {
  client.send({
    type: 'start',
    modeId: 'score',
    bpm: 120,
    profile: 'standard',
    countInBeats: 6,
    countInUs: 3_000_000,
    ticksPerQuarter: 960,
    atoms: [{ startTick: 0, durationTicks: 960, kind: 'note', bar: 1, beat: 1 }],
    assisted: false,
  });
  const started = await client.waitFor('started');
  const target = started.targets[0];
  client.send({ type: 'hit', seq: 1, atMs: target.atMs + 8, notes: [60] });
  client.send({ type: 'tick', nowMs: target.atMs + 250 + 500 });
  client.send({ type: 'finish' });
  return client.waitFor('report');
}

const TAKES_BLOCKED_DIR = `${TAKES_DIR}.blocked`;

function takeFiles() {
  try {
    if (!existsSync(TAKES_DIR) || !statSync(TAKES_DIR).isDirectory()) return [];
    return readdirSync(TAKES_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

// chmod-based permission denial is a no-op on Windows. Replace the takes
// directory with a regular file instead: every write under that path fails
// with ENOTDIR on every platform, and the original directory (with any prior
// Takes) is restored when writes are re-enabled.
function setTakesWritable(writable) {
  if (!writable) {
    if (existsSync(TAKES_DIR)) {
      rmSync(TAKES_BLOCKED_DIR, { recursive: true, force: true });
      renameSync(TAKES_DIR, TAKES_BLOCKED_DIR);
    }
    writeFileSync(TAKES_DIR, 'blocked', 'utf8');
    return;
  }
  if (existsSync(TAKES_DIR) && !statSync(TAKES_DIR).isDirectory()) {
    rmSync(TAKES_DIR, { force: true });
  }
  if (existsSync(TAKES_BLOCKED_DIR)) {
    renameSync(TAKES_BLOCKED_DIR, TAKES_DIR);
  }
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
  try { setTakesWritable(true); } catch { /* ignore */ }
  try { client?.ws.close(); } catch { /* ignore */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('Follow Take persistence failure', () => {
  it('reports pending-retry, keeps the draft, and saves it on retry with the same takeId', async () => {
    setTakesWritable(false);
    const { report } = await startAndComplete();

    expect(report.persisted).toBe(false);
    expect(report.persistenceStatus).toBe('pending-retry');
    expect(report.persistenceError).toMatch(/EACCES|EPERM|ENOTDIR|EEXIST|permission|not a directory|already exists|目录|拒绝|已存在/i);
    expect(takeFiles()).toEqual([]);

    const takeId = report.takeId;
    setTakesWritable(true);
    client.send({ type: 'persist-retry', takeId });
    const retried = await client.waitFor('persist-retry-result', (message) => message.takeId === takeId);
    expect(retried).toMatchObject({ persisted: true, persistenceStatus: 'persisted', persistenceError: null });
    expect(takeFiles()).toEqual([`${takeId}.json`]);

    const record = JSON.parse(readFileSync(path.join(TAKES_DIR, `${takeId}.json`), 'utf8'));
    expect(record.takeId).toBe(takeId);
    expect(record.assessment.followReport.completedTargets).toBe(1);

    // A duplicate finish returns the same committed Take; it must not create a
    // second file or resurrect the pending state.
    client.send({ type: 'follow-finish' });
    const duplicate = await client.waitFor('follow-report');
    expect(duplicate.takeId).toBe(takeId);
    expect(duplicate.persisted).toBe(true);
    expect(takeFiles()).toHaveLength(1);

    // An unknown takeId must not fabricate a draft or claim success.
    client.send({ type: 'persist-retry', takeId: 'take-does-not-exist' });
    const unknown = await client.waitFor('persist-retry-result', (message) => message.takeId === 'take-does-not-exist');
    expect(unknown).toMatchObject({ persisted: false, persistenceStatus: 'unknown' });
  }, 30000);

  it('retries from a new connection after the finishing connection closed', async () => {
    setTakesWritable(false);
    const { report } = await startAndComplete();
    expect(report.persisted).toBe(false);
    const takeId = report.takeId;

    client.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    setTakesWritable(true);

    client = await connect();
    client.send({ type: 'persist-retry', takeId });
    const retried = await client.waitFor('persist-retry-result', (message) => message.takeId === takeId);
    expect(retried).toMatchObject({ persisted: true, persistenceStatus: 'persisted' });
    expect(takeFiles()).toContain(`${takeId}.json`);
  }, 30000);

  it('retries a failed Timeline Take and applies mastery evidence exactly once', async () => {
    const profilePath = path.join(DATA_DIR, 'profile.json');
    expect(existsSync(profilePath)).toBe(false);

    setTakesWritable(false);
    const report = await startTimelineAndFinish();
    expect(report.persisted).toBe(false);
    expect(report.persistenceStatus).toBe('pending-retry');
    const takeId = report.takeId;
    expect(takeFiles()).not.toContain(`${takeId}.json`);
    // A failed write must not feed the derived mastery cache either.
    expect(existsSync(profilePath)).toBe(false);

    setTakesWritable(true);
    client.send({ type: 'persist-retry', takeId });
    const retried = await client.waitFor('persist-retry-result', (message) => message.takeId === takeId);
    expect(retried).toMatchObject({ persisted: true, persistenceStatus: 'persisted' });

    const record = JSON.parse(readFileSync(path.join(TAKES_DIR, `${takeId}.json`), 'utf8'));
    expect(record.assessment).toMatchObject({
      attemptStatus: 'completed',
      planAuthority: 'client-rts-projection',
      planIntegrity: 'unavailable',
      persistenceStatus: 'persisted',
    });
    expect(record.assessment.timelineReport).toBeTruthy();
    expect(existsSync(profilePath)).toBe(true);
    const profileAfterFirst = readFileSync(profilePath, 'utf8');

    // A duplicate retry is idempotent: one Take, one mastery update.
    client.send({ type: 'persist-retry', takeId });
    await client.waitFor('persist-retry-result', (message) => message.takeId === takeId);
    expect(readFileSync(profilePath, 'utf8')).toBe(profileAfterFirst);
    expect(takeFiles().filter((name) => name === `${takeId}.json`)).toHaveLength(1);
  }, 30000);

  it('rejects a countInBeats that disagrees with the canonical countInUs', async () => {
    client.send({
      type: 'start',
      modeId: 'score',
      bpm: 120,
      profile: 'standard',
      countInBeats: 4,
      countInUs: 3_000_000,
      ticksPerQuarter: 960,
      atoms: [{ startTick: 0, durationTicks: 960, kind: 'note', bar: 1, beat: 1 }],
      assisted: false,
    });
    const error = await client.waitFor('error');
    expect(error.message).toMatch(/countInBeats.*countInUs|countInUs.*countInBeats/);
  }, 20000);
});
