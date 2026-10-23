'use strict';

// Session Journal slice: one append-only JSONL per Take with ordered command,
// boundary and settlement events. Written at lifecycle edges (never in the
// MIDI callback). Persistence failure sets persistenceDegraded instead of
// pretending the events are safely stored.

import fs from 'node:fs';
import path from 'node:path';

export const JOURNAL_SCHEMA_VERSION = 1;

export class TakeJournal {
  constructor(options) {
    this.journalId = options.journalId;
    this.practiceSessionId = options.practiceSessionId;
    this.takeId = options.takeId;
    this.dir = options.dir;
    this.seq = 0;
    this.entries = [];
    this.persistenceDegraded = false;
    this.persistenceError = null;
    this.append('take_created', { captureEpoch: options.captureEpoch ?? null });
  }

  append(kind, detail = {}) {
    this.seq += 1;
    const entry = {
      journalSeq: this.seq,
      journalId: this.journalId,
      practiceSessionId: this.practiceSessionId,
      takeId: this.takeId,
      kind,
      atIso: new Date().toISOString(),
      ...detail,
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Writes the journal once at finalization (single JSONL per Take).
   * Returns a summary suitable for embedding in the session record.
   */
  finalize(extra = {}) {
    this.append('take_finalized', extra);
    const file = path.join(this.dir, `${this.journalId}.jsonl`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(file, this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
      return {
        journalId: this.journalId,
        journalSeq: this.seq,
        entryCount: this.entries.length,
        persistenceDegraded: false,
        file: `${this.journalId}.jsonl`,
      };
    } catch (error) {
      this.persistenceDegraded = true;
      this.persistenceError = String((error && error.message) || error);
      return {
        journalId: this.journalId,
        journalSeq: this.seq,
        entryCount: this.entries.length,
        persistenceDegraded: true,
        error: this.persistenceError,
      };
    }
  }
}

export function readJournal(dir, journalId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(journalId))) return null;
  const file = path.join(dir, `${journalId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const entries = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { journalId, entryCount: entries.length, entries };
}
