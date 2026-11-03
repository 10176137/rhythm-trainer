import { startPianoVoice, type PianoVoiceHandle } from './synthPiano';
export type InstrumentId = 'grand' | 'electric';
const KEY = 'rhythm-trainer.instrument.v1';
export function getInstrument(): InstrumentId { try { return localStorage.getItem(KEY) === 'electric' ? 'electric' : 'grand'; } catch { return 'grand'; } }
export function saveInstrument(id: InstrumentId) { try { localStorage.setItem(KEY, id); } catch { /* private browsing */ } }
const names = ['A0', ...Array.from({ length: 7 }, (_, i) => [`C${i+1}`, `Ds${i+1}`, `Fs${i+1}`, `A${i+1}`]).flat(), 'C8'];
const pitches = names.map((_, i) => 21 + i * 3);
const banks = new WeakMap<BaseAudioContext, Promise<AudioBuffer[]>>();
export function prepareInstrument(ctx: BaseAudioContext, id: InstrumentId) {
  if (id === 'electric') return Promise.resolve([] as AudioBuffer[]);
  let bank = banks.get(ctx);
  if (!bank) {
    bank = Promise.all(names.map(async name => {
      const response = await fetch(`/audio/salamander/${name}.mp3`);
      if (!response.ok) throw new Error(`本地钢琴采样缺失：${name}`);
      return ctx.decodeAudioData(await response.arrayBuffer());
    }));
    banks.set(ctx, bank); bank.catch(() => banks.delete(ctx));
  }
  return bank;
}
export function instrumentVoice(ctx: AudioContext, destination: AudioNode, pitch: number, at: number, velocity: number,
  id: InstrumentId, buffers: AudioBuffer[]): PianoVoiceHandle {
  if (id === 'electric') return startPianoVoice(ctx, destination, pitch, at, velocity);
  if (!buffers.length) throw new Error('钢琴采样未准备完成');
  let index = 0; for (let i = 1; i < pitches.length; i++) if (Math.abs(pitches[i] - pitch) < Math.abs(pitches[index] - pitch)) index = i;
  const source = ctx.createBufferSource(); source.buffer = buffers[index]; source.playbackRate.value = 2 ** ((pitch - pitches[index]) / 12);
  const gain = ctx.createGain(); const filter = ctx.createBiquadFilter(); filter.type = 'lowpass';
  filter.frequency.value = 2500 + Math.max(0, Math.min(1, velocity)) * 12500;
  const level = Math.max(.001, Math.min(1, velocity)) ** 1.3 * .65;
  gain.gain.setValueAtTime(level, at); source.connect(filter).connect(gain).connect(destination);
  let released = false;
  source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
  source.start(at);
  const stop = (time: number, hard = false) => {
    const when = Math.max(time, ctx.currentTime);
    if (hard && at > when) { try { source.stop(when); } catch { /* ended */ } released = true; return; }
    if (released && !hard) return; released = true;
    gain.gain.cancelScheduledValues(when); gain.gain.setValueAtTime(level, when);
    gain.gain.exponentialRampToValueAtTime(.0001, when + (hard ? .015 : .22));
    try { source.stop(when + (hard ? .02 : .25)); } catch { /* already ended */ }
  };
  return { midiNote: pitch, startedAt: at, release: t => stop(t), forceStop: t => stop(t ?? ctx.currentTime, true), stopNow: () => stop(ctx.currentTime, true), isReleased: () => released };
}
