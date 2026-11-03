import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import WebSocket from 'ws';
import { songCompletionAtMs } from './song-completion.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const corpus = JSON.parse(readFileSync(join(root, '../audit-r1/fixtures/parity-cases/rust-parity-input/G1-base.json'), 'utf8'));
const { plannerVersion, ...baseConfig } = corpus.config;
void plannerVersion;
const dataDir = mkdtempSync(join(tmpdir(), 'rhythm-armed-regression-'));
const port = 9050 + Math.floor(Math.random() * 400);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child; let socket;
const received = [];
function request(message, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`timeout ${type}`)); }, 6000);
    function onMessage(raw) {
      const result = JSON.parse(String(raw));
      if (result.type !== type && result.type !== 'error') return;
      clearTimeout(timeout); socket.off('message', onMessage);
      result.type === 'error' ? reject(new Error(result.message)) : resolve(result);
    }
    socket.on('message', onMessage); socket.send(JSON.stringify({ protocolVersion: 1, ...message }));
  });
}
async function start(countInUs = 3000000, selection, options = {}) {
  const config = selection ? { ...baseConfig, countInUs, range: { startMeasureOrdinal: 1, endMeasureOrdinal: 1 } } : { ...baseConfig, countInUs };
  const plan = await request({ type: 'plan-request', requestId: `armed-${countInUs}-${received.length}`, mode: 'timeline',
    document: corpus.document, report: corpus.report, config, ...(selection ? { noteRange: selection } : {}) }, 'plan-response');
  expect(plan.ok).toBe(true);
  const occurrences = new Map(plan.plan.occurrences.map((event) => [event.occurrenceId, event]));
  const scoreEvents = plan.plan.scoreEvents.map((event) => {
    const [n, d] = occurrences.get(event.runtimeOccurrenceId).playbackBeat.split('/').map(Number);
    return { scoreEventId: event.runtimeOccurrenceId, measure: event.measure, beatPosition: n / d, pitch: event.pitch,
      targetOnsetMs: event.targetOnsetUs / 1000, targetDurationMs: event.targetDurationUs / 1000, partId: event.partId, parseConfidence: event.parseConfidence };
  });
  const started = await request({ type: 'start', modeId: options.modeId ?? 'score', bpm: baseConfig.bpm.numerator, profile: 'standard', armOnFirstInput: options.armed ?? true,
    countInBeats: countInUs / 1000000 * baseConfig.bpm.numerator / 60, countInUs, ticksPerQuarter: 960,
    atoms: plan.plan.atoms, scoreEvents, scoreFingerprint: plan.scoreFingerprint, playbackPlanId: plan.plan.runtimeIds.planId,
    planRequestId: plan.requestId, plannerAuthority: plan.plannerAuthority, plannerVersion: plan.plannerVersion, planFingerprint: plan.planFingerprint,
    hand: 'both', durationPolicy: 'strict-keydown', scoreBarCount: corpus.document.parts[0].measures.length }, 'started');
  const endAt = songCompletionAtMs({ modeId: 'score', targets: started.targets, scoreEvents, atoms: plan.plan.atoms,
    bpm: baseConfig.bpm.numerator, ticksPerQuarter: 960, countInMs: countInUs / 1000 });
  return { started, pitch: scoreEvents[0].pitch, plan, endAt };
}
const inject = (bytes) => socket.send(JSON.stringify({ type: 'midi-test-note', bytes }));
beforeAll(async () => {
  child = spawn(process.execPath, ['server/engine-server.mjs'], { cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RHYTHM_PLANNER: 'rust', RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server timeout')), 10000);
    child.stdout.on('data', (data) => { if (String(data).includes('引擎服务')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.on('message', (raw) => received.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => { socket.on('open', resolve); socket.on('error', reject); });
  const pong = await request({ type: 'clock-ping', id: 'armed-clock', clientSendPerfMs: performance.now() }, 'clock-pong');
  await request({ type: 'clock-sample', id: pong.id, clientReceivePerfMs: performance.now() }, 'clock-status');
  await request({ type: 'midi-connect', deviceId: 'mock:0' }, 'midi-status');
}, 15000);
afterAll(() => { socket?.close(); child?.kill(); });

describe('armed practice through real Node MIDI admission and Rust scoring', () => {
  it('auto-finalizes a song at its full musical end and persists exactly one Take', async () => {
    const { endAt } = await start(0, undefined, { armed: false }); const mark = received.length;
    socket.send(JSON.stringify({ type: 'tick', nowMs: endAt - 1 })); await wait(30);
    expect(received.slice(mark).some(m => m.type === 'report')).toBe(false);
    const report = await request({ type: 'tick', nowMs: endAt }, 'report'); expect(report.persisted).toBe(true);
    const saved = await fetch(`http://127.0.0.1:${port}/api/takes/${report.takeId}`).then(r => r.json());
    expect(saved.lifecycle.endReason).toBe('completed');
    socket.send(JSON.stringify({ type: 'finish' })); socket.send(JSON.stringify({ type: 'tick', nowMs: endAt + 100 })); await wait(25);
    expect(received.slice(mark).filter(m => m.type === 'report')).toHaveLength(1);
  });
  it('shifts the automatic song end after a pause, without ending a paused Take', async () => {
    const { endAt } = await start(0, undefined, { armed: false }); const mark = received.length;
    await request({ type: 'pause', nowMs: 100, atSourceMs: performance.now() }, 'paused');
    socket.send(JSON.stringify({ type: 'tick', nowMs: endAt + 5000 })); await wait(20);
    expect(received.slice(mark).some(m => m.type === 'report')).toBe(false);
    await request({ type: 'resume', nowMs: 1100, atSourceMs: performance.now() + 1000 }, 'resumed');
    socket.send(JSON.stringify({ type: 'tick', nowMs: endAt })); await wait(20);
    expect(received.slice(mark).some(m => m.type === 'report')).toBe(false);
    expect((await request({ type: 'tick', nowMs: endAt + 1000 }, 'report')).persisted).toBe(true);
  });
  it('auto-finalizes each loop pass so a fresh armed Take can follow', async () => {
    const { endAt } = await start(0, undefined, { armed: false, modeId: 'loop' }); const mark = received.length;
    const report = await request({ type: 'tick', nowMs: endAt }, 'report'); expect(report.persisted).toBe(true);
    const next = await start(0, undefined, { modeId: 'loop' }); expect(next.started.armed).toBe(true);
    socket.send(JSON.stringify({ type: 'tick', nowMs: endAt + 1000 })); await wait(25);
    expect(received.slice(mark).filter(m => m.type === 'report')).toHaveLength(1);
    const standby = await request({ type: 'finish' }, 'report');
    const history = await fetch(`http://127.0.0.1:${port}/api/takes`).then(r => r.json());
    expect(history.items.some(item => item.takeId === standby.takeId)).toBe(false);
  });
  it.each([0, 3000000])('pairs Note On/Off and aligns the first key with count-in %s', async (countInUs) => {
    const { started, pitch } = await start(countInUs);
    const mark = received.length;
    inject([0x80, pitch, 0]); inject([0x90, pitch, 0]); inject([0xb0, 64, 127]);
    inject([0x90, 127, 90]); inject([0x80, 127, 0]);
    await wait(50);
    expect(received.slice(mark).some((message) => message.type === 'clock-started')).toBe(false);
    const anchored = await request({ type: 'midi-test-note', bytes: [0x90, pitch, 90] }, 'clock-started');
    expect(anchored.captureEpoch).toBe(started.captureEpoch);
    expect(anchored.firstTargetAtMs).toBe(started.firstTargetAtMs);
    expect(Number.isFinite(anchored.originClientPerfMs)).toBe(true);
    await wait(100); inject([0x80, pitch, 40]); inject([0xb0, 64, 0]); await wait(30);
    const report = await request({ type: 'finish' }, 'report');
    expect(report.scoreV1.eventResults[0]).toMatchObject({ result: 'MATCH', pairingStatus: 'complete', onsetErrorMs: 0 });
    expect(report.durations.openNoteCount).toBe(0);
    expect(report.durations.assessments[0].actualKeyDownMs).toBeGreaterThan(50);
    const saved = JSON.parse(readFileSync(join(dataDir, 'takes', `${report.takeId}.json`), 'utf8'));
    expect(saved.assessment.timelineReport.scoreV1.eventResults[0].pairingStatus).toBe('complete');
  });
  it('allows pause/resume before the first key without arming on paused input', async () => {
    const { pitch } = await start(); const mark = received.length;
    await request({ type: 'pause', nowMs: 0, atSourceMs: performance.now() }, 'paused');
    inject([0x90, pitch, 90]); await wait(35);
    expect(received.slice(mark).some((message) => message.type === 'clock-started')).toBe(false);
    await request({ type: 'resume', nowMs: 0, atSourceMs: performance.now() }, 'resumed');
    await request({ type: 'midi-test-note', bytes: [0x90, pitch, 90] }, 'clock-started');
    inject([0x80, pitch, 40]);
    const report = await request({ type: 'finish' }, 'report');
    expect(report.scoreV1.eventResults[0]).toMatchObject({ result: 'MATCH', onsetErrorMs: 0 });
  });
  it('forwards endpoint IDs over the planner protocol and binds the exact subset', async () => {
    const events = corpus.document.parts[0].measures[0].events.filter((event) => event.kind === 'note');
    const event = events.at(-1);
    const { plan } = await start(3000000, { startEventId: event.eventId, endEventId: event.eventId });
    expect(plan.plan.occurrences.every((occurrence) => occurrence.scoreEventId === event.eventId
      || events.some((member) => member.eventId === occurrence.scoreEventId && JSON.stringify(member.onsetBeat) === JSON.stringify(event.onsetBeat)))).toBe(true);
    await request({ type: 'finish' }, 'report');
  });
});
