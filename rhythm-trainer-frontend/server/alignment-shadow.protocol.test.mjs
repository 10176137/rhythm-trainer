'use strict';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-shadow-e2e-'));
let child;
let ws;
let port;
let queue = [];
let listeners = [];

const send = (data) => ws.send(JSON.stringify(data));
const waitFor = (type, predicate = () => true) => new Promise((resolve, reject) => {
  const index = queue.findIndex((x) => x.type === type && predicate(x));
  if (index >= 0) return resolve(queue.splice(index, 1)[0]);
  const timer = setTimeout(() => {
    listeners = listeners.filter((l) => l !== receive);
    reject(new Error(`timed out waiting for ${type}`));
  }, 20000);
  function receive(x) {
    if (x.type !== type || !predicate(x)) return;
    clearTimeout(timer);
    listeners = listeners.filter((l) => l !== receive);
    resolve(x);
  }
  listeners.push(receive);
});

beforeAll(async () => {
  const net = await import('node:net');
  port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
    server.on('error', reject);
  });
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'engine-server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RHYTHM_PLANNER: 'rts',
      RHYTHM_MIDI_BACKEND: 'mock',
      RHYTHM_ALIGNMENT_SHADOW: '1',
      RHYTHM_DATA_DIR: DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('engine startup timeout: ' + stderr)), 20000);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('引擎服务')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`engine exited: ${code}, ${stderr}`)); });
  });
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(String(raw)); } catch { return; }
    const matched = listeners.filter((fn) => {
      // Send to all registered waiters; unmatched messages remain queued.
      try { fn(data); } catch { /* waiter handles its own error */ }
      return !listeners.includes(fn);
    });
    if (matched.length === 0) queue.push(data);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
}, 40000);

afterAll(() => {
  try { ws?.close(); } catch { /* ignore */ }
  child?.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('Take finalization shadow opt-in', () => {
  it('persists a separate, non-authoritative comparison after Take commit', async () => {
    send({
      type: 'start', modeId: 'score', bpm: 120, profile: 'standard',
      countInBeats: 6, countInUs: 3_000_000, ticksPerQuarter: 960,
      atoms: [{ startTick: 0, durationTicks: 960, kind: 'note', bar: 1, beat: 1 }],
      scoreEvents: [{
        scoreEventId: 's1', measure: 1, beatPosition: 1, pitch: 60,
        targetOnsetMs: 3000, targetDurationMs: 500, partId: 'P1',
      }],
      assisted: false, durationPolicy: 'strict-keydown',
    });
    const started = await waitFor('started');
    const atMs = started.targets[0].atMs + 8;
    for (const [seq, ms, bytes] of [
      [1, atMs, [0x90, 60, 90]],
      [2, atMs + 200, [0x80, 60, 40]],
    ]) {
      send({
        type: 'raw-midi',
        ingest: {
          packet: {
            sourceId: 'shadow-test', sourceSeq: seq,
            clockDomainId: 'mock-clock', capturedAtMs: ms, rawBytes: bytes,
            transport: 'mock', captureEpoch: started.captureEpoch,
          },
          sessionTimeMs: ms, clockMappingId: 'shadow-test',
          clockUncertaintyMs: 0, clockQuality: 'good',
        },
      });
    }
    send({ type: 'tick', nowMs: atMs + 800 });
    send({ type: 'finish' });
    const result = await waitFor('report');
    expect(result.persisted).toBe(true);
    expect(result.scoreV1).toBeTruthy();
    const takeId = result.takeId;
    const takeFile = path.join(DIR, 'takes', `${takeId}.json`);
    const sidecarFile = path.join(DIR, 'alignment-shadow', `${takeId}.json`);
    const take = JSON.parse(fs.readFileSync(takeFile, 'utf8'));
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
    expect(take.assessment.timelineReport.scoreV1).toEqual(result.scoreV1);
    expect(take.assessment.alignmentShadow).toBeUndefined();
    expect(sidecar).toMatchObject({
      takeId, status: 'compared', authority: 'diagnostic-only',
      input: { scoreCount: 1, performedCount: 1 },
      provenance: { traceId: take.evidence.traceRef },
    });
    const before = fs.readFileSync(sidecarFile, 'utf8');
    send({ type: 'finish' });
    // Duplicate finish must not mutate the already committed sidecar.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(sidecarFile, 'utf8')).toBe(before);
  }, 40000);
});
