import { expect, it } from 'vitest';
import { MidiAdmissionLedger } from './admission-ledger.mjs';
const packet = seq => ({ sourceId: 'piano', sourceSeq: seq, capturedAtMs: 1000, clockDomainId: 'mock' });
const note = id => ({ kind: 'note-on', complete: true, eventId: id });
const context = { paused: false, pauseSegments: [], scoringStartMs: 100, segmentId: 'active-0' };
it('never admits a duplicate event or rewrites its original evidence', () => {
  const ledger = new MidiAdmissionLedger();
  const first = ledger.record(note('n1'), packet(1), 1000, context);
  const duplicate = ledger.record(note('n1'), packet(1), 1000, { ...context, paused: true });
  expect(first.eligibleForFinalOnsetScore).toBe(true);
  expect(duplicate).toMatchObject({ suppressionReason: 'duplicate', duplicateOf: first.decisionId, eligibleForRealtime: false });
  expect(ledger.get('n1')).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(ledger.counters.admittedNoteOns).toBe(1);
});
it('keeps suppressed inputs suppressed when replayed after the pause', () => {
  const ledger = new MidiAdmissionLedger();
  ledger.record(note('paused'), packet(1), 200, { ...context, paused: true });
  expect(ledger.record(note('paused'), packet(1), 200, context).eligibleForFinalOnsetScore).toBe(false);
  expect(ledger.record(note('delayed'), packet(2), 250, { ...context, pauseSegments: [{ startSession: 200, endSession: 300 }] }).suppressionReason).toBe('paused');
  expect(ledger.record(note('boundary'), packet(3), 300, { ...context, pauseSegments: [{ startSession: 200, endSession: 300 }] }).eligibleForRealtime).toBe(true);
});
it('only advances the onset baseline after successful delivery and allows chord ties', () => {
  const ledger = new MidiAdmissionLedger();
  ledger.record(note('failed'), packet(1), 1000, context);
  const accepted = ledger.record(note('next'), packet(2), 900, context);
  expect(accepted.eligibleForRealtime).toBe(true);
  ledger.commitOnset(900);
  expect(ledger.record(note('chord'), packet(3), 900, context).eligibleForRealtime).toBe(true);
  expect(ledger.record(note('late'), packet(4), 899, context).suppressionReason).toBe('out-of-order');
});
it('preserves releases and excludes clockless or count-in onsets', () => {
  const ledger = new MidiAdmissionLedger();
  expect(ledger.record(note('early'), packet(1), 99, context).suppressionReason).toBe('count-in');
  expect(ledger.record(note('clock'), packet(2), null, context).suppressionReason).toBe('clock');
  const release = ledger.record({ kind: 'note-off', complete: true, eventId: 'off' }, packet(3), 99, context);
  expect(release).toMatchObject({ suppressionReason: null, eligibleForRealtime: false });
  ledger.reset();
  expect(ledger.get('early')).toBeUndefined();
  expect(ledger.counters.packets).toBe(0);
  expect(ledger.record(note('new'), packet(4), 1000, context).decisionId).toBe('adm-1');
});
