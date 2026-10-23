import { describe, expect, it } from 'vitest';
import { startPianoVoice } from './synthPiano';

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
  setTargetAtTime() { return this; }
}

class FakeNode {
  connect(target: unknown) { return target; }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  frequency = { setValueAtTime: () => undefined };
  starts: number[] = [];
  stops: number[] = [];
  start(time: number) { this.starts.push(time); }
  stop(time: number) { this.stops.push(time); }
}

function fakeContext(currentTime: number) {
  const oscillators: FakeOscillator[] = [];
  const ctx = {
    currentTime,
    destination: new FakeNode(),
    createGain: () => new FakeGain(),
    createOscillator: () => {
      const oscillator = new FakeOscillator();
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  return { ctx, oscillators };
}

describe('synth piano voice lifecycle', () => {
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
