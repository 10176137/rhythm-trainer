import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LiveNoteFeedback } from './live-note-feedback.mjs';
const require = createRequire(import.meta.url);
const { scorePerformance } = require('../../rhythm-trainer-core-v0.2/bindings/node');
const event = (id, pitch, onset = 1000) => ({ scoreEventId: id, measure: 1, beatPosition: 0, pitch, targetOnsetMs: onset, targetDurationMs: 500, partId: 'P1' });
const target = (onset = 1000) => ({ atMs: onset, goodWindowMs: 60 });

describe('authoritative live pitch/onset feedback', () => {
  it('never awards a hit to silence; misses only after the engine window closes', () => {
    const feedback = new LiveNoteFeedback([event('a', 60)], [target()], scorePerformance);
    expect(feedback.update(1000)).toEqual([]);
    expect(feedback.update(1060)).toEqual([]);
    expect(feedback.update(1061)).toEqual([{ scoreEventId: 'a', state: 'miss' }]);
    expect(feedback.update(2000)).toEqual([]);
  });
  it('requires both pitch and the effective engine timing window', () => {
    const correct = new LiveNoteFeedback([event('a', 60)], [target()], scorePerformance);
    correct.addOnset('p1', 60, 1020);
    expect(correct.update(1020)).toEqual([{ scoreEventId: 'a', state: 'hit' }]);
    const wrong = new LiveNoteFeedback([event('a', 60)], [target()], scorePerformance);
    wrong.addOnset('p1', 61, 1020);
    expect(wrong.update(1020)).toEqual([{ scoreEventId: 'a', state: 'wrong' }]);
    const late = new LiveNoteFeedback([event('a', 60)], [target()], scorePerformance);
    late.addOnset('p1', 60, 1100);
    expect(late.update(1100)).toEqual([{ scoreEventId: 'a', state: 'miss' }]);
  });
  it('tracks chord tones separately and never invents missing tones', () => {
    const feedback = new LiveNoteFeedback([event('c', 60), event('e', 64), event('g', 67)], [target()], scorePerformance);
    feedback.addOnset('p1', 67, 1000);
    expect(feedback.update(1000)).toEqual([{ scoreEventId: 'g', state: 'hit' }]);
    feedback.addOnset('p2', 60, 1010);
    feedback.addOnset('p3', 64, 1020);
    expect(feedback.update(1020)).toEqual([{ scoreEventId: 'c', state: 'hit' }, { scoreEventId: 'e', state: 'hit' }]);
  });
  it.each([{ pitches: [66, 60, 64, 67] }, { pitches: [60, 64, 67, 66] }])('reports the extra tone in a complete chord regardless of arrival order: $pitches', ({ pitches }) => {
    const feedback = new LiveNoteFeedback([event('c', 60), event('e', 64), event('g', 67)], [target()], scorePerformance);
    const shown = new Map();
    pitches.forEach((pitch, index) => {
      feedback.addOnset(`p${index}`, pitch, 1000 + index * 5);
      for (const item of feedback.update(1000 + index * 5)) shown.set(item.scoreEventId, item);
    });
    expect([...shown.values()]).toHaveLength(3);
    for (const id of ['c', 'e', 'g']) expect(shown.get(id)).toEqual({ scoreEventId: id, state: 'hit', extraCount: 1 });
    expect(feedback.update(1061)).toEqual([]);
  });
  it('does not attach a gap extra to a correct chord or contaminate the next chord', () => {
    const events = [event('c', 60), event('e', 64), event('g', 67), event('next', 72, 2000)];
    const feedback = new LiveNoteFeedback(events, [target(), target(2000)], scorePerformance);
    [60, 64, 67].forEach((pitch, index) => feedback.addOnset(`p${index}`, pitch, 1000));
    feedback.update(1000);
    feedback.addOnset('gap', 66, 1500);
    expect(feedback.update(1500)).toEqual([]);
    feedback.addOnset('next', 72, 2000);
    expect(feedback.update(2000)).toEqual([{ scoreEventId: 'next', state: 'hit' }]);
  });
  it('assigns an extra to the nearest onset when timing windows overlap', () => {
    const feedback = new LiveNoteFeedback([event('a', 60), event('b', 64, 1100)], [target(), target(1100)], scorePerformance);
    feedback.addOnset('a', 60, 1000); feedback.addOnset('b', 64, 1100);
    feedback.update(1100);
    feedback.addOnset('extra', 66, 1055);
    expect(feedback.update(1100)).toEqual([{ scoreEventId: 'b', state: 'hit', extraCount: 1 }]);
  });
  it('shifts future deadlines on resume and keeps past results intact', () => {
    const feedback = new LiveNoteFeedback([event('a', 60), event('b', 62, 2000)], [target(), target(2000)], scorePerformance);
    feedback.addOnset('p1', 60, 1000);
    feedback.update(1000);
    feedback.resume(1500, 3000);
    expect(feedback.update(4000)).toEqual([]);
    feedback.addOnset('p2', 62, 5000);
    expect(feedback.update(5000)).toEqual([{ scoreEventId: 'b', state: 'hit' }]);
  });
  it('reuses alignment until new evidence arrives and accepts no duplicate onset ids', () => {
    let calls = 0;
    const feedback = new LiveNoteFeedback([event('a', 60)], [target()], (...args) => { calls++; return scorePerformance(...args); });
    feedback.addOnset('p1', 60, 1000);
    feedback.addOnset('p1', 60, 1000);
    feedback.update(1000); feedback.update(1040); feedback.update(1080);
    expect(calls).toBe(1);
  });
});
