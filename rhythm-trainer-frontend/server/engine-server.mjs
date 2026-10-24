'use strict';

// Local engine service for the Rhythm Trainer frontend.
//
// Responsibilities:
//   - own the Rust core (via the N-API addon) — the single scoring authority
//   - build target schedules from client-sent score atoms
//   - accept hit/tick/pause/resume/finish messages over WebSocket
//   - return judgments, the deterministic replay report, and rule-based
//     coaching analysis
//   - persist finished sessions as JSON (atomic writes) and maintain a
//     rule-based StudentModel (skill mastery) updated from each report
//   - serve the built frontend (dist/) and a small REST API
//     (/api/sessions, /api/profile, /api/health, /api/scores)
//
// Loopback only. Clock-domain note: the client anchors the session at its own
// performance.now() origin and sends session-relative `atMs`; the server builds
// targets at countInMs + beat offsets in the same relative domain. Fine clock
// synchronization is a separate subsystem and is intentionally not faked here.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { NodeMidiAdapter } from './midi/adapter.mjs';
import { createJulusianBackend } from './midi/julusian-backend.mjs';
import { createMockBackend } from './midi/mock-backend.mjs';
import { computeClockSample, mapNodeEventToSession, selectClockSample } from './midi/clock-map.mjs';
import { TakeTraceRecorder, readTrace } from './midi/trace-recorder.mjs';
import { TakeJournal, readJournal } from './journal.mjs';
import { replayTakeTrace } from './trace-replay.mjs';
import { resolveModeScoringConfig } from './mode-config.mjs';
import { ScoreLibrary, ScoreLibraryError, SCORE_LIBRARY_SCHEMA_VERSION, MAX_SCORE_XML_BYTES } from './score-library.mjs';
import { TakeTemplateStore, TakeTemplateError, TAKE_TEMPLATE_SCHEMA_VERSION } from './take-templates.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8788);
// Loopback by default. Set HOST=0.0.0.0 to expose the engine on the LAN
// (iPad/practice-room scenario); the WebSocket and REST surface are then
// reachable from other devices on the same network.
const HOST = process.env.HOST || '127.0.0.1';
const QUEUE_CAPACITY = 512;
const FINALIZATION_GRACE_MS = 80;
// Mode/profile validation moved to server/mode-config.mjs (single authority).
const SCHEMA_VERSION = 1;
// Pass rule (product heuristic, same threshold as the core's prescription):
// clean input, no miss/extra, mean absolute error within 30 ms.
const PASS_MAE_MS = 30.0;
// v0.3 key-down duration policy defaults (product heuristics, not standards;
// calibrate per device/tempo before trusting). Version bump when changed.
const DURATION_POLICY_VERSION = 1;
const DURATION_TOLERANCE_MS = 50.0;
const DURATION_TOLERANCE_RATIO = 0.15;

function unavailableMidiBackend(error) {
  const code = error?.code ?? 'MIDI_BACKEND_UNAVAILABLE';
  const message = String(error?.message ?? error);
  return {
    name: 'unavailable',
    version: 'unknown',
    listInputs() {
      throw Object.assign(new Error(message), { code });
    },
    openInput() {
      throw Object.assign(new Error(message), { code });
    },
  };
}

// One production input source per server. Tests can select the deterministic
// mock backend with RHYTHM_MIDI_BACKEND=mock.
let midiAdapter;
try {
  const backend = process.env.RHYTHM_MIDI_BACKEND === 'mock'
    ? createMockBackend()
    : createJulusianBackend();
  midiAdapter = new NodeMidiAdapter({ backend, queueCapacity: 2048 });
} catch (error) {
  console.error('[engine] MIDI 后端不可用:', String((error && error.message) || error));
  midiAdapter = new NodeMidiAdapter({ backend: unavailableMidiBackend(error), queueCapacity: 2048 });
}

const addonDir = process.env.RHYTHM_CORE_ADDON_DIR
  || path.resolve(__dirname, '../../rhythm-trainer-core-v0.2/bindings/node');

let addon;
try {
  addon = require(addonDir);
} catch (error) {
  console.error(`[engine] 无法加载 Rust 原生模块 (${addonDir})。`);
  console.error('请先在 rhythm-trainer-core-v0.2/bindings/node 下执行 npm install && npm run build:debug。');
  console.error(String((error && error.message) || error));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Persistence: user-data JSON files with atomic writes (tmp + rename).

const DATA_DIR = process.env.RHYTHM_DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rhythm-trainer-frontend');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const TRACES_DIR = path.join(DATA_DIR, 'traces');
const JOURNALS_DIR = path.join(DATA_DIR, 'journals');
const SCORES_DIR = path.join(DATA_DIR, 'scores');
const TAKE_TEMPLATES_DIR = path.join(DATA_DIR, 'take-templates');
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json');

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(file, obj) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function safeId(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value)) ? String(value) : null;
}

ensureDirSync(SESSIONS_DIR);
ensureDirSync(TRACES_DIR);
ensureDirSync(JOURNALS_DIR);
ensureDirSync(SCORES_DIR);
ensureDirSync(TAKE_TEMPLATES_DIR);
const scoreLibrary = new ScoreLibrary({ dir: SCORES_DIR });
const takeTemplateStore = new TakeTemplateStore({ dir: TAKE_TEMPLATES_DIR });
let sessionIdCounter = 0;
let practiceSessionCounter = 0;

// StudentModel: restored from disk at startup, updated on every finish.
let studentModel = null;
try {
  if (fs.existsSync(PROFILE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    if (parsed.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.snapshot)) {
      studentModel = new addon.NativeStudentModel(parsed.snapshot);
    }
  }
} catch (err) {
  console.error('[engine] profile.json 损坏，已忽略并重建（原文件保留为 profile.json.corrupt）');
  try { fs.renameSync(PROFILE_FILE, `${PROFILE_FILE}.corrupt`); } catch { /* ignore */ }
}
if (!studentModel) studentModel = new addon.NativeStudentModel();

function persistProfile() {
  try {
    atomicWriteJson(PROFILE_FILE, { schemaVersion: SCHEMA_VERSION, snapshot: studentModel.snapshot() });
  } catch (err) {
    console.error('[engine] profile 保存失败:', String((err && err.message) || err));
  }
}

function listSessionFiles() {
  return fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json') && safeId(f.slice(0, -5)));
}

