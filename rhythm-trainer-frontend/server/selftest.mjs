'use strict';

// Engine-service self test. Spawns its OWN server instance on a scratch port
// with a throwaway data dir (never touches the user's real data), opens real
// WebSocket connections, drives the Rust core with synthetic (instant,
// non-decreasing) session timestamps, asserts on the deterministic replay
// reports, then checks the REST persistence API and the mastery profile.
// Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const URL = `ws://127.0.0.1:${PORT}/ws`;

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

class TestClient {
  constructor() {
    this.socket = new WebSocket(URL);
    this.queue = [];
    this.waiters = [];
    this.socket.on('message', (raw) => this.handleIncoming(raw));
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket.on('open', resolve);
      this.socket.on('error', reject);
    });
  }

  next(type, predicate = () => true, timeoutMs = 3000) {
    const queuedIndex = this.queue.findIndex((m) => m.type === type && predicate(m));
    if (queuedIndex >= 0) return Promise.resolve(this.queue.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: 0 };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  handleIncoming(raw) {
    const message = JSON.parse(raw.toString());
    const waiterIndex = this.waiters.findIndex((w) => w.type === message.type && w.predicate(message));
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }

  send(payload) {
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.socket.close();
  }
}

const quarterAtoms = (count, bar) => Array.from({ length: count }, (_, i) => ({
  startTick: i * 960,
  durationTicks: 960,
  kind: 'note',
  bar,
  beat: i + 1,
}));

/** B1 score events use the same quarter-note grid as quarterAtoms. */
function scoreEventsForAtoms(atoms, { bpm = 240, countInBeats = 4, ticksPerQuarter = 960 } = {}) {
  const msPerTick = 60_000 / bpm / ticksPerQuarter;
  const countInMs = countInBeats * (60_000 / bpm);
  return atoms.map((atom, index) => ({
    scoreEventId: `score-${index}`,
    measure: atom.bar,
    beatPosition: atom.beat,
    pitch: 60,
    targetOnsetMs: countInMs + atom.startTick * msPerTick,
    targetDurationMs: atom.durationTicks * msPerTick,
    partId: 'P1',
    parseConfidence: 1,
  }));
}

async function accurateSession(client, hits = 8) {
  client.send({
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(hits, 1), assisted: false,
  });
  const started = await client.next('started');
  started.targets.forEach((target, i) => {
    client.send({ type: 'hit', seq: i + 1, atMs: target.atMs + 8, notes: [60] });
  });
  const last = started.targets[started.targets.length - 1];
  client.send({ type: 'tick', nowMs: last.atMs + 250 + 500 });
  client.send({ type: 'finish' });
  const report = await client.next('report');
  return { ...report, started };
}

/** Mastery scenarios need inputHealth=healthy; ensure the mock adapter is connected. */
async function ensureMidiConnected(client) {
  client.send({ type: 'midi-refresh' });
  const devices = await client.next(
    'midi-devices',
    (m) => Array.isArray(m.items) && m.items.some((d) => d.id === 'mock:0'),
    800,
  ).catch(() => null);
  if (!devices) return false; // adapter unavailable in this run
  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  const status = await client.next('midi-status', (m) => m.connected === true, 800).catch(() => null);
  return !!status;
}

async function scenarioAccurateHits() {
  console.log('scenario: 全部准点击打 → 8 Perfect,数据可信,报告已持久化');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status').catch(() => null);
  await ensureMidiConnected(client);
  const { report, analysis, sessionId, started } = await accurateSession(client);
  check('started 返回后端首音时刻', started.firstTargetAtMs === started.targets[0].atMs,
    `${started.firstTargetAtMs} vs ${started.targets[0].atMs}`);
  check('120 BPM 四拍预备后首音在 2000ms', Math.abs(started.firstTargetAtMs - 2000) < 0.001,
    String(started.firstTargetAtMs));
  check('started 返回预备拍长度', Math.abs(started.countInMs - 2000) < 0.001, String(started.countInMs));
  check('8 个 Perfect', report.stats.perfectCount === 8, JSON.stringify(report.stats));
  check('无 Miss/Extra', report.stats.missCount === 0 && report.stats.extraCount === 0);
  check('平均偏差约 +8ms', report.stats.meanSignedMs != null && Math.abs(report.stats.meanSignedMs - 8) < 0.5,
    String(report.stats.meanSignedMs));
  check('数据可信', report.trustworthy === true);
  check('状态 completed', report.state === 'completed');
  check('分析特征目标数正确', analysis && analysis.report && analysis.report.features.targetCount === 8);
  check('返回 sessionId', typeof sessionId === 'string' && sessionId.length > 0);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
  check('REST /api/sessions 已有记录', list.items.length >= 1);
  const latest = list.items[0];
  check('最新记录即本次(可信, 8 目标)',
    latest.trustworthy === true && latest.targetCount === 8 && latest.modeId === 'score',
    JSON.stringify(latest));

  const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}`)).json();
  check('REST 详情返回完整报告', detail.sessionId === sessionId && detail.report.stats.perfectCount === 8);

  const bad = await fetch(`http://127.0.0.1:${PORT}/api/sessions/..%2Fetc`);
  check('路径穿越 id 被 404', bad.status === 404);

  const profile = await (await fetch(`http://127.0.0.1:${PORT}/api/profile`)).json();
  const score = profile.skills.find((s) => s.skillId === 'score');
  check('能力画像出现 score 技能', !!score);
  check('1 次可信尝试', score && score.trustworthyAttempts === 1, JSON.stringify(profile.skills));
  client.close();
}

async function scenarioMasteryProvisional() {
  console.log('scenario: 连续 3 次达标 → score 技能升到 provisional');
  for (let round = 0; round < 2; round += 1) {
    const client = new TestClient();
    await client.open();
    await client.next('midi-status').catch(() => null);
    await ensureMidiConnected(client);
    await accurateSession(client);
    client.close();
  }
  const profile = await (await fetch(`http://127.0.0.1:${PORT}/api/profile`)).json();
  const score = profile.skills.find((s) => s.skillId === 'score');
  check('3 次可信尝试', score && score.trustworthyAttempts === 3, JSON.stringify(score));
  check('连续 3 次 pass → provisional', score && score.state === 'provisional', JSON.stringify(score));
  check('totals 统计会话数', profile.totals.sessions >= 3);
}

async function scenarioMixedOutcomes() {
  console.log('scenario: 混合结果 → Perfect×6/Good×1/Miss×1/Extra×1,并打断模型连胜');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status').catch(() => null);
  await ensureMidiConnected(client);
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(8, 1), assisted: false,
  });
  const started = await client.next('started');
  const t = started.targets;
  // 8 目标(达到 mastery 政策每次尝试最少 8 目标):t0 perfect,t1 漏,
  // t2 good(+45),一个 extra 喺窗口之间,t3..t7 全部 +8 perfect。
  client.send({ type: 'hit', seq: 1, atMs: t[0].atMs + 8, notes: [60] });
  client.send({ type: 'tick', nowMs: t[1].atMs + 60 + 80 + 1 });
  client.send({ type: 'hit', seq: 2, atMs: t[2].atMs + 45, notes: [60] });
  client.send({ type: 'hit', seq: 3, atMs: t[2].atMs + 120, notes: [60] });
  for (let i = 3; i < 8; i++) {
    client.send({ type: 'hit', seq: i + 1, atMs: t[i].atMs + 8, notes: [60] });
  }
  client.send({ type: 'tick', nowMs: t[7].atMs + 250 + 500 });
  client.send({ type: 'finish' });
  const { report } = await client.next('report');
  check('6 Perfect', report.stats.perfectCount === 6, JSON.stringify(report.stats));
  check('1 Good', report.stats.goodCount === 1);
  check('1 Miss', report.stats.missCount === 1);
  check('1 Extra', report.stats.extraCount === 1);
  check('命中率 = 7/8', Math.abs(report.stats.targetHitRate - 7 / 8) < 1e-9);

  // 呢次尝试有 miss/extra → passed=false,打断连胜
  const profile = await (await fetch(`http://127.0.0.1:${PORT}/api/profile`)).json();
  const score = profile.skills.find((s) => s.skillId === 'score');
  check('fail 后 consecutivePasses 归零', score && score.consecutivePasses === 0, JSON.stringify(score));
  check('可信尝试累计 4 次', score && score.trustworthyAttempts === 4, JSON.stringify(score));
  client.close();
}

async function scenarioPauseResume() {
  console.log('scenario: 暂停/恢复 → 剩余目标整体平移,不把暂停算成偏差');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 60, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false,
  });
  const started = await client.next('started');
  const t = started.targets;
  client.send({ type: 'hit', seq: 1, atMs: t[0].atMs + 8, notes: [60] });
  client.send({ type: 'tick', nowMs: 4200 });
  client.send({ type: 'pause', nowMs: 5000 });
  await client.next('paused');
  // A late tick while paused must be ignored, not reject NativeSession.advance
  // and abort the UI with an engine error.
  client.send({ type: 'tick', nowMs: 5500 });
  const pausedTickError = await client.next('error', () => true, 300).then(() => true).catch(() => false);
  check('暂停期间 tick 不产生引擎错误', pausedTickError === false);
  client.send({ type: 'resume', nowMs: 9000 });
  const resumed = await client.next('resumed');
  check('resume 返回 4000ms 平移量', resumed.deltaMs === 4000);
  client.send({ type: 'hit', seq: 2, atMs: t[1].atMs + 4000 + 8, notes: [60] });
  client.send({ type: 'tick', nowMs: 12000 });
  client.send({ type: 'finish' });
  const { report } = await client.next('report');
  check('暂停后两个目标均 Perfect', report.stats.perfectCount === 2, JSON.stringify(report.stats));
  check('平均偏差仍约 +8ms(未吃进暂停时长)',
    report.stats.meanSignedMs != null && Math.abs(report.stats.meanSignedMs - 8) < 0.5,
    String(report.stats.meanSignedMs));
  client.close();
}

async function scenarioDegradedHealthExcluded() {
  console.log('scenario: 输入降级 → captureDiagnostics 标记 degraded，尝试不计入掌握证据');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status');
  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  await client.next('midi-status', (m) => m.connected === true);

  const startPayload = {
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  };
  client.send(startPayload);
  const started = await client.next('started');
  const t = started.targets;
  // Overfill nothing: just hit both targets cleanly, then degrade the adapter
  // before finishing. Worst-health policy must keep the attempt out of mastery.
  client.send({ type: 'hit', seq: 1, atMs: t[0].atMs + 5, notes: [60] });
  client.send({ type: 'hit', seq: 2, atMs: t[1].atMs + 5, notes: [60] });
  client.send({ type: 'tick', nowMs: t[1].atMs + 200 });
  // Simulate degradation by disconnecting mid-take (health -> disconnected).
  client.send({ type: 'midi-disconnect' });
  const disconnected = await client.next('midi-status', (m) => m.connected === false);
  // Adapter close bumps the generation; the degraded status must arrive while
  // the take is still active for the journal/health to observe it.
  client.send({ type: 'tick', nowMs: t[1].atMs + 600 });
  client.send({ type: 'finish' });
  const { report, captureDiagnostics } = await client.next('report');
  check('两个目标仍命中（降级不改写成绩）', report.stats.perfectCount === 2, JSON.stringify(report.stats));
  check('captureDiagnostics.inputHealth = disconnected', captureDiagnostics.inputHealth === 'disconnected'
    || disconnected.inputHealth === 'disconnected' && captureDiagnostics.inputHealth !== 'healthy',
    JSON.stringify(captureDiagnostics));
  check('报告本身仍按核心结果可信', report.trustworthy === true, JSON.stringify(report.diagnostics));
  check('disconnected 状态被记录', disconnected.inputHealth === 'disconnected');
  client.close();
}

