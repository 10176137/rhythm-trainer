'use strict';

// Named MusicXML library. One entry = one raw .musicxml file plus metadata,
// stored next to sessions/traces in the engine data dir. The client remains
// the XML parser; this module only validates names/size and persists text so
// an iPad and the desktop can share the same library.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SCORE_LIBRARY_SCHEMA_VERSION = 1;
export const MAX_SCORE_NAME_LENGTH = 80;
export const MAX_SCORE_XML_BYTES = 10 * 1024 * 1024;

export class ScoreLibraryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ScoreLibraryError';
    this.code = code;
    this.status = status;
  }
}

function assertSafeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ScoreLibraryError('INVALID_SCORE_ID', '乐谱 ID 非法');
  }
  return id;
}

export function normalizeScoreName(name) {
  if (typeof name !== 'string') throw new ScoreLibraryError('INVALID_SCORE_NAME', '乐谱名称必须是文本');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new ScoreLibraryError('INVALID_SCORE_NAME', '乐谱名称不能为空');
  if (clean.length > MAX_SCORE_NAME_LENGTH) {
    throw new ScoreLibraryError('INVALID_SCORE_NAME', `乐谱名称不能超过 ${MAX_SCORE_NAME_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/.test(clean)) {
    throw new ScoreLibraryError('INVALID_SCORE_NAME', '乐谱名称不能包含控制字符');
  }
  return clean;
}

function normalizeFileName(fileName, fallbackName) {
  if (typeof fileName !== 'string' || !fileName.trim()) return `${fallbackName}.musicxml`;
  const base = path.basename(fileName.trim());
  if (/[\u0000-\u001f\u007f]/.test(base)) {
    throw new ScoreLibraryError('INVALID_FILE_NAME', '文件名包含控制字符');
  }
  return base.slice(0, 200);
}

export function validateScoreXml(xml) {
  if (typeof xml !== 'string') throw new ScoreLibraryError('INVALID_SCORE_XML', 'MusicXML 内容必须是文本');
  const size = Buffer.byteLength(xml, 'utf8');
  if (size === 0) throw new ScoreLibraryError('INVALID_SCORE_XML', 'MusicXML 内容为空');
  if (size > MAX_SCORE_XML_BYTES) {
    throw new ScoreLibraryError('SCORE_TOO_LARGE', `MusicXML 不能超过 ${MAX_SCORE_XML_BYTES / 1024 / 1024} MiB`, 413);
  }
  if (!xml.trim().startsWith('<')) {
    throw new ScoreLibraryError('INVALID_SCORE_XML', '内容不像 MusicXML（应以 < 开头）');
  }
  return { size };
}

const IMPORT_STATUSES = new Set(['READY', 'READY_WITH_WARNINGS', 'DISPLAY_ONLY', 'REJECTED']);
const ISSUE_SEVERITIES = new Set(['info', 'warning', 'error']);

function finiteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function shortString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/**
 * Persist only the display/eligibility summary, never the note tree. Older
 * records without a summary stay valid and are marked unverified until opened.
 */
export function normalizeImportSummary(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScoreLibraryError('INVALID_IMPORT_SUMMARY', 'Import 摘要必须是对象');
  }
  if (!IMPORT_STATUSES.has(input.status)) {
    throw new ScoreLibraryError('INVALID_IMPORT_SUMMARY', 'Import 摘要状态非法');
  }
  const counts = input.counts && typeof input.counts === 'object' ? input.counts : {};
  const topIssues = Array.isArray(input.topIssues)
    ? input.topIssues.slice(0, 20).map((issue) => ({
      code: shortString(issue?.code, 80) || 'unknown_issue',
      severity: ISSUE_SEVERITIES.has(issue?.severity) ? issue.severity : 'info',
      message: shortString(issue?.message, 500) || '未提供说明',
      ...(Number.isFinite(issue?.measureOrdinal) && issue.measureOrdinal > 0
        ? { measureOrdinal: Math.floor(issue.measureOrdinal) }
        : {}),
    }))
    : [];
  return {
    status: input.status,
    strictAllowed: input.strictAllowed === true,
    parserVersion: shortString(input.parserVersion, 80),
    supportProfileVersion: shortString(input.supportProfileVersion, 80),
    fingerprint: shortString(input.fingerprint, 128),
    counts: {
      noteCount: finiteCount(counts.noteCount),
      measureCount: finiteCount(counts.measureCount),
      partCount: finiteCount(counts.partCount),
      warningCount: finiteCount(counts.warningCount),
      errorCount: finiteCount(counts.errorCount),
    },
    topIssues,
    importedAtIso: typeof input.importedAtIso === 'string' && !Number.isNaN(Date.parse(input.importedAtIso))
      ? input.importedAtIso
      : new Date().toISOString(),
  };
}

function importFields(summary) {
  if (!summary) return {};
  return {
    importStatus: summary.status,
    importReportSummary: summary,
    parserVersion: summary.parserVersion,
    importedAtIso: summary.importedAtIso,
  };
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

export class ScoreLibrary {
  constructor({ dir }) {
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  metaFile(id) {
    return path.join(this.dir, `${assertSafeId(id)}.meta.json`);
  }

  xmlFile(id) {
    return path.join(this.dir, `${assertSafeId(id)}.musicxml`);
  }

  readMeta(id) {
    const file = this.metaFile(id);
    if (!fs.existsSync(file)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!meta || meta.schemaVersion !== SCORE_LIBRARY_SCHEMA_VERSION || typeof meta.id !== 'string') return null;
      return meta;
    } catch {
      return null;
    }
  }

  list() {
    const entries = [];
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.meta.json')) continue;
      const id = file.slice(0, -'.meta.json'.length);
      const meta = this.readMeta(id);
      if (meta) entries.push({ ...meta, fileMissing: !fs.existsSync(this.xmlFile(id)) });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  /** Number of .meta.json files that cannot be read as valid library metadata. */
  invalidCount() {
    let invalid = 0;
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.meta.json')) continue;
      const id = file.slice(0, -'.meta.json'.length);
      if (!this.readMeta(id)) invalid += 1;
    }
    return invalid;
  }

  get(id) {
    const meta = this.readMeta(id);
    if (!meta) return null;
    const xmlPath = this.xmlFile(id);
    if (!fs.existsSync(xmlPath)) return null;
    return { ...meta, xml: fs.readFileSync(xmlPath, 'utf8') };
  }

  create({ name, fileName, xml, importSummary }) {
    const cleanName = normalizeScoreName(name);
    this.assertNameAvailable(cleanName);
    const { size } = validateScoreXml(xml);
    const summary = importSummary === undefined ? null : normalizeImportSummary(importSummary);
    const now = new Date().toISOString();
    const id = `score-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const meta = {
      schemaVersion: SCORE_LIBRARY_SCHEMA_VERSION,
      id,
      name: cleanName,
      fileName: normalizeFileName(fileName, cleanName),
      size,
      savedAtIso: now,
      updatedAtIso: now,
      ...importFields(summary),
    };
    writeAtomic(this.xmlFile(id), xml);
    writeAtomic(this.metaFile(id), JSON.stringify(meta, null, 2));
    return meta;
  }

  update(id, patch = {}) {
    assertSafeId(id);
    const existing = this.readMeta(id);
    if (!existing) throw new ScoreLibraryError('SCORE_NOT_FOUND', '乐谱不存在', 404);
    const hasName = patch.name !== undefined;
    const hasXml = patch.xml !== undefined;
    const hasSummary = patch.importSummary !== undefined;
    if (!hasName && !hasXml && patch.fileName === undefined && !hasSummary) {
      throw new ScoreLibraryError('EMPTY_UPDATE', '没有需要更新的字段');
    }
    const nextName = hasName ? normalizeScoreName(patch.name) : existing.name;
    if (hasName && nextName.toLowerCase() !== existing.name.toLowerCase()) {
      this.assertNameAvailable(nextName, id);
    }
    let size = existing.size;
    if (hasXml) size = validateScoreXml(patch.xml).size;
    const summary = hasSummary ? normalizeImportSummary(patch.importSummary) : null;
    const next = {
      ...existing,
      name: nextName,
      fileName: normalizeFileName(patch.fileName ?? existing.fileName, nextName),
      size,
      updatedAtIso: new Date().toISOString(),
    };
    if (hasSummary) {
      Object.assign(next, importFields(summary));
    } else if (hasXml) {
      // New XML without a new report is an unverified replacement, not the
      // old report's status.
      delete next.importStatus;
      delete next.importReportSummary;
      delete next.parserVersion;
      delete next.importedAtIso;
    }
    if (hasXml) writeAtomic(this.xmlFile(id), patch.xml);
    writeAtomic(this.metaFile(id), JSON.stringify(next, null, 2));
    return next;
  }

  remove(id) {
    assertSafeId(id);
    const existed = fs.existsSync(this.metaFile(id)) || fs.existsSync(this.xmlFile(id));
    if (!existed) return false;
    for (const file of [this.metaFile(id), this.xmlFile(id)]) {
      try { fs.unlinkSync(file); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return true;
  }

  assertNameAvailable(name, ignoreId = null) {
    const normalized = name.toLowerCase();
    const conflict = this.list().find((entry) => entry.id !== ignoreId && entry.name.toLowerCase() === normalized);
    if (conflict) {
      throw new ScoreLibraryError('SCORE_NAME_CONFLICT', `乐谱库中已有名为《${name}》的乐谱`, 409);
    }
  }
}
