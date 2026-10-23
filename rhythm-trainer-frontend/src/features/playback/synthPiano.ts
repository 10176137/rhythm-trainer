// Small, local, license-free synthesized piano voice. This is intentionally an
// additive model, not a sampled instrument: no network fetch, no sample
// licensing and no hidden resource load. It gives reference playback a stable
// piano-like envelope while the sampled-instrument decision remains open.

const PARTIALS = [
  { ratio: 1, amplitude: 0.52 },
  { ratio: 2.01, amplitude: 0.24 },
  { ratio: 3.04, amplitude: 0.13 },
  { ratio: 4.09, amplitude: 0.07 },
] as const;

const MAX_DECAY_SECONDS = 10;

export interface PianoVoiceHandle {
  readonly midiNote: number;
  readonly startedAt: number;
  release(atAudioTime: number): void;
  /** Hard stop used by pause/stop/all-notes-off; overrides a future note-off. */
  forceStop(atAudioTime?: number): void;
  stopNow(): void;
  isReleased(): boolean;
}

class SynthPianoVoice implements PianoVoiceHandle {
  readonly midiNote: number;
  readonly startedAt: number;
  private readonly ctx: AudioContext;
  private readonly gain: GainNode;
  private readonly oscillators: OscillatorNode[] = [];
  private released = false;
  private stopped = false;
  private hardStopped = false;

  constructor(ctx: AudioContext, destination: AudioNode, midiNote: number, when: number, velocity: number) {
    this.ctx = ctx;
    this.midiNote = midiNote;
    this.startedAt = when;
    const level = Math.max(0.0002, Math.min(0.28, velocity * 0.26));
    const frequency = 440 * 2 ** ((midiNote - 69) / 12);
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0.0001, when);
    this.gain.gain.linearRampToValueAtTime(level, when + 0.006);
    // Piano-like natural decay; release() cancels this ramp when the target
    // note ends earlier.
    this.gain.gain.exponentialRampToValueAtTime(0.0001, when + MAX_DECAY_SECONDS);
    this.gain.connect(destination);

    for (const partial of PARTIALS) {
      const oscillator = ctx.createOscillator();
      const partialGain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency * partial.ratio, when);
      partialGain.gain.setValueAtTime(partial.amplitude, when);
      oscillator.connect(partialGain).connect(this.gain);
      oscillator.start(when);
      this.oscillators.push(oscillator);
    }
  }

  release(atAudioTime: number): void {
    if (this.stopped || this.released) return;
    this.released = true;
    const now = this.ctx.currentTime;
    const releaseAt = Math.max(atAudioTime, now);

    if (this.startedAt > releaseAt + 0.001) {
      // The note was only scheduled for the future (pause/stop). Cancel it
      // completely; it must never speak after the stop command.
      try {
        this.gain.gain.cancelScheduledValues(now);
        this.gain.gain.setValueAtTime(0.0001, now);
      } catch {
        // Closed contexts are already silent.
      }
      for (const oscillator of this.oscillators) {
        try { oscillator.stop(now + 0.005); } catch { /* already stopped */ }
      }
      this.stopped = true;
      return;
    }

    try {
      const param = this.gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
      if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(releaseAt);
      } else {
        param.cancelScheduledValues(releaseAt);
      }
      param.setTargetAtTime(0.0001, releaseAt, 0.07);
    } catch {
      // A closed context must not turn cleanup into a crash.
    }
    for (const oscillator of this.oscillators) {
      try { oscillator.stop(releaseAt + 0.45); } catch { /* already stopped */ }
    }
    this.stopped = true;
  }

  forceStop(atAudioTime = this.ctx.currentTime): void {
    if (this.hardStopped) return;
    this.hardStopped = true;
    this.released = true;
    this.stopped = true;
    const now = Math.max(atAudioTime, this.ctx.currentTime);
    try {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0.0001, now);
    } catch {
      // Closed contexts are already silent.
    }
    for (const oscillator of this.oscillators) {
      try { oscillator.stop(now + 0.005); } catch { /* already stopped */ }
    }
  }

  stopNow(): void {
    this.forceStop();
  }

  isReleased(): boolean {
    return this.released;
  }
}

export function startPianoVoice(
  ctx: AudioContext,
  destination: AudioNode,
  midiNote: number,
  atAudioTime: number,
  velocity: number,
): PianoVoiceHandle {
  return new SynthPianoVoice(ctx, destination, midiNote, atAudioTime, velocity);
}