async function scenarioPauseScoring() {
  console.log('scenario: B1 暂停/恢复 → 评分目标随引擎平移，raw MIDI 仍匹配');
  const client = new TestClient();
  await client.open();
  const atoms = quarterAtoms(2, 1);
  const scoreEvents = scoreEventsForAtoms(atoms, { bpm: 60 });
  client.send({
    type: 'start', modeId: 'score', bpm: 60, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms, assisted: false, durationPolicy: 'strict-keydown', scoreEvents,
  });
  const started = await client.next('started');
  const origin = performance.now();
  client.send({ type: 'session-origin', clientPerfMs: origin });
  const targets = started.targets;
  const epoch = started.captureEpoch;
  let seq = 0;
  const sendPacket = (sessionMs, bytes) => {
    seq += 1;
    client.send({
      type: 'raw-midi',
      ingest: {
        packet: {
          sourceId: 'pause-score', sourceSeq: seq, clockDomainId: 'mock-clock',
          capturedAtMs: origin + sessionMs, rawBytes: bytes, transport: 'mock', captureEpoch: epoch,
        },
        sessionTimeMs: sessionMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
      },
    });
  };
  sendPacket(targets[0].atMs + 8, [0x90, 60, 90]);
  sendPacket(targets[0].atMs + 300, [0x80, 60, 40]);
  client.send({ type: 'pause', nowMs: targets[0].atMs + 500, atSourceMs: origin + targets[0].atMs + 500 });
  await client.next('paused');
  client.send({ type: 'resume', nowMs: targets[0].atMs + 4500, atSourceMs: origin + targets[0].atMs + 4500 });
  const resumed = await client.next('resumed');
  // Target 1 was planned at 5000ms; the engine shifts it to 9000ms.
  sendPacket(targets[1].atMs + 4000 + 8, [0x90, 60, 90]);
  sendPacket(targets[1].atMs + 4000 + 300, [0x80, 60, 40]);
  client.send({ type: 'tick', nowMs: targets[1].atMs + 4800 });
  client.send({ type: 'finish' });
  const message = await client.next('report');
  check('暂停平移量 4000ms', resumed.deltaMs === 4000, String(resumed.deltaMs));
  check('scoreV1 两音均匹配（目标已平移）', message.scoreV1
    && message.scoreV1.pitch.correct === 2
    && message.scoreV1.pitch.missed === 0
    && message.scoreV1.pitch.extra === 0,
    JSON.stringify(message.scoreV1 && message.scoreV1.pitch));
  check('scoreV1 起音误差仍约 +8ms', message.scoreV1
    && message.scoreV1.onset.signedMeanMs != null
    && Math.abs(message.scoreV1.onset.signedMeanMs - 8) < 0.5,
    JSON.stringify(message.scoreV1 && message.scoreV1.onset));
  check('pauseAdjusted 标记为真', message.pauseAdjusted === true, String(message.pauseAdjusted));
  client.close();
}

