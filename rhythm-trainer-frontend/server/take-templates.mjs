'use strict';

// Saved Take templates. A template is a reusable practice configuration
// (score identity, range, BPM, hand, mode) — not a performance record.
// Starting a template always creates a new Session/Take linked to it, so
// completed history is never overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TAKE_TEMPLATE_SCHEMA_VERSION = 1;
export const MAX_TAKE_NAME_LENGTH = 80;

export class TakeTemplateError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TakeTemplateError';
    this.code = code;
    this.status = status;
  }
}

function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new TakeTemplateError('INVALID_TAKE_ID', 'Take ID 非法');
  }
  return id;
}

export function normalizeTakeName(name) {
  if (typeof name !== 'string') throw new TakeTemplateError('INVALID_TAKE_NAME', 'Take 名称必须是文本');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new TakeTemplateError('INVALID_TAKE_NAME', 'Take 名称不能为空');
  if (clean.length > MAX_TAKE_NAME_LENGTH) {
    throw new TakeTemplateError('INVALID_TAKE_NAME', `Take 名称不能超过 ${MAX_TAKE_NAME_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new TakeTemplateError('INVALID_TAKE_NAME', 'Take 名称不能包含控制字符');
  return clean;
}

const MODES = new Set(['score', 'rhythm', 'free']);
const HANDS = new Set(['both', 'right', 'left']);
const FEEDBACK = new Set(['live', 'after']);
const PROFILES = new Set(['strict', 'standard', 'relaxed']);
const DURATION = new Set(['strict-keydown', 'disabled']);
const ADVANCE = new Set(['timeline', 'follow']);

function finiteInteger(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function normalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 配置必须是对象');
  }
  const modeId = typeof input.modeId === 'string' && MODES.has(input.modeId) ? input.modeId : null;
  if (!modeId) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 模式非法（只允许 score/rhythm/free）');
  const hand = typeof input.hand === 'string' && HANDS.has(input.hand) ? input.hand : null;
  if (!hand) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 手别非法');
  const feedback = typeof input.feedback === 'string' && FEEDBACK.has(input.feedback) ? input.feedback : null;
  if (!feedback) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 反馈方式非法');
  const profile = typeof input.profile === 'string' && PROFILES.has(input.profile) ? input.profile : null;
  if (!profile) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 判定档位非法');
  const durationPolicy = typeof input.durationPolicy === 'string' && DURATION.has(input.durationPolicy)
    ? input.durationPolicy
    : null;
  if (!durationPolicy) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 时值策略非法');
  const advanceMode = typeof input.advanceMode === 'string' && ADVANCE.has(input.advanceMode)
    ? input.advanceMode
    : null;
  if (!advanceMode) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 推进方式非法');
  const tempo = finiteInteger(input.tempo, 40, 160);
  if (tempo == null) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take BPM 需在 40–160');
  const beats = finiteInteger(input.timeSignature?.[0], 1, 16);
  const unit = finiteInteger(input.timeSignature?.[1], 1, 16);
  if (beats == null || unit == null) throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 拍号非法');
  const loopStartBar = finiteInteger(input.loopStartBar, 1, 999);
  const loopEndBar = finiteInteger(input.loopEndBar, 1, 999);
  if (loopStartBar == null || loopEndBar == null || loopEndBar < loopStartBar) {
    throw new TakeTemplateError('INVALID_TAKE_CONFIG', 'Take 小节范围非法');
  }
  return {
    modeId,
    tempo,
    timeSignature: [beats, unit],
    hand,
    feedback,
    loopEnabled: input.loopEnabled === true,
    loopStartBar,
    loopEndBar,
    profile,
    durationPolicy,
    advanceMode,
  };
}

function normalizeOptionalString(value, maxLength) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

export class TakeTemplateStore {
  constructor({ dir }) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${safeId(id)}.json`);
  }

  read(id) {
    const file = this.file(id);
    if (!fs.existsSync(file)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record || record.schemaVersion !== TAKE_TEMPLATE_SCHEMA_VERSION || record.id !== id) return null;
      if (!record.config || typeof record.config !== 'object') return null;
      return record;
    } catch {
      return null;
    }
  }

  list() {
    const entries = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      const record = this.read(file.slice(0, -'.json'.length));
      if (record) entries.push(record);
    }
    return entries.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  assertNameAvailable(name, exceptId = null) {
    const existing = this.list().find((item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== exceptId);
    if (existing) throw new TakeTemplateError('TAKE_NAME_EXISTS', '已有同名 Take', 409);
  }

  create(input = {}) {
    const name = normalizeTakeName(input.name);
    this.assertNameAvailable(name);
    const config = normalizeConfig(input.config);
    const now = new Date().toISOString();
    const record = {
      schemaVersion: TAKE_TEMPLATE_SCHEMA_VERSION,
      id: `take-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      name,
      config,
      scoreFingerprint: normalizeOptionalString(input.scoreFingerprint, 128),
      scoreLabel: normalizeOptionalString(input.scoreLabel, 200),
      scoreLibraryId: normalizeOptionalString(input.scoreLibraryId, 120),
      sourceReportId: normalizeOptionalString(input.sourceReportId, 120),
      sourceTakeId: normalizeOptionalString(input.sourceTakeId, 120),
      prescriptionId: normalizeOptionalString(input.prescriptionId, 160),
      createdAtIso: now,
      updatedAtIso: now,
    };
    writeAtomic(this.file(record.id), JSON.stringify(record, null, 2));
    return record;
  }

  update(id, patch = {}) {
    const existing = this.read(id);
    if (!existing) throw new TakeTemplateError('TAKE_NOT_FOUND', 'Take 不存在', 404);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TakeTemplateError('INVALID_TAKE_PATCH', 'Take 更新内容必须是对象');
    }
    const hasName = patch.name !== undefined;
    const hasConfig = patch.config !== undefined;
    if (!hasName && !hasConfig && patch.scoreLabel === undefined
      && patch.scoreFingerprint === undefined && patch.scoreLibraryId === undefined) {
      throw new TakeTemplateError('EMPTY_TAKE_UPDATE', '没有需要更新的字段');
    }
    const name = hasName ? normalizeTakeName(patch.name) : existing.name;
    if (hasName && name.toLowerCase() !== existing.name.toLowerCase()) this.assertNameAvailable(name, id);
    const next = {
      ...existing,
      name,
      config: hasConfig ? normalizeConfig(patch.config) : existing.config,
      scoreFingerprint: patch.scoreFingerprint === undefined
        ? existing.scoreFingerprint
        : normalizeOptionalString(patch.scoreFingerprint, 128),
      scoreLabel: patch.scoreLabel === undefined
        ? existing.scoreLabel
        : normalizeOptionalString(patch.scoreLabel, 200),
      scoreLibraryId: patch.scoreLibraryId === undefined
        ? existing.scoreLibraryId
        : normalizeOptionalString(patch.scoreLibraryId, 120),
      updatedAtIso: new Date().toISOString(),
    };
    writeAtomic(this.file(id), JSON.stringify(next, null, 2));
    return next;
  }

  remove(id) {
    const file = this.file(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}
