// Local additive instruments. Each preset owns its spectrum and envelope;
// sample-backed piano variants are defined separately in instrumentCatalog.

const PARTIALS = [
  { ratio: 1, amplitude: 0.52 },
  { ratio: 2.01, amplitude: 0.24 },
  { ratio: 3.04, amplitude: 0.13 },
  { ratio: 4.09, amplitude: 0.07 },
] as const;

const MAX_DECAY_SECONDS = 10;
export type SynthVoiceId = 'electric' | 'epiano' | 'organ' | 'bell';
const PRESETS = {
  electric: { partials: PARTIALS, attack: .006, decay: MAX_DECAY_SECONDS, sustain: false, release: .07, tail: .45 },
  epiano: { partials: [{ ratio: 1, amplitude: .66 }, { ratio: 2, amplitude: .21 }, { ratio: 3.99, amplitude: .09 }, { ratio: 7.98, amplitude: .04 }], attack: .008, decay: 6, sustain: false, release: .09, tail: .55 },
  organ: { partials: [{ ratio: 1, amplitude: .52 }, { ratio: 2, amplitude: .24 }, { ratio: 3, amplitude: .13 }, { ratio: 4, amplitude: .07 }, { ratio: 8, amplitude: .04 }], attack: .025, decay: 0, sustain: true, release: .035, tail: .22 },
  bell: { partials: [{ ratio: 1, amplitude: .56 }, { ratio: 2.76, amplitude: .24 }, { ratio: 5.4, amplitude: .14 }, { ratio: 8.93, amplitude: .06 }], attack: .003, decay: 5, sustain: false, release: .12, tail: .72 },
} as const;

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
  private readonly preset: typeof PRESETS[SynthVoiceId];

  constructor(ctx: AudioContext, destination: AudioNode, midiNote: number, when: number, velocity: number, voice: SynthVoiceId) {
    this.preset = PRESETS[voice];
    this.ctx = ctx;
    this.midiNote = midiNote;
    this.startedAt = when;
    const level = Math.max(0.0002, Math.min(0.28, velocity * 0.26));
    const frequency = 440 * 2 ** ((midiNote - 69) / 12);
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0.0001, when);
    this.gain.gain.linearRampToValueAtTime(level, when + this.preset.attack);
    // Piano-like natural decay; release() cancels this ramp when the target
    // note ends earlier.
    if (!this.preset.sustain) this.gain.gain.exponentialRampToValueAtTime(0.0001, when + this.preset.decay);
    this.gain.connect(destination);

    let activeOscillators = 0;
    for (const partial of this.preset.partials) {
      // Omit inaudible partials instead of folding them onto the Nyquist edge.
      const partialFrequency = frequency * partial.ratio;
      if (partialFrequency >= (ctx.sampleRate || 44100) * .49) continue;
      const oscillator = ctx.createOscillator();
      const partialGain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(partialFrequency, when);
      partialGain.gain.setValueAtTime(partial.amplitude, when);
      if (voice === 'epiano' || voice === 'bell') {
        // Metal overtones fade faster than the fundamental.
        partialGain.gain.exponentialRampToValueAtTime(.0001, when + this.preset.decay / Math.sqrt(partial.ratio));
      }
      oscillator.connect(partialGain).connect(this.gain);
      activeOscillators++;
      oscillator.onended = () => {
        oscillator.disconnect(); partialGain.disconnect();
        if (--activeOscillators === 0) this.gain.disconnect();
      };
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
      param.setTargetAtTime(0.0001, releaseAt, this.preset.release);
    } catch {
      // A closed context must not turn cleanup into a crash.
    }
    for (const oscillator of this.oscillators) {
      try { oscillator.stop(releaseAt + this.preset.tail); } catch { /* already stopped */ }
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
  voice: SynthVoiceId = 'electric',
): PianoVoiceHandle {
  return new SynthPianoVoice(ctx, destination, midiNote, atAudioTime, velocity, voice);
}