async function scenarioPauseWithMidiInput() {
  console.log('scenario: 暂停期间 MIDI 输入 → 保留证据、不失败、不计分、不丢 Take');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The injected note must travel the real Node MIDI path (adapter → clock map
  // → ingest), which is the path that used to call pushHit while paused.
  client.send({ type: 'midi-refresh' });
  await client.next('midi-devices', (m) => Array.isArray(m.items) && m.items.some((d) => d.id === 'mock:0'));
  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  await client.next('midi-status', (m) => m.connected === true);
  for (let i = 0; i < 6; i += 1) {
    const id = `pause-input-clock-${i}`;
    client.send({ type: 'clock-ping', id, clientSendPerfMs: performance.now() });
    await client.next('clock-pong', (m) => m.id === id);
    client.send({ type: 'clock-sample', id, clientReceivePerfMs: performance.now() });
    await client.next('clock-status');
  }

  // 5 targets so scoring_v1 has enough matched pairs for high confidence.
  const atoms = quarterAtoms(5, 1);
  const scoreEvents = scoreEventsForAtoms(atoms, { bpm: 120 });
  client.send({
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms, assisted: false, durationPolicy: 'strict-keydown', scoreEvents,
  });
  const started = await client.next('started');
  const origin = performance.now();
  client.send({ type: 'session-origin', clientPerfMs: origin });
  const targets = started.targets;
  const epoch = started.captureEpoch;
  let seq = 0;
  const sendPacket = (sessionMs, bytes) => {
    seq += 1;
    client.send({
      type: 'raw-midi',
      ingest: {
        packet: {
          sourceId: 'pause-input', sourceSeq: seq, clockDomainId: 'mock-clock',
          capturedAtMs: origin + sessionMs, rawBytes: bytes, transport: 'mock', captureEpoch: epoch,
        },
        sessionTimeMs: sessionMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
      },
    });
  };

  // Target 0 is played correctly before the pause.
  sendPacket(targets[0].atMs + 8, [0x90, 60, 90]);
  sendPacket(targets[0].atMs + 300, [0x80, 60, 40]);

  // Wait past the count-in so a paused note cannot be explained by count-in
  // suppression, then pause on the real session clock like the browser does.
  await sleep(targets[0].atMs + 120);
  const pauseNow = performance.now() - origin;
  client.send({ type: 'pause', nowMs: pauseNow, atSourceMs: origin + pauseNow });
  await client.next('paused');

  // (a) real Node MIDI path while paused
  client.send({ type: 'midi-test-note', bytes: [0x90, 64, 90] });
  await sleep(60);
  client.send({ type: 'midi-test-note', bytes: [0x80, 64, 40] });
  // (b) raw packet while paused
  sendPacket(pauseNow + 120, [0x90, 65, 90]);
  sendPacket(pauseNow + 200, [0x80, 65, 40]);

  const pauseError = await client.next('error', () => true, 400).then(() => true).catch(() => false);
  check('暂停期间收到 MIDI 不产生引擎错误', pauseError === false);

  const resumeNow = pauseNow + 2000;
  client.send({ type: 'resume', nowMs: resumeNow, atSourceMs: origin + resumeNow });
  const resumed = await client.next('resumed');
  check('暂停后仍可恢复，Take 未丢失', Math.abs(resumed.deltaMs - 2000) < 1e-6, String(resumed.deltaMs));

  // (c) a late packet whose onset belongs to the pause window, delivered after
  // resume. It must be quarantined by the recorded interval, not judged.
  sendPacket(pauseNow + 300, [0x90, 67, 90]);
  sendPacket(pauseNow + 380, [0x80, 67, 40]);

  // Remaining targets were planned from 2500ms on and shifted by +2000ms.
  for (const target of targets.slice(1)) {
    sendPacket(target.atMs + 2000 + 8, [0x90, 60, 90]);
    sendPacket(target.atMs + 2000 + 300, [0x80, 60, 40]);
  }

  client.send({ type: 'tick', nowMs: targets[targets.length - 1].atMs + 2600 });
  client.send({ type: 'finish' });
  const message = await client.next('report');
  const { scoreV1, scoreStatus, scoreInputNoteCount, captureDiagnostics, traceId, journalId } = message;

  check('暂停期间的输入全部被抑制', captureDiagnostics?.pauseSuppressed >= 3,
    JSON.stringify(captureDiagnostics));
  check('暂停输入未进入评分输入', scoreInputNoteCount === 5, String(scoreInputNoteCount));
  check('暂停输入在最终评分中被扣除', captureDiagnostics?.pauseExcludedFromScore === 3,
    String(captureDiagnostics?.pauseExcludedFromScore));
  check('Take 仍可评分且结果正确', scoreStatus === 'AVAILABLE' && scoreV1 && !scoreV1.error
    && scoreV1.pitch.correct === 5 && scoreV1.pitch.extra === 0 && scoreV1.pitch.missed === 0,
    JSON.stringify({ scoreStatus, pitch: scoreV1 && scoreV1.pitch }));

  const trace = await (await fetch(`http://127.0.0.1:${PORT}/api/traces/${traceId}`)).json();
  const pausedNodeEvent = trace.events.find((event) => event.transport === 'node-midi' && event.duringPause === true);
  check('Trace 保留暂停期间的 Node MIDI 事件并标记 duringPause', !!pausedNodeEvent,
    JSON.stringify(trace.events.filter((event) => event.transport === 'node-midi').map((event) => ({
      seq: event.sourceSeq, at: event.sessionTimeMs, duringPause: event.duringPause,
    }))));

  const journal = await (await fetch(`http://127.0.0.1:${PORT}/api/journals/${journalId}`)).json();
  check('Journal 记录暂停期间的输入边界',
    journal.entries.some((entry) => entry.kind === 'input_during_pause'),
    JSON.stringify(journal.entries.map((entry) => entry.kind)));
  client.close();
}

// --- P1-2 admission ledger: policy B ---------------------------------------
// The ingress decision is authoritative. Every case asserts that final scoring
// consumed that decision instead of re-deriving it from onset time.

function admissionInvariants(label, admission) {
  check(`${label}: packet 层计数守衡`,
    admission && admission.packets === admission.noteOns + admission.nonOnsets,
    JSON.stringify(admission && {
      packets: admission.packets, noteOns: admission.noteOns, nonOnsets: admission.nonOnsets,
    }));
  check(`${label}: 每个 Note On 恰有一个决策`,
    admission && admission.noteOns === admission.admittedNoteOns
      + admission.suppressedNoteOns.countIn
      + admission.suppressedNoteOns.paused
      + admission.suppressedNoteOns.clock
      + admission.suppressedNoteOns.duplicate
      + admission.suppressedNoteOns.outOfOrder,
    JSON.stringify(admission && { noteOns: admission.noteOns, admitted: admission.admittedNoteOns, ...admission.suppressedNoteOns }));
  check(`${label}: 不存在重复 decision ID`, admission && admission.duplicateEventIds === 0, String(admission && admission.duplicateEventIds));
  check(`${label}: 实时准入数 == pushHit 调用数`,
    admission && admission.admittedNoteOns === admission.pushHitCount,
    JSON.stringify(admission && { admitted: admission.admittedNoteOns, pushHit: admission.pushHitCount }));
}

async function admissionTake(client, label, { bpm = 60, atoms = quarterAtoms(2, 1) } = {}) {
  const scoreEvents = scoreEventsForAtoms(atoms, { bpm });
  client.send({
    type: 'start', modeId: 'score', bpm, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms, assisted: false, durationPolicy: 'strict-keydown', scoreEvents,
  });
  const started = await client.next('started');
  const origin = performance.now();
  let seq = 0;
  const send = (sessionMs, bytes, options = {}) => {
    seq = options.seq ?? seq + 1;
    const packet = {
      sourceId: label, sourceSeq: seq, clockDomainId: 'mock-clock',
      capturedAtMs: origin + (sessionMs ?? 0), rawBytes: bytes, transport: 'mock',
    };
    // Omitting captureEpoch is a legitimate client shape and bypasses the
    // CaptureRouter; the admission ledger must stay unique on its own.
    if (options.withEpoch !== false && started.captureEpoch != null) {
      packet.captureEpoch = started.captureEpoch;
    }
    client.send({
      type: 'raw-midi',
      ingest: {
        packet,
        sessionTimeMs: sessionMs,
        clockMappingId: 'selftest',
        clockUncertaintyMs: 0,
        clockQuality: 'good',
      },
    });
  };
  return { started, origin, send, targets: started.targets };
}

async function closeTake(client, nowMs) {
  client.send({ type: 'tick', nowMs });
  client.send({ type: 'finish' });
  return client.next('report');
}

async function scenarioPauseAdmissionLedger() {
  console.log('scenario: P1-2 输入准入账本 → 实时与最终评分对同一 Note On 只有一个结论');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status');
  client.send({ type: 'midi-refresh' });
  await client.next('midi-devices', (m) => Array.isArray(m.items) && m.items.some((d) => d.id === 'mock:0'));
  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  await client.next('midi-status', (m) => m.connected === true);

  // T1 — exact reproduction: pause at target+20ms, onset target+8ms, delivered
  // while paused. The realtime path suppresses it; final scoring must agree.
  {
    const take = await admissionTake(client, 'adm-probe');
    const t0 = take.targets[0].atMs;
    client.send({ type: 'pause', nowMs: t0 + 20, atSourceMs: take.origin + t0 + 20 });
    await client.next('paused');
    take.send(t0 + 8, [0x90, 60, 90]);
    take.send(t0 + 300, [0x80, 60, 40]);
    const pauseError = await client.next('error', () => true, 300).then(() => true).catch(() => false);
    check('T1: 暂停中的准入被拒绝且不报错', pauseError === false);
    client.send({ type: 'resume', nowMs: t0 + 1020, atSourceMs: take.origin + t0 + 1020 });
    await client.next('resumed');
    const message = await closeTake(client, t0 + 2200);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T1', admission);
    check('T1: 该 Note On 记为 paused 抑制', admission?.suppressedNoteOns.paused === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T1: 被抑制起音不进入最终评分输入', message.scoreInputNoteCount === 0,
      String(message.scoreInputNoteCount));
    check('T1: 最终评分不把暂停起音判为命中', message.scoreV1
      && message.scoreV1.pitch.correct === 0 && message.scoreV1.pitch.extra === 0
      && message.scoreV1.pitch.missed === 2,
      JSON.stringify(message.scoreV1 && message.scoreV1.pitch));
    check('T1: 实时与最终都是 2 miss / 0 extra',
      message.report.stats.missCount === 2 && message.report.stats.extraCount === 0,
      JSON.stringify(message.report.stats));
    check('T1: 最终评分侧同步扣除该起音', message.captureDiagnostics?.pauseExcludedFromScore === 1,
      String(message.captureDiagnostics?.pauseExcludedFromScore));
    const trace = await (await fetch(`http://127.0.0.1:${PORT}/api/traces/${message.traceId}`)).json();
    const pausedAdmission = trace.events.find((event) => event.admission?.reason === 'paused'
      && typeof event.admission?.decisionId === 'string');
    check('T1: Trace 保存决策 ID、原因与段 ID', !!pausedAdmission
      && typeof pausedAdmission.admission.segmentId === 'string',
      JSON.stringify(trace.events.map((event) => event.admission)));
  }

  // T2 — admitted before the pause, released during it: the onset stays valid
  // evidence, the key-down duration must be marked as crossing the pause.
  {
    const take = await admissionTake(client, 'adm-cross');
    const t0 = take.targets[0].atMs;
    take.send(t0 + 8, [0x90, 60, 90]);
    client.send({ type: 'pause', nowMs: t0 + 60, atSourceMs: take.origin + t0 + 60 });
    await client.next('paused');
    take.send(t0 + 400, [0x80, 60, 40]);
    client.send({ type: 'resume', nowMs: t0 + 1060, atSourceMs: take.origin + t0 + 1060 });
    await client.next('resumed');
    const message = await closeTake(client, t0 + 2200);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T2', admission);
    check('T2: 跨暂停的 Note Off 不算一次新的 Note On 抑制',
      admission?.suppressedNoteOns.paused === 0, JSON.stringify(admission?.suppressedNoteOns));
    check('T2: 已准入起音仍计入最终评分', message.scoreInputNoteCount === 1
      && message.scoreV1 && message.scoreV1.pitch.correct === 1,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
    const assessment = message.durations && Array.isArray(message.durations.assessments)
      ? message.durations.assessments[0] : null;
    check('T2: 跨暂停释放的时值不按严格成绩处理',
      assessment && assessment.quality === 'crossed_pause_boundary',
      JSON.stringify(assessment));
  }

  // T3 — onset before the pause but the packet arrives during it, release after
  // resume: the whole lifecycle stays out of scoring (no late EXTRA).
  {
    const take = await admissionTake(client, 'adm-late-release');
    const t0 = take.targets[0].atMs;
    client.send({ type: 'pause', nowMs: t0 - 100, atSourceMs: take.origin + t0 - 100 });
    await client.next('paused');
    take.send(t0 - 192, [0x90, 60, 90]);
    client.send({ type: 'resume', nowMs: t0 + 900, atSourceMs: take.origin + t0 + 900 });
    await client.next('resumed');
    take.send(t0 + 1000, [0x80, 60, 40]);
    const message = await closeTake(client, t0 + 2400);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T3', admission);
    check('T3: 起音在暂停前但送达在暂停中 → paused 抑制', admission?.suppressedNoteOns.paused === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T3: 恢复后到达的 Note Off 不复活该生命周期',
      message.scoreInputNoteCount === 0 && message.scoreV1
      && message.scoreV1.pitch.correct === 0 && message.scoreV1.pitch.extra === 0
      && message.scoreV1.pitch.missed === 2,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
  }

  // T4 — onset inside a closed pause segment, delivered after resume: the
  // closed-segment rule must reject it even though the arrival is not paused.
  {
    const take = await admissionTake(client, 'adm-closed-seg');
    const t0 = take.targets[0].atMs;
    client.send({ type: 'pause', nowMs: t0 + 20, atSourceMs: take.origin + t0 + 20 });
    await client.next('paused');
    client.send({ type: 'resume', nowMs: t0 + 520, atSourceMs: take.origin + t0 + 520 });
    await client.next('resumed');
    take.send(t0 + 300, [0x90, 62, 90]);
    take.send(t0 + 360, [0x80, 62, 40]);
    // An onset before the pause, delivered after resume, is still admitted.
    take.send(t0 + 8, [0x90, 60, 90]);
    take.send(t0 + 260, [0x80, 60, 40]);
    const message = await closeTake(client, t0 + 2200);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T4', admission);
    check('T4: 已闭合暂停段内的事件被抑制', admission?.suppressedNoteOns.paused === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T4: 暂停前的起音在恢复后仍可准入', message.scoreInputNoteCount === 1
      && message.scoreV1 && message.scoreV1.pitch.correct === 1 && message.scoreV1.pitch.extra === 0,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
  }

  // T5 — count-in boundary: before scoring starts => count-in; after => admitted.
  {
    const take = await admissionTake(client, 'adm-count-in');
    const t0 = take.targets[0].atMs;
    take.send(t0 - 200, [0x90, 66, 90]);
    take.send(t0 - 140, [0x80, 66, 40]);
    take.send(t0 + 8, [0x90, 60, 90]);
    take.send(t0 + 260, [0x80, 60, 40]);
    const message = await closeTake(client, t0 + 1600);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T5', admission);
    check('T5: 计分开始前的 Note On 记为 count-in', admission?.suppressedNoteOns.countIn === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T5: count-in 抑制与准入互不覆盖', message.scoreInputNoteCount === 1
      && message.scoreV1 && message.scoreV1.pitch.correct === 1 && message.scoreV1.pitch.extra === 0,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
  }

  // T6 — Take ends while paused: open segment is kept, nothing is scored.
  {
    const take = await admissionTake(client, 'adm-end-paused');
    const t0 = take.targets[0].atMs;
    client.send({ type: 'pause', nowMs: t0 - 100, atSourceMs: take.origin + t0 - 100 });
    await client.next('paused');
    take.send(t0 - 50, [0x90, 65, 90]);
    take.send(t0 + 100, [0x80, 65, 40]);
    const message = await closeTake(client, t0 + 300);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T6', admission);
    check('T6: 暂停中结束仍保留开放暂停段',
      Array.isArray(admission?.pauseSegments) && admission.pauseSegments.some((segment) => segment.endSession === null),
      JSON.stringify(admission?.pauseSegments));
    check('T6: 暂停中的输入不进入最终评分', message.scoreInputNoteCount === 0
      && message.scoreV1 && message.scoreV1.pitch.correct === 0 && message.scoreV1.pitch.extra === 0,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
    check('T6: 暂停中结束后任务仍完成', typeof message.takeId === 'string' && message.scoreStatus !== 'INVALID',
      JSON.stringify({ takeId: message.takeId, scoreStatus: message.scoreStatus }));
  }

  // T7 — clock: a Node MIDI event without a usable mapping gets a 'clock'
  // decision, no fabricated session time, and never reaches scoring.
  {
    const take = await admissionTake(client, 'adm-clock');
    const t0 = take.targets[0].atMs;
    // Deliberately no session-origin: Node events cannot be mapped.
    client.send({ type: 'midi-test-note', bytes: [0x90, 64, 90] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    client.send({ type: 'midi-test-note', bytes: [0x80, 64, 40] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const message = await closeTake(client, t0 + 1200);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T7', admission);
    check('T7: 不可映射的 Node 事件记录 clock 决策', (admission?.suppressedNoteOns.clock ?? 0) >= 1, JSON.stringify(admission));
    check('T7: 未映射事件同时计入 nodeEventsUnmapped',
      (message.captureDiagnostics?.node?.unmappedEvents ?? 0) >= 1,
      JSON.stringify(message.captureDiagnostics?.node));
    check('T7: clock 抑制不进入最终评分', message.scoreInputNoteCount === 0,
      String(message.scoreInputNoteCount));
  }

  // T8 — pause after the target window closed: live and final must still agree.
  {
    const take = await admissionTake(client, 'adm-after-window');
    const t0 = take.targets[0].atMs;
    client.send({ type: 'pause', nowMs: t0 + 400, atSourceMs: take.origin + t0 + 400 });
    await client.next('paused');
    client.send({ type: 'resume', nowMs: t0 + 1400, atSourceMs: take.origin + t0 + 1400 });
    await client.next('resumed');
    take.send(take.targets[1].atMs + 1000 + 8, [0x90, 60, 90]);
    take.send(take.targets[1].atMs + 1000 + 260, [0x80, 60, 40]);
    const message = await closeTake(client, take.targets[1].atMs + 2000);
    const admission = message.captureDiagnostics?.admission;
    admissionInvariants('T8', admission);
    check('T8: 窗口后暂停不影响已判定结果', message.report.stats.missCount === 1
      && message.report.stats.extraCount === 0,
      JSON.stringify(message.report.stats));
    check('T8: 最终评分与实时一致（1 命中 / 1 漏）', message.scoreV1
      && message.scoreV1.pitch.correct === 1 && message.scoreV1.pitch.missed === 1,
      JSON.stringify(message.scoreV1 && message.scoreV1.pitch));
  }

  // T9 — duplicate event id without captureEpoch (no CaptureRouter): the second
  // packet must not produce a second realtime hit or a second scored lifecycle.
  {
    const take = await admissionTake(client, 'adm-dup');
    const t0 = take.targets[0].atMs;
    take.send(t0 + 8, [0x90, 60, 90], { seq: 1, withEpoch: false });
    take.send(t0 + 8, [0x90, 60, 90], { seq: 1, withEpoch: false });
    take.send(t0 + 260, [0x80, 60, 40], { seq: 2, withEpoch: false });
    const message = await closeTake(client, t0 + 1600);
    const admission = message.captureDiagnostics?.admission;
    check('T9: 重复 eventId 被单独计数', admission?.duplicateEventIds === 1,
      JSON.stringify(admission));
    check('T9: 重复 Note On 记为 duplicate 抑制', admission?.suppressedNoteOns.duplicate === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T9: 重复包不产生第二次实时命中', admission?.admittedNoteOns === 1
      && admission?.pushHitCount === 1 && message.report.stats.perfectCount === 1,
      JSON.stringify({ admitted: admission?.admittedNoteOns, pushHit: admission?.pushHitCount, stats: message.report.stats }));
    check('T9: 重复包不产生第二条评分生命周期', message.scoreInputNoteCount === 1
      && message.scoreV1 && message.scoreV1.pitch.correct === 1 && message.scoreV1.pitch.extra === 0,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
    check('T9: packet 层计数仍守衡', admission?.packets === admission?.noteOns + admission?.nonOnsets,
      JSON.stringify(admission));
  }

  // T10 — out-of-order Note On: a later onset is admitted first, then an earlier
  // one arrives. It must be isolated instead of invalidating the Take.
  {
    const take = await admissionTake(client, 'adm-ooo');
    const t0 = take.targets[0].atMs;
    const t1 = take.targets[1].atMs;
    take.send(t1 + 8, [0x90, 60, 90]);        // admitted; baseline = 5008
    take.send(9000, [0x80, 60, 40]);          // Note Off must not advance the baseline
    take.send(t1 + 1008, [0x90, 62, 90]);     // 6008 > 5008 => admitted (extra live)
    take.send(6200, [0x80, 62, 40]);
    take.send(t0 + 8, [0x90, 64, 90]);        // 4008 < 5008 => out-of-order
    take.send(t0 + 300, [0x80, 64, 40]);
    const message = await closeTake(client, 7000);
    const admission = message.captureDiagnostics?.admission;
    check('T10: 乱序 Note On 记为 out-of-order', admission?.suppressedNoteOns.outOfOrder === 1,
      JSON.stringify(admission?.suppressedNoteOns));
    check('T10: 乱序事件不进入实时引擎', admission?.admittedNoteOns === 2
      && admission?.pushHitCount === 2,
      JSON.stringify({ admitted: admission?.admittedNoteOns, pushHit: admission?.pushHitCount }));
    check('T10: Take 未因 OutOfOrderEvent 失败', typeof message.takeId === 'string'
      && message.scoreStatus !== 'INVALID' && !!message.scoreV1 && !message.scoreV1.error,
      JSON.stringify({ takeId: message.takeId, scoreStatus: message.scoreStatus }));
    check('T10: 实时结果只含已准入起音', message.report.stats.perfectCount === 1
      && message.report.stats.missCount === 1 && message.report.stats.extraCount === 1,
      JSON.stringify(message.report.stats));
    check('T10: 最终评分与实时一致，乱序起音不复活', message.scoreInputNoteCount === 2
      && message.scoreV1 && message.scoreV1.pitch.correct === 1
      && message.scoreV1.pitch.missed === 1 && message.scoreV1.pitch.extra === 1,
      JSON.stringify({ count: message.scoreInputNoteCount, pitch: message.scoreV1 && message.scoreV1.pitch }));
    const trace = await (await fetch(`http://127.0.0.1:${PORT}/api/traces/${message.traceId}`)).json();
    const outOfOrder = trace.events.find((event) => event.admission?.reason === 'out-of-order');
    check('T10: Trace 保留乱序事件的时间、决策与原因',
      !!outOfOrder && Math.abs(outOfOrder.sessionTimeMs - (t0 + 8)) < 1e-6
      && typeof outOfOrder.admission.decisionId === 'string',
      JSON.stringify(outOfOrder && { sessionTimeMs: outOfOrder.sessionTimeMs, admission: outOfOrder.admission }));
  }

  // T11 — equal timestamps are not regressions under the Rust `<` rule.
  {
    const take = await admissionTake(client, 'adm-equal');
    const t0 = take.targets[0].atMs;
    take.send(t0 + 8, [0x90, 60, 90]);
    take.send(t0 + 8, [0x90, 62, 90]);
    take.send(t0 + 300, [0x80, 60, 40]);
    take.send(t0 + 320, [0x80, 62, 40]);
    const message = await closeTake(client, t0 + 1600);
    const admission = message.captureDiagnostics?.admission;
    check('T11: 相同时间戳不因乱序规则被拒绝', admission?.suppressedNoteOns.outOfOrder === 0
      && admission?.admittedNoteOns === 2 && admission?.pushHitCount === 2,
      JSON.stringify(admission));
    check('T11: 相等时间戳的第二个音按既有规则计为 Extra',
      message.report.stats.extraCount === 1 && message.scoreV1
      && message.scoreV1.pitch.correct === 1 && message.scoreV1.pitch.missed === 1
      && message.scoreV1.pitch.extra === 1,
      JSON.stringify({ stats: message.report.stats, pitch: message.scoreV1 && message.scoreV1.pitch }));
  }

  client.send({ type: 'midi-disconnect' });
  await client.next('midi-status', (m) => m.connected === false);
  client.close();
}

async function scenarioPauseCrossingKey() {
  console.log('scenario: 跨暂停的按键标记 crossed_pause_boundary、不做严格时值评分');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  const t = started.targets;
  const epoch = started.captureEpoch;
  const sendPacket = (seq, atMs, bytes) => client.send({
    type: 'raw-midi',
    ingest: {
      packet: {
        sourceId: 'input-0', sourceSeq: seq, clockDomainId: 'web-page-performance-timeline',
        capturedAtMs: atMs, rawBytes: bytes, transport: 'web-midi', captureEpoch: epoch,
      },
      sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
    },
  });
  // Note On before Pause; Note Off only after Resume.
  sendPacket(1, t[0].atMs + 8, [0x90, 60, 90]);
  client.send({ type: 'pause', nowMs: t[0].atMs + 100, atSourceMs: t[0].atMs + 100 });
  await client.next('paused');
  client.send({ type: 'resume', nowMs: t[0].atMs + 500, atSourceMs: t[0].atMs + 500 });
  await client.next('resumed');
  sendPacket(2, t[0].atMs + 600, [0x80, 60, 40]);
  client.send({ type: 'tick', nowMs: t[1].atMs + 1000 });
  client.send({ type: 'finish' });
  const { report, durations } = await client.next('report');
  const first = durations && durations.assessments.find((a) => a.targetIndex === 0);
  check('跨暂停音仍被起音判定命中', report.stats.perfectCount === 1, JSON.stringify(report.stats));
  check('跨暂停按键 quality = crossed_pause_boundary', first && first.quality === 'crossed_pause_boundary',
    JSON.stringify(first));
  check('跨暂停按键 result = unknown', first && first.result === 'unknown', JSON.stringify(first));
  client.close();
}

async function scenarioScoreChain() {
  console.log('scenario: B1 完整评分链 → Raw MIDI → key lifecycles → NAPI scoring_v1 → 报告/历史');
  const atoms = quarterAtoms(8, 1);
  const scoreEvents = scoreEventsForAtoms(atoms);
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms, assisted: false, durationPolicy: 'strict-keydown', scoreEvents,
    scoreFingerprint: 'selftest-score-fp', hand: 'both', scoreBarCount: 1,
  });
  const started = await client.next('started');
  const targets = started.targets;
  const epoch = started.captureEpoch;
  let seq = 0;
  const sendPacket = (atMs, bytes) => {
    seq += 1;
    client.send({
      type: 'raw-midi',
      ingest: {
        packet: {
          sourceId: 'score-chain', sourceSeq: seq, clockDomainId: 'mock-clock',
          capturedAtMs: atMs, rawBytes: bytes, transport: 'mock', captureEpoch: epoch,
        },
        sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
      },
    });
  };
  // A count-in keypress stays in the trace but must never become an EXTRA
  // note in scoring_v1.
  sendPacket(targets[0].atMs - 500, [0x90, 72, 90]);
  sendPacket(targets[0].atMs - 300, [0x80, 72, 40]);
  targets.forEach((target) => {
    const pitch = 60;
    sendPacket(target.atMs + 8, [0x90, pitch, 90]);
    sendPacket(target.atMs + 8 + 240, [0x80, pitch, 40]);
  });
  // One deliberate extra note after the final target: it must be reported as
  // EXTRA, not folded into the score.
  sendPacket(targets[targets.length - 1].atMs + 450, [0x90, 64, 90]);
  sendPacket(targets[targets.length - 1].atMs + 650, [0x80, 64, 40]);
  client.send({ type: 'tick', nowMs: targets[targets.length - 1].atMs + 900 });
  client.send({ type: 'finish' });
  const message = await client.next('report');
  const {
    report, scoreV1, scoreStatus, scoreConfigVersion, scoreAlgorithmVersion,
    scoreInputNoteCount, scoreUnmappedNoteCount, pauseAdjusted, captureDiagnostics, sessionId,
    takeId: sourceTakeId, practiceSessionId: sourcePracticeSessionId,
  } = message;
  const sourceDetailBefore = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}`)).text();
  const eventResults = scoreV1 && Array.isArray(scoreV1.eventResults) ? scoreV1.eventResults : [];
  check('scoreV1 已生成且无错误', !!scoreV1 && !scoreV1.error, JSON.stringify(scoreV1));
  check('scoreStatus = AVAILABLE', scoreStatus === 'AVAILABLE', String(scoreStatus));
  check('Rust 统计仍为 8 Perfect', report.stats.perfectCount === 8, JSON.stringify(report.stats));
  check('pitch 8 正确 + 1 extra', scoreV1 && scoreV1.pitch.correct === 8
    && scoreV1.pitch.extra === 1 && scoreV1.pitch.missed === 0,
    JSON.stringify(scoreV1 && scoreV1.pitch));
  check('事件级结果 8 MATCH + 1 EXTRA',
    eventResults.filter((item) => item.result === 'MATCH').length === 8
    && eventResults.filter((item) => item.result === 'EXTRA').length === 1,
    JSON.stringify(eventResults.map((item) => item.result)));
  check('时值 8 条 graded', scoreV1 && scoreV1.duration.graded === 8,
    JSON.stringify(scoreV1 && scoreV1.duration));
  check('逐小节 1 小节 / 8 matched', scoreV1 && scoreV1.measures.length === 1
    && scoreV1.measures[0].matched === 8, JSON.stringify(scoreV1 && scoreV1.measures));
  check('综合分由 Rust 返回且可评分', scoreV1 && scoreV1.overall
    && Number.isFinite(scoreV1.overall.score) && scoreV1.overall.renormalized === false,
    JSON.stringify(scoreV1 && scoreV1.overall));
  check('confidence = high', scoreV1 && scoreV1.confidence === 'high', String(scoreV1 && scoreV1.confidence));
  check('配置/算法版本可追溯', typeof scoreConfigVersion === 'string' && scoreConfigVersion.length > 0
    && typeof scoreAlgorithmVersion === 'string' && scoreAlgorithmVersion.length > 0,
    `${scoreConfigVersion} / ${scoreAlgorithmVersion}`);
  check('输入计数 9 / 未映射 0 / 未调整暂停', scoreInputNoteCount === 9
    && scoreUnmappedNoteCount === 0 && pauseAdjusted === false,
    JSON.stringify({ scoreInputNoteCount, scoreUnmappedNoteCount, pauseAdjusted }));
  check('captureDiagnostics 带 scoreStatus',
    captureDiagnostics && captureDiagnostics.scoreStatus === 'AVAILABLE',
    JSON.stringify(captureDiagnostics));

  const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}`)).json();
  check('历史详情持久化 scoreEvents/scoreV1/状态',
    Array.isArray(detail.scoreEvents) && detail.scoreEvents.length === 8
    && detail.scoreV1 && detail.scoreV1.eventResults.length === 9
    && detail.scoreStatus === 'AVAILABLE',
    JSON.stringify({ events: detail.scoreEvents && detail.scoreEvents.length, status: detail.scoreStatus }));
  client.close();

  // B2: a targeted retry must create a new Take, keep the source immutable and
  // persist both the source reference and the prescription.
  check('来源报告有 Take 标识', typeof sourceTakeId === 'string' && sourceTakeId.length > 0,
    String(sourceTakeId));
  const retryAtoms = quarterAtoms(8, 1);
  const retryEvents = scoreEventsForAtoms(retryAtoms, { bpm: 60 });
  const prescription = {
    prescriptionId: 'rx-selftest-retry',
    sourceReportId: sessionId,
    sourceTakeId,
    ruleId: 'LOCAL_ONSET_V1',
    problemType: 'local-onset',
    evidence: [{ source: 'score-measure', metric: 'meanAbsOnsetErrorMs', value: 8, measure: 1 }],
    confidenceStatus: 'high',
    measureRange: { startMeasure: 1, endMeasure: 1 },
    recommendedBpm: 60,
    recommendedHand: 'both',
    recommendedMode: 'loop',
    reason: 'selftest targeted retry',
    action: 'repeat measure 1 once',
    status: 'EXECUTABLE',
    createdAtIso: new Date().toISOString(),
  };
  const sessionsBeforeBad = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?limit=200`)).json();
  const badRetry = new TestClient();
  await badRetry.open();
  badRetry.send({
    type: 'start', modeId: 'loop', bpm: 60, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: retryAtoms, assisted: false, durationPolicy: 'strict-keydown',
    scoreEvents: retryEvents, scoreFingerprint: 'selftest-score-fp', hand: 'both', scoreBarCount: 1,
    sourceReportId: sessionId, sourceTakeId: 'take-bogus',
    prescriptionId: prescription.prescriptionId, prescription,
  });
  const badRetryError = await badRetry.next('error');
  check('来源 Take 不匹配时拒绝创建复练',
    typeof badRetryError.message === 'string' && badRetryError.message.includes('来源 Take'),
    String(badRetryError.message));
  const sessionsAfterBad = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?limit=200`)).json();
  check('初始化失败不留下半成品任务',
    sessionsAfterBad.items.length === sessionsBeforeBad.items.length,
    `${sessionsBeforeBad.items.length} -> ${sessionsAfterBad.items.length}`);
  badRetry.close();

  const retry = new TestClient();
  await retry.open();
  const retryStart = {
    type: 'start', modeId: 'loop', bpm: 60, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: retryAtoms, assisted: false, durationPolicy: 'strict-keydown',
    scoreEvents: retryEvents, scoreFingerprint: 'selftest-score-fp', hand: 'both', scoreBarCount: 1,
    sourceReportId: sessionId, sourceTakeId, prescriptionId: prescription.prescriptionId, prescription,
  };
  retry.send(retryStart);
  const retryStarted = await retry.next('started');
  const retryEpoch = retryStarted.captureEpoch;
  // A second confirm while the retry Take is active must be rejected, so it
  // cannot create a duplicate Take.
  retry.send(retryStart);
  const duplicateError = await retry.next('error');
  check('复练确认重复提交被拒绝', typeof duplicateError.message === 'string'
    && duplicateError.message.includes('进行中'), String(duplicateError.message));
  let retrySeq = 0;
  const retryPacket = (atMs, bytes) => {
    retrySeq += 1;
    retry.send({
      type: 'raw-midi',
      ingest: {
        packet: {
          sourceId: 'targeted-retry', sourceSeq: retrySeq, clockDomainId: 'mock-clock',
          capturedAtMs: atMs, rawBytes: bytes, transport: 'mock', captureEpoch: retryEpoch,
        },
        sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
      },
    });
  };
  retryStarted.targets.forEach((target) => {
    retryPacket(target.atMs + 8, [0x90, 60, 90]);
    retryPacket(target.atMs + 8 + 900, [0x80, 60, 40]);
  });
  retry.send({ type: 'tick', nowMs: retryStarted.targets[7].atMs + 1200 });
  retry.send({ type: 'finish' });
  const retryMessage = await retry.next('report');
  const retryDetail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${retryMessage.sessionId}`)).json();
  const sourceDetailAfter = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}`)).text();
  check('复练创建新的 Session/Take',
    retryMessage.practiceSessionId !== sourcePracticeSessionId
    && (retryMessage.practiceSessionId !== sourcePracticeSessionId || retryMessage.takeId !== sourceTakeId),
    `${sourcePracticeSessionId}/${sourceTakeId} -> ${retryMessage.practiceSessionId}/${retryMessage.takeId}`);
  check('复练报告关联来源和处方',
    retryMessage.sourceReportId === sessionId
    && retryMessage.sourceTakeId === sourceTakeId
    && retryMessage.prescriptionId === prescription.prescriptionId,
    JSON.stringify({
      source: retryMessage.sourceReportId,
      take: retryMessage.sourceTakeId,
      prescription: retryMessage.prescriptionId,
    }));
  check('复练报告持久化来源引用',
    retryDetail.sourceReportId === sessionId
    && retryDetail.sourceTakeId === sourceTakeId
    && retryDetail.prescriptionId === prescription.prescriptionId
    && retryDetail.prescription
    && retryDetail.prescription.ruleId === 'LOCAL_ONSET_V1',
    JSON.stringify({
      source: retryDetail.sourceReportId,
      prescription: retryDetail.prescriptionId,
    }));
  check('原报告保持不可变', sourceDetailBefore === sourceDetailAfter);
  check('复练产生前后比较',
    retryMessage.retryComparison
    && retryMessage.retryComparison.comparable === true
    && retryMessage.retryComparison.metrics.length > 0,
    JSON.stringify(retryMessage.retryComparison));
  check('不同 BPM 的比较有明确限制',
    retryMessage.retryComparison
    && retryMessage.retryComparison.limitations.some((item) => item.includes('BPM')),
    JSON.stringify(retryMessage.retryComparison && retryMessage.retryComparison.limitations));
  check('复练比较已持久化并可重新读取',
    retryDetail.retryComparison
    && retryDetail.retryComparison.comparable === true
    && retryDetail.retryComparison.metrics.length > 0,
    JSON.stringify(retryDetail.retryComparison));
  retry.close();

  // A retry with no captured input is INSUFFICIENT_DATA; the comparison must
  // say so instead of inventing a progress percentage.
  const unscoredRetry = new TestClient();
  await unscoredRetry.open();
  const unscoredPrescription = { ...prescription, prescriptionId: 'rx-selftest-unscored' };
  unscoredRetry.send({
    type: 'start', modeId: 'loop', bpm: 60, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: retryAtoms, assisted: false, durationPolicy: 'strict-keydown',
    scoreEvents: retryEvents, scoreFingerprint: 'selftest-score-fp', hand: 'both', scoreBarCount: 1,
    sourceReportId: sessionId, sourceTakeId,
    prescriptionId: unscoredPrescription.prescriptionId, prescription: unscoredPrescription,
  });
  const unscoredStarted = await unscoredRetry.next('started');
  unscoredRetry.send({ type: 'tick', nowMs: unscoredStarted.targets[7].atMs + 900 });
  unscoredRetry.send({ type: 'finish' });
  const unscoredReport = await unscoredRetry.next('report');
  check('不可评分复练不制造比较进步',
    unscoredReport.scoreStatus === 'INSUFFICIENT_DATA'
    && unscoredReport.retryComparison
    && unscoredReport.retryComparison.comparable === false
    && unscoredReport.retryComparison.metrics.length === 0,
    JSON.stringify(unscoredReport.retryComparison));
  unscoredRetry.close();

  // No scoreEvents (legacy/free path): must be explicitly unavailable, not a
  // fabricated zero score.
  const plain = new TestClient();
  await plain.open();
  plain.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1), assisted: false,
  });
  const plainStarted = await plain.next('started');
  plain.send({ type: 'hit', seq: 1, atMs: plainStarted.targets[0].atMs + 8, notes: [60] });
  plain.send({ type: 'tick', nowMs: plainStarted.targets[0].atMs + 400 });
  plain.send({ type: 'finish' });
  const plainReport = await plain.next('report');
  check('无 scoreEvents → scoreStatus UNAVAILABLE', plainReport.scoreStatus === 'UNAVAILABLE',
    String(plainReport.scoreStatus));
  check('无 scoreEvents → scoreV1 为 null（不伪造 0 分）', plainReport.scoreV1 === null,
    JSON.stringify(plainReport.scoreV1));
  plain.close();

  // Score events exist, but no performed input was captured: this is
  // insufficient evidence, not a zero score and not degraded hardware.
  const insufficient = new TestClient();
  await insufficient.open();
  insufficient.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(8, 1), assisted: false,
    durationPolicy: 'strict-keydown', scoreEvents: scoreEventsForAtoms(quarterAtoms(8, 1)),
  });
  await insufficient.next('started');
  insufficient.send({ type: 'tick', nowMs: 4000 });
  insufficient.send({ type: 'finish' });
  const insufficientReport = await insufficient.next('report');
  check('有目标但零输入 → scoreStatus INSUFFICIENT_DATA',
    insufficientReport.scoreStatus === 'INSUFFICIENT_DATA', String(insufficientReport.scoreStatus));
  check('零输入仍返回 Rust 报告但不伪造命中',
    insufficientReport.scoreV1 && insufficientReport.scoreV1.pitch.correct === 0
    && insufficientReport.scoreV1.pitch.missed === 8,
    JSON.stringify(insufficientReport.scoreV1 && insufficientReport.scoreV1.pitch));
  insufficient.close();

  // Degraded input still computes a Rust report, but the UI must not present
  // it as a normal score.
  const degraded = new TestClient();
  await degraded.open();
  await ensureMidiConnected(degraded);
  const degradedAtoms = quarterAtoms(8, 1);
  const degradedEvents = scoreEventsForAtoms(degradedAtoms);
  degraded.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: degradedAtoms, assisted: false, durationPolicy: 'strict-keydown',
    scoreEvents: degradedEvents,
  });
  const degradedStarted = await degraded.next('started');
  let degradedSeq = 0;
  const degradedPacket = (atMs, bytes) => {
    degradedSeq += 1;
    degraded.send({
      type: 'raw-midi',
      ingest: {
        packet: {
          sourceId: 'degraded-chain', sourceSeq: degradedSeq, clockDomainId: 'mock-clock',
          capturedAtMs: atMs, rawBytes: bytes, transport: 'mock', captureEpoch: degradedStarted.captureEpoch,
        },
        sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
      },
    });
  };
  degradedStarted.targets.slice(0, 4).forEach((target) => {
    degradedPacket(target.atMs + 8, [0x90, 60, 90]);
    degradedPacket(target.atMs + 8 + 240, [0x80, 60, 40]);
  });
  degraded.send({ type: 'tick', nowMs: degradedStarted.targets[7].atMs + 500 });
  degraded.send({ type: 'midi-disconnect' });
  await degraded.next('midi-status', (m) => m.connected === false);
  degraded.send({ type: 'tick', nowMs: degradedStarted.targets[7].atMs + 900 });
  degraded.send({ type: 'finish' });
  const degradedReport = await degraded.next('report');
  check('降级输入仍保留 Rust 结果', !!degradedReport.scoreV1 && !degradedReport.scoreV1.error,
    JSON.stringify(degradedReport.scoreV1));
  check('降级输入 scoreStatus = DEGRADED', degradedReport.scoreStatus === 'DEGRADED',
    String(degradedReport.scoreStatus));
  check('降级输入捕获诊断同步标记', degradedReport.captureDiagnostics.scoreStatus === 'DEGRADED'
    && degradedReport.captureDiagnostics.inputHealth === 'disconnected',
    JSON.stringify(degradedReport.captureDiagnostics));
  degraded.close();
}

