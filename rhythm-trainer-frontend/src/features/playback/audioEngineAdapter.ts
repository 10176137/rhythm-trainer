import { ensureSharedAudioContext } from './sharedAudioContext';
import type { PianoVoiceHandle } from './synthPiano';
import { getInstrument, instrumentVoice, prepareInstrument, type InstrumentId } from './instruments';

export interface PlaybackVoiceSpec {
  /** Unique per occurrence; repeated pitches must use different IDs. */
  voiceId: string;
  midiNote: number;
  velocity: number;
}

export interface PlaybackAudioEngine {
  prepare(): Promise<void>;
  scheduleNoteOn(voice: PlaybackVoiceSpec, atAudioTime: number): void;
  scheduleNoteOff(voiceId: string, atAudioTime: number): void;
  allNotesOff(reason: string, atAudioTime?: number): void;
  setGain(value: number): void;
  currentTime(): number;
  state(): AudioContextState | 'unknown';
  dispose(): void;
}

/**
 * Web Audio implementation. The context is shared with the metronome; this
 * adapter owns only its master/compressor chain and its voices. It never
 * creates or closes the shared context, so stopping playback cannot break the
 * beat grid and vice versa.
 */
export class WebAudioEngineAdapter implements PlaybackAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private readonly voices = new Map<string, PianoVoiceHandle>();
  private gain = 0.85;
  private instrument: InstrumentId = 'grand';
  private buffers: AudioBuffer[] = [];
  private preparation = 0;
  private readonly retired = new Map<string, number>();

  async prepare(): Promise<void> {
    const token = ++this.preparation;
    const ctx = await ensureSharedAudioContext();
    this.instrument = getInstrument();
    this.buffers = await prepareInstrument(ctx, this.instrument);
    if (token !== this.preparation) throw new Error('音频准备已取消');
    if (!this.ctx || this.ctx !== ctx) {
      this.ctx = ctx;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.2;
      this.master = ctx.createGain();
      this.master.gain.value = this.gain;
      this.master.connect(this.compressor);
      this.compressor.connect(ctx.destination);
    }
    if (ctx.state !== 'running') throw new Error('音频上下文未运行，无法开始参考播放。');
  }

  scheduleNoteOn(voice: PlaybackVoiceSpec, atAudioTime: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) throw new Error('音频引擎尚未准备。');
    if (ctx.state !== 'running') throw new Error('音频上下文已挂起，无法调度音符。');
    const existing = this.voices.get(voice.voiceId);
    for (const [id, end] of this.retired) if (end < ctx.currentTime) { this.voices.delete(id); this.retired.delete(id); }
    if (existing) existing.forceStop(ctx.currentTime);
    this.voices.set(
      voice.voiceId,
      instrumentVoice(ctx, this.master, voice.midiNote, Math.max(atAudioTime, ctx.currentTime), voice.velocity, this.instrument, this.buffers),
    );
  }

  scheduleNoteOff(voiceId: string, atAudioTime: number): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    voice.release(atAudioTime);
    this.retired.set(voiceId, atAudioTime + 2);
  }

  allNotesOff(_reason: string, atAudioTime?: number): void {
    this.preparation++;
    const now = atAudioTime ?? this.ctx?.currentTime ?? 0;
    for (const voice of this.voices.values()) voice.forceStop(now);
    this.voices.clear();
    this.retired.clear();
  }

  setGain(value: number): void {
    this.gain = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    if (!this.ctx || !this.master) return;
    try {
      this.master.gain.setTargetAtTime(this.gain, this.ctx.currentTime, 0.02);
    } catch {
      // Closed context.
    }
  }

  currentTime(): number {
    return this.ctx?.currentTime ?? 0;
  }

  state(): AudioContextState | 'unknown' {
    return this.ctx?.state ?? 'unknown';
  }

  dispose(): void {
    this.allNotesOff('dispose');
    try { this.master?.disconnect(); } catch { /* best effort */ }
    try { this.compressor?.disconnect(); } catch { /* best effort */ }
    this.master = null;
    this.compressor = null;
    this.ctx = null;
  }
}
