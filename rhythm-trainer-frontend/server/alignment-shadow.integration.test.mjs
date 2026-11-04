// Real Node + Rust N-API + websocket integration. Run after building the addon.
// Proves that opt-in sidecar compares the SAME admitted MIDI as scorePerformance
// while official score/report/persistence remain unmodified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8920 + Math.floor(Math.random() * 40);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-alignment-shadow-integration-'));
let child;
let ws;
let inbox = [];
let waiters = [];
let sourceSeq = 0;
function onMessage(raw) {
  const value = JSON.parse(String(raw));
  const index = waiters.findIndex((w) => w.type === value.type);
  if (index >= 0) waiters.splice(index, 1)[0].resolve(value);
  else inbox.push(value);
}
function receive(type, timeout = 12000) {
  const index = inbox.findIndex((v) => v.type === type);
  if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve: (value) => { clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== waiter);
      reject(new Error('timed out: ' + type));
    }, timeout);
    waiters.push(waiter);
  });
}
function send(payload) {
  ws.send(JSON.stringify({ protocolVersion: 1, ...payload }));
}
function sendRaw(atMs, bytes, epoch) {
  sourceSeq += 1;
  send({
    type: 'raw-midi',
    ingest: {
      packet: {
        sourceId: 'shadow-integration', sourceSeq,
        clockDomainId: 'test', capturedAtMs: atMs,
        rawBytes: bytes, transport: 'mock', captureEpoch: epoch,
      },
      sessionTimeMs: atMs, clockMappingId: 'shadow-test',
      clockUncertaintyMs: 0, clockQuality: 'good',
    },
  });
}
beforeAll(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT),
      RHYTHM_DATA_DIR: DATA, RHYTHM_PLANNER: 'rts',
      RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_ALIGNMENT_SHADOW: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('engine did not start')), 20000);
    child.stdout.on('data', (bytes) => {
      if (String(bytes).includes('引擎服务')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => reject(new Error('server exit: ' + code)));
  });
  ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', onMessage);
}, 35000);
afterAll(() => {
  try { ws?.close(); } catch { /* ignore */ }
  child?.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
});

describe('Timeline opt-in Alignment Shadow Sidecar', () => {
  it('stores a separate alignment diff without replacing the official V1 score', async () => {
    const atoms = Array.from({ length: 6 }, (_, i) => ({
      startTick: i * 960, durationTicks: 960, kind: 'note', bar: 1, beat: i + 1,
    }));
    const scoreEvents = atoms.map((a, i) => ({
      scoreEventId: 's' + i, measure: 1, beatPosition: i,
      pitch: 60, targetOnsetMs: 3000 + i * 500,
      targetDurationMs: 500, partId: 'P1', parseConfidence: 1,
    }));
    send({
      type: 'start', modeId: 'score', bpm: 120,
      profile: 'standard', countInBeats: 6, countInUs: 3000000,
      ticksPerQuarter: 960, atoms, scoreEvents, assisted: false,
      scoreFingerprint: 'shadow-integration-score',
    });
    const started = await receive('started');
    expect(started.targets).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const onset = started.targets[i].atMs + (i === 0 ? 0 : 300);
      sendRaw(onset, [0x90, 60, 90], started.captureEpoch);
      sendRaw(onset + 200, [0x80, 60, 40], started.captureEpoch);
    }
    send({ type: 'tick', nowMs: started.targets[5].atMs + 1300 });
    send({ type: 'finish' });
    const result = await receive('report');
    expect(result.persisted).toBe(true);
    expect(result.scoreV1).toBeTruthy();
    expect(result.scoreV1.algorithmVersion).toBe('scoring-v1.0.0');
    const takePath = path.join(DATA, 'takes', result.takeId + '.json');
    const take = JSON.parse(fs.readFileSync(takePath, 'utf8'));
    expect(take.assessment.timelineReport.scoreV1).toEqual(result.scoreV1);
    const ref = take.assessment.assessmentV2Ref;
    expect(ref).toMatch(/^assessments\/take-[A-Za-z0-9_-]+\/offline-alignment-shadow-v1\.json$/);
    const artifactPath = path.join(DATA, ref);
    const artifactText = fs.readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactText);
    expect(artifact.scoringPolicyVersion).toBe('none-shadow-only');
    expect(artifact.baselineAlgorithmVersion).toBe('scoring-v1.0.0');
    expect(artifact.candidate.pairs.length).toBeGreaterThan(artifact.baseline.pairs.length);
    expect(artifact.comparison.recovered).toBeGreaterThanOrEqual(1);
    expect(artifact.candidate.pairs.some((p) => p.onsetErrorMs === 300)).toBe(true);
    expect(artifact.input.traceSha256).toMatch(/^[a-f0-9]{64}$/);
    send({ type: 'persist-retry', takeId: result.takeId });
    const retried = await receive('persist-retry-result');
    expect(retried.persisted).toBe(true);
    expect(fs.readFileSync(artifactPath, 'utf8')).toBe(artifactText);
  }, 30000);
});