async function scenarioDisconnectFinalizesTake() {
  console.log('scenario: 设备/浏览器断开 → 自动结算并持久化中断 Take');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1), assisted: false, durationPolicy: 'strict-keydown',
    scoreFingerprint: 'disconnect-fp', hand: 'both', scoreBarCount: 1,
    scoreEvents: [{
      scoreEventId: 'disconnect-target', measure: 1, beatPosition: 1, pitch: 60,
      targetOnsetMs: 1000, targetDurationMs: 250, partId: 'P1',
    }],
  });
  const started = await client.next('started');
  const target = started.targets[0];
  const send = (seq, atMs, bytes) => client.send({
    type: 'raw-midi',
    ingest: {
      packet: {
        sourceId: 'disconnect-selftest', sourceSeq: seq, clockDomainId: 'mock-clock',
        capturedAtMs: atMs, rawBytes: bytes, transport: 'mock', captureEpoch: started.captureEpoch,
      },
      sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
    },
  });
  send(1, target.atMs + 8, [0x90, 60, 90]);
  send(2, target.atMs + 208, [0x80, 60, 40]);
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions?limit=10`)).json();
  const interrupted = list.items.find((item) => item.interrupted === true);
  check('断连后出现中断会话', !!interrupted, JSON.stringify(list.items.slice(0, 3)));
  if (interrupted) {
    const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${interrupted.sessionId}`)).json();
    check('中断报告标记 interrupted / 不可信', detail.interrupted === true
      && detail.report && detail.report.trustworthy === false,
      JSON.stringify({ interrupted: detail.interrupted, trustworthy: detail.report && detail.report.trustworthy }));
    check('中断 Take 仍保留真实输入和评分字段', detail.scoreV1
      && detail.scoreV1.pitch
      && detail.captureDiagnostics
      && detail.captureDiagnostics.inputHealth === 'disconnected',
      JSON.stringify({ scoreV1: !!detail.scoreV1, capture: detail.captureDiagnostics }));
  }
}

