import { toNumber, toTicks, type RationalBeat } from '../domain/rational';
import type { TempoConfiguration, TempoMap } from '../domain/types';

export class TempoMapError extends Error {
  constructor(readonly code: 'invalid_tempo' | 'invalid_beat', message: string) {
    super(message);
    this.name = 'TempoMapError';
  }
}

const MIN_BPM = 20;
const MAX_BPM = 300;

export function buildTempoMap(tempo: TempoConfiguration, ticksPerQuarter = 960): TempoMap {
  if (!Number.isFinite(tempo.bpm) || tempo.bpm < MIN_BPM || tempo.bpm > MAX_BPM) {
    throw new TempoMapError('invalid_tempo', `BPM 需在 ${MIN_BPM}–${MAX_BPM} 之间，收到 ${String(tempo.bpm)}`);
  }
  if (!Number.isSafeInteger(ticksPerQuarter) || ticksPerQuarter <= 0) {
    throw new TempoMapError('invalid_tempo', 'ticksPerQuarter 必须是正整数');
  }
  const quarterMs = 60_000 / tempo.bpm;
  return {
    bpm: tempo.bpm,
    ticksPerQuarter,
    origin: tempo.timeOrigin,
    beatToMs(beat: RationalBeat): number {
      return toNumber(beat) * quarterMs;
    },
    beatToTicks(beat: RationalBeat): number | null {
      return toTicks(beat, ticksPerQuarter);
    },
  };
}

/** Audio/metronome scheduling uses the same session-relative definition. */
export function beatToMsAtBpm(beat: RationalBeat, bpm: number): number {
  if (!Number.isFinite(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    throw new TempoMapError('invalid_tempo', `BPM 需在 ${MIN_BPM}–${MAX_BPM} 之间`);
  }
  return toNumber(beat) * (60_000 / bpm);
}
