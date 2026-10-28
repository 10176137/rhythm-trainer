'use strict';

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TakeFinalizationService, PERSISTENCE_STATUS } from './take-finalization.mjs';

const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-finalize-'));
  dirs.push(dir);
  return dir;
}

function record(takeId, marker = 'first') {
  return {
    schemaVersion: 1,
    takeId,
    assessment: { scoreStatus: 'AVAILABLE', note: marker },
    lifecycle: { endReason: 'completed' },
  };
}

function faultyFs(failures) {
  let remaining = failures;
  return {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    openSync: (...args) => {
      if (remaining > 0) {
        remaining -= 1;
        const error = new Error('ENOSPC: no space left on device, open');
        error.code = 'ENOSPC';
        throw error;
      }
      return fs.openSync(...args);
    },
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  };
}

function readTake(dir, takeId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${takeId}.json`), 'utf8'));
}

afterEach(() => {
  while (dirs.length > 0) rmDir(dirs.pop());
});

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe('TakeFinalizationService', () => {
  it('retries a failed derived update without rewriting or duplicating the committed Take', () => {
    const dir = tempDir();
    const service = new TakeFinalizationService({ takesDir: dir, maxRetainedEntries: 1, logger: { error() {} } });
    let attempts = 0;
    const first = service.finalize(record('derived'), { onPersisted: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('profile unavailable');
    } });
    expect(first).toMatchObject({ persisted: true, derivedUpdatePending: true, derivedUpdateError: 'profile unavailable' });
    const original = fs.readFileSync(path.join(dir, 'derived.json'), 'utf8');
    service.finalize(record('other'));
    expect(service.retry('derived')).toMatchObject({ persisted: true, derivedUpdatePending: false, derivedUpdateError: null });
    service.retry('derived');
    expect(attempts).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'derived.json'), 'utf8')).toBe(original);
  });
  it('writes one authoritative Take and treats a duplicate finalize as idempotent', () => {
    const dir = tempDir();
    const service = new TakeFinalizationService({ takesDir: dir });
    const first = service.finalize(record('take-1'));

    expect(first).toMatchObject({
      takeId: 'take-1',
      persisted: true,
      persistenceStatus: PERSISTENCE_STATUS.PERSISTED,
      persistenceError: null,
      created: true,
      alreadyFinalized: false,
    });
    expect(readTake(dir, 'take-1').assessment.note).toBe('first');
    expect(fs.readdirSync(dir)).toEqual(['take-1.json']);

    const duplicate = service.finalize(record('take-1', 'second'));
    expect(duplicate).toMatchObject({ persisted: true, created: false, alreadyFinalized: true, conflict: true });
    expect(readTake(dir, 'take-1').assessment.note).toBe('first');
    expect(fs.readdirSync(dir)).toEqual(['take-1.json']);
  });

  it('retains the frozen draft after a write failure and retries with the same takeId', () => {
    const dir = tempDir();
    const service = new TakeFinalizationService({ takesDir: dir, fsImpl: faultyFs(1) });
    let sideEffects = 0;
    const first = service.finalize(record('take-2'), { onPersisted: () => { sideEffects += 1; } });

    expect(first).toMatchObject({
      takeId: 'take-2',
      persisted: false,
      persistenceStatus: PERSISTENCE_STATUS.PENDING_RETRY,
      created: false,
    });
    expect(first.persistenceError).toMatch(/ENOSPC/);
    expect(sideEffects).toBe(0);
    expect(fs.existsSync(path.join(dir, 'take-2.json'))).toBe(false);
    expect(service.pending()).toHaveLength(1);

    const retried = service.retry('take-2');
    expect(retried).toMatchObject({ persisted: true, persistenceStatus: PERSISTENCE_STATUS.PERSISTED, created: true });
    expect(sideEffects).toBe(1);
    expect(readTake(dir, 'take-2').takeId).toBe('take-2');

    // Repeated retries and duplicate finalizes do not re-run side effects or
    // create a second Take.
    service.retry('take-2');
    service.finalize(record('take-2'));
    expect(sideEffects).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['take-2.json']);
  });

  it('does not overwrite a first draft when a later finalize carries different content', () => {
    const dir = tempDir();
    const service = new TakeFinalizationService({ takesDir: dir });
    service.finalize(record('take-3', 'original'));
    const conflict = service.finalize(record('take-3', 'tampered'));

    expect(conflict).toMatchObject({ persisted: true, alreadyFinalized: true, conflict: true });
    expect(readTake(dir, 'take-3').assessment.note).toBe('original');
  });

  it('returns null for an unknown retry and never invents a draft', () => {
    const dir = tempDir();
    const service = new TakeFinalizationService({ takesDir: dir });
    expect(service.retry('take-missing')).toBeNull();
    expect(service.pending()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
