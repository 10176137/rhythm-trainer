'use strict';

// Deterministic replay of a persisted Take trace through the Rust core.
//
// The trace records every raw packet the ingest pipeline accepted, with the
// session time that was used for scoring. Replaying feeds the same packets,
// at the same session times, into a fresh NativeSession built from the same
// atoms/count-in — so the resulting report must match the original one.

import { readTrace } from './midi/trace-recorder.mjs';

/**
 * @param {object} options
 * @param {string} options.dataDir        Engine data dir (contains traces/)
 * @param {string} options.traceId
 * @param {object} options.sessionRecord  Persisted session record (atoms/bpm/…)
 * @param {object} options.addon          Loaded Rust N-API addon
 * @param {number} options.queueCapacity
 * @param {number} options.finalizationGraceMs
 * @returns {{report: object, judgmentCount: number, noteOnCount: number, suppressedCount: number}}
 */
export function replayTakeTrace(options) {
  const { dataDir, traceId, sessionRecord, addon, queueCapacity, finalizationGraceMs } = options;
  const trace = readTrace(`${dataDir}/traces`, traceId);
  if (!trace) throw new Error(`trace not found: ${traceId}`);

  const countInBeats = Number(sessionRecord.countInBeats ?? 4);
  const bpm = Number(sessionRecord.bpm);
  const ticksPerQuarter = Number(sessionRecord.ticksPerQuarter ?? 960);
  if (!Number.isFinite(bpm)) throw new Error('session record lacks bpm; cannot rebuild targets');

  const pattern = {
    id: `replay-${traceId}`,
    ticksPerQuarter,
    atoms: sessionRecord.atoms,
  };
  if (!Array.isArray(pattern.atoms) || pattern.atoms.length === 0) {
    throw new Error('session record lacks atoms; cannot rebuild targets');
  }
  const countInMs = countInBeats * (60_000 / bpm);
  const targets = addon.buildSchedule(pattern, bpm, countInMs, sessionRecord.profile ?? 'standard');
  const scoringStartMs = targets.length
    ? Math.max(0, targets[0].atMs - targets[0].goodWindowMs)
    : countInMs;

  const native = new addon.NativeSession(targets, queueCapacity, finalizationGraceMs);
  native.start();

  let scoringSeq = 0;
  let noteOnCount = 0;
  let suppressedCount = 0;
  // Trace events are already ordered by ingest; replay preserves that order
  // and never re-sorts by time (ordering is part of the recorded facts).
  for (const event of trace.events) {
    if (event.messageType !== 'note-on') continue;
    noteOnCount += 1;
    const atMs = Number(event.sessionTimeMs);
    if (atMs < scoringStartMs) {
      suppressedCount += 1;
      continue;
    }
    scoringSeq += 1;
    native.pushHit({ seq: scoringSeq, atMs, source: 'keyboard', notes: [eventNoteNumber(event)] });
    native.processPending();
  }
  native.advance(lastEventTime(trace) + 500);

  return { report: native.finish(), judgmentCount: scoringSeq, noteOnCount, suppressedCount };
}

function eventNoteNumber(event) {
  const bytes = event.rawBytes ?? [];
  const status = bytes[0];
  if (status != null && (status & 0xf0) === 0x90 && bytes[2] > 0) return bytes[1];
  // Non-note payloads should not appear for messageType 'note-on'; be strict.
  throw new Error(`trace event ${event.sourceSeq} is not a Note On: ${JSON.stringify(event.rawBytes)}`);
}

function lastEventTime(trace) {
  let last = 0;
  for (const event of trace.events) {
    const at = Number(event.sessionTimeMs);
    if (Number.isFinite(at) && at > last) last = at;
  }
  return last;
}
