'use strict';

// Minimal local demo server: browser spacebar input -> WebSocket -> the Rust
// core via the N-API addon. The browser never scores anything itself; it only
// timestamps key presses (performance.now() relative to session origin) and
// renders judgments returned by the server. Listens on loopback only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const addon = require('../bindings/node');

const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const COUNT_IN_BEATS = 4;
const QUEUE_CAPACITY = 512;
const FINALIZATION_GRACE_MS = 80;
const PROFILES = new Set(['strict', 'standard', 'relaxed']);

function atoms(rows) {
  return rows.map(([startTick, durationTicks, kind, bar, beat]) => ({
    startTick, durationTicks, kind, bar, beat,
  }));
}

function quarters(id, bars) {
  const rows = [];
  for (let i = 0; i < bars * 4; i++) {
    rows.push([i * 960, 960, 'note', Math.floor(i / 4) + 1, (i % 4) + 1]);
  }
  return { id, ticksPerQuarter: 960, atoms: atoms(rows) };
}

function eighths(id, bars) {
  const rows = [];
  for (let i = 0; i < bars * 8; i++) {
    rows.push([i * 480, 480, 'note', Math.floor(i / 8) + 1, 1 + i / 2]);
  }
  return { id, ticksPerQuarter: 960, atoms: atoms(rows) };
}

function restReentry(id) {
  // bar1: N . N .  | bar2: N . N N  — offbeat-free, focuses on rest re-entry.
  const layout = [
    ['note', 1], ['rest', 2], ['note', 3], ['rest', 4],
    ['note', 1], ['rest', 2], ['note', 3], ['note', 4],
  ];
  const rows = [];
  const restFollowTicks = [];
  let previousKind = null;
  layout.forEach(([kind, beat], i) => {
    const bar = i < 4 ? 1 : 2;
    const tick = ((bar - 1) * 4 + (beat - 1)) * 960;
    rows.push([tick, 960, kind, bar, beat]);
    if (kind === 'note' && previousKind === 'rest') restFollowTicks.push(tick);
    previousKind = kind;
  });
  return { id, ticksPerQuarter: 960, atoms: atoms(rows), restFollowTicks };
}

function offbeatTicksOf(pattern) {
  return pattern.atoms
    .filter((atom) => atom.kind === 'note' && !Number.isInteger(atom.beat))
    .map((atom) => atom.startTick);
}

const QUARTERS = quarters('demo-quarters', 2);
const EIGHTHS = eighths('demo-eighths', 2);
const RESTS = restReentry('demo-rests');

const PATTERNS = {
  quarters: {
    label: '四分音符 · 稳定拍感(2 小节)',
    suggestedBpm: 70,
    pattern: QUARTERS,
    restFollowTicks: [],
    offbeatTicks: offbeatTicksOf(QUARTERS),
  },
  eighths: {
    label: '八分连击 · 细分稳定(2 小节)',
    suggestedBpm: 70,
    pattern: EIGHTHS,
    restFollowTicks: [],
    offbeatTicks: offbeatTicksOf(EIGHTHS),
  },
  rests: {
    label: '休止后重进(2 小节,推荐 60 BPM)',
    suggestedBpm: 60,
    pattern: RESTS,
    restFollowTicks: RESTS.restFollowTicks,
    offbeatTicks: [],
  },
};

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('demo page missing');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (socket) => {
  let native = null;
  let meta = null;

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(socket, { type: 'error', message: '消息不是合法 JSON' });
      return;
    }
    try {
      handle(msg);
    } catch (err) {
      send(socket, { type: 'error', message: String((err && err.message) || err) });
    }
  });

  function handle(msg) {
    switch (msg.type) {
      case 'start': {
        if (native) { try { native.finish(); } catch { /* previous session already closed */ } native = null; }
        const def = PATTERNS[msg.pattern];
        if (!def) throw new Error('未知的节奏型');
        const bpm = Number(msg.bpm);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('BPM 需在 20–300 之间');
        const profile = PROFILES.has(msg.profile) ? msg.profile : 'standard';

        const countInMs = COUNT_IN_BEATS * (60_000 / bpm);
        const targets = addon.buildSchedule(def.pattern, bpm, countInMs, profile);
        native = new addon.NativeSession(targets, QUEUE_CAPACITY, FINALIZATION_GRACE_MS);
        native.start();
        meta = { def, bpm, profile };
        send(socket, {
          type: 'started',
          pattern: msg.pattern,
          bpm,
          profile,
          countInBeats: COUNT_IN_BEATS,
          targets,
          restFollowTargetIds: targets
            .filter((t) => def.restFollowTicks.some((tick) => t.id === `${def.pattern.id}:tick:${tick}`))
            .map((t) => t.id),
        });
        break;
      }
      case 'hit': {
        if (!native) return;
        const seq = Number(msg.seq);
        const atMs = Number(msg.atMs);
        if (!Number.isFinite(seq) || !Number.isFinite(atMs)) throw new Error('hit 字段非法');
        native.pushHit({ seq, atMs, source: 'keyboard', notes: [] });
        send(socket, { type: 'judgments', items: native.processPending() });
        break;
      }
      case 'tick': {
        if (!native) return;
        const nowMs = Number(msg.nowMs);
        if (!Number.isFinite(nowMs)) return;
        send(socket, { type: 'judgments', items: native.advance(nowMs) });
        break;
      }
      case 'finish': {
        finishSession(socket);
        break;
      }
      default:
        break; // 未知消息忽略
    }
  }

  function finishSession(sock) {
    if (!native) return;
    const report = native.finish();
    native = null;
    let analysis = null;
    try {
      analysis = addon.analyzeTiming(report.judgments, {
        measurementTrustworthy: report.trustworthy,
        restReentryTargetIds: targetsWithTicks(meta.def.restFollowTicks),
        offbeatTargetIds: targetsWithTicks(meta.def.offbeatTicks),
      }, meta.bpm);
    } catch (err) {
      analysis = { error: String((err && err.message) || err) };
    }
    send(sock, { type: 'report', report, analysis });
  }

  function targetsWithTicks(ticks) {
    return ticks.map((tick) => `${meta.def.pattern.id}:tick:${tick}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Rhythm Trainer demo: http://${HOST}:${PORT}`);
});