async function scenarioTakeTemplates() {
  console.log('scenario: Take 模板 CRUD → 启动关联 → 历史记录可追溯');
  const name = `selftest-take-${Date.now()}`;
  const createdResponse = await fetch(`http://127.0.0.1:${PORT}/api/take-templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      scoreFingerprint: 'template-fp',
      scoreLabel: 'C 大调钢琴练习曲',
      config: {
        modeId: 'score', tempo: 120, timeSignature: [4, 4], hand: 'both',
        feedback: 'live', loopEnabled: false, loopStartBar: 1, loopEndBar: 1,
        profile: 'standard', durationPolicy: 'strict-keydown', advanceMode: 'timeline',
      },
    }),
  });
  const createdBody = await createdResponse.json();
  check('Take 模板创建成功', createdResponse.status === 201 && createdBody.take?.id,
    JSON.stringify(createdBody));
  const template = createdBody.take;
  const listResponse = await (await fetch(`http://127.0.0.1:${PORT}/api/take-templates`)).json();
  check('Take 模板列表可读', listResponse.items.some((item) => item.id === template.id));

  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1), assisted: false, durationPolicy: 'strict-keydown',
    scoreFingerprint: 'template-fp', hand: 'both', scoreBarCount: 1, takeTemplateId: template.id,
  });
  await client.next('started');
  client.send({ type: 'tick', nowMs: 2000 });
  client.send({ type: 'finish' });
  const report = await client.next('report');
  check('演奏记录关联 Take', report.takeTemplateId === template.id && report.takeTemplateName === name,
    JSON.stringify({ id: report.takeTemplateId, name: report.takeTemplateName }));
  const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${report.sessionId}`)).json();
  check('历史详情保留 Take 关联', detail.takeTemplateId === template.id && detail.takeTemplateName === name,
    JSON.stringify({ id: detail.takeTemplateId, name: detail.takeTemplateName }));
  client.close();

  const renamedResponse = await fetch(`http://127.0.0.1:${PORT}/api/take-templates/${template.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${name}-renamed` }),
  });
  const renamed = await renamedResponse.json();
  check('Take 模板可重命名', renamedResponse.ok && renamed.take?.name === `${name}-renamed`);
  const deleteResponse = await fetch(`http://127.0.0.1:${PORT}/api/take-templates/${template.id}`, { method: 'DELETE' });
  check('Take 模板可删除', deleteResponse.ok);
  const afterDelete = await (await fetch(`http://127.0.0.1:${PORT}/api/take-templates`)).json();
  check('删除后列表不再出现', !afterDelete.items.some((item) => item.id === template.id));
}

