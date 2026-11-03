import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, '../audit-r1/fixtures/parity-cases/rust-parity-input/G1-base.json'), 'utf8'));
const { plannerVersion: _fixtureVersion, ...baseConfig } = corpus.config;
const config = { ...baseConfig, countInUs: 0 };
const dataDir = mkdtempSync(join(tmpdir(), 'rhythm-takeover-'));
const port = 9600 + Math.floor(Math.random() * 300);
let server; let sequence = 0;
const clients = [];

async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = []; const waiters = [];
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    const index = waiters.findIndex(waiter => waiter.type === message.type);
    if (index < 0) { messages.push(message); return; }
    const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const client = {
    socket,
    wait(type) {
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: setTimeout(() => reject(new Error(`timeout ${type}`)), 6000) };
        waiters.push(waiter);
      });
    },
    send(message) { socket.send(JSON.stringify({ protocolVersion: 1, ...message })); },
    request(message, type) { this.send(message); return this.wait(type); },
  };
  clients.push(client); return client;
}
const control = (client, action, expectedLeaseId, requestId = `control-${++sequence}`) =>
  client.request({ type: 'session-control', action, expectedLeaseId, requestId }, 'session-control-result');
async function timeline(client, reply = 'started') {
  const plan = await client.request({ type: 'plan-request', requestId: `plan-${++sequence}`, mode: 'timeline',
    document: corpus.document, report: corpus.report, config }, 'plan-response');
  expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
  const occurrences = new Map(plan.plan.occurrences.map(event => [event.occurrenceId, event]));
  return client.request({ type: 'start', modeId: 'score', bpm: corpus.config.bpm.numerator, profile: 'standard', armOnFirstInput: true,
    countInBeats: 0, countInUs: 0, ticksPerQuarter: 960, atoms: plan.plan.atoms,
    scoreEvents: plan.plan.scoreEvents.map(event => {
      const [n, d] = occurrences.get(event.runtimeOccurrenceId).playbackBeat.split('/').map(Number);
      return { scoreEventId: event.runtimeOccurrenceId, measure: event.measure, beatPosition: n / d, pitch: event.pitch,
        targetOnsetMs: event.targetOnsetUs / 1000, targetDurationMs: event.targetDurationUs / 1000, partId: event.partId, parseConfidence: event.parseConfidence };
    }),
    scoreFingerprint: plan.scoreFingerprint, playbackPlanId: plan.plan.runtimeIds.planId, planRequestId: plan.requestId,
    plannerAuthority: plan.plannerAuthority, plannerVersion: plan.plannerVersion, planFingerprint: plan.planFingerprint,
    hand: 'both', durationPolicy: 'strict-keydown', scoreBarCount: corpus.document.parts[0].measures.length }, reply);
}
async function follow(client, reply = 'follow-started') {
  const plan = await client.request({ type: 'plan-request', requestId: `follow-plan-${++sequence}`, mode: 'follow',
    document: corpus.document, report: corpus.report, config }, 'plan-response');
  expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
  return client.request({ type: 'follow-start', planRequestId: plan.requestId, bpm: corpus.config.bpm.numerator,
    plannerAuthority: 'rust', scoreFingerprint: plan.scoreFingerprint, plannerVersion: plan.plannerVersion,
    planFingerprint: plan.planFingerprint, basePerfMs: performance.now(), modeId: 'score' }, reply);
}
const storedTake = takeId => JSON.parse(readFileSync(join(dataDir, 'takes', `${takeId}.json`), 'utf8'));

beforeAll(async () => {
  server = spawn(process.execPath, ['server/engine-server.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RHYTHM_PLANNER: 'rust', RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server timeout')), 10000);
    server.stdout.on('data', chunk => { if (String(chunk).includes('引擎服务')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)); });
  });
}, 15000);
afterAll(() => { clients.forEach(client => client.socket.close()); server?.kill(); });

it('takes over timeline from another client, persists interruption, and prevents old-page automatic reclaim', async () => {
  const a = await connect(); const b = await connect();
  const started = await timeline(a);
  const busy = await follow(b, 'error');
  expect(busy).toMatchObject({ code: 'SESSION_BUSY', conflict: { kind: 'timeline', self: false } });
  expect((await control(b, 'takeover', busy.conflict.leaseId)).ok).toBe(true);
  expect((await a.wait('session-revoked')).message).toContain('接管');
  const interrupted = await a.wait('report');
  expect(interrupted.persisted).toBe(true);
  expect(storedTake(started.takeId).lifecycle.endReason).toBe('interrupted');
  expect((await follow(a, 'error')).code).toBe('SESSION_REVOKED');
  const next = await follow(b);
  expect(next.takeId).not.toBe(started.takeId);
  expect((await b.request({ type: 'follow-finish', takeId: next.takeId }, 'follow-report')).persisted).toBe(true);
}, 15000);

it('takes over Follow, recovers the same connection, and keeps duplicate or stale taps from ending a newer Take', async () => {
  const a = await connect(); const b = await connect();
  const first = await follow(a);
  const busy = await timeline(b, 'error');
  expect(busy.conflict.kind).toBe('follow');
  const requestId = `same-request-${++sequence}`;
  expect((await control(b, 'takeover', busy.conflict.leaseId, requestId)).ok).toBe(true);
  const interrupted = await a.wait('follow-report');
  expect(interrupted).toMatchObject({ takeId: first.takeId, persisted: true, endReason: 'interrupted' });
  expect(storedTake(first.takeId).lifecycle.endReason).toBe('interrupted');
  const next = await timeline(b);
  // Replay of a successful tap must not finalize the new session.
  expect((await control(b, 'takeover', busy.conflict.leaseId, requestId)).ok).toBe(true);
  const stale = await control(a, 'takeover', busy.conflict.leaseId);
  expect(stale).toMatchObject({ ok: false, conflict: { kind: 'timeline' } });
  const selfBusy = await follow(b, 'error');
  expect(selfBusy.conflict.self).toBe(true);
  expect((await control(b, 'takeover', selfBusy.conflict.leaseId)).ok).toBe(true);
  expect((await b.wait('report')).takeId).toBe(next.takeId);
  const recovered = await follow(b);
  await b.request({ type: 'follow-finish', takeId: recovered.takeId }, 'follow-report');
  const empty = await control(a, 'status');
  expect(empty.conflict).toBeNull();
  expect((await control(a, 'takeover', null)).ok).toBe(true);
  const resumed = await timeline(a);
  expect((await a.request({ type: 'finish', takeId: resumed.takeId }, 'report')).persisted).toBe(true);
  expect(readdirSync(join(dataDir, 'takes')).filter(file => file.endsWith('.json'))).toHaveLength(6);
}, 15000);
