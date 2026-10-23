'use strict';

// Per-Take MIDI trace recorder. Events are accumulated in memory (bounded)
// during the take and written once at finalization, never in the MIDI callback.
// This is a first persistent Trace slice: no replay engine or ZIP bundle yet.

import fs from 'node:fs';
import path from 'node:path';

export const TRACE_SCHEMA_VERSION = 1;

export class TakeTraceRecorder {
  constructor(options) {
    this.traceId = options.traceId;
    this.practiceSessionId = options.practiceSessionId;
    this.takeId = options.takeId;
    this.captureEpoch = options.captureEpoch;
    this.dir = options.dir;
    this.capacity = Math.max(1, Number(options.capacity) || 20000);
    this.records = [];
    this.dropped = 0;
    this.createdAtIso = new Date().toISOString();
    this.finalized = false;
  }

  append(record) {
    if (this.finalized) return;
    if (this.records.length >= this.capacity) {
      this.dropped += 1;
      return;
    }
    this.records.push(record);
  }

  finalize() {
    if (this.finalized) {
      return { traceId: this.traceId, eventCount: this.records.length, dropped: this.dropped, persistenceDegraded: false };
    }
    this.finalized = true;
    fs.mkdirSync(this.dir, { recursive: true });
    const traceFile = path.join(this.dir, `${this.traceId}.jsonl`);
    const manifestFile = path.join(this.dir, `${this.traceId}.manifest.json`);
    const manifest = {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      practiceSessionId: this.practiceSessionId,
      takeId: this.takeId,
      captureEpoch: this.captureEpoch,
      clockDomainId: 'node-to-browser-performance',
      createdAtIso: this.createdAtIso,
      finalizedAtIso: new Date().toISOString(),
      eventCount: this.records.length,
      dropped: this.dropped,
      complete: this.dropped === 0,
      traceFile: `${this.traceId}.jsonl`,
    };
    try {
      fs.writeFileSync(traceFile, this.records.map((record) => JSON.stringify(record)).join('\n') + (this.records.length ? '\n' : ''), 'utf8');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
      return {
        traceId: this.traceId,
        eventCount: this.records.length,
        dropped: this.dropped,
        persistenceDegraded: false,
        complete: this.dropped === 0,
      };
    } catch (error) {
      return {
        traceId: this.traceId,
        eventCount: 0,
        dropped: this.dropped,
        persistenceDegraded: true,
        complete: false,
        error: String((error && error.message) || error),
      };
    }
  }
}

export function readTrace(dir, traceId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(traceId))) return null;
  const manifestFile = path.join(dir, `${traceId}.manifest.json`);
  const traceFile = path.join(dir, `${traceId}.jsonl`);
  if (!fs.existsSync(manifestFile) || !fs.existsSync(traceFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const events = fs.readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { manifest, events };
}