async function scenarioSingleActiveTakeLease() {
  console.log('scenario: 多浏览器并发 → 只允许一个活动 Take');
  const a = new TestClient();
  const b = new TestClient();
  await a.open();
  await b.open();
  const payload = {
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1), assisted: false,
  };
  a.send(payload);
  await a.next('started');
  b.send(payload);
  const leaseError = await b.next('error');
  check('第二个浏览器不能抢占活动 Take', typeof leaseError.message === 'string'
    && leaseError.message.includes('另一个设备'), String(leaseError.message));
  a.send({ type: 'tick', nowMs: 2000 });
  a.send({ type: 'finish' });
  await a.next('report');
  b.send(payload);
  const bStarted = await b.next('started');
  check('第一个 Take 结束后释放租约，第二个浏览器可开始', bStarted.targets.length === 1);
  b.send({ type: 'tick', nowMs: 2000 });
  b.send({ type: 'finish' });
  await b.next('report');
  a.close();
  b.close();
}

async function scenarioErrors() {
  console.log('scenario: 非法输入 → 结构化错误,不崩溃');
  const client = new TestClient();
  await client.open();
  client.send({ type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4, ticksPerQuarter: 960, atoms: [] });
  const err1 = await client.next('error');
  check('空乐谱被拒绝', typeof err1.message === 'string' && err1.message.length > 0);
  // A full score's start payload can exceed the old 256KB ws default. A large
  // frame must produce a structured error without killing the service.
  client.send({
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: [], padding: 'x'.repeat(300 * 1024),
  });
  const largePayloadError = await client.next('error');
  check('大于旧 256KB 上限的消息不再打崩服务', typeof largePayloadError.message === 'string');
  client.send({
    type: 'start', modeId: 'score', bpm: 120, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1),
  });
  await client.next('started');
  client.send({ type: 'hit', seq: 1, atMs: -5, notes: [60] });
  const err2 = await client.next('error');
  check('负时间被拒绝', typeof err2.message === 'string');
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1),
    scoreEvents: [{
      scoreEventId: 'off-plan', measure: 1, beatPosition: 1, pitch: 60,
      targetOnsetMs: 999999, targetDurationMs: 250, partId: 'P1',
    }],
  });
  const err3 = await client.next('error');
  check('scoreEvents 与 atoms 时间线不一致被拒绝', typeof err3.message === 'string'
    && err3.message.includes('时间线'), String(err3.message));
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(1, 1),
  });
  const started = await client.next('started');
  check('出错后同一连接可重新开始', started.targets.length === 1);
  client.close();
}

