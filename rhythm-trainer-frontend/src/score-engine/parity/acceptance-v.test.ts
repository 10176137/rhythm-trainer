// R2-2c acceptance class V: fixed-vector consistency (byte-exact).
// TS stage only — the Rust-side independent reproduction of N-FP-V1 is
// explicitly DEFERRED_TO_R2-3 and must never be reported as done here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import canonicalize from 'canonicalize';
import { beatToMicroseconds, computePlanFingerprintV1 } from '../contract-v1/plan-fingerprint';
const VECTORS_PATH = new URL('../../../../audit-r1/contracts/test-vectors/plan-fingerprint-v1.json', import.meta.url);

export const RUST_V_CLASS_STATUS = 'DEFERRED_TO_R2-3' as const;

const GOLDEN = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  vectors: Record<string, { payload: unknown; expectedCanonical: string; expectedFingerprint: string }>;
};

describe('acceptance V: fixed-vector consistency (TS stage)', () => {
  it('carries the frozen five plus the rational-BPM vector', () => {
    expect(Object.keys(GOLDEN.vectors)).toEqual(
      expect.arrayContaining(['V-single', 'V-rest-gap', 'V-chord', 'V-tie', 'V-hand', 'V-rational-bpm']),
    );
  });

  it.each(Object.keys(GOLDEN.vectors))('%s: dual-path byte-exact (reference AND independent canonicalize+sha256)', (name) => {
    const vector = GOLDEN.vectors[name];
    // Path 1: the reference implementation.
    expect(computePlanFingerprintV1(vector.payload as never)).toBe(vector.expectedFingerprint);
    // Path 2: independent raw canonicalize + node crypto over the payload.
    const canonical = canonicalize(vector.payload);
    if (!canonical) throw new Error(`${name}: canonicalize returned no bytes`);
    const independent = `plan-v1:sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
    expect(independent).toBe(vector.expectedFingerprint);
    // And sha256 over the COMMITTED canonical bytes agrees too.
    const fromCommittedBytes = `plan-v1:sha256:${createHash('sha256').update(vector.expectedCanonical, 'utf8').digest('hex')}`;
    expect(fromCommittedBytes).toBe(vector.expectedFingerprint);
  });

  it('V-rational-bpm freezes the exact rational tempo (175/2, count-in 35/8)', () => {
    const tempo = (GOLDEN.vectors['V-rational-bpm'].payload as { tempo: { bpm: { numerator: number; denominator: number }; countInBeats: { numerator: number; denominator: number } } }).tempo;
    // 3,000,000 µs × 175 / (60,000,000 × 2) = 525/1200 = 35/8, reduced.
    expect(tempo.bpm).toEqual({ numerator: 175, denominator: 2 });
    expect(tempo.countInBeats).toEqual({ numerator: 35, denominator: 8 });
  });

  it('rational-BPM integer µs follow the frozen half-up formula (hand table)', () => {
    // 175/2 BPM: µs(beat) = roundHalfUp(beat × 60,000,000 × 2 / 175).
    const bpm = { numerator: 175, denominator: 2 };
    const table: Array<[number, number, number]> = [
      [1, 1, 685714],   // 120,000,000/175 = 685,714.2857
      [2, 1, 1371429],  // 240,000,000/175 = 1,371,428.571
      [3, 1, 2057143],  // 360,000,000/175 = 2,057,142.857
      [4, 1, 2742857],  // 480,000,000/175 = 2,742,857.143
    ];
    for (const [numerator, denominator, expectedUs] of table) {
      expect(beatToMicroseconds({ numerator, denominator }, bpm)).toBe(expectedUs);
    }
    // Cross-check the parity case G1-rational-bpm expected durations:
    // a 1-beat note is 685,714 µs and the final 2-beat note is 1,371,429 µs.
    expect(beatToMicroseconds({ numerator: 1, denominator: 1 }, bpm)).toBe(685714);
    expect(beatToMicroseconds({ numerator: 2, denominator: 1 }, bpm)).toBe(1371429);
    // Integer BPM anchors: G5's one-beat offset at 90 and G4's triplet at 60.
    expect(beatToMicroseconds({ numerator: 1, denominator: 1 }, { numerator: 90, denominator: 1 })).toBe(666667);
    expect(beatToMicroseconds({ numerator: 1, denominator: 3 }, { numerator: 60, denominator: 1 })).toBe(333333);
  });

  it('honestly reports the Rust side as deferred (no fake cross-language parity)', () => {
    // R2-2 runs the TS side only; N-FP-V1's Rust reproduction belongs to R2-3.
    expect(RUST_V_CLASS_STATUS).toBe('DEFERRED_TO_R2-3');
  });
});
