import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { buildNoteReview } from './note-review.mjs';
const native = createRequire(import.meta.url)('../../rhythm-trainer-core-v0.2/bindings/node');
const take = (change = {}) => ({ takeId: 'take-review', score: { scoreFingerprint: 'a'.repeat(64) }, assessment: {
  trustworthy: true, timelineReport: {
    scoreEvents: [{ scoreEventId: 'n1', measure: 2, pitch: 60, targetDurationMs: 500 }],
    scoreV1: { configVersion: 'scoring-v1.0.1:default', eventResults: [{ result: 'MATCH', scoreEventId: 'n1', performedNoteId: 'press-1', expectedPitch: 60, actualPitch: 60, measure: 2, onsetErrorMs: 61 }] },
    keyLifecycles: { observations: [{ pressId: 'press-1', status: 'complete', noteOnSourceSeq: 100, keyDownDurationMs: 495 }] },
    durations: { assessments: [{ onsetSeq: 100, pitch: 60, quality: 'ok', nominalDurationMs: 500, actualKeyDownMs: 495, result: 'within_tolerance' }] },
    ...change,
  } } });
it('uses the frozen Rust tolerance and preserves exact onset and release evidence', () => {
  for (const error of [-61, -60, 0, 60, 61]) {
    const t = take(); const e = t.assessment.timelineReport.scoreV1.eventResults[0]; e.onsetErrorMs = error;
    const report = native.scorePerformance([{ scoreEventId: 'n1', measure: 2, beatPosition: 0, pitch: 60, targetOnsetMs: 1000, targetDurationMs: 500, partId: 'P1' }],
      [{ performedNoteId: 'press-1', pitch: 60, onsetMs: 1000 + error, releaseMs: 1500 + error, pairingStatus: 'complete' }]);
    expect(report.configVersion).toBe('scoring-v1.0.1:default');
    const review = buildNoteReview(t); const row = review.items[0];
    expect(row.state === 'attention').toBe(report.onset.outOfToleranceCount === 1);
    expect(row.onsetErrorMs).toBe(error); expect(row.actualDurationMs).toBe(495); expect(row.expectedDurationMs).toBe(500);
  }
});
it('never applies a chord group duration to a different nominal note duration', () => {
  const t = take(); t.assessment.timelineReport.scoreV1.eventResults[0].onsetErrorMs = 0;
  t.assessment.timelineReport.durations.assessments[0].nominalDurationMs = 1000;
  const row = buildNoteReview(t).items[0]; expect(row.durationResult).toBe('unknown'); expect(row.state).toBe('unknown');
  expect(row.actualDurationMs).toBe(495); expect(row.messages.join('')).toContain('未单独判定');
});
it('retains all notes, misses and unlocated extras without guessing their position', () => {
  const t = take(); t.assessment.timelineReport.scoreV1.eventResults = Array.from({ length: 150 }, (_, i) => ({ result: 'MISSING', scoreEventId: `n${i}`, expectedPitch: 60 }));
  t.assessment.timelineReport.scoreV1.eventResults.push({ result: 'EXTRA', actualPitch: 61 });
  const review = buildNoteReview(t); expect(review.items).toHaveLength(151);
  expect(review.items[150]).toMatchObject({ state: 'error', eventId: null, measure: null });
});
it('does not manufacture timing or duration grades for old versions or absent reports', () => {
  const t = take(); t.assessment.timelineReport.scoreV1.configVersion = 'future';
  expect(buildNoteReview(t).items[0].state).toBe('unknown');
  expect(buildNoteReview({ takeId: 'old', assessment: {} }).kind).toBe('unavailable');
  t.assessment.trustworthy = false; expect(buildNoteReview(t).notice).toContain('不可信');
});
it('keeps Follow group timing separate from fixed-clock and individual key durations', () => {
  const t = { takeId: 'follow', evidence: { followSourceNotes: [{ targetId: 'g1', eventId: 'source-C', pitch: 60, spelling: 'C4' }, { targetId: 'g1', eventId: 'source-E', pitch: 64, spelling: 'E4' }] },
    assessment: { trustworthy: true, followReport: { targets: [{ targetId: 'g1', bar: 1, completed: true, standard: false, expectedPitches: ['C4', 'E4'], wrongNotes: [{ midiNote: 61 }], duplicateNotes: 0, intervalJudged: true, intervalErrorMs: -120, chordSpreadMs: 30 }] } } };
  const review = buildNoteReview(t); expect(review.items).toHaveLength(2);
  expect(review.items[0]).toMatchObject({ eventId: 'source-C', onsetErrorMs: null, intervalErrorMs: -120, durationResult: 'not-applicable' });
  expect(review.items[0].messages.join('')).toContain('此目标组曾按错');
});
