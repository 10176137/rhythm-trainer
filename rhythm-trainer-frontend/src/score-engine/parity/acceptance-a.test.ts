// R2-2c acceptance class A: fingerprint sensitivity / invariance
// (TS_RUST_PARITY_GATE_V1 §6 A). Class A asserts fingerprint change ONLY —
// no error codes, no rejection. Per the task card, existing contract tests
// are REUSED by reference; only genuine gaps get new assertions here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computePlanFingerprintV1 } from '../contract-v1/plan-fingerprint';

const VECTORS_PATH = new URL('../../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json', import.meta.url);

/**
 * Reuse map: every A-class item already covered by a committed contract test.
 * The test below pins this map against reality so the reference cannot rot
 * silently (renamed/deleted reuse anchors fail loudly).
 */
const REUSE_MAP: Record<string, { file: string; testTitle: string }> = {
  'N-PITCH-S1 (member midiNote+1 => fingerprint changes)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'a real semantic change (pitch) changes the fingerprint',
  },
  'N-FP-S1 (per-field config tampering => fingerprint changes)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'changes when scope, repeat, tempo, planner version or members change',
  },
  'N-FP-S1 (source tampering => sourceFingerprint/revision change)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'whitespace change in the source XML changes sourceFingerprint and revision id',
  },
  'N-FP-S2 (consistent runtime ID rename => fingerprint invariant)': {
    file: 'src/score-engine/contract-v1/contract-v1.test.ts',
    testTitle: 'changing internal ID encodings without changing semantic sources leaves the fingerprint identical',
  },
};

describe('acceptance A: fingerprint sensitivity / invariance', () => {
  it('reuse map points at contract tests that actually exist', () => {
    for (const [item, anchor] of Object.entries(REUSE_MAP)) {
      const source = readFileSync(new URL(`../../../${anchor.file}`, import.meta.url), 'utf8');
      expect(source.includes(anchor.testTitle), `${item}: anchor missing in ${anchor.file}`).toBe(true);
    }
  });

  // Genuine gap: spelling participates in payload identity, so an enharmonic
  // respelling with the SAME midiNote must still move the fingerprint.
  it('N-PITCH-S2: spelling change with identical midiNote changes the fingerprint', () => {
    const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
    const base = JSON.parse(JSON.stringify(vectors.vectors['V-single'].payload));
    const original = computePlanFingerprintV1(base);
    base.targetGroups[0].members[0].pitch.spelling = 'B#3'; // same pitch class, midi 60 unchanged
    expect(base.targetGroups[0].members[0].pitch.midiNote).toBe(60);
    const respelled = computePlanFingerprintV1(base);
    expect(respelled).not.toBe(original);
  });
});