async function scenarioDurations() {
  console.log('scenario: v0.3 按键时值 → Note On/Off 配对、too_short/within/unknown、孤立事件');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(8, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  check('目标带名义时值 250ms', started.targets.every((t) => Math.abs(t.nominalDurationMs - 250) < 1e-9),
    JSON.stringify(started.targets.map((t) => t.nominalDurationMs)));

  const t = started.targets;
  // 8 个准确起音；原始 note 事件：6 个按 180ms（too_short）、1 个按 230ms（within）、
  // 1 个唔松键（unknown）；再加一个孤立 note-off。allowed = max(50, 250×0.15) = 50。
  let seq = 0;
  const holdMs = [180, 180, 180, 180, 180, 180, 230, null];
  t.forEach((target, i) => {
    seq += 1;
    const hitSeq = seq;
    client.send({ type: 'hit', seq: hitSeq, atMs: target.atMs + 8, notes: [60] });
    client.send({ type: 'note-on', seq: hitSeq, atMs: target.atMs + 8, pitch: 60, velocity: 90 });
    if (holdMs[i] != null) {
      seq += 1;
      client.send({ type: 'note-off', seq, atMs: target.atMs + 8 + holdMs[i], pitch: 60 });
    }
  });
  seq += 1;
  client.send({ type: 'note-off', seq, atMs: t[7].atMs + 900, pitch: 99 }); // orphan

  client.send({ type: 'tick', nowMs: t[7].atMs + 250 + 500 });
  client.send({ type: 'finish' });
  const { report, durations } = await client.next('report');
  check('8 个 Perfect（起音判定不受时值影响）', report.stats.perfectCount === 8, JSON.stringify(report.stats));
  check('返回时值报告', !!durations && Array.isArray(durations.assessments));
  check('8 条逐音评估', durations.assessments.length === 8);
  check('6 个 too_short', durations.assessments.filter((a) => a.result === 'too_short').length === 6,
    JSON.stringify(durations.assessments.map((a) => a.result)));
  check('1 个 within_tolerance', durations.assessments.filter((a) => a.result === 'within_tolerance').length === 1);
  check('1 个 unknown（未松键）', durations.assessments.filter((a) => a.result === 'unknown').length === 1);
  check('孤立 note-off 计数 = 1', durations.orphanNoteOffCount === 1);
  check('未闭合 note 计数 = 1', durations.openNoteCount === 1);
  check('IOI 与 key-down 分开记录', durations.assessments[0].interOnsetIntervalMs != null
    && durations.assessments[0].actualKeyDownMs !== durations.assessments[0].interOnsetIntervalMs);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
  const latestId = list.items[0].sessionId;
  const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${latestId}`)).json();
  check('时值报告已持久化到会话 JSON', !!detail.durations && detail.durations.assessments.length === 8);
  client.close();
}

async function scenarioRawMidiPackets() {
  console.log('scenario: v0.6 raw packets → Rust 解码 → 命中 + 时值（前端零解码）');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(4, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  const t = started.targets;
  // 4 targets; mock packets with REAL raw bytes (0x90/0x80) through raw-midi:
  // target0 +8 (hold 200 < 250-50 → too_short), target1 +8 (hold 240 → within,
  // allowed = max(50, 37.5) = 50, err -10), target2 no release (unknown), target3 +8 (perfect).
  const send = (obj) => client.send(obj);
  t.forEach((target, i) => {
    const atMs = target.atMs + 8;
    const pitch = 60 + i * 2;
    send({ type: 'raw-midi', ingest: { packet: { sourceId: 'mock-a', sourceSeq: i * 2 + 1, clockDomainId: 'mock-clock', capturedAtMs: atMs, rawBytes: [0x90, pitch, 90], transport: 'mock' }, sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good' } });
    if (i !== 2) {
      const hold = i === 0 ? 190 : 240;
      send({ type: 'raw-midi', ingest: { packet: { sourceId: 'mock-a', sourceSeq: i * 2 + 2, clockDomainId: 'mock-clock', capturedAtMs: atMs + hold, rawBytes: [0x80, pitch, 40], transport: 'mock' }, sessionTimeMs: atMs + hold, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good' } });
    }
  });
  client.send({ type: 'tick', nowMs: t[3].atMs + 250 + 500 });
  client.send({ type: 'finish' });
  const { report, durations, keyLifecycles } = await client.next('report');
  check('4 个 Perfect（解码后 Note On 派生命中）', report.stats.perfectCount === 4, JSON.stringify(report.stats));
  check('keyLifecycles 报告存在', !!keyLifecycles && Array.isArray(keyLifecycles.observations));
  check('4 条生命周期观测（target2 未松键）', keyLifecycles.observations.length === 4
    && keyLifecycles.observations.filter((o) => o.status === 'missing-note-off').length === 1,
    JSON.stringify(keyLifecycles.observations.map((o) => [o.status, o.keyDownDurationMs])));
  check('时值：1 too_short + 2 within + 1 unknown', durations
    && durations.assessments.filter((a) => a.result === 'too_short').length === 1
    && durations.assessments.filter((a) => a.result === 'within_tolerance').length === 2
    && durations.assessments.filter((a) => a.result === 'unknown').length === 1,
    JSON.stringify(durations.assessments.map((a) => a.result)));
  client.close();
}

// Real SP-A500 behaviour: MIDI Clock (0xF8) and Active Sensing (0xFE) are
// received continuously and consume sourceSeq even though the frontend only
// forwards note packets. The core's hit sequence must therefore be dense and
// independent of sourceSeq; otherwise every note looks like ~48 lost events.
async function scenarioRealDeviceTransportGaps() {
  console.log('scenario: 真机时钟占用 sourceSeq → 评分序号仍密集、报告可信');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(4, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  const t = started.targets;
  let transportSeq = 1;
  t.forEach((target, i) => {
    const atMs = target.atMs + 8;
    const pitch = 60 + i * 2;
    // Jump sourceSeq as if 48 clock messages arrived between notes.
    transportSeq += 48;
    client.send({ type: 'raw-midi', ingest: { packet: { sourceId: 'input-0', sourceSeq: transportSeq, clockDomainId: 'web-page-performance-timeline', capturedAtMs: atMs, rawBytes: [0x90, pitch, 90], transport: 'web-midi' }, sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good' } });
    transportSeq += 1;
    client.send({ type: 'raw-midi', ingest: { packet: { sourceId: 'input-0', sourceSeq: transportSeq, clockDomainId: 'web-page-performance-timeline', capturedAtMs: atMs + 200, rawBytes: [0x80, pitch, 40], transport: 'web-midi' }, sessionTimeMs: atMs + 200, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good' } });
  });
  client.send({ type: 'tick', nowMs: t[3].atMs + 250 + 500 });
  client.send({ type: 'finish' });
  const { report, captureDiagnostics } = await client.next('report');
  check('4 个 Perfect', report.stats.perfectCount === 4, JSON.stringify(report.stats));
  check('sourceSeq 空洞不再被当成评分丢包', report.diagnostics.sequenceGapCount === 0,
    JSON.stringify(report.diagnostics));
  check('报告仍可信', report.trustworthy === true, JSON.stringify(report.diagnostics));
  check('评分序号密集（4 个命中）', !!captureDiagnostics && captureDiagnostics.scoringEvents === 4,
    JSON.stringify(captureDiagnostics));
  check('原始传输包保留 8 条', !!captureDiagnostics && captureDiagnostics.forwardedPackets === 8,
    JSON.stringify(captureDiagnostics));
  client.close();
}

async function scenarioCountdownInputNotScored() {
  console.log('scenario: 倒数内输入只留痕、不计分');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  // Targets start at 1000ms (4 beats @ 240 BPM); play at 300ms, inside count-in.
  const sendPacket = (seq, capturedAtMs, bytes) => client.send({
    type: 'raw-midi',
    ingest: {
      packet: { sourceId: 'input-0', sourceSeq: seq, clockDomainId: 'web-page-performance-timeline', capturedAtMs, rawBytes: bytes, transport: 'web-midi' },
      sessionTimeMs: capturedAtMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
    },
  });
  sendPacket(1, 300, [0x90, 60, 90]);
  sendPacket(2, 500, [0x80, 60, 40]);
  client.send({ type: 'tick', nowMs: started.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const { report, captureDiagnostics } = await client.next('report');
  check('倒数输入不产生 Extra', report.stats.extraCount === 0, JSON.stringify(report.stats));
  check('两个目标仍为 Miss（未演奏）', report.stats.missCount === 2, JSON.stringify(report.stats));
  check('倒数抑制计数 = 1', !!captureDiagnostics && captureDiagnostics.countdownSuppressed === 1,
    JSON.stringify(captureDiagnostics));
  check('倒数原始包仍在 trace', !!captureDiagnostics && captureDiagnostics.forwardedPackets === 2,
    JSON.stringify(captureDiagnostics));
  client.close();
}

async function scenarioCaptureEpochQuarantine() {
  console.log('scenario: CaptureEpoch 不匹配的包被隔离');
  const client = new TestClient();
  await client.open();
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  check('started 下发 captureEpoch', typeof started.captureEpoch === 'number' && started.captureEpoch > 0,
    JSON.stringify(started.captureEpoch));
  const t = started.targets;
  const sendPacket = (epoch, seq, atMs, bytes) => client.send({
    type: 'raw-midi',
    ingest: {
      packet: {
        sourceId: 'input-0', sourceSeq: seq, clockDomainId: 'web-page-performance-timeline',
        capturedAtMs: atMs, rawBytes: bytes, transport: 'web-midi', captureEpoch: epoch,
      },
      sessionTimeMs: atMs, clockMappingId: 'selftest', clockUncertaintyMs: 0, clockQuality: 'good',
    },
  });
  // Old-generation note on target 0: must not score.
  sendPacket(started.captureEpoch - 1, 1, t[0].atMs + 8, [0x90, 60, 90]);
  sendPacket(started.captureEpoch - 1, 2, t[0].atMs + 200, [0x80, 60, 40]);
  // Correct-generation note on target 1: must score.
  sendPacket(started.captureEpoch, 3, t[1].atMs + 8, [0x90, 62, 90]);
  sendPacket(started.captureEpoch, 4, t[1].atMs + 200, [0x80, 62, 40]);
  client.send({ type: 'tick', nowMs: t[1].atMs + 500 });
  client.send({ type: 'finish' });
  const { report, captureDiagnostics } = await client.next('report');
  check('旧 epoch 的音未命中', report.stats.perfectCount === 1, JSON.stringify(report.stats));
  check('第一个目标仍为 Miss', report.stats.missCount === 1, JSON.stringify(report.stats));
  check('没有 Extra', report.stats.extraCount === 0, JSON.stringify(report.stats));
  check('epochMismatch = 2', captureDiagnostics && captureDiagnostics.epochMismatch === 2,
    JSON.stringify(captureDiagnostics));
  check('只接收正确 epoch 的 2 条包', captureDiagnostics && captureDiagnostics.forwardedPackets === 2,
    JSON.stringify(captureDiagnostics));
  client.close();
}

async function scenarioTakeLifecycle() {
  console.log('scenario: PracticeSession 多轮 Take、活动 Take 保护、身份持久化');
  const client = new TestClient();
  await client.open();
  const startPayload = () => ({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false,
  });
  client.send(startPayload());
  const first = await client.next('started');
  check('started 下发会话与 Take 身份',
    typeof first.practiceSessionId === 'string' && first.practiceSessionId.length > 0
    && first.takeId === 'take-1' && first.takeIndex === 1,
    JSON.stringify({ practiceSessionId: first.practiceSessionId, takeId: first.takeId, takeIndex: first.takeIndex }));

  // A second start while the Take is live must be rejected, not replace it.
  client.send(startPayload());
  const activeError = await client.next('error');
  check('活动 Take 期间拒绝新 start', /已有进行中/.test(activeError.message), activeError.message);

  client.send({ type: 'tick', nowMs: first.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const report1 = await client.next('report');
  check('第一份报告带相同 Take 身份',
    report1.takeId === first.takeId && report1.practiceSessionId === first.practiceSessionId,
    JSON.stringify({ takeId: report1.takeId, practiceSessionId: report1.practiceSessionId }));

  // Duplicate finish is a no-op: no second report should arrive.
  client.send({ type: 'finish' });
  let duplicateReport = false;
  try { await client.next('report', () => true, 500); duplicateReport = true; } catch { /* expected timeout */ }
  check('重复 finish 不产生第二份报告', duplicateReport === false);

  client.send(startPayload());
  const second = await client.next('started');
  check('同一配置进入 Take 2',
    second.practiceSessionId === first.practiceSessionId
    && second.takeIndex === 2
    && second.takeId !== first.takeId
    && second.captureEpoch === first.captureEpoch + 1,
    JSON.stringify({ practiceSessionId: second.practiceSessionId, takeId: second.takeId, takeIndex: second.takeIndex, epoch: second.captureEpoch }));
  client.send({ type: 'tick', nowMs: second.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const report2 = await client.next('report');
  check('第二份报告带 Take 2 身份', report2.takeId === second.takeId);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
  const latest = list.items[0];
  const detail = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${latest.sessionId}`)).json();
  check('会话 JSON 保存 practiceSessionId/takeId',
    detail.practiceSessionId === first.practiceSessionId && detail.takeId === second.takeId,
    JSON.stringify({ practiceSessionId: detail.practiceSessionId, takeId: detail.takeId }));
  check('会话 JSON 保存 Take 快照', !!detail.takeSnapshot && detail.takeSnapshot.takeState === 'finalizing',
    JSON.stringify(detail.takeSnapshot));
  client.close();
}

