// Absolute-timeline metronome. Clicks are scheduled on the shared AudioContext
// clock from session-relative target times. The session origin is an explicit
// parameter: subtracting performance.now() from a session-relative timestamp
// was a clock-domain bug that made every click look like it was in the past.

import { getSharedAudioContext, primeSharedAudioContext } from '../playback/sharedAudioContext';

export interface MetronomeClick {
  /** Session-relative time (performance.now() domain after adding the origin). */
  atMs: number;
  frequency: number;
  gain: number;
}

/**
 * Convert a session-relative click time to AudioContext time. The session
 * origin must be added before comparing with performance.now(); treating a
 * session-relative timestamp as an absolute one silently drops every click.
 */
export function metronomeClickAudioTime(
  atMs: number,
  sessionOriginPerfMs: number,
  nowPerfMs: number,
  audioNow: number,
): number {
  return audioNow + (sessionOriginPerfMs + atMs - nowPerfMs) / 1000;
}

export class Metronome {
  private ctx: AudioContext | null = null;
  private scheduled: OscillatorNode[] = [];

  /** Must be called from a user gesture (button click) to satisfy autoplay policies. */
  ensure(): AudioContext {
    this.ctx = this.ctx ?? primeSharedAudioContext();
    if (!this.ctx) {
      throw new Error('当前浏览器不支持 Web Audio。');
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  schedule(clicks: MetronomeClick[], sessionOriginPerfMs: number) {
    const ctx = this.ctx ?? getSharedAudioContext();
    if (!ctx || !Number.isFinite(sessionOriginPerfMs)) return;
    const nowPerf = performance.now();
    for (const click of clicks) {
      const when = metronomeClickAudioTime(
        click.atMs,
        sessionOriginPerfMs,
        nowPerf,
        ctx.currentTime,
      );
      if (when < ctx.currentTime + 0.01) continue; // already past
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = click.frequency;
      gain.gain.setValueAtTime(click.gain, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.09);
      osc.connect(gain).connect(ctx.destination);
      osc.start(when);
      osc.stop(when + 0.12);
      this.scheduled.push(osc);
    }
  }

  stopAll() {
    for (const osc of this.scheduled) {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
    }
    this.scheduled = [];
  }

  close() {
    this.stopAll();
    // The shared context belongs to the workspace, not to this metronome.
    this.ctx = null;
  }
}

/**
 * Beat grid for a practice timeline: count-in beats (accented on the first)
 * plus one click per quarter beat up to the last target. The accent repeats at
 * the score's quarter-note bar length, not hard-coded 4/4.
 */
export function buildBeatClicks(
  firstTargetAtMs: number,
  lastTargetAtMs: number,
  quarterMs: number,
  countInBeats: number,
  beatsPerBar = 4,
): MetronomeClick[] {
  const clicks: MetronomeClick[] = [];
  if (!(quarterMs > 0)) return clicks;
  const barBeats = Math.max(1, Math.round(beatsPerBar));
  const firstBeatAtMs = firstTargetAtMs - countInBeats * quarterMs;
  const totalBeats = Math.max(0, Math.round((lastTargetAtMs - firstBeatAtMs) / quarterMs));
  for (let beat = 0; beat <= totalBeats; beat += 1) {
    const atMs = firstBeatAtMs + beat * quarterMs;
    const isBarHead = beat % barBeats === 0;
    const inCountIn = atMs < firstTargetAtMs - 1;
    clicks.push({
      atMs,
      frequency: isBarHead ? 880 : 550,
      gain: isBarHead ? 0.2 : inCountIn ? 0.16 : 0.12,
    });
  }
  return clicks;
}
