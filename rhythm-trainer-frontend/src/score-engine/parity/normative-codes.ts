// R2-2c: normative C-class rejection codes for candidate-output validation
// (TS_RUST_PARITY_GATE_V1 §6, mapping table frozen @ 838cd9b). The Node server
// currently rejects via plain Error + Chinese message with no machine code;
// these pure functions mirror those checks and emit the frozen language-
// independent codes. The server message→code mapping below is the ONLY error
// reinterpretation the harness is allowed to perform.
export type NormativeCode =
  | 'duplicate_target_id'
  | 'invalid_target_pitch'
  | 'measure_coverage_mismatch'
  | 'target_outside_prescription_range';

/** Frozen message anchors (engine-server.mjs:1454-1480); text must not drift. */
export const SERVER_MESSAGE_ANCHORS: Record<NormativeCode, string> = {
  duplicate_target_id: 'scoreEvents 目标 ID 重复',
  invalid_target_pitch: 'scoreEvents 含非法目标',
  measure_coverage_mismatch: '小节覆盖与 atoms 不一致',
  target_outside_prescription_range: 'scoreEvents 超出处方小节范围',
};

/**
 * Maps a server rejection message to its normative code. Returns null for
 * anything that is not one of the four frozen anchors — no guessing, no
 * reinterpretation of unrelated errors.
 */
export function mapServerRejectionToNormativeCode(message: string): NormativeCode | null {
  for (const [code, anchor] of Object.entries(SERVER_MESSAGE_ANCHORS) as Array<[NormativeCode, string]>) {
    if (message.includes(anchor)) return code;
  }
  return null;
}

export interface CandidateTargetLike {
  scoreEventId: string;
  pitch: number;
  measure: number;
  targetDurationMs: number;
}

export interface CandidateValidationOptions {
  /** Bars spanned by note atoms; when given, measure coverage is enforced. */
  atomBars?: number[];
  /** Prescription measure range; when given, out-of-range targets are rejected. */
  prescriptionRange?: { start: number; end: number };
}

/**
 * Pure mirror of the server-side candidate-target checks, emitting the frozen
 * normative codes. Returns the first violation, or null when the candidate is
 * acceptable. Never returns empty-plan/warning outcomes: rejection is the only
 * failure mode (fail-closed per task card §6/C).
 */
export function validateCandidateScoreEvents(
  events: CandidateTargetLike[],
  options: CandidateValidationOptions = {},
): NormativeCode | null {
  const seen = new Set<string>();
  for (const event of events) {
    if (!event.scoreEventId
      || !Number.isFinite(event.targetDurationMs)
      || !Number.isInteger(event.pitch)
      || event.pitch < 0 || event.pitch > 127
      || !Number.isInteger(event.measure) || event.measure < 1) {
      return 'invalid_target_pitch';
    }
    if (!(event.targetDurationMs > 0)) return 'invalid_target_pitch';
    if (seen.has(event.scoreEventId)) return 'duplicate_target_id';
    seen.add(event.scoreEventId);
  }
  if (options.prescriptionRange) {
    const { start, end } = options.prescriptionRange;
    const outside = events.find((event) => event.measure < start || event.measure > end);
    if (outside) return 'target_outside_prescription_range';
  }
  if (options.atomBars) {
    const measureSet = new Set(events.map((event) => event.measure));
    const barSet = new Set(options.atomBars);
    if (measureSet.size !== barSet.size || [...barSet].some((bar) => !measureSet.has(bar))) {
      return 'measure_coverage_mismatch';
    }
  }
  return null;
}
