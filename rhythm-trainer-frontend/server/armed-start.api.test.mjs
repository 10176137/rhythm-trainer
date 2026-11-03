import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import WebSocket from 'ws';
import { waitsForFirstInput } from '../src/features/practice/sessionStartPolicy';
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RHYTHM_PLANNER: 'rust', RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_DATA_DIR: dataDir, RHYTHM_TAKE_EVENT_LIMIT: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  /** Plays one note (on + off) through raw-midi admission and finishes the take. */
  const playAndFinish = async (started, pitch, onsetMs, plan, holdMs = 240) => {
    for (const [index, bytes] of [[0x90, pitch, 90], [0x80, pitch, 0]].entries()) {
      socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
        packet: { sourceId: `boundary-${started.takeId}`, sourceSeq: index + 1, clockDomainId: 'mock-clock',
          capturedAtMs: onsetMs + index * holdMs, rawBytes: bytes, transport: 'mock', captureEpoch: started.captureEpoch },
        sessionTimeMs: onsetMs + index * holdMs, clockMappingId: 'boundary-test', clockUncertaintyMs: 0, clockQuality: 'good',
      } }));
    }
    return request({ type: 'finish' }, 'report');
  };
  const eventResult = (report, plan, index) =>
    report.scoreV1.eventResults.find(item => item.scoreEventId === plan.plan.scoreEvents[index].runtimeOccurrenceId);

  it('keeps final pitch/onset scoring aligned after two pauses', async () => {
    const { started, pitch, plan } = await start(3000000, undefined, { modeId: 'fixed-line', armed: false });
    const mark = received.length;
    try {
      await request({ type: 'pause', nowMs: 100, atSourceMs: 100 }, 'paused');
      await request({ type: 'resume', nowMs: 4100, atSourceMs: 4100 }, 'resumed');
      await request({ type: 'pause', nowMs: 4200, atSourceMs: 4200 }, 'paused');
      await request({ type: 'resume', nowMs: 5200, atSourceMs: 5200 }, 'resumed');
      const atMs = started.targets[0].atMs + 5000;
      for (const [index, bytes] of [[0x90, pitch, 90], [0x80, pitch, 0]].entries()) {
        socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
          packet: { sourceId: 'pause-test', sourceSeq: index + 1, clockDomainId: 'mock-clock',
            capturedAtMs: atMs + index * 100, rawBytes: bytes, transport: 'mock', captureEpoch: started.captureEpoch },
          sessionTimeMs: atMs + index * 100, clockMappingId: 'pause-test', clockUncertaintyMs: 0, clockQuality: 'good',
        } }));
      }
      const report = await request({ type: 'finish' }, 'report');
      const result = report.scoreV1.eventResults.find(item => item.scoreEventId === plan.plan.scoreEvents[0].runtimeOccurrenceId);
      expect(result).toMatchObject({ result: 'MATCH', onsetErrorMs: 0 });
      // P1-A: live feedback, the final Rust report and the saved record must
      // agree that the shift basis is the Rust cursor over not-yet-processed
      // targets: the played note is judged live against the shifted target,
      // the report keeps the ORIGINAL onset error (0 here), and the saved
      // evidence carries exactly the two pause intervals that define it.
      const liveJudgments = received.slice(mark).flatMap(m => m.type === 'judgments' ? m.items : []);
      expect(liveJudgments.some(item => item.targetIndex === 0 && ['perfect', 'good'].includes(item.grade))).toBe(true);
      const saved = JSON.parse(readFileSync(join(dataDir, 'takes', `${report.takeId}.json`), 'utf8'));
      expect(saved.lifecycle.endReason).toBe('completed');
      expect(saved.evidence.pauseIntervals).toEqual([
        { startMs: 100, endMs: 4100 },
        { startMs: 4200, endMs: 5200 },
      ]);
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('judges a target normally when the pause lands before its onset', async () => {
    const { started, pitch, plan } = await start(3000000, undefined, { armed: false });
    try {
      await request({ type: 'pause', nowMs: 100, atSourceMs: 100 }, 'paused');
      await request({ type: 'resume', nowMs: 1100, atSourceMs: 1100 }, 'resumed');
      const report = await playAndFinish(started, pitch, started.targets[0].atMs + 1000, plan);
      expect(eventResult(report, plan, 0)).toMatchObject({ result: 'MATCH', onsetErrorMs: 0 });
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('does not lose a target when the pause lands exactly at its onset', async () => {
    const { started, pitch, plan } = await start(3000000, undefined, { armed: false });
    try {
      const atMs = started.targets[0].atMs;
      await request({ type: 'pause', nowMs: atMs, atSourceMs: atMs }, 'paused');
      await request({ type: 'resume', nowMs: atMs + 1000, atSourceMs: atMs + 1000 }, 'resumed');
      const report = await playAndFinish(started, pitch, atMs + 1000, plan);
      expect(eventResult(report, plan, 0)).toMatchObject({ result: 'MATCH', onsetErrorMs: 0 });
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('keeps an already-judged target unshifted when the pause lands inside its tolerance window', async () => {
    const { started, pitch, plan } = await start(3000000, undefined, { armed: false });
    try {
      // Target 0 is played 40 ms late (inside the standard tolerance). The
      // pause opens after its onset but before the tolerance window closes:
      // the judged target keeps its original error while the NEXT target
      // shifts by the pause.
      const t0 = started.targets[0].atMs;
      for (const [index, bytes] of [[0x90, pitch, 90], [0x80, pitch, 0]].entries()) {
        socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
          packet: { sourceId: `tolerance-${started.takeId}`, sourceSeq: index + 1, clockDomainId: 'mock-clock',
            capturedAtMs: t0 + 40 + index * 10, rawBytes: bytes, transport: 'mock', captureEpoch: started.captureEpoch },
          sessionTimeMs: t0 + 40 + index * 10, clockMappingId: 'boundary-test', clockUncertaintyMs: 0, clockQuality: 'good',
        } }));
      }
      await request({ type: 'pause', nowMs: t0 + 55, atSourceMs: t0 + 55 }, 'paused');
      await request({ type: 'resume', nowMs: t0 + 1055, atSourceMs: t0 + 1055 }, 'resumed');
      const pitch1 = plan.plan.scoreEvents[1].pitch;
      const report = await playAndFinish(started, pitch1, started.targets[1].atMs + 1000, plan);
      expect(eventResult(report, plan, 0)).toMatchObject({ result: 'MATCH', onsetErrorMs: 40 });
      expect(eventResult(report, plan, 1)).toMatchObject({ result: 'MATCH', onsetErrorMs: 0 });
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('excludes a pause span from key-down time when a held note crosses the boundary', async () => {
    const { started, pitch, plan } = await start(3000000, undefined, { armed: false });
    try {
      const t0 = started.targets[0].atMs;
      socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
        packet: { sourceId: `held-${started.takeId}`, sourceSeq: 1, clockDomainId: 'mock-clock',
          capturedAtMs: t0, rawBytes: [0x90, pitch, 90], transport: 'mock', captureEpoch: started.captureEpoch },
        sessionTimeMs: t0, clockMappingId: 'boundary-test', clockUncertaintyMs: 0, clockQuality: 'good',
      } }));
      await request({ type: 'pause', nowMs: t0 + 400, atSourceMs: t0 + 400 }, 'paused');
      await request({ type: 'resume', nowMs: t0 + 1400, atSourceMs: t0 + 1400 }, 'resumed');
      socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
        packet: { sourceId: `held-${started.takeId}`, sourceSeq: 2, clockDomainId: 'mock-clock',
          capturedAtMs: t0 + 1700, rawBytes: [0x80, pitch, 40], transport: 'mock', captureEpoch: started.captureEpoch },
        sessionTimeMs: t0 + 1700, clockMappingId: 'boundary-test', clockUncertaintyMs: 0, clockQuality: 'good',
      } }));
      const report = await request({ type: 'finish' }, 'report');
      // The hold spans non-performance time (400 ms before the pause + 300 ms
      // after resume, against a 750 ms quarter), so Rust must not grade the
      // key-down strictly: it reports `crossed_pause_boundary` / `unknown`
      // rather than guessing from a pause-inflated 1700 ms hold.
      const assessment = report.durations.assessments.find(item => item.pitch === pitch);
      expect(assessment).toMatchObject({ result: 'unknown', quality: 'crossed_pause_boundary' });
      // The onset itself is still judged normally against the shifted target.
      expect(eventResult(report, plan, 0)).toMatchObject({ result: 'MATCH' });
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('acknowledges duplicate pause/resume without shifting the take twice', async () => {
    await start(3000000, undefined, { armed: false });
    try {
      await request({ type: 'pause', nowMs: 100, atSourceMs: 100 }, 'paused');
      await request({ type: 'pause', nowMs: 200, atSourceMs: 200 }, 'paused');
      expect(await request({ type: 'resume', nowMs: 1100, atSourceMs: 1100 }, 'resumed')).toMatchObject({ deltaMs: 1000 });
      expect(await request({ type: 'resume', nowMs: 1200, atSourceMs: 1200 }, 'resumed')).toMatchObject({ deltaMs: 0 });
      const report = await request({ type: 'finish' }, 'report');
      const saved = JSON.parse(readFileSync(join(dataDir, 'takes', `${report.takeId}.json`), 'utf8'));
      expect(saved.evidence.pauseIntervals).toEqual([{ startMs: 100, endMs: 1100 }]);
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('rejects a backward pause before changing coordinator state', async () => {
    await start(3000000, undefined, { armed: false });
    try {
      await request({ type: 'tick', nowMs: 500 }, 'judgments');
      // A queued stale tick must not move the validation baseline backwards.
      socket.send(JSON.stringify({ type: 'tick', nowMs: 200 }));
      await expect(request({ type: 'pause', nowMs: 100 }, 'paused')).rejects.toThrow();
      await request({ type: 'pause', nowMs: 600, atSourceMs: 600 }, 'paused');
      await expect(request({ type: 'resume', nowMs: 550 }, 'resumed')).rejects.toThrow();
      expect(await request({ type: 'resume', nowMs: 700, atSourceMs: 700 }, 'resumed')).toMatchObject({ deltaMs: 100 });
      expect((await request({ type: 'finish' }, 'report')).persisted).toBe(true);
    } finally { socket.send(JSON.stringify({ type: 'finish' })); }
  });
  it('rejects commands for the preceding take without disturbing the new take', async () => {
    const first = await start(0, undefined, { armed: false });
    await request({ type: 'finish', takeId: first.started.takeId }, 'report');
    const next = await start(0, undefined, { armed: false });
    for (const type of ['tick', 'pause', 'resume', 'finish']) {
      await expect(request({ type, takeId: first.started.takeId, nowMs: 100 }, 'paused')).rejects.toThrow('轮次已过期');
    }
    await request({ type: 'pause', takeId: next.started.takeId, nowMs: 100 }, 'paused');
    await request({ type: 'resume', takeId: next.started.takeId, nowMs: 200 }, 'resumed');
    const report = await request({ type: 'finish', takeId: next.started.takeId }, 'report');
    expect(report.takeId).toBe(next.started.takeId);
    expect(report.persisted).toBe(true);
  });
  it('seals failed take evidence before the next start replaces its resources', async () => {
    const { started } = await start(3000000, undefined, { armed: false });
    await expect(request({ type: 'hit', seq: 1, atMs: -1, notes: [60] }, 'judgments')).rejects.toThrow();
    const suffix = `${started.practiceSessionId}-${started.engineTakeId}`;
    const journal = readFileSync(join(dataDir, 'journals', `journal-${suffix}.jsonl`), 'utf8');
    expect(journal).toContain('invalid_input');
    expect(journal).toContain('take_aborted');
    expect(readFileSync(join(dataDir, 'traces', `trace-${suffix}.manifest.json`), 'utf8')).toContain('traceId');
    const next = await start(0, undefined, { armed: false });
    const report = await request({ type: 'finish', takeId: next.started.takeId }, 'report');
    expect(report.persisted).toBe(true);
  });
  it('releases Follow ownership before Timeline start and preserves duplicate Follow reports', async () => {
    const follow = await request({ type: 'follow-start', plannerAuthority: 'rts', bpm: 60,
      groups: [{ groupId: 'switch1', bar: 1, playbackBeat: 0, pitches: [{ midiNote: 60, spelling: 'C4' }] }],
    }, 'follow-started');
    const firstReport = await request({ type: 'follow-finish' }, 'follow-report');
    expect(firstReport.takeId).toBe(follow.takeId);
    expect(firstReport.persistenceStatus).toBe('persisted');
    const next = await start(0, undefined, { modeId: 'fixed-line', armed: false });
    const duplicate = await request({ type: 'follow-finish' }, 'follow-report');
    expect(duplicate.takeId).toBe(follow.takeId);
    await request({ type: 'pause', nowMs: 100, takeId: next.started.takeId }, 'paused');
    await request({ type: 'resume', nowMs: 200, takeId: next.started.takeId }, 'resumed');
    expect((await request({ type: 'finish', takeId: next.started.takeId }, 'report')).persisted).toBe(true);
  });
  it('keeps duplicate raw packets as evidence but admits only one scoring onset', async () => {
    const { started, pitch } = await start(3000000, undefined, { modeId: 'fixed-line', armed: false });
    const atMs = started.targets[0].atMs;
    const ingest = { packet: { sourceId: 'duplicate-test', sourceSeq: 1, capturedAtMs: atMs,
      clockDomainId: 'mock-clock', rawBytes: [0x90, pitch, 90], transport: 'mock' },
      sessionTimeMs: atMs, clockMappingId: 'duplicate-test', clockUncertaintyMs: 0, clockQuality: 'good' };
    socket.send(JSON.stringify({ type: 'raw-midi', ingest }));
    socket.send(JSON.stringify({ type: 'raw-midi', ingest }));
    socket.send(JSON.stringify({ type: 'raw-midi', ingest: { ...ingest,
      packet: { ...ingest.packet, sourceSeq: 2, capturedAtMs: atMs + 100, rawBytes: [0x80, pitch, 0] }, sessionTimeMs: atMs + 100 } }));
    const report = await request({ type: 'finish', takeId: started.takeId }, 'report');
    expect(report.captureDiagnostics.admission).toMatchObject({ packets: 3, admittedNoteOns: 1, pushHitCount: 1, duplicateEventIds: 1 });
    expect(report.scoreInputNoteCount).toBe(1);
    expect(report.persisted).toBe(true);
  });
  it('resets admission and pause state across twelve successive takes on one connection', async () => {
    const ids = new Set();
    for (let index = 0; index < 12; index++) {
      const { started, pitch } = await start(3000000, undefined, { modeId: 'fixed-line', armed: false });
      expect(ids.has(started.takeId)).toBe(false); ids.add(started.takeId);
      await request({ type: 'pause', takeId: started.takeId, nowMs: 100, atSourceMs: 100 }, 'paused');
      await request({ type: 'resume', takeId: started.takeId, nowMs: 200, atSourceMs: 200 }, 'resumed');
      const atMs = started.targets[0].atMs + 100;
      for (const [offset, bytes] of [[0x90, pitch, 90], [0x80, pitch, 0]].entries()) {
        socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
          packet: { sourceId: 'reused-source', sourceSeq: offset + 1, clockDomainId: 'mock',
            capturedAtMs: atMs + offset * 100, rawBytes: bytes, transport: 'mock' },
          sessionTimeMs: atMs + offset * 100, clockMappingId: 'repeat', clockUncertaintyMs: 0, clockQuality: 'good',
        } }));
      }
      const report = await request({ type: 'finish', takeId: started.takeId }, 'report');
      expect(report.persisted).toBe(true);
      expect(report.captureDiagnostics.admission).toMatchObject({ packets: 2, admittedNoteOns: 1, duplicateEventIds: 0 });
      expect(report.captureDiagnostics.admission.pauseSegments).toEqual([{ segmentId: 'pause-1', startSession: 100, endSession: 200 }]);
      expect(report.scoreV1.eventResults.some(item => item.result === 'MATCH' && item.onsetErrorMs === 0)).toBe(true);
    }
  }, 20000);
  it('advances fixed-line without MIDI input and marks every target as missed', async () => {
    const { started, endAt } = await start(3000000, undefined, { modeId: 'fixed-line', armed: waitsForFirstInput('fixed-line') });
    expect(started.armed).toBe(false);
    socket.send(JSON.stringify({ type: 'tick', nowMs: endAt }));
    const report = await request({ type: 'finish' }, 'report');
    expect(report.persisted).toBe(true);
    expect(report.scoreV1.eventResults.length).toBeGreaterThan(0);
    expect(report.scoreV1.eventResults.every(event => event.result === 'MISSING')).toBe(true);
  });
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

