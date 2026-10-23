'use strict';

// Smoke test for the Node-API binding. Asserts the key scoring behaviors so a
// broken addon fails loudly instead of printing plausible-looking output.
// Field names are camelCase to match the napi-rs generated index.d.ts contract.

const assert = require('node:assert/strict');
const { buildSchedule, NativeSession, NativeStudentModel } = require('../bindings/node');

const targets = buildSchedule({
  id: 'smoke-quarter-notes',
  ticksPerQuarter: 960,
  atoms: [
    { startTick: 0, durationTicks: 960, kind: 'note', bar: 1, beat: 1 },
    { startTick: 960, durationTicks: 960, kind: 'note', bar: 1, beat: 2 },
    { startTick: 1920, durationTicks: 960, kind: 'note', bar: 1, beat: 3 },
    { startTick: 2880, durationTicks: 960, kind: 'note', bar: 1, beat: 4 },
  ],
}, 120, 1000, 'standard');

assert.equal(targets.length, 4, 'four note onsets produce four targets');
assert.equal(targets[1].atMs, 1500, 'second quarter note lands at 1500 ms');

const session = new NativeSession(targets, 32, 35);
assert.equal(session.state(), 'ready');
session.start();
assert.equal(session.state(), 'running');

// One perfect hit, one late-but-good hit (45 ms late: outside the 30 ms Perfect
// window, inside the 60 ms Good window), one miss (no event for target 3), and
// one 10 ms late hit on the last target.
session.pushHit({ seq: 1, atMs: 1000, source: 'midi', notes: [60], velocity: 80 });
session.pushHit({ seq: 2, atMs: 1545, source: 'midi', notes: [60], velocity: 80 });
session.pushHit({ seq: 3, atMs: 2510, source: 'midi', notes: [60], velocity: 80 });
const realtime = session.processPending();
const report = session.finish();

assert.equal(report.targetCount, 4);
assert.equal(report.stats.perfectCount, 2);
assert.equal(report.stats.goodCount, 1);
assert.equal(report.stats.missCount, 1);
assert.equal(report.trustworthy, true, 'a clean session is trustworthy');

const grades = report.judgments.map((j) => j.grade);
assert.deepEqual([...grades].sort(), ['good', 'miss', 'perfect', 'perfect']);

console.log('smoke test passed:', {
  grades,
  meanAbsoluteMs: report.stats.meanAbsoluteMs,
});

// Deterministic replay: a second identical session must produce identical grades.
const replaySession = new NativeSession(buildSchedule({
  id: 'smoke-quarter-notes',
  ticksPerQuarter: 960,
  atoms: [
    { startTick: 0, durationTicks: 960, kind: 'note', bar: 1, beat: 1 },
    { startTick: 960, durationTicks: 960, kind: 'note', bar: 1, beat: 2 },
    { startTick: 1920, durationTicks: 1920, kind: 'note', bar: 1, beat: 3 },
    { startTick: 2880, durationTicks: 960, kind: 'note', bar: 1, beat: 4 },
  ],
}, 120, 1000, 'standard'), 32, 35);
replaySession.start();
[1000, 1545, 2510].forEach((atMs, index) => {
  replaySession.pushHit({ seq: index + 1, atMs, source: 'midi', notes: [60], velocity: 80 });
});
replaySession.processPending();
const replayReport = replaySession.finish();
assert.deepEqual(
  replayReport.judgments.map((j) => j.grade),
  report.judgments.map((j) => j.grade),
);
console.log('deterministic replay passed');

// StudentModel: untrustworthy attempts must not count as evidence, and a
// snapshot must round-trip through the constructor without losing progress.
const model = new NativeStudentModel();
const pass = {
  passed: true,
  trustworthy: true,
  targetCount: 16,
  assisted: false,
  transferTest: false,
  delayedRetest: false,
};
assert.equal(model.observeAttempt('offbeat', pass), 'developing');
model.observeAttempt('offbeat', pass);
assert.equal(model.observeAttempt('offbeat', pass), 'provisional', 'three passes reach provisional');

const untrusted = {
  passed: true,
  trustworthy: false,
  targetCount: 16,
  assisted: false,
  transferTest: true,
  delayedRetest: true,
};
assert.equal(model.observeAttempt('pulse', untrusted), 'not_assessed');
assert.equal(model.getSkill('pulse'), null, 'untrusted attempt adds no skill entry');

const snapshot = model.snapshot();
assert.equal(snapshot.length, 1);
assert.equal(snapshot[0].skillId, 'offbeat');
assert.equal(snapshot[0].trustworthyAttempts, 3);

const restored = new NativeStudentModel(snapshot);
assert.deepEqual(restored.getSkill('offbeat'), model.getSkill('offbeat'));
assert.equal(restored.observeAttempt('offbeat', pass), 'provisional', 'restored model continues accumulating');
assert.equal(restored.getSkill('offbeat').trustworthyAttempts, 4);

let rejectedDuplicate = false;
try {
  new NativeStudentModel([...snapshot, ...snapshot]);
} catch {
  rejectedDuplicate = true;
}
assert.ok(rejectedDuplicate, 'duplicate skill ids in a snapshot must be rejected');
console.log('student model roundtrip passed');