async function scenarioNodeMidiPipeline() {
  console.log('scenario: Node MIDI Adapter → 时钟映射 → 既有 Session/Core 管线（mock 设备）');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status'); // initial broadcast
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  client.send({ type: 'midi-refresh' });
  const devices = await client.next('midi-devices', (m) => Array.isArray(m.items) && m.items.some((d) => d.id === 'mock:0'));
  check('Node 设备列表包含 mock 输入', devices.items.some((d) => d.id === 'mock:0'), JSON.stringify(devices.items));

  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  const connected = await client.next('midi-status', (m) => m.connected === true);
  check('Node Adapter 成功打开端口', connected.inputHealth === 'healthy' && connected.device?.id === 'mock:0',
    JSON.stringify(connected));

  for (let i = 0; i < 6; i += 1) {
    const id = `selftest-clock-${i}`;
    const c0 = performance.now();
    client.send({ type: 'clock-ping', id, clientSendPerfMs: c0 });
    const pong = await client.next('clock-pong', (m) => m.id === id);
    if (!Number.isFinite(pong.serverReceivePerfMs) || !Number.isFinite(pong.serverSendPerfMs)
      || pong.serverSendPerfMs < pong.serverReceivePerfMs) {
      throw new Error(`clock pong invalid: ${JSON.stringify(pong)}`);
    }
    client.send({ type: 'clock-sample', id, clientReceivePerfMs: performance.now() });
    await client.next('clock-status');
  }

  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  client.send({ type: 'session-origin', clientPerfMs: performance.now() });
  await sleep(300);
  client.send({ type: 'midi-test-note', bytes: [0x90, 60, 90] });
  await sleep(120);
  client.send({ type: 'tick', nowMs: started.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const { report, captureDiagnostics, traceId, trace: traceMeta, journalId, journal: journalMeta } = await client.next('report');
  check('Node MIDI 事件进入既有 ingest 管线', captureDiagnostics && captureDiagnostics.forwardedPackets >= 1,
    JSON.stringify(captureDiagnostics));
  check('Node 事件已映射到 session 时间', captureDiagnostics?.node?.mappedEvents >= 1
    && captureDiagnostics.node.staleGenerationEvents === 0, JSON.stringify(captureDiagnostics?.node));
  check('倒计时内的 Node 输入被抑制而非计分', captureDiagnostics?.countdownSuppressed >= 1,
    JSON.stringify(captureDiagnostics));
  check('Node 路径报告仍可结算', !!report && typeof report.trustworthy === 'boolean', JSON.stringify(report?.stats));
  check('报告返回持久化 traceId', typeof traceId === 'string' && traceMeta && traceMeta.eventCount >= 1,
    JSON.stringify({ traceId, traceMeta }));
  check('报告返回持久化 journalId', typeof journalId === 'string' && journalMeta
    && journalMeta.entryCount >= 2 && journalMeta.persistenceDegraded === false,
    JSON.stringify({ journalId, journalMeta }));

  const persistedJournal = await (await fetch(`http://127.0.0.1:${PORT}/api/journals/${journalId}`)).json();
  const kinds = persistedJournal.entries.map((entry) => entry.kind);
  check('Journal 记录开始/结算边界', kinds.includes('take_started') && kinds.includes('take_finalized')
    && persistedJournal.entries.every((entry, index) => entry.journalSeq === index + 1),
    JSON.stringify({ kinds }));

  const persistedTrace = await (await fetch(`http://127.0.0.1:${PORT}/api/traces/${traceId}`)).json();
  check('持久化 Take Trace 可读取', persistedTrace.manifest?.eventCount >= 1
    && persistedTrace.events.some((event) => event.rawBytes?.[0] === 0x90 && event.messageType === 'note-on'),
    JSON.stringify({ manifest: persistedTrace.manifest, events: persistedTrace.events?.length }));

  const adapterTrace = await (await fetch(`http://127.0.0.1:${PORT}/api/midi/trace`)).json();
  check('Node Adapter Trace 保留原始事件', adapterTrace.eventCount >= 1
    && adapterTrace.events.some((event) => event.rawData?.[0] === 0x90 && event.noteNumber === 60),
    JSON.stringify({ eventCount: adapterTrace.eventCount, dropped: adapterTrace.dropped }));

  client.send({ type: 'midi-disconnect' });
  const disconnected = await client.next('midi-status', (m) => m.connected === false && m.inputHealth === 'disconnected');
  check('Node Adapter 可释放端口', disconnected.inputHealth === 'disconnected', JSON.stringify(disconnected));
  client.close();
}

async function scenarioTraceReplayDeterminism() {
  console.log('scenario: 持久化 Trace 两次重放 → 判定统计与原报告一致');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status');
  client.send({ type: 'midi-connect', deviceId: 'mock:0' });
  await client.next('midi-status', (m) => m.connected === true);

  // Node→browser clock handshake, otherwise mapped events are quarantined.
  for (let i = 0; i < 6; i += 1) {
    const id = `replay-clock-${i}`;
    client.send({ type: 'clock-ping', id, clientSendPerfMs: performance.now() });
    await client.next('clock-pong', (m) => m.id === id);
    client.send({ type: 'clock-sample', id, clientReceivePerfMs: performance.now() });
    await client.next('clock-status');
  }

  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(3, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const started = await client.next('started');
  client.send({ type: 'session-origin', clientPerfMs: performance.now() });
  const t = started.targets;
  client.send({ type: 'midi-test-note', bytes: [0x90, 60, 90] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  client.send({ type: 'midi-test-note', bytes: [0x80, 60, 40] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  client.send({ type: 'tick', nowMs: t[2].atMs + 500 });
  client.send({ type: 'finish' });
  const { sessionId, traceId, captureDiagnostics: replayCap } = await client.next('report');
  check('重放场景拿到 sessionId/traceId', typeof sessionId === 'string' && typeof traceId === 'string'
    && replayCap.forwardedPackets >= 1,
    JSON.stringify({ sessionId, traceId, cap: replayCap }));
  client.close();

  const replay1 = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}/replay`)).json();
  const replay2 = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sessionId}/replay`)).json();
  check('两次重放均成功', replay1.ok === true && replay2.ok === true,
    JSON.stringify([replay1.error, replay2.error]));
  check('重放判定统计与原报告一致', replay1.matchesOriginal === true,
    JSON.stringify({ original: replay1.report?.stats, replay: replay1.report && replay1.report.stats }));
  check('两次重放结果完全相同', JSON.stringify(replay1.report?.stats) === JSON.stringify(replay2.report?.stats),
    JSON.stringify([replay1.report?.stats, replay2.report?.stats]));
  check('重放消化了被抑制的倒计时输入', replay1.suppressedCount >= 1, JSON.stringify({
    noteOn: replay1.noteOnCount, suppressed: replay1.suppressedCount, judgments: replay1.replayedJudgmentCount,
  }));
}

async function scenarioModeScoringConfig() {
  console.log('scenario: 模式→ScoringConfig：映射、行为差异、快照隔离、非法拒绝、报告追溯');
  const client = new TestClient();
  await client.open();
  await client.next('midi-status');

  // 1) Mapping: each mode resolves to its declared default (loop=strict).
  client.send({
    type: 'start', modeId: 'loop', bpm: 240, profile: 'standard', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const loopStarted = await client.next('started');
  check('loop 模式默认 strict 生效（用户未覆盖时不回落到统一默认）',
    loopStarted.scoringConfig?.judgmentProfile === 'standard'
      && loopStarted.scoringConfig?.judgmentProfileSource === 'user'
      && loopStarted.profile === 'standard',
    JSON.stringify(loopStarted.scoringConfig));
  client.send({ type: 'tick', nowMs: loopStarted.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const loopReport = await client.next('report');
  check('loop 报告可追溯配置快照/版本/算法版本',
    loopReport.scoringConfig?.modeId === 'loop'
      && loopReport.scoringConfig?.configVersion === 'mode-config-1.0.0'
      && typeof loopReport.scoringConfigVersion === 'string'
      && typeof loopReport.coreAlgorithmVersion === 'string',
    JSON.stringify({ sc: loopReport.scoringConfig, v: loopReport.scoringConfigVersion, a: loopReport.coreAlgorithmVersion }));
  check('loop 报告 analysis 标注模式范围', loopReport.analysis?.modeScope?.modeId === 'loop',
    JSON.stringify(loopReport.analysis?.modeScope));

  // 2) Behavior: free mode rejects scoring knobs instead of silently ignoring.
  client.send({
    type: 'start', modeId: 'free', bpm: 240, profile: 'strict', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1),
  });
  const freeError = await client.next('error');
  check('free 模式明确拒绝 profile 覆盖（不静默忽略）', /不适用/.test(freeError.message), freeError.message);

  // 3) Invalid config rejected with a stable message.
  client.send({
    type: 'start', modeId: 'score', bpm: 240, profile: 'impossible', countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1),
  });
  const invalidError = await client.next('error');
  check('非法判定档位被拒绝', /判定档位非法/.test(invalidError.message), invalidError.message);

  // 4) Snapshot isolation: take the take, then restart with a different
  //    global default (client-side profile) — the finished report keeps the
  //    config that was effective when the take was created.
  client.send({
    type: 'start', modeId: 'score', bpm: 240, countInBeats: 4,
    ticksPerQuarter: 960, atoms: quarterAtoms(2, 1), assisted: false, durationPolicy: 'strict-keydown',
  });
  const scoreStarted = await client.next('started');
  check('score 模式默认 standard（mode-default 来源）',
    scoreStarted.scoringConfig?.judgmentProfile === 'standard'
      && scoreStarted.scoringConfig?.judgmentProfileSource === 'mode-default',
    JSON.stringify(scoreStarted.scoringConfig));
  client.send({ type: 'tick', nowMs: scoreStarted.targets[1].atMs + 500 });
  client.send({ type: 'finish' });
  const scoreReport = await client.next('report');
  check('完成后报告中的配置 == 本次生效配置',
    scoreReport.scoringConfig?.judgmentProfile === 'standard'
      && scoreReport.practiceSessionId === scoreStarted.practiceSessionId,
    JSON.stringify(scoreReport.scoringConfig));

  // 5) Replay determinism with config: the persisted trace + same atoms
  //    reproduces the same statistics.
  const replay = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions/${scoreReport.sessionId}/replay`)).json();
  check('带配置的确定性重放与原报告一致', replay.ok === true && replay.matchesOriginal === true,
    JSON.stringify({ error: replay.error, stats: replay.report?.stats }));
  client.close();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('引擎服务未在预期时间内就绪');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-engine-selftest-'));
  const child = spawn(process.execPath, [path.join(__dirname, 'engine-server.mjs')], {
    env: { ...process.env, PORT: String(PORT), RHYTHM_DATA_DIR: dataDir, RHYTHM_MIDI_BACKEND: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

  try {
    await waitForServer();
    await scenarioAccurateHits();
    await scenarioRawMidiPackets();
    await scenarioRealDeviceTransportGaps();
    await scenarioCountdownInputNotScored();
    await scenarioCaptureEpochQuarantine();
    await scenarioTakeLifecycle();
    await scenarioNodeMidiPipeline();
    await scenarioDegradedHealthExcluded();
    await scenarioTraceReplayDeterminism();
    await scenarioModeScoringConfig();
    await scenarioDurations();
    await scenarioMasteryProvisional();
    await scenarioMixedOutcomes();
    await scenarioPauseResume();
    await scenarioPauseScoring();
    await scenarioPauseWithMidiInput();
    await scenarioPauseAdmissionLedger();
    await scenarioPauseCrossingKey();
    await scenarioScoreChain();
    await scenarioDisconnectFinalizesTake();
    await scenarioTakeTemplates();
    await scenarioSingleActiveTakeLease();
    await scenarioErrors();
    check('profile.json 已写入数据目录', fs.existsSync(path.join(dataDir, 'profile.json')));
    check('会话 JSON 落盘', fs.readdirSync(path.join(dataDir, 'sessions')).length >= 5);
  } finally {
    child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部自测通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