it('ends an over-budget take explicitly and accepts a fresh take afterwards', async () => {
  await start(3000000, undefined, { modeId: 'fixed-line', armed: false });
  for (let i = 0; i < 100; i++) socket.send(JSON.stringify({ type: 'raw-midi', ingest: {
    packet: { sourceId: 'budget', clockDomainId: 'performance', sourceSeq: i + 1, capturedAtMs: i, rawBytes: [0xb0, 1, 0], transport: 'mock' }, sessionTimeMs: i,
  } }));
  const report = await request({ type: 'raw-midi', ingest: {
    packet: { sourceId: 'budget', clockDomainId: 'performance', sourceSeq: 101, capturedAtMs: 100, rawBytes: [0xb0, 1, 0], transport: 'mock' }, sessionTimeMs: 100,
  } }, 'report');
  expect(report.persisted).toBe(true);
  const record = JSON.parse(readFileSync(join(dataDir, 'takes', `${report.takeId}.json`), 'utf8'));
  expect(record.lifecycle.endReason).toBe('resource_limit');
  expect(record.assessment.trustworthy).toBe(false);
  expect(record.assessment.scoreStatus).toBe('DEGRADED');
  expect(record.assessment.timelineReport.captureDiagnostics.admission.packets).toBe(100);
  // The boundary is auditable: the 101st packet was rejected, not retained,
  // and the record says where input stopped.
  expect(record.evidence.captureDiagnostics.resourceBudget).toMatchObject({
    eventLimit: 100, reached: true, events: 100,
    rejectedKind: 'raw-midi', rejectedSourceId: 'budget', rejectedSourceSeq: 101,
  });
  await start(3000000, undefined, { modeId: 'fixed-line', armed: false });
  const next = await request({ type: 'finish' }, 'report');
  expect(next.persisted).toBe(true);
  const nextRecord = JSON.parse(readFileSync(join(dataDir, 'takes', `${next.takeId}.json`), 'utf8'));
  expect(nextRecord.evidence.captureDiagnostics.resourceBudget).toMatchObject({
    reached: false, events: 0, rejectedKind: null, rejectedSourceSeq: null,
  });
});