function readSessionRecord(id) {
  const clean = safeId(id);
  if (!clean) return null;
  const file = path.join(SESSIONS_DIR, `${clean}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Duration assessments are joined by targetIndex in the core. Attach the
 * target's measure here so B2 can create an evidence-backed local task.
 * Old records keep null/absent fields.
 */
function attachDurationMeasures(durations, targets) {
  if (!durations || durations.error || !Array.isArray(durations.assessments)) return durations;
  return {
    ...durations,
    assessments: durations.assessments.map((assessment) => {
      const target = Number.isInteger(assessment.targetIndex)
        ? targets[assessment.targetIndex]
        : null;
      return {
        ...assessment,
        bar: target && Number.isInteger(target.bar) ? target.bar : null,
        beat: target && Number.isFinite(target.beat) ? target.beat : null,
      };
    }),
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ratioOrNull(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : null;
}

/**
 * B2 comparison is presentation only: it never derives a new score. It only
 * pairs real numeric metrics with identical definitions and refuses to compare
 * unavailable/degraded reports or different scoring versions.
 */
function buildRetryComparison(sourceRecord, retryRecord) {
  const sourceScore = sourceRecord?.scoreV1;
  const retryScore = retryRecord?.scoreV1;
  const sourceStatus = sourceRecord?.scoreStatus ?? null;
  const retryStatus = retryRecord?.scoreStatus ?? null;
  const base = {
    sourceReportId: sourceRecord?.sessionId ?? retryRecord?.sourceReportId ?? null,
    sourceTakeId: sourceRecord?.takeId ?? retryRecord?.sourceTakeId ?? null,
    retryReportId: retryRecord?.sessionId ?? null,
    retryTakeId: retryRecord?.takeId ?? null,
    prescriptionId: retryRecord?.prescriptionId ?? null,
    comparable: false,
    blockedReason: null,
    limitations: [],
    sourceStatus,
    retryStatus,
    metrics: [],
  };
  if (!sourceRecord) return { ...base, blockedReason: '找不到来源报告，无法比较。' };
  if (!sourceScore || typeof sourceScore !== 'object' || 'error' in sourceScore) {
    return { ...base, blockedReason: '来源报告没有可用的完整评分。' };
  }
  if (!retryScore || typeof retryScore !== 'object' || 'error' in retryScore) {
    return { ...base, blockedReason: '复练报告没有可用的完整评分。' };
  }
  if (sourceStatus !== 'AVAILABLE' || retryStatus !== 'AVAILABLE') {
    return {
      ...base,
      blockedReason: `只有两份报告均为 AVAILABLE 才比较（原 ${sourceStatus ?? 'unknown'} / 复练 ${retryStatus ?? 'unknown'}）。`,
    };
  }
  if (!sourceRecord.scoreFingerprint || !retryRecord.scoreFingerprint
    || sourceRecord.scoreFingerprint !== retryRecord.scoreFingerprint) {
    return { ...base, blockedReason: '两份报告的曲谱指纹不一致或缺失，不能比较。' };
  }
  if (sourceRecord.scoreAlgorithmVersion !== retryRecord.scoreAlgorithmVersion
    || sourceRecord.scoringConfigVersion !== retryRecord.scoringConfigVersion) {
    return { ...base, blockedReason: '评分算法或评分配置版本不同，指标定义不可直接比较。' };
  }

  const limitations = [];
  if (finiteNumber(sourceRecord.bpm) != null && finiteNumber(retryRecord.bpm) != null
    && sourceRecord.bpm !== retryRecord.bpm) {
    limitations.push(`BPM 不同（原 ${sourceRecord.bpm} → 复练 ${retryRecord.bpm}），起音/时值指标受难度影响。`);
  }
  if (sourceRecord.hand && retryRecord.hand && sourceRecord.hand !== retryRecord.hand) {
    limitations.push(`手别不同（原 ${sourceRecord.hand} → 复练 ${retryRecord.hand}）。`);
  }
  if (sourceRecord.modeId !== retryRecord.modeId) {
    limitations.push(`练习模式不同（原 ${sourceRecord.modeId} → 复练 ${retryRecord.modeId}）。`);
  }
  if (retryRecord.prescriptionId) {
    limitations.push('复练按处方/手动选择的小节范围生成；原报告范围可能不同，不能把差异全部归因于进步。');
  }

  const metrics = [];
  const add = (key, label, unit, before, after, lowerIsBetter) => {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    metrics.push({
      key,
      label,
      unit,
      before,
      after,
      delta: after - before,
      lowerIsBetter,
    });
  };
  add('pitch.recall', '音高正确率', 'ratio', finiteNumber(sourceScore.pitch?.recall), finiteNumber(retryScore.pitch?.recall), false);
  add('pitch.precision', '音高精确率', 'ratio', finiteNumber(sourceScore.pitch?.precision), finiteNumber(retryScore.pitch?.precision), false);
  add('onset.meanAbsoluteMs', '平均绝对起音误差', 'ms', finiteNumber(sourceScore.onset?.meanAbsoluteMs), finiteNumber(retryScore.onset?.meanAbsoluteMs), true);
  add('rhythm.jitterRatioMad', '节奏抖动 (MAD)', 'ratio', finiteNumber(sourceScore.rhythm?.jitterRatioMad), finiteNumber(retryScore.rhythm?.jitterRatioMad), true);
  add(
    'duration.tooShortRatio',
    '时值偏短比例',
    'ratio',
    ratioOrNull(sourceScore.duration?.tooShortCount, sourceScore.duration?.graded),
    ratioOrNull(retryScore.duration?.tooShortCount, retryScore.duration?.graded),
    true,
  );
  add(
    'duration.tooLongRatio',
    '时值偏长比例',
    'ratio',
    ratioOrNull(sourceScore.duration?.tooLongCount, sourceScore.duration?.graded),
    ratioOrNull(retryScore.duration?.tooLongCount, retryScore.duration?.graded),
    true,
  );
  add('continuity.coveredRatio', '目标覆盖率', 'ratio', finiteNumber(sourceScore.continuity?.coveredRatio), finiteNumber(retryScore.continuity?.coveredRatio), false);

  if (metrics.length === 0) {
    return { ...base, limitations, blockedReason: '两份报告没有共同的可比较数值指标。' };
  }
  return { ...base, comparable: true, limitations, metrics };
}

// ---------------------------------------------------------------------------
// Static file serving (production mode). In dev, Vite serves the page and
// proxies /ws and /api here.

const distDir = path.resolve(__dirname, '../dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Determinism check: grades per target must match the original report. */
function replayMatchesOriginal(original, replayed) {
  if (!original || !replayed) return false;
  const a = original.stats ?? {};
  const b = replayed.stats ?? {};
  return a.targetCount === b.targetCount
    && a.perfectCount === b.perfectCount
    && a.goodCount === b.goodCount
    && a.missCount === b.missCount
    && a.extraCount === b.extraCount;
}

// ---------------------------------------------------------------------------
// Named MusicXML library REST API. Raw XML is persisted; parsing stays in the
// browser. Request bodies are capped at twice the XML limit to leave room for
// JSON string escaping.

const MAX_SCORE_REQUEST_BYTES = MAX_SCORE_XML_BYTES * 2;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SCORE_REQUEST_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new ScoreLibraryError('PAYLOAD_TOO_LARGE', '请求体过大', 413));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new ScoreLibraryError('INVALID_BODY', '请求体为空'));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new ScoreLibraryError('INVALID_JSON', '请求体不是合法 JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new ScoreLibraryError('INVALID_BODY', '请求体必须是 JSON 对象'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

function sendScoreError(res, error) {
  if (error instanceof ScoreLibraryError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error('[engine] 乐谱库操作失败:', String((error && error.message) || error));
  sendJson(res, 500, { ok: false, error: { code: 'SCORE_LIBRARY_FAILED', message: '乐谱库操作失败' } });
}

async function handleScoreApi(req, res, scoreId) {
  try {
    if (!scoreId) {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          schemaVersion: SCORE_LIBRARY_SCHEMA_VERSION,
          scores: scoreLibrary.list(),
          invalidCount: scoreLibrary.invalidCount(),
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const score = scoreLibrary.create(body);
        sendJson(res, 201, { ok: true, score });
        return;
      }
      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
      return;
    }
    if (req.method === 'GET') {
      const score = scoreLibrary.get(scoreId);
      if (!score) {
        sendJson(res, 404, { ok: false, error: { code: 'SCORE_NOT_FOUND', message: '乐谱不存在' } });
        return;
      }
      sendJson(res, 200, { schemaVersion: SCORE_LIBRARY_SCHEMA_VERSION, score });
      return;
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const score = scoreLibrary.update(scoreId, body);
      sendJson(res, 200, { ok: true, score });
      return;
    }
    if (req.method === 'DELETE') {
      if (!scoreLibrary.remove(scoreId)) {
        sendJson(res, 404, { ok: false, error: { code: 'SCORE_NOT_FOUND', message: '乐谱不存在' } });
        return;
      }
      sendJson(res, 200, { ok: true, deleted: true, id: scoreId });
      return;
    }
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
  } catch (error) {
    sendScoreError(res, error);
  }
}

function sendTakeTemplateError(res, error) {
  if (error instanceof TakeTemplateError) {
    sendJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error('[engine] Take 模板操作失败:', String((error && error.message) || error));
  sendJson(res, 500, { ok: false, error: { code: 'TAKE_TEMPLATE_FAILED', message: 'Take 模板操作失败' } });
}

async function handleTakeTemplateApi(req, res, takeId) {
  try {
    if (!takeId) {
      if (req.method === 'GET') {
        sendJson(res, 200, { schemaVersion: TAKE_TEMPLATE_SCHEMA_VERSION, items: takeTemplateStore.list() });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        const take = takeTemplateStore.create(body);
        sendJson(res, 201, { ok: true, schemaVersion: TAKE_TEMPLATE_SCHEMA_VERSION, take });
        return;
      }
      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
      return;
    }
    if (req.method === 'GET') {
      const take = takeTemplateStore.read(takeId);
      if (!take) {
        sendJson(res, 404, { ok: false, error: { code: 'TAKE_NOT_FOUND', message: 'Take 不存在' } });
        return;
      }
      sendJson(res, 200, { schemaVersion: TAKE_TEMPLATE_SCHEMA_VERSION, take });
      return;
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const take = takeTemplateStore.update(takeId, body);
      sendJson(res, 200, { ok: true, schemaVersion: TAKE_TEMPLATE_SCHEMA_VERSION, take });
      return;
    }
    if (req.method === 'DELETE') {
      if (!takeTemplateStore.remove(takeId)) {
        sendJson(res, 404, { ok: false, error: { code: 'TAKE_NOT_FOUND', message: 'Take 不存在' } });
        return;
      }
      sendJson(res, 200, { ok: true, deleted: true, id: takeId });
      return;
    }
    sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
  } catch (error) {
    sendTakeTemplateError(res, error);
  }
}

async function handleApi(req, res, urlPath, query) {
  if (urlPath === '/api/take-templates' || urlPath.startsWith('/api/take-templates/')) {
    if (urlPath === '/api/take-templates') {
      await handleTakeTemplateApi(req, res, null);
      return;
    }
    const takeMatch = urlPath.match(/^\/api\/take-templates\/([A-Za-z0-9_-]+)$/);
    if (!takeMatch) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
      return;
    }
    await handleTakeTemplateApi(req, res, takeMatch[1]);
    return;
  }
  if (urlPath === '/api/scores' || urlPath.startsWith('/api/scores/')) {
    if (urlPath === '/api/scores') {
      await handleScoreApi(req, res, null);
      return;
    }
    const scoreMatch = urlPath.match(/^\/api\/scores\/([A-Za-z0-9_-]+)$/);
    if (!scoreMatch) {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } });
      return;
    }
    await handleScoreApi(req, res, scoreMatch[1]);
    return;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION });
    return;
  }
  if (urlPath === '/api/sessions') {
    const limit = Math.min(Number(query.get('limit')) || 50, 200);
    const items = listSessionFiles()
      .map((f) => {
        const record = readSessionRecord(f.slice(0, -5));
        if (!record) return null;
        return {
          sessionId: record.sessionId,
          interrupted: !!record.interrupted,
          finishedAtIso: record.finishedAtIso,
          modeId: record.modeId,
          bpm: record.bpm,
          profile: record.profile,
          trustworthy: record.report && record.report.trustworthy,
          targetCount: record.report ? record.report.targetCount : 0,
          perfectCount: record.report ? record.report.stats.perfectCount : 0,
          goodCount: record.report ? record.report.stats.goodCount : 0,
          missCount: record.report ? record.report.stats.missCount : 0,
          extraCount: record.report ? record.report.stats.extraCount : 0,
          targetHitRate: record.report ? record.report.stats.targetHitRate : 0,
          meanSignedMs: record.report ? record.report.stats.meanSignedMs ?? null : null,
          meanAbsoluteMs: record.report ? record.report.stats.meanAbsoluteMs ?? null : null,
          sourceReportId: record.sourceReportId ?? null,
          prescriptionId: record.prescriptionId ?? null,
          takeTemplateId: record.takeTemplateId ?? null,
          takeTemplateName: record.takeTemplateName ?? null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.finishedAtIso < b.finishedAtIso ? 1 : -1))
      .slice(0, limit);
    sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, items });
    return;
  }
  const sessionMatch = urlPath.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
  if (sessionMatch) {
    const record = readSessionRecord(sessionMatch[1]);
    if (!record) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    sendJson(res, 200, record);
    return;
  }
  if (urlPath === '/api/midi/devices') {
    try {
      const devices = midiAdapter.listInputs();
      sendJson(res, 200, { ok: true, ...midiAdapter.getStatus(), devices });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        backend: midiAdapter.getStatus().backend,
        error: {
          code: error?.code ?? 'MIDI_DEVICE_LIST_FAILED',
          message: String((error && error.message) || error),
        },
      });
    }
    return;
  }
  if (urlPath === '/api/midi/status') {
    sendJson(res, 200, { ok: true, ...midiAdapter.getStatus() });
    return;
  }
  if (urlPath === '/api/midi/trace') {
    sendJson(res, 200, midiAdapter.getTrace());
    return;
  }
  const traceMatch = urlPath.match(/^\/api\/traces\/([A-Za-z0-9_-]+)$/);
  if (traceMatch) {
    const trace = readTrace(TRACES_DIR, traceMatch[1]);
    if (!trace) {
      sendJson(res, 404, { error: 'trace not found' });
      return;
    }
    sendJson(res, 200, trace);
    return;
  }
  const journalMatch = urlPath.match(/^\/api\/journals\/([A-Za-z0-9_-]+)$/);
  if (journalMatch) {
    const journal = readJournal(JOURNALS_DIR, journalMatch[1]);
    if (!journal) {
      sendJson(res, 404, { error: 'journal not found' });
      return;
    }
    sendJson(res, 200, journal);
    return;
  }
  const replayMatch = urlPath.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/replay$/);
  if (replayMatch) {
    const record = readSessionRecord(replayMatch[1]);
    if (!record || !record.traceId) {
      sendJson(res, 404, { error: 'session or trace not found' });
      return;
    }
    try {
      const result = replayTakeTrace({
        dataDir: DATA_DIR,
        traceId: record.traceId,
        sessionRecord: record,
        addon,
        queueCapacity: QUEUE_CAPACITY,
        finalizationGraceMs: FINALIZATION_GRACE_MS,
      });
      sendJson(res, 200, {
        ok: true,
        sessionId: record.sessionId,
        traceId: record.traceId,
        replayedJudgmentCount: result.judgmentCount,
        noteOnCount: result.noteOnCount,
        suppressedCount: result.suppressedCount,
        report: result.report,
        matchesOriginal: replayMatchesOriginal(record.report, result.report),
      });
    } catch (error) {
      sendJson(res, 409, {
        ok: false,
        error: {
          code: 'REPLAY_FAILED',
          message: String((error && error.message) || error),
        },
      });
    }
    return;
  }
  if (urlPath === '/api/profile') {
    const skills = studentModel.snapshot();
    const files = listSessionFiles();
    let sessions = 0;
    let trustworthySessions = 0;
    for (const f of files) {
      const record = readSessionRecord(f.slice(0, -5));
      if (!record) continue;
      sessions += 1;
      if (record.report && record.report.trustworthy) trustworthySessions += 1;
    }
    sendJson(res, 200, { schemaVersion: SCHEMA_VERSION, skills, totals: { sessions, trustworthySessions } });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://localhost');
  if (parsed.pathname.startsWith('/api/')) {
    handleApi(req, res, parsed.pathname, parsed.searchParams).catch((error) => {
      console.error('[engine] API 处理失败:', String((error && error.message) || error));
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  const urlPath = decodeURIComponent(parsed.pathname);
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const candidate = path.normalize(path.join(distDir, relative));
  if (!candidate.startsWith(distDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(candidate, (err, buf) => {
    if (err) {
      // SPA fallback: unknown non-asset paths go to index.html when it exists.
      if (!relative.startsWith('/assets/')) {
        fs.readFile(path.join(distDir, 'index.html'), (err2, index) => {
          if (err2) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('前端构建产物不存在。开发模式请运行:npm run dev(另开终端 npm run server)。');
            return;
          }
          res.writeHead(200, { 'content-type': MIME['.html'] }).end(index);
        });
        return;
      }
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(candidate)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// A full score's start message carries one scoreEvent per note. A 1,600-note
// score is already >256KB, so the old 256KB cap made ws emit an unhandled
// WS_ERR_UNSUPPORTED_MESSAGE_LENGTH and killed the whole engine (manifesting
// as /api/scores 500 and a disconnected device). Keep a bounded but realistic
// cap; individual socket errors are handled below.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });

function broadcast(payload) {
  const json = JSON.stringify({ protocolVersion: 1, ...payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

// The active Take that should receive Node MIDI input. Set by the connection
// that owns the current session; events from a stale adapter generation are
// filtered inside the sink as well as by the Rust CaptureEpoch router.
let activeNodeSink = null;
// A device/browser can view shared history and Take templates at any time, but
// only one connection may own the live Take. Without this lease two browsers
// could each create a NativeSession while the global Node MIDI sink silently
// follows whichever started last.
let activeTakeLease = null;

midiAdapter.onEvent((event) => {
  broadcast({ type: 'midi-event', event });
  if (activeNodeSink) activeNodeSink(event);
});
midiAdapter.onStatus((status) => {
  broadcast({ type: 'midi-status', ...status });
});
midiAdapter.onDiagnostic((diagnostic) => {
  broadcast({ type: 'diagnostic', ...diagnostic });
});
// Health is orthogonal to lifecycle: the Take keeps Recording while degraded.
// Worst health observed during the active take; a later healthy status must
// not heal a transient overflow. The take-scoped hook is installed by the
// connection handler (serverTakeHealth), so this stays out of module scope.
const serverTakeHealth = { value: 'unknown' };

// The MIDI library has no portable hotplug callback. Poll at a low rate and
// publish only list changes; a missing selected port closes that connection.
let lastDeviceSignature = '';
const hotplugPoll = setInterval(() => {
  try {
    const devices = midiAdapter.refreshDevices();
    const signature = JSON.stringify(devices.map((device) => [device.id, device.name]));
    if (signature !== lastDeviceSignature) {
      lastDeviceSignature = signature;
      broadcast({ type: 'midi-devices', items: devices });
    }
  } catch { /* list failure is reported on explicit refresh/connect */ }
}, 2000);
hotplugPoll.unref?.();

function shutdown(signal) {
  console.log(`[engine] 关闭 (${signal})`);
  try { midiAdapter.close('server_shutdown'); } catch { /* best effort */ }
  try { server.close(() => process.exit(0)); } catch { process.exit(0); }
  setTimeout(() => process.exit(0), 500).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

wss.on('error', (error) => {
  console.error('[engine] WebSocket 服务错误:', String((error && error.message) || error));
});

wss.on('connection', (socket) => {
  socket.on('error', (error) => {
    console.error('[engine] WebSocket 连接错误:', String((error && error.message) || error));
    try { socket.close(1009, 'invalid websocket message'); } catch { /* best effort */ }
  });
  let native = null;   // addon.NativeSession
  let meta = null;     // { modeId, bpm, profile, assisted, durationPolicy, targets, countInMs }
  let pausedAtMs = null;
  let pausedSourceMs = null;      // performance-timeline timestamp at Pause
  let pauseIntervalsSourceMs = []; // flat [start, end, ...] pairs for duration policy
  // Pause segments in session time. Every admission decision references the
  // segment that was active when it was made; a Take that ends while paused
  // keeps an open segment instead of pretending the pause was active practice.
  let pauseSegments = [];          // [{ segmentId, startSession, endSession|null }]
  let pauseSegmentSeq = 0;
  let activePauseSegmentId = 'active-0';
  // Admission ledger: exactly one immutable decision per packet. Policy B: the
  // decision made at ingress is the only authority for whether an onset may be
  // scored. Final scoring consumes it and never re-derives it from onset time.
  const admissionByEventId = new Map();
  let admissionSeq = 0;
  // Session time of the last Note On that was successfully handed to pushHit.
  // The Rust matcher requires non-decreasing input times; comparing against this
  // (instead of wall/now time) isolates only genuine timestamp regressions.
  let lastAdmittedRealtimeOnsetMs = null;
  const admissionCounters = {
    packets: 0,
    noteOns: 0,
    nonOnsets: 0,
    admittedNoteOns: 0,
    pushHitCount: 0,
    finalPerformedNotes: 0,
    finalSkippedByAdmission: 0,
    finalDuplicateLifecycles: 0,
    suppressedNoteOns: { 'count-in': 0, paused: 0, clock: 0, duplicate: 0, 'out-of-order': 0 },
    captureQuarantinedPackets: 0,
    duplicateEventIds: 0,
  };
  let pauseSuppressed = 0;        // compat: packets suppressed by the pause policy (packet unit)
  let pauseExcludedFromScore = 0; // compat: observations skipped because the onset was suppressed
  let rawNotes = [];   // v0.3 legacy path
  let ingests = [];    // v0.6 raw packets (authoritative input)
  // Transport sequence and scoring sequence are different streams. sourceSeq
  // counts EVERY MIDI message (clock/active sensing/CC included), so handing it
  // to the core as the strictly-increasing hit seq produced false "lost event"
  // gaps on real hardware. Hits get their own dense sequence; sourceSeq remains
  // in the raw trace for transport diagnostics.
  let scoringSeq = 0;
  let countdownSuppressed = 0;
  // Rust-authoritative PracticeSession / PerformanceTake coordinator. It owns
  // take lifecycle, capture generations and quarantine counters; the scoring
  // engine stays per-Take.
  let coordinator = null;   // addon.NativeTakeCoordinator
  let activeTake = null;    // { takeId, captureEpoch, practiceSessionId, takeIndex }
  let traceRecorder = null; // TakeTraceRecorder for the active take
  let takeJournal = null;   // TakeJournal for the active take
  // Worst adapter health observed while this take is active. Installed as the
  // status hook target so health tracking survives only for the live take.
  const takeHealth = { value: 'unknown' };
  midiAdapter.onStatus(takeHealthHandler);
  function takeHealthHandler(status) {
    if (!activeTake) return;
    const order = ['unknown', 'healthy', 'degraded', 'disconnected'];
    if (order.indexOf(status.inputHealth) > order.indexOf(takeHealth.value)) {
      takeHealth.value = status.inputHealth;
      serverTakeHealth.value = status.inputHealth;
    }
    try { coordinator?.setInputHealth(activeTake.takeId, takeHealth.value); } catch { /* report keeps adapter health */ }
  }
  let practiceKey = null;   // mode/bpm/profile/score signature of the coordinator's session
  let lastNowMs = 0;
  // Node MIDI -> browser clock mapping for this connection.
  const clockPending = new Map();
  const clockSamples = [];
  let clockOffsetServerMinusClientMs = null;
  let clockUncertaintyMs = null;
  let clockQuality = 'unknown';
  let sessionOriginClientPerfMs = null;
  let nodeEventsMapped = 0;
  let nodeEventsUnmapped = 0;
  let nodeEventsStale = 0;
  // The duration assessor joins onset judgments to key observations by the
  // Note On's source_seq. The matcher now sees the dense scoring seq, so keep
  // the bridge here: score reports use scoringSeq, duration matching uses the
  // original transport seq. A future Take-model contract should carry both.
  const scoringSeqToSourceSeq = new Map();

  const send = (payload) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ protocolVersion: 1, ...payload }));
  };

  // A newly connected device panel needs the current state without waiting for
  // the next adapter event.
  send({ type: 'midi-status', ...midiAdapter.getStatus() });
  try {
    send({ type: 'midi-devices', items: midiAdapter.listInputs() });
  } catch (error) {
    send({
      type: 'midi-error',
      code: error?.code ?? 'MIDI_DEVICE_LIST_FAILED',
      message: String((error && error.message) || error),
    });
  }

  // An unrecoverable scoring/clock error closes the Take as Failed. The
  // coordinator keeps the trace and reason; the connection can start a new
  // Take instead of silently replacing a live one.
  const failActiveTake = (reason) => {
    if (activeNodeSink === handleNodeMidiEvent) activeNodeSink = null;
    if (coordinator && activeTake) {
      try {
        coordinator.fail(activeTake.takeId, lastNowMs, reason);
      } catch {
        try { coordinator.abort(activeTake.takeId, lastNowMs, reason); } catch { /* best effort */ }
      }
    }
    native = null;
    meta = null;
    activeTake = null;
    if (activeTakeLease?.socket === socket) activeTakeLease = null;
  };

  // Shared by browser/mock raw-midi messages and Node MIDI adapter events.
  // Attribution, admission, scoring sequence and judgments stay in this one path
  // so the two transports cannot diverge.
  function ingestRawPacket(ingest) {
    if (!native || !meta) return;
    if (!ingest || !ingest.packet) throw new Error('raw-midi 缺少 ingest.packet');
    const packet = ingest.packet;
    const atMs = ingest.sessionTimeMs == null ? null : Number(ingest.sessionTimeMs);
    if (atMs !== null && !Number.isFinite(atMs)) throw new Error('raw-midi 时间非法');
    const packetEpoch = packet.captureEpoch;
    if (packetEpoch != null) {
      if (!coordinator || !activeTake) throw new Error('没有活动中的练习轮次');
      // CaptureRouter quarantine is independent of scoring admission: a packet
      // from another epoch never becomes evidence for this Take.
      const routed = coordinator.routePacket(
        Number(packetEpoch),
        String(packet.sourceId),
        Number(packet.sourceSeq),
        atMs ?? Number(packet.capturedAtMs),
      );
      if (!routed.accepted || routed.takeId !== activeTake.takeId) {
        admissionCounters.captureQuarantinedPackets += 1;
        return;
      }
    }
    const decodedList = addon.decodeMidiPackets([ingest]);
    const decoded = decodedList[0];
    const admission = recordAdmission(decoded, packet, atMs);
    // Raw evidence is retained for every packet, including suppressed ones.
    ingests.push(ingest);
    traceRecorder?.append({
      seq: ingests.length,
      practiceSessionId: activeTake?.practiceSessionId ?? null,
      takeId: activeTake?.takeId ?? null,
      sourceId: packet.sourceId,
      sourceSeq: packet.sourceSeq,
      transport: packet.transport,
      captureEpoch: packet.captureEpoch ?? null,
      capturedAtMs: packet.capturedAtMs,
      handlerAtMs: Number.isFinite(Number(packet.handlerAtMs)) ? Number(packet.handlerAtMs) : null,
      sessionTimeMs: admission.sessionTimeMs,
      rawBytes: packet.rawBytes,
      messageType: decoded?.kind ?? 'unknown',
      clockQuality: ingest.clockQuality ?? null,
      // Compat diagnostic: the decision itself is authoritative.
      duringPause: admission.suppressionReason === 'paused',
      admission: {
        decisionId: admission.decisionId,
        reason: admission.suppressionReason,
        segmentId: admission.decisionSegmentId,
        realtime: admission.eligibleForRealtime,
        finalOnset: admission.eligibleForFinalOnsetScore,
        duplicateOf: admission.duplicateOf,
      },
      countdownSuppressed: admission.suppressionReason === 'count-in',
    });
    if (admission.suppressionReason === 'paused') pauseSuppressed += 1;
    if (admission.suppressionReason) {
      if (admission.suppressionReason === 'count-in') countdownSuppressed += 1;
      if (decoded && decoded.kind === 'note-on') {
        takeJournal?.append('input_suppressed', {
          decisionId: admission.decisionId,
          reason: admission.suppressionReason,
          atSessionMs: admission.sessionTimeMs,
          noteNumber: decoded.noteNumber ?? null,
          sourceSeq: Number(packet.sourceSeq),
        });
        // Compat with the previous take shape; the reason above is authoritative.
        if (admission.suppressionReason === 'paused') {
          takeJournal?.append('input_during_pause', {
            decisionId: admission.decisionId,
            atSessionMs: admission.sessionTimeMs,
            noteNumber: decoded.noteNumber ?? null,
            sourceSeq: Number(packet.sourceSeq),
          });
        }
      }
      return;
    }
    if (decoded && decoded.kind === 'note-on' && decoded.complete) {
      admissionCounters.pushHitCount += 1;
      scoringSeq += 1;
      scoringSeqToSourceSeq.set(scoringSeq, Number(packet.sourceSeq));
      try {
        native.pushHit({ seq: scoringSeq, atMs, source: 'keyboard', notes: [decoded.noteNumber] });
        // Only a successfully delivered onset becomes the monotonic baseline.
        lastAdmittedRealtimeOnsetMs = atMs;
      } catch (err) {
        failActiveTake('invalid_input');
        throw err;
      }
      send({ type: 'judgments', items: native.processPending() });
    }
  }

  /**
   * Policy B: one immutable decision per packet, made at ingress.
   * Priority: paused arrival -> clock availability -> closed pause segment ->
   * count-in -> admitted. A note-on is only scoring evidence when admitted.
   */
  function recordAdmission(decoded, packet, atMs) {
    const isNoteOn = decoded?.kind === 'note-on';
    const eventId = decoded?.eventId ?? null;
    // Identity first: a packet whose event id was already admitted/rejected is a
    // duplicate and can never produce a second hit or a second lifecycle.
    const existing = eventId ? admissionByEventId.get(eventId) : undefined;
    const complete = decoded?.complete !== false;
    let reason = null;
    if (existing) {
      reason = 'duplicate';
    } else if (pausedAtMs !== null) {
      reason = 'paused';
    } else if (atMs === null || !Number.isFinite(atMs)) {
      // Applies to note-offs too: an unmappable packet has no usable event time.
      reason = 'clock';
    } else if (isNoteOn && isInClosedPauseSegment(atMs)) {
      reason = 'paused';
    } else if (isNoteOn && atMs < meta.scoringStartMs) {
      reason = 'count-in';
    } else if (isNoteOn && complete && lastAdmittedRealtimeOnsetMs !== null
      && atMs < lastAdmittedRealtimeOnsetMs) {
      // The Rust matcher rejects non-monotonic onset times and invalidates the
      // whole session. Isolate the regression here; equal timestamps still pass.
      reason = 'out-of-order';
    }
    const admitted = isNoteOn && complete && reason === null && !existing;
    const decision = {
      decisionId: `adm-${++admissionSeq}`,
      eventId,
      sourceId: String(packet.sourceId),
      sourceSeq: Number(packet.sourceSeq),
      kind: decoded?.kind ?? 'unknown',
      decisionSegmentId: activePauseSegmentId,
      capturedAtMs: Number(packet.capturedAtMs),
      handlerAtMs: Number.isFinite(Number(packet.handlerAtMs)) ? Number(packet.handlerAtMs) : null,
      sessionTimeMs: atMs === null || !Number.isFinite(atMs) ? null : atMs,
      clockDomainId: packet.clockDomainId ?? null,
      suppressionReason: reason,
      duplicateOf: existing?.decisionId ?? null,
      eligibleForRealtime: admitted,
      eligibleForFinalOnsetScore: admitted,
    };
    admissionCounters.packets += 1;
    if (isNoteOn) {
      admissionCounters.noteOns += 1;
      if (admitted) admissionCounters.admittedNoteOns += 1;
      else if (reason) admissionCounters.suppressedNoteOns[reason] += 1;
    } else {
      admissionCounters.nonOnsets += 1;
    }
    if (eventId && !existing) {
      admissionByEventId.set(eventId, decision);
    } else if (existing) {
      admissionCounters.duplicateEventIds += 1;
    }
    return decision;
  }

  /** True for event times inside a pause segment that has already been closed. */
  function isInClosedPauseSegment(atMs) {
    return pauseSegments.some((segment) => segment.endSession !== null
      && atMs >= segment.startSession && atMs < segment.endSession);
  }

  /** Resets the admission ledger and pause segments for a new Take. */
  function resetAdmissionState() {
    admissionByEventId.clear();
    admissionSeq = 0;
    admissionCounters.packets = 0;
    admissionCounters.noteOns = 0;
    admissionCounters.nonOnsets = 0;
    admissionCounters.admittedNoteOns = 0;
    admissionCounters.pushHitCount = 0;
    admissionCounters.finalPerformedNotes = 0;
    admissionCounters.finalSkippedByAdmission = 0;
    admissionCounters.finalDuplicateLifecycles = 0;
    admissionCounters.captureQuarantinedPackets = 0;
    admissionCounters.duplicateEventIds = 0;
    admissionCounters.suppressedNoteOns['count-in'] = 0;
    admissionCounters.suppressedNoteOns.paused = 0;
    admissionCounters.suppressedNoteOns.clock = 0;
    admissionCounters.suppressedNoteOns.duplicate = 0;
    admissionCounters.suppressedNoteOns['out-of-order'] = 0;
    lastAdmittedRealtimeOnsetMs = null;
    pauseSegments = [];
    pauseSegmentSeq = 0;
    activePauseSegmentId = 'active-0';
    pauseSuppressed = 0;
    pauseExcludedFromScore = 0;
  }

  function handleNodeMidiEvent(event) {
    if (!native || !meta || !activeTake) return;
    const adapterStatus = midiAdapter.getStatus();
    if (event.connectionGeneration !== adapterStatus.generation) {
      nodeEventsStale += 1;
      return;
    }
    const mapped = mapNodeEventToSession({
      capturedAtMonotonicMs: event.capturedAtMonotonicMs,
      offsetServerMinusClientMs: clockOffsetServerMinusClientMs,
      sessionOriginClientPerfMs,
    });
    if (!mapped || mapped.atSessionMs < 0) {
      nodeEventsUnmapped += 1;
      // Policy B: an unmappable event still gets an explicit admission decision
      // (reason 'clock'). No session time is fabricated from the capture time.
      try {
        ingestRawPacket({
          packet: {
            sourceId: event.sourceId,
            sourceSeq: event.sourceSeq,
            clockDomainId: 'node-midi-monotonic',
            capturedAtMs: event.capturedAtMonotonicMs,
            handlerAtMs: event.capturedAtMonotonicMs,
            rawBytes: event.rawData,
            transport: 'node-midi',
            captureEpoch: activeTake.captureEpoch,
          },
          // napi-rs Option<f64> rejects null; omit the field to mean "no value".
          clockQuality: clockQuality === 'good' || clockQuality === 'estimated' || clockQuality === 'unstable'
            ? clockQuality
            : 'unknown',
        });
      } catch (error) {
        console.error('[engine] clock admission failed:', String((error && error.message) || error));
        send({ type: 'error', message: String((error && error.message) || error) });
      }
      return;
    }
    nodeEventsMapped += 1;
    const ingest = {
      packet: {
        sourceId: event.sourceId,
        sourceSeq: event.sourceSeq,
        clockDomainId: 'node-midi-monotonic',
        capturedAtMs: event.capturedAtMonotonicMs,
        handlerAtMs: event.capturedAtMonotonicMs,
        rawBytes: event.rawData,
        transport: 'node-midi',
        captureEpoch: activeTake.captureEpoch,
      },
      sessionTimeMs: mapped.atSessionMs,
      clockMappingId: 'node-to-browser-performance',
      clockUncertaintyMs: clockUncertaintyMs ?? 0,
      clockQuality: clockQuality === 'good' || clockQuality === 'estimated' || clockQuality === 'unstable'
        ? clockQuality
        : 'unknown',
    };
    try {
      ingestRawPacket(ingest);
    } catch (error) {
      send({ type: 'error', message: String((error && error.message) || error) });
    }
  }

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send({ type: 'error', message: '消息不是合法 JSON' });
      return;
    }
    try {
      handle(msg);
    } catch (err) {
      send({ type: 'error', message: String((err && err.message) || err) });
    }
  });

  socket.on('close', () => {
    if (activeNodeSink === handleNodeMidiEvent) activeNodeSink = null;
    // Switching browser/device closes this socket. Finalize the captured Take
    // into an explicit untrusted history record instead of losing it. This is
    // persistence of the interrupted attempt, not cross-device Take resumption.
    if (native && activeTake) {
      try {
        finishSession({ interrupted: true });
      } catch (err) {
        console.error('[engine] 断连结算失败:', String((err && err.message) || err));
        if (coordinator && activeTake) {
          try { coordinator.abort(activeTake.takeId, lastNowMs, 'connection_closed'); } catch { /* best effort */ }
        }
      }
    } else if (coordinator && activeTake) {
      try { coordinator.abort(activeTake.takeId, lastNowMs, 'connection_closed'); } catch { /* best effort */ }
    }
    // If finalization could not happen, keep at least the journal/trace.
    if (takeJournal) {
      takeJournal.append('take_aborted', { reason: 'connection_closed', atSessionMs: lastNowMs });
      takeJournal.finalize({ aborted: true });
      takeJournal = null;
    }
    if (traceRecorder) {
      traceRecorder.finalize();
      traceRecorder = null;
    }
    native = null;
    meta = null;
    activeTake = null;
    if (activeTakeLease?.socket === socket) activeTakeLease = null;
  });

  function handle(msg) {
    if (msg.protocolVersion != null && msg.protocolVersion !== 1) {
      send({ type: 'error', message: '不支持的 WebSocket protocolVersion' });
      return;
    }
    switch (msg.type) {
      case 'clock-ping': {
        const id = String(msg.id ?? '');
        const clientSendPerfMs = Number(msg.clientSendPerfMs);
        if (!id || !Number.isFinite(clientSendPerfMs)) return;
        const serverReceivePerfMs = performance.now();
        const serverSendPerfMs = performance.now();
        clockPending.set(id, { clientSendPerfMs, serverReceivePerfMs, serverSendPerfMs });
        if (clockPending.size > 64) clockPending.delete(clockPending.keys().next().value);
        send({ type: 'clock-pong', id, clientSendPerfMs, serverReceivePerfMs, serverSendPerfMs });
        break;
      }
      case 'clock-sample': {
        const id = String(msg.id ?? '');
        const pending = clockPending.get(id);
        if (!pending) return;
        clockPending.delete(id);
        const sample = computeClockSample({
          ...pending,
          clientReceivePerfMs: Number(msg.clientReceivePerfMs),
        });
        if (!sample) return;
        clockSamples.push(sample);
        if (clockSamples.length > 32) clockSamples.shift();
        const selected = selectClockSample(clockSamples);
        if (selected) {
          clockOffsetServerMinusClientMs = selected.offsetServerMinusClientMs;
          clockUncertaintyMs = selected.uncertaintyMs;
          clockQuality = selected.quality;
          send({ type: 'clock-status', ...selected });
        }
        break;
      }
      case 'session-origin': {
        const origin = Number(msg.clientPerfMs);
        if (Number.isFinite(origin)) sessionOriginClientPerfMs = origin;
        break;
      }
      case 'midi-refresh': {
        try {
          const devices = midiAdapter.listInputs();
          send({ type: 'midi-devices', items: devices });
          send({ type: 'midi-status', ...midiAdapter.getStatus() });
        } catch (error) {
          send({
            type: 'midi-error',
            code: error?.code ?? 'MIDI_DEVICE_LIST_FAILED',
            message: String((error && error.message) || error),
          });
        }
        break;
      }
      case 'midi-connect': {
        try {
          midiAdapter.openInput(String(msg.deviceId));
          send({ type: 'midi-status', ...midiAdapter.getStatus() });
          broadcast({ type: 'midi-devices', items: midiAdapter.listInputs() });
        } catch (error) {
          send({
            type: 'midi-error',
            code: error?.code ?? 'MIDI_INPUT_OPEN_FAILED',
            message: String((error && error.message) || error),
          });
          send({ type: 'midi-status', ...midiAdapter.getStatus() });
        }
        break;
      }
      case 'midi-disconnect': {
        midiAdapter.close('user');
        // close() already emitted the disconnected status; the extra send here
        // raced with take-scoped health tracking, so only fill gaps.
        break;
      }
      case 'midi-test-note': {
        // Software-only integration test hook; never enabled in production.
        if (process.env.RHYTHM_MIDI_BACKEND === 'mock' && Array.isArray(msg.bytes)) {
          midiAdapter.injectMessage(msg.bytes);
        }
        break;
      }
      case 'start': {
        // One active Take at a time across all browsers. Replacing a live Take
        // silently would discard its trace/report and make MIDI ownership
        // ambiguous; reject instead of repairing.
        if (activeTakeLease && activeTakeLease.socket !== socket) {
          if (activeTakeLease.socket.readyState === 1) {
            throw new Error('另一个设备有进行中的练习，请先结束那一轮或等待其断连保存');
          }
          activeTakeLease = null;
        }
        if (native) throw new Error('已有进行中的练习轮次，请先结束当前轮次');
        rawNotes = [];
        ingests = [];
        scoringSeq = 0;
        countdownSuppressed = 0;
        scoringSeqToSourceSeq.clear();
        pausedAtMs = null;
        pausedSourceMs = null;
        pauseIntervalsSourceMs = [];
        resetAdmissionState();
        lastNowMs = 0;
        const bpm = Number(msg.bpm);
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) throw new Error('BPM 需在 20–300 之间');
        const countInBeats = Number(msg.countInBeats) || 4;
        const ticksPerQuarter = Number(msg.ticksPerQuarter) || 960;
        if (!Array.isArray(msg.atoms) || msg.atoms.length === 0) throw new Error('乐谱目标为空,无法生成练习计划');
        // Mode → effective scoring config: single resolution point. Overrides
        // that a mode declares N/A are rejected, not silently dropped.
        const scoringConfig = resolveModeScoringConfig({
          modeId: msg.modeId,
          userOverrides: {
            ...(msg.profile ? { profile: msg.profile } : {}),
            ...(msg.durationPolicy ? { durationPolicy: msg.durationPolicy } : {}),
            ...(msg.feedback ? { feedback: msg.feedback } : {}),
          },
        });
        const profile = scoringConfig.judgmentProfile;
        const durationPolicy = scoringConfig.durationPolicy;
        // Traceability from the semantic score engine (never used for scoring).
        const scoreFingerprint = typeof msg.scoreFingerprint === 'string' ? msg.scoreFingerprint : null;
        const playbackPlanId = typeof msg.playbackPlanId === 'string' ? msg.playbackPlanId : null;
        const scoreImportStatus = typeof msg.scoreImportStatus === 'string' ? msg.scoreImportStatus : null;
        const hand = msg.hand === 'both' || msg.hand === 'right' || msg.hand === 'left' ? msg.hand : null;
        const scoreBarCountValue = Number(msg.scoreBarCount);
        const scoreBarCount = Number.isInteger(scoreBarCountValue) && scoreBarCountValue > 0
          ? scoreBarCountValue
          : null;
        // Saved Take template: a reusable config, never a performance record.
        // The new Session/Take links to it; the template itself is immutable.
        const takeTemplateId = safeId(msg.takeTemplateId || '');
        const takeTemplate = takeTemplateId ? takeTemplateStore.read(takeTemplateId) : null;
        if (msg.takeTemplateId && !takeTemplate) {
          throw new Error('保存的 Take 不存在，不能开始本轮');
        }
        if (takeTemplate?.scoreFingerprint && scoreFingerprint
          && takeTemplate.scoreFingerprint !== scoreFingerprint) {
          throw new Error('当前曲谱与保存的 Take 不一致');
        }
        // B2 targeted practice: source report/Take and the confirmed rule
        // prescription. Validate the immutable source record before creating a
        // new Take; a failed validation leaves no half task behind.
        const sourceReportId = safeId(msg.sourceReportId || '');
        const sourceTakeId = safeId(msg.sourceTakeId || '');
        const prescriptionId = safeId(msg.prescriptionId || '');
        const prescription = msg.prescription && typeof msg.prescription === 'object' && !Array.isArray(msg.prescription)
          ? msg.prescription
          : null;
        const hasTargetedPayload = !!(msg.sourceReportId || msg.sourceTakeId || msg.prescriptionId || msg.prescription);
        if (hasTargetedPayload) {
          if (!sourceReportId || !sourceTakeId || !prescriptionId || !prescription) {
            throw new Error('复练任务缺少 sourceReportId/sourceTakeId/prescriptionId/prescription');
          }
          const sourceRecord = readSessionRecord(sourceReportId);
          if (!sourceRecord) throw new Error('找不到来源报告，不能创建复练任务');
          if (!sourceRecord.takeId || sourceRecord.takeId !== sourceTakeId) {
            throw new Error('来源 Take 与来源报告不匹配');
          }
          if (!sourceRecord.scoreV1 || ('error' in sourceRecord.scoreV1)) {
            throw new Error('来源报告没有可用的完整评分，不能创建复练任务');
          }
          if (!sourceRecord.scoreFingerprint || !scoreFingerprint
            || sourceRecord.scoreFingerprint !== scoreFingerprint) {
            throw new Error('复练曲谱与来源报告不一致，不能创建任务');
          }
          if (sourceRecord.scoreBarCount && scoreBarCount && sourceRecord.scoreBarCount !== scoreBarCount) {
            throw new Error('复练小节总数与来源报告不一致');
          }
          if (prescription.sourceReportId !== sourceReportId
            || prescription.sourceTakeId !== sourceTakeId
            || prescription.prescriptionId !== prescriptionId) {
            throw new Error('处方来源引用与本次复练请求不一致');
          }
          const range = prescription.measureRange;
          if (!range || !Number.isInteger(range.startMeasure) || !Number.isInteger(range.endMeasure)
            || range.startMeasure < 1 || range.endMeasure < range.startMeasure
            || (scoreBarCount != null && range.endMeasure > scoreBarCount)) {
            throw new Error('处方小节范围非法');
          }
          if (!['EXECUTABLE', 'MANUAL'].includes(prescription.status)) {
            throw new Error('处方状态不可执行');
          }
          if (prescription.recommendedMode !== 'loop') {
            throw new Error('当前复练只支持 loop 范围任务');
          }
          if (!['both', 'right', 'left'].includes(prescription.recommendedHand)) {
            throw new Error('处方手别非法');
          }
          if (!Number.isFinite(prescription.recommendedBpm)
            || prescription.recommendedBpm < 20 || prescription.recommendedBpm > 300) {
            throw new Error('处方 BPM 非法');
          }
          if (prescription.recommendedBpm !== bpm || prescription.recommendedHand !== hand) {
            throw new Error('复练 BPM/手别与已确认处方不一致');
          }
          const rangeStart = prescription.measureRange.startMeasure;
          const rangeEnd = prescription.measureRange.endMeasure;
          const outsideRange = msg.atoms.find((atom) => (
            Number.isInteger(Number(atom.bar))
            && (Number(atom.bar) < rangeStart || Number(atom.bar) > rangeEnd)
          ));
          if (outsideRange) {
            throw new Error('复练 atoms 超出处方小节范围');
          }
        }
        // Per-note final-score events derived by the frontend from the same
        // PlaybackPlan as the atoms. Invalid entries are rejected here so a
        // later scorePerformance call cannot silently use a partial plan.
        const scoreEvents = Array.isArray(msg.scoreEvents)
          ? msg.scoreEvents.map((event) => ({
            scoreEventId: String(event.scoreEventId ?? ''),
            measure: Number(event.measure),
            beatPosition: Number(event.beatPosition),
            pitch: Number(event.pitch),
            targetOnsetMs: Number(event.targetOnsetMs),
            targetDurationMs: Number(event.targetDurationMs),
            partId: String(event.partId ?? ''),
            parseConfidence: event.parseConfidence == null ? 1 : Number(event.parseConfidence),
          }))
          : null;
        if (scoreEvents) {
          const invalid = scoreEvents.find((event) => !event.scoreEventId
            || !Number.isFinite(event.targetOnsetMs)
            || !Number.isFinite(event.targetDurationMs)
            || !Number.isInteger(event.pitch)
            || event.pitch < 0 || event.pitch > 127
            || !Number.isInteger(event.measure) || event.measure < 1);
          if (invalid) throw new Error('scoreEvents 含非法目标，无法形成可评分计划');
          // P1-3: identity and value integrity. Duplicate IDs make per-note
          // results ambiguous; a non-positive duration cannot express a note.
          const seenIds = new Set();
          for (const event of scoreEvents) {
            if (seenIds.has(event.scoreEventId)) {
              throw new Error(`scoreEvents 目标 ID 重复: ${event.scoreEventId}`);
            }
            seenIds.add(event.scoreEventId);
            if (!(event.targetDurationMs > 0)) {
              throw new Error(`scoreEvents 目标 ${event.scoreEventId} 的时值必须为正`);
            }
          }
          if (hasTargetedPayload) {
            const rangeStart = prescription.measureRange.startMeasure;
            const rangeEnd = prescription.measureRange.endMeasure;
            const outsideRange = scoreEvents.find((event) => (
              event.measure < rangeStart || event.measure > rangeEnd
            ));
            if (outsideRange) throw new Error('scoreEvents 超出处方小节范围');
          }
        }

        const pattern = {
          id: `frontend-${msg.modeId}-${Date.now()}`,
          ticksPerQuarter,
          atoms: msg.atoms.map((atom) => ({
            startTick: Number(atom.startTick),
            durationTicks: Number(atom.durationTicks),
            kind: atom.kind === 'rest' ? 'rest' : 'note',
            bar: Number(atom.bar),
            beat: Number(atom.beat),
          })),
        };
        const countInMs = countInBeats * (60_000 / bpm);
        const targets = addon.buildSchedule(pattern, bpm, countInMs, profile);
        // P1-3: prove atoms and scoreEvents describe the SAME plan before any
        // take starts. Data model (playback-planner.ts): one EngineAtom per
        // PlaybackGroup (an onset group that may contain several notes), and
        // one scoreEvent per notated note. So the verifiable invariants are
        // per-onset-GROUP, not per-note:
        //   - the set of scoreEvents onset groups == the set of targets;
        //   - each onset group maps to exactly one note atom;
        //   - the group's duration equals the group's LONGEST scoreEvent (the
        //     atom records group.durationBeat, i.e. the max, not per-note).
        // Per-note count/pitch cannot be verified against atoms (they carry no
        // pitch or note count) and need explicit group IDs in a future contract.
        if (scoreEvents && scoreEvents.length > 0) {
          const targetOnsets = targets.map((target) => Number(target.atMs));
          const offPlan = scoreEvents.find((event) => !targetOnsets.some(
            (atMs) => Number.isFinite(atMs) && Math.abs(atMs - event.targetOnsetMs) <= 0.5,
          ));
          if (offPlan) {
            throw new Error(`scoreEvents 目标 ${offPlan.scoreEventId} 的 onset 不在本次练习时间线上`);
          }
          const scoreEventsByOnset = new Map();
          for (const event of scoreEvents) {
            const key = targetOnsets.find((atMs) => Math.abs(atMs - event.targetOnsetMs) <= 0.5);
            const group = scoreEventsByOnset.get(key) ?? [];
            group.push(event);
            scoreEventsByOnset.set(key, group);
          }
          if (scoreEventsByOnset.size !== targets.length) {
            throw new Error(`scoreEvents 与目标时间线不一致：覆盖 ${scoreEventsByOnset.size} 个 onset，目标 ${targets.length} 个`);
          }
          const noteAtomsByOnset = new Map();
          for (const atom of pattern.atoms) {
            if (atom.kind !== 'note') continue;
            const atMs = countInMs + (atom.startTick / ticksPerQuarter) * (60_000 / bpm);
            const onset = targetOnsets.find((value) => Math.abs(value - atMs) <= 0.5);
            if (onset == null) continue; // buildSchedule merged same-tick atoms already
            if (noteAtomsByOnset.has(onset)) {
              throw new Error(`atoms 在 onset ${onset.toFixed(1)}ms 处出现多个起音组（应已被 buildSchedule 合并）`);
            }
            noteAtomsByOnset.set(onset, atom);
          }
          for (const [onset, events] of scoreEventsByOnset) {
            const atom = noteAtomsByOnset.get(onset);
            if (!atom) {
              throw new Error(`scoreEvents 的 onset ${onset.toFixed(1)}ms 没有对应的 note atom`);
            }
            // One atom = one onset group; the group's nominal duration is the
            // LONGEST member (group.durationBeat). Compare against the longest
            // scoreEvent of the group, not each note individually.
            const longestEventMs = Math.max(...events.map((event) => event.targetDurationMs));
            const nominalMs = (atom.durationTicks / ticksPerQuarter) * (60_000 / bpm);
            if (Math.abs(longestEventMs - nominalMs) > 1) {
              throw new Error(`scoreEvents 在 onset ${onset.toFixed(1)}ms 处的组时值 ${longestEventMs.toFixed(1)}ms 与计划 ${nominalMs.toFixed(1)}ms 不一致`);
            }
          }
          // Measure coverage: the set of measures in scoreEvents must equal the
          // set of bars spanned by note atoms.
          const scoreBars = new Set(scoreEvents.map((event) => event.measure));
          const atomBars = new Set(pattern.atoms.filter((atom) => atom.kind === 'note').map((atom) => atom.bar));
          if (scoreBars.size !== atomBars.size || [...atomBars].some((bar) => !scoreBars.has(bar))) {
            throw new Error(`scoreEvents 的小节覆盖与 atoms 不一致（scoreEvents: ${[...scoreBars].sort((a, b) => a - b).join(',')} / atoms: ${[...atomBars].sort((a, b) => a - b).join(',')}）`);
          }
        }
        const atomSignature = msg.atoms.map((atom) => `${Number(atom.startTick)}:${Number(atom.durationTicks)}`).join(',');
        const nextPracticeKey = `${msg.modeId}|${bpm}|${profile}|${atomSignature}|${scoreFingerprint ?? ''}|${sourceReportId ?? ''}|${prescriptionId ?? ''}`;
        // Same practice config => same PracticeSession, next Take. A different
        // score/BPM/profile starts a new session so takes cannot share a stale
        // fingerprint.
        if (!coordinator || practiceKey !== nextPracticeKey) {
          practiceKey = nextPracticeKey;
          practiceSessionCounter += 1;
          coordinator = new addon.NativeTakeCoordinator(
            `practice-${Date.now()}-${practiceSessionCounter}`,
            `frontend-${msg.modeId}-${bpm}-${targets.length}`,
            profile,
          );
          activeTake = null;
        }
        const take = coordinator.beginTake(0);
        const nextNative = new addon.NativeSession(targets, QUEUE_CAPACITY, FINALIZATION_GRACE_MS);
        nextNative.start();
        native = nextNative;
        activeTake = {
          takeId: take.takeId,
          captureEpoch: take.captureEpoch,
          practiceSessionId: take.practiceSessionId,
          takeIndex: take.takeIndex,
        };
        activeTakeLease = {
          socket,
          takeId: take.takeId,
          practiceSessionId: take.practiceSessionId,
        };
        const traceId = `trace-${take.practiceSessionId}-${take.takeId}`;
        traceRecorder = new TakeTraceRecorder({
          traceId,
          practiceSessionId: take.practiceSessionId,
          takeId: take.takeId,
          captureEpoch: take.captureEpoch,
          dir: TRACES_DIR,
        });
        takeJournal = new TakeJournal({
          journalId: `journal-${take.practiceSessionId}-${take.takeId}`,
          practiceSessionId: take.practiceSessionId,
          takeId: take.takeId,
          captureEpoch: take.captureEpoch,
          dir: JOURNALS_DIR,
        });
        takeJournal.append('take_started', {
          modeId: msg.modeId,
          bpm,
          profile,
          countInBeats,
          targetCount: targets.length,
          captureEpoch: take.captureEpoch,
          scoringConfig,
          scoreFingerprint,
          playbackPlanId,
          scoreImportStatus,
          hand,
          scoreBarCount,
          sourceReportId,
          sourceTakeId,
          prescriptionId,
          takeTemplateId,
          takeTemplateName: takeTemplate?.name ?? null,
        });
        sessionOriginClientPerfMs = null;
        nodeEventsMapped = 0;
        nodeEventsUnmapped = 0;
        nodeEventsStale = 0;
        activeNodeSink = handleNodeMidiEvent;
        takeHealth.value = midiAdapter.getStatus().inputHealth === 'healthy' ? 'healthy' : 'unknown';
        serverTakeHealth.value = takeHealth.value;
        try { coordinator.setInputHealth(take.takeId, takeHealth.value); } catch { /* keep adapter health in report */ }
        // Notes before the first target's early tolerance are count-in input:
        // keep them in the trace, but do not score them. Starting at the early
        // window instead of exactly countInMs preserves legitimate early
        // attacks on the first beat.
        const scoringStartMs = targets.length
          ? Math.max(0, targets[0].atMs - targets[0].goodWindowMs)
          : countInMs;
        meta = {
          modeId: msg.modeId, bpm, profile, assisted: !!msg.assisted,
          durationPolicy, targets, countInMs, scoringStartMs, ...activeTake,
          atoms: pattern.atoms,
          countInBeats,
          ticksPerQuarter,
          scoringConfig,
          scoreFingerprint,
          playbackPlanId,
          scoreImportStatus,
          scoreEvents,
          hand,
          scoreBarCount,
          sourceReportId,
          sourceTakeId,
          prescriptionId,
          prescription,
          takeTemplateId,
          takeTemplateName: takeTemplate?.name ?? null,
          takeTemplateUpdatedAtIso: takeTemplate?.updatedAtIso ?? null,
        };
        meta.assisted = scoringConfig.feedback === 'live';
        send({
          type: 'started', bpm, profile, countInBeats, targets,
          countInMs,
          firstTargetAtMs: targets.length > 0 ? targets[0].atMs : null,
          scoreFingerprint,
          playbackPlanId,
          scoreImportStatus,
          hand,
          scoreBarCount,
          sourceReportId,
          sourceTakeId,
          prescriptionId,
          takeTemplateId,
          takeTemplateName: takeTemplate?.name ?? null,
          captureEpoch: take.captureEpoch,
          practiceSessionId: take.practiceSessionId,
          takeId: take.takeId,
          takeIndex: take.takeIndex,
          scoringConfig,
        });
        break;
      }
      case 'hit': {
        if (!native) return;
        const seq = Number(msg.seq);
        const atMs = Number(msg.atMs);
        if (!Number.isFinite(seq) || !Number.isFinite(atMs)) throw new Error('hit 字段非法');
        const notes = Array.isArray(msg.notes) ? msg.notes.map(Number).filter((n) => Number.isFinite(n)) : [];
        try {
          native.pushHit({ seq, atMs, source: 'keyboard', notes });
        } catch (err) {
          failActiveTake('invalid_input');
          throw err;
        }
        send({ type: 'judgments', items: native.processPending() });
        break;
      }
      case 'note-on':
      case 'note-off': {
        // v0.3 legacy path (kept for old clients/selftest) — superseded by raw-midi.
        if (!native) return;
        const seq = Number(msg.seq);
        const atMs = Number(msg.atMs);
        const pitch = Number(msg.pitch);
        if (!Number.isFinite(seq) || !Number.isFinite(atMs) || !Number.isFinite(pitch)) {
          throw new Error('note 事件字段非法');
        }
        if (pitch < 0 || pitch > 127) throw new Error('pitch 需在 0–127 之间');
        const velocity = msg.velocity == null ? null : Number(msg.velocity);
        const event = {
          seq, atMs, pitch,
          kind: msg.type === 'note-on' ? 'note_on' : 'note_off',
        };
        // napi-rs Option<u32> rejects null; omit the field instead.
        if (velocity != null && Number.isFinite(velocity)) event.velocity = velocity;
        rawNotes.push(event);
        break;
      }
      case 'raw-midi': {
        // Browser/mock input remains the same raw-packet path. Node MIDI uses
        // the same function from the adapter sink, never a second scoring path.
        ingestRawPacket(msg.ingest);
        break;
      }
      case 'tick': {
        if (!native) return;
        // Advancing a paused NativeSession is invalid. The client already
        // stops its tick timer on pause, but a late/queued tick must also be
        // harmless instead of closing the report with an engine error.
        if (pausedAtMs !== null) return;
        const nowMs = Number(msg.nowMs);
        if (!Number.isFinite(nowMs)) return;
        lastNowMs = nowMs;
        send({ type: 'judgments', items: native.advance(nowMs) });
        break;
      }
      case 'pause': {
        if (!native) return;
        const nowMs = Number(msg.nowMs);
        if (!Number.isFinite(nowMs)) throw new Error('pause 时间非法');
        if (coordinator && activeTake) coordinator.pause(activeTake.takeId, nowMs);
        const judgments = native.pause(nowMs);
        pausedAtMs = nowMs;
        pauseSegmentSeq += 1;
        const pauseSegment = { segmentId: `pause-${pauseSegmentSeq}`, startSession: nowMs, endSession: null };
        pauseSegments.push(pauseSegment);
        activePauseSegmentId = pauseSegment.segmentId;
        const pauseSourceMs = Number(msg.atSourceMs);
        pausedSourceMs = Number.isFinite(pauseSourceMs) ? pauseSourceMs : null;
        lastNowMs = nowMs;
        takeJournal?.append('pause_boundary', {
          atSessionMs: nowMs,
          atSourceMs: pausedSourceMs,
          segmentId: pauseSegment.segmentId,
        });
        send({ type: 'judgments', items: judgments });
        send({ type: 'paused' });
        break;
      }
      case 'resume': {
        if (!native) return;
        const nowMs = Number(msg.nowMs);
        if (!Number.isFinite(nowMs)) throw new Error('resume 时间非法');
        if (coordinator && activeTake) coordinator.resume(activeTake.takeId, nowMs);
        native.resume(nowMs);
        const deltaMs = pausedAtMs === null ? 0 : nowMs - pausedAtMs;
        const openSegment = pauseSegments.find((segment) => segment.endSession === null);
        if (openSegment) openSegment.endSession = nowMs;
        pauseSegmentSeq += 1;
        activePauseSegmentId = `active-${pauseSegmentSeq}`;
        const resumeSourceMs = Number(msg.atSourceMs);
        if (pausedSourceMs !== null && Number.isFinite(resumeSourceMs) && resumeSourceMs >= pausedSourceMs) {
          pauseIntervalsSourceMs.push(pausedSourceMs, resumeSourceMs);
        }
        pausedSourceMs = null;
        pausedAtMs = null;
        lastNowMs = nowMs;
        takeJournal?.append('resume_boundary', { atSessionMs: nowMs, deltaMs });
        send({ type: 'resumed', deltaMs, resumedAtMs: nowMs });
        break;
      }
      case 'finish': {
        finishSession();
        break;
      }
      default:
        break; // unknown messages are ignored, never fatal
    }
  }

  function finishSession({ interrupted = false } = {}) {
    if (!native) return;
    // Drain Node input that was captured before the stop boundary, then close
    // the sink so events arriving during finalization cannot enter the take.
    try { midiAdapter.flush(); } catch { /* adapter diagnostics already emitted */ }
    if (activeNodeSink === handleNodeMidiEvent) activeNodeSink = null;
    const finishedTake = activeTake;
    if (interrupted) {
      // A browser/device switch closes this socket. Preserve the captured Take
      // as an explicitly untrusted, interrupted report instead of dropping it.
      takeHealth.value = 'disconnected';
      takeJournal?.append('connection_closed', { atSessionMs: lastNowMs });
    }
    // Worst health OBSERVED during the take (never "upgraded" by the order list).
    const worstHealth = takeHealth.value;
    // Close the scoreable gate before the final drain; the coordinator keeps
    // the Take in Finalizing until the report has been persisted.
    if (coordinator && finishedTake) {
      try {
        coordinator.stop(finishedTake.takeId, lastNowMs);
        takeJournal?.append('stop_boundary', { atSessionMs: lastNowMs });
      } catch (err) {
        console.error('[engine] Take stop 失败:', String((err && err.message) || err));
      }
    }
    const takeSnapshot = coordinator ? coordinator.snapshot() : null;
    const report = native.finish();
    native = null;
    // A Node input stream with an unstable/unknown browser mapping cannot
    // support sample-accurate synchronization. Keep the judgments visible but
    // never call the attempt trustworthy or feed it to mastery evidence.
    const nodeMappingLost = nodeEventsUnmapped > 0 || nodeEventsStale > 0;
    const clockMappingStatus = nodeMappingLost
      ? 'unscorable'
      : nodeEventsMapped === 0
        ? 'ok'
        : clockQuality === 'unstable' || clockQuality === 'unknown'
          ? 'unscorable'
          : clockQuality === 'estimated'
            ? 'limited'
            : 'ok';
    const clockMapping = {
      quality: clockQuality,
      uncertaintyMs: clockUncertaintyMs,
      mappedEvents: nodeEventsMapped,
      status: clockMappingStatus,
      reason: clockMappingStatus === 'unscorable'
        ? nodeMappingLost
          ? `Node MIDI 有 ${nodeEventsUnmapped + nodeEventsStale} 个事件未能映射到本次会话；同步计时不可作为精确成绩`
          : 'Node MIDI 到浏览器时钟映射不稳定或未知；本次同步计时不可作为精确成绩'
        : clockMappingStatus === 'limited'
          ? 'Node MIDI 时钟映射为估计值；同步精度受限'
          : 'Node MIDI 时钟映射正常',
    };
    if (clockMappingStatus === 'unscorable' || interrupted) report.trustworthy = false;
    const traceInfo = traceRecorder ? traceRecorder.finalize() : null;
    traceRecorder = null;
    const journalInfo = takeJournal
      ? takeJournal.finalize({
          trustworthy: report.trustworthy,
          stats: {
            targetCount: report.targetCount,
            missCount: report.stats.missCount,
            extraCount: report.stats.extraCount,
          },
          traceId: traceInfo ? traceInfo.traceId : null,
          traceDropped: traceInfo ? traceInfo.dropped : 0,
          inputHealth: worstHealth,
        })
      : null;
    takeJournal = null;
    // A Take can end while still paused. Close the open interval so a key held
    // across that pause is marked as crossed rather than graded normally.
    if (pausedSourceMs !== null) {
      pauseIntervalsSourceMs.push(pausedSourceMs, Number.MAX_SAFE_INTEGER);
      pausedSourceMs = null;
    }
    if (pausedAtMs !== null) {
      // The Take ended while paused. The segment stays open on purpose: it is
      // evidence that this tail of the Take was not active practice.
      pausedAtMs = null;
    }

    let analysis = null;
    try {
      // Mode config gates which coaching dimensions this take reports.
      const diagnosis = meta?.scoringConfig?.diagnosis ?? {};
      analysis = addon.analyzeTiming(report.judgments, {
        measurementTrustworthy: report.trustworthy,
        restReentryTargetIds: [],
        offbeatTargetIds: [],
      }, meta ? meta.bpm : null);
      if (analysis && !analysis.error) {
        // Mode config gates which coaching dimensions this take reports.
        // rest_reentry/offbeat depend on parsed-score context that the current
        // fixture cannot provide, so they stay off in every mode for now.
        if (Array.isArray(analysis.report?.diagnostics)) {
          analysis.report.diagnostics = analysis.report.diagnostics.filter((diagnostic) => {
            if (diagnostic?.issue === 'rest_reentry_timing' || diagnostic?.issue === 'offbeat_timing') return false;
            return true;
          });
        }
        analysis.modeScope = {
          modeId: meta?.modeId,
          diagnosis,
          pitchHint: meta?.scoringConfig?.pitchHint ?? false,
        };
      }
    } catch (err) {
      analysis = { error: String((err && err.message) || err) };
    }

    // v0.6 authoritative path: raw packets -> tracker -> key-press grading.
    // v0.3 legacy path (rawNotes) kept for old clients only.
    let keyLifecycles = null;
    let durations = null;
    if (meta && meta.durationPolicy && ingests.length > 0) {
      try {
        keyLifecycles = addon.trackKeyLifecycles(ingests);
        // Duration assessment still joins by source_seq. Re-point the report's
        // dense scoring seq at the original transport seq for this call only;
        // the returned report keeps the scoring seq.
        const durationJudgments = report.judgments.map((judgment) => {
          if (judgment.strikeSeq == null) return judgment;
          const sourceSeq = scoringSeqToSourceSeq.get(judgment.strikeSeq);
          return sourceSeq == null ? judgment : { ...judgment, strikeSeq: sourceSeq };
        });
        const durationOptions = {
          policy: meta.durationPolicy,
          toleranceMs: DURATION_TOLERANCE_MS,
          toleranceRatio: DURATION_TOLERANCE_RATIO,
        };
        if (pauseIntervalsSourceMs.length > 0) {
          durationOptions.pauseIntervalsSourceMs = pauseIntervalsSourceMs;
        }
        durations = attachDurationMeasures(
          addon.assessKeyPresses(meta.targets, keyLifecycles.observations, durationJudgments, durationOptions),
          meta.targets,
        );
      } catch (err) {
        keyLifecycles = { error: String((err && err.message) || err) };
      }
    } else if (meta && meta.durationPolicy && rawNotes.length > 0) {
      try {
        durations = attachDurationMeasures(
          addon.assessDurations(meta.targets, rawNotes, report.judgments, {
            policy: meta.durationPolicy,
            toleranceMs: DURATION_TOLERANCE_MS,
            toleranceRatio: DURATION_TOLERANCE_RATIO,
          }),
          meta.targets,
        );
      } catch (err) {
        durations = { error: String((err && err.message) || err) };
      }
    }

    // ---- B1 final score (scoring_v1 through NAPI) ----
    // The score events were built by the frontend from the same PlaybackPlan
    // that produced the atoms. Performed notes use the mapped session times of
    // the key-lifecycle events, never raw device clocks.
    let scoreV1 = null;
    let scoreStatus = 'UNAVAILABLE';
    let scoreConfigVersion = null;
    let scoreAlgorithmVersion = null;
    let scoreInputNoteCount = 0;
    let scoreUnmappedNoteCount = 0;
    let pauseAdjusted = false;
    try {
      if (meta && Array.isArray(meta.scoreEvents) && meta.scoreEvents.length > 0) {
        const decoded = addon.decodeMidiPackets(ingests);
        const sessionTimeByEventId = new Map();
        for (const event of decoded) {
          // decodeMidiPackets returns the mapped session time directly; do not
          // reconstruct it from a different clock domain.
          if (Number.isFinite(event.sessionTimeMs)) {
            sessionTimeByEventId.set(event.eventId, Number(event.sessionTimeMs));
          }
        }
        const observations = keyLifecycles && !keyLifecycles.error && Array.isArray(keyLifecycles.observations)
          ? keyLifecycles.observations
          : [];
        const statusMap = {
          complete: 'complete',
          'missing-note-off': 'missing-release',
          'interrupted-by-disconnect': 'missing-release',
          'ambiguous-pairing': 'ambiguous',
          'invalid-time': 'invalid-time',
        };
        // Policy B: final scoring consumes the ingress admission decision. It
        // never re-derives "was this paused?" from the onset time, so a note the
        // realtime path suppressed can never reappear here.
        const closedPauseSegments = pauseSegments.filter((segment) => segment.endSession !== null);
        const performedNotes = [];
        // One Note On may produce at most one performed-note lifecycle, even if
        // a duplicate packet slipped past the ingress guard.
        const consumedOnsetEventIds = new Set();
        for (const observation of observations) {
          if (consumedOnsetEventIds.has(observation.noteOnEventId)) {
            admissionCounters.finalDuplicateLifecycles += 1;
            continue;
          }
          consumedOnsetEventIds.add(observation.noteOnEventId);
          const admission = admissionByEventId.get(observation.noteOnEventId);
          if (!admission) {
            // A lifecycle without an admission decision is a structural gap, not
            // a scoring opportunity; fail closed and count it.
            scoreUnmappedNoteCount += 1;
            admissionCounters.finalSkippedByAdmission += 1;
            continue;
          }
          if (!admission.eligibleForFinalOnsetScore) {
            admissionCounters.finalSkippedByAdmission += 1;
            if (admission.suppressionReason === 'paused') pauseExcludedFromScore += 1;
            continue;
          }
          const onsetMs = admission.sessionTimeMs;
          if (!Number.isFinite(onsetMs)) {
            scoreUnmappedNoteCount += 1;
            admissionCounters.finalSkippedByAdmission += 1;
            continue;
          }
          const releaseCandidate = observation.noteOffEventId
            ? sessionTimeByEventId.get(observation.noteOffEventId)
            : null;
          const releaseMs = Number.isFinite(releaseCandidate) ? Number(releaseCandidate) : null;
          const pairingStatus = releaseMs == null && statusMap[observation.status] === 'complete'
            ? 'missing-release'
            : (statusMap[observation.status] ?? 'invalid-time');
          const performedNote = {
            performedNoteId: observation.pressId,
            pitch: Number(observation.noteNumber),
            onsetMs: Number(onsetMs),
            pairingStatus,
          };
          // napi-rs Option<f64> rejects null. A key that never released (Take
          // ended while held, device unplugged) must omit the field so Rust sees
          // None, instead of turning the whole report INVALID.
          if (releaseMs != null) performedNote.releaseMs = releaseMs;
          performedNotes.push(performedNote);
        }
        scoreInputNoteCount = performedNotes.length;
        admissionCounters.finalPerformedNotes = performedNotes.length;

        const adjustedScoreEvents = meta.scoreEvents.map((event) => {
          let shift = 0;
          for (const pause of closedPauseSegments) {
            // The engine shifts unresolved targets at pause time. A target
            // whose planned onset is at/after the pause boundary belongs to the
            // shifted segment; already-played targets do not get double-shifted.
            if (event.targetOnsetMs >= pause.startSession) {
              shift += pause.endSession - pause.startSession;
            }
          }
          return shift === 0 ? event : { ...event, targetOnsetMs: event.targetOnsetMs + shift };
        });
        pauseAdjusted = closedPauseSegments.length > 0;

        scoreV1 = addon.scorePerformance(adjustedScoreEvents, performedNotes);
        scoreConfigVersion = scoreV1.configVersion ?? null;
        scoreAlgorithmVersion = scoreV1.algorithmVersion ?? null;
        scoreStatus = performedNotes.length === 0 ? 'INSUFFICIENT_DATA' : 'AVAILABLE';
        if (clockMapping.status === 'unscorable'
          || worstHealth === 'disconnected'
          || worstHealth === 'degraded'
          || scoreUnmappedNoteCount > 0) {
          scoreStatus = 'DEGRADED';
        } else if (scoreV1.dataDegraded) {
          scoreStatus = 'DEGRADED';
        } else if (scoreV1.confidence === 'low' || scoreV1.confidence === 'not-assessable') {
          // Low confidence means the evidence is too thin, not that the
          // performer scored zero. Keep "insufficient data" distinct from
          // "degraded input/clock" and from a real available score.
          scoreStatus = 'INSUFFICIENT_DATA';
        }
      }
    } catch (err) {
      scoreV1 = { error: String((err && err.message) || err) };
      scoreStatus = 'INVALID';
    }

    // Input-attribution counters (the seed of the Take Model's quarantine /
    // health reporting): how many packets the client forwarded, how many were
    // not scored because they fell inside the count-in, and the dense scoring
    // sequence length. sourceSeq gaps from clock/CC are intentionally not
    // treated as lost scoring events. Note: the client currently forwards only
    // note packets, so this is a trace of forwarded input, not the full device
    // stream.
    const adapterStatus = midiAdapter.getStatus();
    const captureDiagnostics = {
      forwardedPackets: ingests.length,
      scoringEvents: scoringSeq,
      countdownSuppressed,
      epochMismatch: takeSnapshot ? Number(takeSnapshot.epochMismatch) : 0,
      inputHealth: worstHealth,
      traceId: traceInfo ? traceInfo.traceId : null,
      traceDropped: traceInfo ? traceInfo.dropped : 0,
      tracePersistenceDegraded: traceInfo ? traceInfo.persistenceDegraded : false,
      clockMapping,
      scoreStatus,
      scoreInputNoteCount,
      scoreUnmappedNoteCount,
      pauseAdjusted,
      pauseSuppressed,
      pauseExcludedFromScore,
      admission: {
        version: 'admission-1',
        packets: admissionCounters.packets,
        noteOns: admissionCounters.noteOns,
        nonOnsets: admissionCounters.nonOnsets,
        admittedNoteOns: admissionCounters.admittedNoteOns,
        pushHitCount: admissionCounters.pushHitCount,
        finalPerformedNotes: admissionCounters.finalPerformedNotes,
        finalSkippedByAdmission: admissionCounters.finalSkippedByAdmission,
        finalDuplicateLifecycles: admissionCounters.finalDuplicateLifecycles,
        suppressedNoteOns: {
          countIn: admissionCounters.suppressedNoteOns['count-in'],
          paused: admissionCounters.suppressedNoteOns.paused,
          clock: admissionCounters.suppressedNoteOns.clock,
          duplicate: admissionCounters.suppressedNoteOns.duplicate,
          outOfOrder: admissionCounters.suppressedNoteOns['out-of-order'],
        },
        captureQuarantinedPackets: admissionCounters.captureQuarantinedPackets,
        duplicateEventIds: admissionCounters.duplicateEventIds,
        pauseSegments: pauseSegments.map((segment) => ({ ...segment })),
      },
      connectionClosed: interrupted,
      node: {
        backend: adapterStatus.backend,
        adapterGeneration: adapterStatus.generation,
        mappedEvents: nodeEventsMapped,
        unmappedEvents: nodeEventsUnmapped,
        staleGenerationEvents: nodeEventsStale,
        queueDropped: adapterStatus.queueDropped,
        clockQuality,
        clockUncertaintyMs,
      },
    };

    // Persist the session record, then update the rule-based mastery model.
    const sessionId = `s-${Date.now()}-${++sessionIdCounter}`;
    const record = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      interrupted,
      finishedAtIso: new Date().toISOString(),
      modeId: meta ? meta.modeId : 'unknown',
      bpm: meta ? meta.bpm : null,
      profile: meta ? meta.profile : null,
      assisted: meta ? !!meta.assisted : false,
      durationPolicy: meta ? meta.durationPolicy : null,
      scoreEvents: meta ? meta.scoreEvents : null,
      // Traceability: the exact effective config this Take was scored with.
      scoringConfig: meta ? meta.scoringConfig : null,
      scoringConfigVersion: meta?.scoringConfig?.configVersion ?? null,
      scoreFingerprint: meta?.scoreFingerprint ?? null,
      playbackPlanId: meta?.playbackPlanId ?? null,
      scoreImportStatus: meta?.scoreImportStatus ?? null,
      hand: meta?.hand ?? null,
      scoreBarCount: meta?.scoreBarCount ?? null,
      sourceReportId: meta?.sourceReportId ?? null,
      sourceTakeId: meta?.sourceTakeId ?? null,
      prescriptionId: meta?.prescriptionId ?? null,
      prescription: meta?.prescription ?? null,
      takeTemplateId: meta?.takeTemplateId ?? null,
      takeTemplateName: meta?.takeTemplateName ?? null,
      takeTemplateUpdatedAtIso: meta?.takeTemplateUpdatedAtIso ?? null,
      retryComparison: null,
      coreAlgorithmVersion: meta ? addon.SCORING_ALGORITHM_VERSION : null,
      // Replay inputs: the exact atom list and count-in that built the targets.
      atoms: meta ? meta.atoms : null,
      countInBeats: meta ? meta.countInBeats : null,
      ticksPerQuarter: meta ? meta.ticksPerQuarter : null,
      practiceSessionId: finishedTake ? finishedTake.practiceSessionId : null,
      takeId: finishedTake ? finishedTake.takeId : null,
      takeIndex: finishedTake ? finishedTake.takeIndex : null,
      takeSnapshot,
      trace: traceInfo,
      traceId: traceInfo ? traceInfo.traceId : null,
      journal: journalInfo,
      captureDiagnostics,
      report,
      analysis,
      durations,
      keyLifecycles,
      scoreV1,
      scoreStatus,
      scoreConfigVersion,
      scoreAlgorithmVersion,
      scoreInputNoteCount,
      scoreUnmappedNoteCount,
      pauseAdjusted,
    };
    if (meta?.sourceReportId) {
      record.retryComparison = buildRetryComparison(
        readSessionRecord(meta.sourceReportId),
        record,
      );
    }
    let recordPersisted = true;
    let persistenceError = null;
    try {
      atomicWriteJson(path.join(SESSIONS_DIR, `${sessionId}.json`), record);
    } catch (err) {
      recordPersisted = false;
      persistenceError = String((err && err.message) || err);
      console.error('[engine] 会话保存失败:', persistenceError);
    }

    try {
      const stats = report.stats;
      // Degraded/disconnected input is not the user's rhythm error, but the
      // attempt must not count toward mastery evidence either.
      const healthClean = captureDiagnostics.inputHealth === 'healthy';
      const passed = !!report.trustworthy
        && healthClean
        && stats.missCount === 0
        && stats.extraCount === 0
        && stats.meanAbsoluteMs != null
        && stats.meanAbsoluteMs <= PASS_MAE_MS;
      studentModel.observeAttempt(record.modeId, {
        passed,
        trustworthy: !!report.trustworthy && healthClean,
        targetCount: report.targetCount,
        assisted: record.assisted,
        transferTest: false,   // transfer testing not implemented yet — honest default
        delayedRetest: false,
      });
      persistProfile();
    } catch (err) {
      console.error('[engine] 学习档案更新失败:', String((err && err.message) || err));
    }

    if (coordinator && finishedTake) {
      try {
        coordinator.finalizeSucceeded(finishedTake.takeId);
      } catch (err) {
        console.error('[engine] Take finalize 失败:', String((err && err.message) || err));
        try {
          coordinator.finalizeFailed(finishedTake.takeId, String((err && err.message) || err));
        } catch {
          try { coordinator.abort(finishedTake.takeId, lastNowMs, 'finalize_failed'); } catch { /* best effort */ }
        }
      }
      activeTake = null;
    }

    send({
      type: 'report', sessionId, report, analysis, durations, keyLifecycles, captureDiagnostics,
      scoreV1, scoreStatus, scoreConfigVersion, scoreAlgorithmVersion,
      scoreInputNoteCount, scoreUnmappedNoteCount, pauseAdjusted,
      persisted: recordPersisted,
      persistenceError,
      practiceSessionId: finishedTake ? finishedTake.practiceSessionId : null,
      takeId: finishedTake ? finishedTake.takeId : null,
      takeIndex: finishedTake ? finishedTake.takeIndex : null,
      takeSnapshot,
      traceId: traceInfo ? traceInfo.traceId : null,
      trace: traceInfo,
      journalId: journalInfo ? journalInfo.journalId : null,
      journal: journalInfo,
      scoringConfig: meta ? meta.scoringConfig : null,
      scoringConfigVersion: meta?.scoringConfig?.configVersion ?? null,
      scoreFingerprint: meta?.scoreFingerprint ?? null,
      playbackPlanId: meta?.playbackPlanId ?? null,
      scoreImportStatus: meta?.scoreImportStatus ?? null,
      hand: meta?.hand ?? null,
      scoreBarCount: meta?.scoreBarCount ?? null,
      sourceReportId: meta?.sourceReportId ?? null,
      sourceTakeId: meta?.sourceTakeId ?? null,
      prescriptionId: meta?.prescriptionId ?? null,
      prescription: meta?.prescription ?? null,
      takeTemplateId: meta?.takeTemplateId ?? null,
      takeTemplateName: meta?.takeTemplateName ?? null,
      takeTemplateUpdatedAtIso: meta?.takeTemplateUpdatedAtIso ?? null,
      retryComparison: record.retryComparison,
      coreAlgorithmVersion: addon.scoringAlgorithmVersion(),
    });
    if (activeTakeLease?.socket === socket) activeTakeLease = null;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[engine] Rhythm Trainer 引擎服务: http://${HOST}:${PORT}`);
  console.log(`[engine] Rust 原生模块目录: ${addonDir}`);
  console.log(`[engine] 数据目录: ${DATA_DIR}`);
  console.log(`[engine] 乐谱库: ${scoreLibrary.list().length} 份`);
});
