import { describe, expect, it } from 'vitest';
import { startPianoVoice, type SynthVoiceId } from './synthPiano';

class FakeParam {
  value = 0;
  decays: number[] = [];
  setValueAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number, time: number) { this.value = value; this.decays.push(time); return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
  setTargetAtTime() { return this; }
}

class FakeNode {
  connect(target: unknown) { return target; }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  starts: number[] = [];
  stops: number[] = [];
  start(time: number) { this.starts.push(time); }
  stop(time: number) { this.stops.push(time); }
}

function fakeContext(currentTime: number) {
  const oscillators: FakeOscillator[] = [];
  const gains: FakeGain[] = [];
  const ctx = {
    currentTime,
    sampleRate: 48000,
    destination: new FakeNode(),
    createGain: () => { const gain = new FakeGain(); gains.push(gain); return gain; },
    createOscillator: () => {
      const oscillator = new FakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  return { ctx, oscillators, gains };
}

describe('synth piano voice lifecycle', () => {
  it('uses distinct spectra and keeps the organ sustained until note-off', () => {
    const spectra: number[][] = [];
    for (const id of ['electric', 'epiano', 'organ', 'bell'] as SynthVoiceId[]) {
      const { ctx, oscillators, gains } = fakeContext(0);
      const voice = startPianoVoice(ctx as unknown as AudioContext, ctx.destination as AudioNode, 69, 0, .7, id);
      spectra.push(oscillators.map(o => o.frequency.value));
      expect(gains[0].gain.decays.length).toBe(id === 'organ' ? 0 : 1);
      if (id === 'epiano' || id === 'bell') {
        expect(gains.at(-1)!.gain.decays[0]).toBeLessThan(gains[1].gain.decays[0]);
      }
      voice.release(5);
      expect(oscillators.every(o => o.stops[0] > 5)).toBe(true);
      voice.forceStop();
      expect(oscillators.every(o => o.stops.at(-1) === .005)).toBe(true);
      oscillators.forEach(o => o.onended?.());
    }
    expect(new Set(spectra.map(s => s.join(','))).size).toBe(4);
    expect(spectra[3][1] / 440).toBeCloseTo(2.76);
  });

  it('omits above-Nyquist overtones for high piano keys', () => {
    const { ctx, oscillators } = fakeContext(0);
    startPianoVoice(ctx as unknown as AudioContext, ctx.destination as AudioNode, 108, 0, .7, 'bell');
    expect(oscillators.length).toBe(3);
    expect(oscillators.every(o => o.frequency.value < ctx.sampleRate / 2)).toBe(true);
  });

  it('hard stop cancels a note that was scheduled to start in the future', () => {
    const { ctx, oscillators } = fakeContext(1.9);
    const voice = startPianoVoice(
      ctx as unknown as AudioContext,
      ctx.destination as unknown as AudioNode,
      60,
      2.0,
      0.7,
    );
    voice.release(2.5);
    expect(oscillators[0].stops).toContain(2.95);

    voice.forceStop();
    expect(oscillators[0].stops.at(-1)).toBeCloseTo(1.905, 6);
  });

  it('normal note off is scheduled at the target end, not at construction time', () => {
    const { ctx, oscillators } = fakeContext(1.9);
    const voice = startPianoVoice(
      ctx as unknown as AudioContext,
      ctx.destination as unknown as AudioNode,
      60,
      2.0,
      0.7,
    );
    voice.release(3.0);
    expect(oscillators[0].stops).toEqual([3.45]);
    expect(voice.isReleased()).toBe(true);
  });
});
