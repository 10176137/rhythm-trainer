// Countdown to the first note on the engine's authoritative schedule.
//
// The backend builds target[0].atMs as count-in + any leading rest in the
// score and returns it as firstTargetAtMs. The preparation overlay must end at
// that instant, not after a separate client-side delay.

/** Product default: three seconds of preparation, independent of tempo. */
export const DEFAULT_COUNT_IN_MS = 3000;

/** Shared by the plan request, launch binding, reference playback and Take.
 * Rhythm reading uses its configured measures; ordinary playing uses 3 seconds. */
export function practiceCountIn(config: { modeId: string; tempo: number; timeSignature: [number, number] }, readingMeasures: number) {
  const countInBeats = config.modeId === 'reading-rhythm'
    ? readingMeasures * config.timeSignature[0]
    : countInBeatsForTempo(config.tempo);
  return {
    countInBeats,
    countInUs: config.modeId === 'reading-rhythm'
      ? Math.round(countInBeats * 60_000_000 / config.tempo)
      : DEFAULT_COUNT_IN_MS * 1000,
  };
}

/**
 * Convert a preparation duration to the tempo's beat count. The value may be
 * fractional (3 s is 3.5 beats at 70 BPM); all timeline builders accept it.
 */
export function countInBeatsForTempo(bpm: number, countInMs: number = DEFAULT_COUNT_IN_MS): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error(`BPM 非法，无法计算预备拍：${String(bpm)}`);
  }
  if (!Number.isFinite(countInMs) || countInMs < 0) {
    throw new Error(`预备时长非法：${String(countInMs)}`);
  }
  return countInMs / (60_000 / bpm);
}

export function countdownToFirstNoteMs(
  firstTargetAtMs: number | null,
  originPerfMs: number | null,
  nowPerfMs: number,
): number | null {
  if (firstTargetAtMs === null || originPerfMs === null) return null;
  if (!Number.isFinite(firstTargetAtMs) || !Number.isFinite(originPerfMs) || !Number.isFinite(nowPerfMs)) {
    return null;
  }
  return Math.max(0, firstTargetAtMs - (nowPerfMs - originPerfMs));
}

/** Whole seconds for display; null when the first note has arrived. */
export function countdownWholeSeconds(remainingMs: number | null): number | null {
  if (remainingMs === null || !Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return Math.ceil(remainingMs / 1000);
}
