// @ts-nocheck
// R2-0: generates the committed golden vectors with dual-path verification
// (reference implementation vs an independent JCS+sha256 script). The output
// is hand-auditable: payload, canonical bytes and expected fingerprint.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import jcs from 'canonicalize';
import { buildUserHandMapping } from '../scope/practice-scope';
import { canonicalizeJcs, computePlanFingerprintV1 } from './plan-fingerprint';

const envelope = (groups, overrides = {}) => ({
  fingerprintSchemaVersion: 1,
  plannerVersion: 'planner-ref-1',
  scoreRevisionId: 'score-revision-v1:sha256:' + 'a'.repeat(64),
  normalizerVersion: 'normalizer-1',
  supportProfileVersion: 'musicxml-v1.0',
  scope: {
    partId: 'P1',
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
    hand: 'right',
    handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }]),
  },
  repeatSelection: { kind: 'none' },
  tempo: { bpm: { numerator: 80, denominator: 1 }, ticksPerQuarter: 960, countInBeats: { numerator: 4, denominator: 1 }, timeOrigin: 'playback-start' },
  targetGroups: groups,
  ...overrides,
});

const single = envelope([{
  groupIndex: 0, passIndex: 0, bar: 1,
  onsetBeatFromRangeStart: { numerator: 0, denominator: 1 },
  durationBeat: { numerator: 1, denominator: 1 },
  beatInMeasure: { numerator: 0, denominator: 1 },
  staffNumbers: [1], voiceIds: ['1'],
  members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }],
}]);
const restGap = envelope([
  { groupIndex: 0, passIndex: 0, bar: 1, onsetBeatFromRangeStart: { numerator: 0, denominator: 1 }, durationBeat: { numerator: 1, denominator: 1 }, beatInMeasure: { numerator: 0, denominator: 1 }, staffNumbers: [1], voiceIds: ['1'], members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }] },
  { groupIndex: 1, passIndex: 0, bar: 2, onsetBeatFromRangeStart: { numerator: 6, denominator: 1 }, durationBeat: { numerator: 2, denominator: 1 }, beatInMeasure: { numerator: 2, denominator: 1 }, staffNumbers: [1], voiceIds: ['1'], members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 2, sourceOrdinal: 2 }, pitch: { midiNote: 67, spelling: 'G4' }, durationBeat: { numerator: 2, denominator: 1 } }] },
]);
const chord = envelope([{
  groupIndex: 0, passIndex: 0, bar: 1, onsetBeatFromRangeStart: { numerator: 0, denominator: 1 }, durationBeat: { numerator: 2, denominator: 1 }, beatInMeasure: { numerator: 0, denominator: 1 }, staffNumbers: [1], voiceIds: ['1'],
  members: [
    { sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } },
    { sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 2 }, pitch: { midiNote: 67, spelling: 'G4' }, durationBeat: { numerator: 2, denominator: 1 } },
  ],
}]);
const tie = envelope([{
  groupIndex: 0, passIndex: 0, bar: 1, onsetBeatFromRangeStart: { numerator: 0, denominator: 1 }, durationBeat: { numerator: 4, denominator: 1 }, beatInMeasure: { numerator: 0, denominator: 1 }, staffNumbers: [1], voiceIds: ['1'],
  members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 4, denominator: 1 }, isTieOnset: true }],
}]);
const hand = envelope([{
  groupIndex: 0, passIndex: 0, bar: 1, onsetBeatFromRangeStart: { numerator: 0, denominator: 1 }, durationBeat: { numerator: 1, denominator: 1 }, beatInMeasure: { numerator: 0, denominator: 1 }, staffNumbers: [1], voiceIds: ['1'],
  members: [{ sourceLocator: { partId: 'P1', measureOrdinal: 1, sourceOrdinal: 1 }, pitch: { midiNote: 60, spelling: 'C4' }, durationBeat: { numerator: 1, denominator: 1 } }],
}], {
  scope: {
    partId: 'P1',
    range: { startMeasureOrdinal: 1, endMeasureOrdinal: 2 },
    hand: 'both',
    handMapping: buildUserHandMapping('P1', [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }]),
  },
});

const vectors = { 'V-single': single, 'V-rest-gap': restGap, 'V-chord': chord, 'V-tie': tie, 'V-hand': hand };
const out = {
  fingerprintSchemaVersion: 1,
  note: 'Golden vectors for planFingerprintV1. Payloads are hand-authored; expectedCanonical is the RFC 8785 JCS (post-NFC) serialization and expectedFingerprint is sha256 over its UTF-8 bytes. Both were produced with an independent script (raw canonicalize + Node crypto) and cross-checked against the reference implementation; a divergence aborts generation.',
  vectors: {},
};
for (const [name, payload] of Object.entries(vectors)) {
  const canonical = canonicalizeJcs(payload);
  const independent = jcs(payload); // payload strings are ASCII, NFC is identity
  if (canonical !== independent) throw new Error(`${name} JCS divergence`);
  const fingerprint = computePlanFingerprintV1(payload);
  const independentHash = `plan-v1:sha256:${createHash('sha256').update(independent, 'utf8').digest('hex')}`;
  if (fingerprint !== independentHash) throw new Error(`${name} hash divergence`);
  out.vectors[name] = { payload, expectedCanonical: canonical, expectedFingerprint: fingerprint };
}
mkdirSync('D:/123/audit-r1/contracts/fixtures', { recursive: true });
writeFileSync('D:/123/audit-r1/contracts/test-vectors/plan-fingerprint-v1.json', JSON.stringify(out, null, 2) + '\n');
console.log('golden written:', Object.entries(out.vectors).map(([key, value]) => `${key}=${value.expectedFingerprint.slice(0, 24)}…`).join(' '));
