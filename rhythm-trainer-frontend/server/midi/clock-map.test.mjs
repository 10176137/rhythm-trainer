import { describe, expect, it } from 'vitest';
import { computeClockSample, mapNodeEventToSession, selectClockSample } from './clock-map.mjs';

describe('clock mapping', () => {
  it('computes RTT and server-minus-client offset from four timestamps', () => {
    const sample = computeClockSample({
      clientSendPerfMs: 1000,
      clientReceivePerfMs: 1010,
      serverReceivePerfMs: 5000,
      serverSendPerfMs: 5002,
    });
    expect(sample.rtt).toBe(8);
    expect(sample.offset).toBe(3996);
    expect(sample.uncertainty).toBe(4);
  });

  it('rejects impossible samples', () => {
    expect(computeClockSample({ clientSendPerfMs: 0, clientReceivePerfMs: 1, serverReceivePerfMs: 100, serverSendPerfMs: 90 })).toBeNull();
    expect(computeClockSample({})).toBeNull();
  });

  it('selects the low-RTT sample and labels quality', () => {
    const selected = selectClockSample([
      { rtt: 8, offset: 10, uncertainty: 4 },
      { rtt: 2, offset: 12, uncertainty: 1 },
      { rtt: 5, offset: 11, uncertainty: 2.5 },
      { rtt: 3, offset: 9, uncertainty: 1.5 },
      { rtt: 4, offset: 10, uncertainty: 2 },
    ]);
    expect(selected.offsetServerMinusClientMs).toBe(12);
    expect(selected.rttMs).toBe(2);
    expect(selected.sampleCount).toBe(5);
    expect(selected.quality).toBe('good');
  });

  it('maps Node monotonic capture time into browser session time', () => {
    expect(mapNodeEventToSession({
      capturedAtMonotonicMs: 5000,
      offsetServerMinusClientMs: 4496,
      sessionOriginClientPerfMs: 400,
    })).toEqual({ clientPerfMs: 504, atSessionMs: 104 });
  });

  it('returns null instead of inventing a time when inputs are missing', () => {
    expect(mapNodeEventToSession({})).toBeNull();
    expect(mapNodeEventToSession({
      capturedAtMonotonicMs: 5000,
      offsetServerMinusClientMs: Number.NaN,
      sessionOriginClientPerfMs: 0,
    })).toBeNull();
  });
});
