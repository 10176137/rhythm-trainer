'use strict';

// Shared Take finalization infrastructure for Timeline and Follow.
//
// Both modes build their own report, but they share one persistence contract:
//   1. the final record is frozen before the first write attempt;
//   2. a failed write retains the frozen draft and the retry context;
//   3. retry is idempotent and only changes persistence state, never content;
//   4. a duplicate finalize returns the first result instead of overwriting it.
//
// The service is intentionally side-effect free apart from the injected fs and
// the optional onPersisted callback, so failure injection is a unit test, not a
// production-only path.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PERSISTENCE_STATUS = Object.freeze({
  PERSISTED: 'persisted',
  PENDING_RETRY: 'pending-retry',
});

const SAFE_TAKE_ID = /^[A-Za-z0-9_-]+$/;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprintOf(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export class TakeFinalizationService {
  #takesDir;
  #pendingDir;
  #fs;
  #now;
  #logger;
  #maxRetainedEntries;
  #entries = new Map();

  constructor({
    takesDir,
    pendingDir = null,
    fsImpl = fs,
    now = () => new Date().toISOString(),
    logger = console,
    maxRetainedEntries = 512,
  } = {}) {
    if (typeof takesDir !== 'string' || takesDir === '') {
      throw new Error('TakeFinalizationService: takesDir is required');
    }
    this.#takesDir = takesDir;
    this.#pendingDir = pendingDir;
    this.#fs = fsImpl;
    this.#now = now;
    this.#logger = logger;
    this.#maxRetainedEntries = maxRetainedEntries;
  }

  /** Called before derived caches recover from authoritative Takes. Bad files
   * remain available for diagnosis; one corrupt draft cannot block the others. */
  recover() {
    if (!this.#pendingDir || !this.#fs.existsSync(this.#pendingDir)) return;
    for (const name of this.#fs.readdirSync(this.#pendingDir).sort()) {
      if (!name.endsWith('.json') || !SAFE_TAKE_ID.test(name.slice(0, -5))) continue;
      try {
        const record = JSON.parse(this.#fs.readFileSync(path.join(this.#pendingDir, name), 'utf8'));
        if (this.#validateTakeId(record) !== name.slice(0, -5)) throw new Error('draft identity mismatch');
        this.finalize(record);
      } catch (error) {
        this.#logger.error?.(`[engine] 待保存记录恢复失败 (${name}):`, String(error.message ?? error));
      }
    }
  }

  /**
   * Freeze `record`, attempt the first write, and retain the draft on failure.
   * Repeated calls with the same takeId never replace the first draft.
   */
  finalize(record, { onPersisted = null } = {}) {
    const takeId = this.#validateTakeId(record);
    const fingerprint = fingerprintOf(record);
    const existing = this.#entries.get(takeId);
    if (existing) {
      return {
        ...this.#summary(existing),
        created: false,
        alreadyFinalized: true,
        conflict: existing.fingerprint !== fingerprint,
      };
    }
    const entry = {
      takeId,
      fingerprint,
      record: cloneJson(record),
      status: PERSISTENCE_STATUS.PENDING_RETRY,
      error: null,
      attempts: 0,
      createdAt: this.#now(),
      persistedAt: null,
      created: false,
      onPersisted: typeof onPersisted === 'function' ? onPersisted : null,
      sideEffectsApplied: false,
      derivedUpdateError: null,
    };
    this.#entries.set(takeId, entry);
    this.#attempt(entry);
    this.#prune();
    return this.#summary(entry);
  }

  /** Re-attempt persistence with the same frozen draft (same takeId). */
  retry(takeId) {
    const entry = this.#entries.get(String(takeId));
    if (!entry) return null;
    if (entry.status !== PERSISTENCE_STATUS.PERSISTED) this.#attempt(entry);
    else this.#applySideEffects(entry);
    return this.#summary(entry);
  }

  /** Recover derived caches when they are next read, without rewriting Takes. */
  retryDerivedUpdates() {
    for (const entry of this.#entries.values()) {
      if (entry.status === PERSISTENCE_STATUS.PERSISTED) this.#applySideEffects(entry);
    }
  }

  get(takeId) {
    const entry = this.#entries.get(String(takeId));
    return entry ? this.#summary(entry) : null;
  }

  /** Pending drafts only; used by diagnostics and fault-injection tests. */
  pending() {
    return [...this.#entries.values()]
      .filter((entry) => entry.status !== PERSISTENCE_STATUS.PERSISTED)
      .map((entry) => this.#summary(entry));
  }

  #validateTakeId(record) {
    const takeId = record && typeof record.takeId === 'string' ? record.takeId : '';
    if (!SAFE_TAKE_ID.test(takeId)) throw new Error('takeId 非法');
    return takeId;
  }

  #attempt(entry) {
    entry.attempts += 1;
    try {
      // Write-ahead draft survives process exit between a failed final write
      // and a later retry. Never acknowledge persistence until the Take exists.
      if (this.#pendingDir) this.#writeOnce(entry.record, this.#pendingDir);
      const written = this.#writeOnce(entry.record);
      if (this.#pendingDir) {
        try { this.#fs.unlinkSync(path.join(this.#pendingDir, `${entry.takeId}.json`)); }
        catch { /* replay is idempotent if cleanup fails */ }
      }
      entry.created = entry.created || written.created;
      entry.status = PERSISTENCE_STATUS.PERSISTED;
      entry.error = null;
      entry.persistedAt = this.#now();
      if (written.created) this.#applySideEffects(entry);
      // The frozen record is only needed while a retry is possible. Keep the
      // fingerprint for duplicate detection, release the payload.
      entry.record = null;
    } catch (error) {
      entry.status = PERSISTENCE_STATUS.PENDING_RETRY;
      entry.error = String((error && error.message) || error);
      this.#logger.error?.(`[engine] Take 保存失败 (${entry.takeId}):`, entry.error);
    }
  }

  #writeOnce(record, dir = this.#takesDir) {
    const file = path.join(dir, `${record.takeId}.json`);
    // A repeated finalization must never replace the first authoritative Take.
    if (this.#fs.existsSync(file)) {
      const saved = JSON.parse(this.#fs.readFileSync(file, 'utf8'));
      if (fingerprintOf(saved) !== fingerprintOf(record)) throw new Error('Take 内容冲突，保留原记录及待保存草稿');
      return { created: false };
    }
    this.#fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    try {
      const fd = this.#fs.openSync(tmp, 'w');
      try {
        this.#fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
        // Flush the file before the rename so a crash cannot leave a renamed
        // but partially written Take.
        this.#fs.fsyncSync(fd);
      } finally {
        this.#fs.closeSync(fd);
      }
      this.#fs.renameSync(tmp, file);
    } catch (error) {
      try { this.#fs.unlinkSync(tmp); } catch { /* temp file may not exist */ }
      throw error;
    }
    try {
      const dirFd = this.#fs.openSync(dir, 'r');
      try { this.#fs.fsyncSync(dirFd); } finally { this.#fs.closeSync(dirFd); }
    } catch { /* directory fsync is best effort; rename already succeeded */ }
    return { created: true };
  }

  #applySideEffects(entry) {
    if (!entry.onPersisted || entry.sideEffectsApplied) return;
    try {
      entry.onPersisted();
      entry.sideEffectsApplied = true;
      entry.derivedUpdateError = null;
      entry.onPersisted = null;
    } catch (error) {
      entry.derivedUpdateError = String((error && error.message) || error);
      this.#logger.error?.(`[engine] Take 保存后的派生更新失败 (${entry.takeId}):`, entry.derivedUpdateError);
    }
  }

  #summary(entry) {
    return {
      takeId: entry.takeId,
      persisted: entry.status === PERSISTENCE_STATUS.PERSISTED,
      persistenceStatus: entry.status,
      persistenceError: entry.error,
      created: entry.created,
      attempts: entry.attempts,
      alreadyFinalized: false,
      conflict: false,
      derivedUpdatePending: !!entry.onPersisted && !entry.sideEffectsApplied,
      derivedUpdateError: entry.derivedUpdateError,
    };
  }

  /** Retain pending drafts regardless of age; prune only old committed summaries. */
  #prune() {
    if (this.#entries.size <= this.#maxRetainedEntries) return;
    for (const [takeId, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxRetainedEntries) break;
      if (entry.status === PERSISTENCE_STATUS.PERSISTED && !entry.onPersisted) this.#entries.delete(takeId);
    }
  }
}
