import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { generateProgram, TrainingProgramStore, reviewProgram } from './training-programs.mjs';
import { importScoreText } from '../src/features/score/scoreImport.ts';
import { projectScoreDocumentV1 } from '../src/score-engine/contract-v1/plan-fingerprint.ts';

const base = { mode: 'timed', minutes: 2, variation: 'shuffle', ids: ['five-finger', 'scales', 'triads'], keys: ['C', 'G', 'F'], hand: 'right', level: 1, bpm: 60, seed: 11 };
function takeFor(drill, change = {}) {
  const events = drill.program.sections.flatMap((s) => Array.from({ length: 10 }, (_, i) => ({ measure: s.startBar, result: 'MATCH', onsetErrorMs: i % 2 ? -20 : 20 })));
  return { takeId: 'take-test', score: { scoreFingerprint: createHash('sha256').update(drill.xml).digest('hex') }, lifecycle: { endReason: 'completed', startedAtIso: new Date(Date.now() + 1000).toISOString() },
    context: { plannerAuthority: 'rust', practiceConfigSnapshot: { tempo: drill.bpm, profile: 'standard', hand: 'both', advanceMode: 'timeline', feedback: 'after' } },
    evidence: { captureDiagnostics: { scoreInputNoteCount: events.length } },
    assessment: { trustworthy: true, scoreStatus: 'AVAILABLE', timelineReport: { assisted: false, scoringConfig: { feedback: 'after' }, scoreV1: { eventResults: events, confidence: 'high', dataDegraded: false } } }, ...change };
}

describe('real piano program material', () => {
  it('plans every assessment note through the actual Rust planner and fingerprint gate', () => {
    const native = createRequire(import.meta.url)('../../rhythm-trainer-core-v0.2/bindings/node');
    const drill = generateProgram({ mode: 'assessment' });
    const { doc, report } = importScoreText(drill.xml, 'baseline.musicxml');
    const { dto } = projectScoreDocumentV1(doc.engine, report);
    const config = { partId: 'P1', range: { startMeasureOrdinal: 1, endMeasureOrdinal: drill.bars }, repeatSelection: { kind: 'none' }, hand: 'both', handMapping: { schemaVersion: 1, mappingVersion: 'hand-mapping-1', source: 'user', parts: [{ partId: 'P1', staves: drill.staffHands }] }, bpm: { numerator: 60, denominator: 1 }, ticksPerQuarter: 960, countInUs: 3000000, unsupportedNotationPolicy: 'reject-strict', plannerVersion: 'rust-planner-1' };
    const plan = JSON.parse(native.buildPlanV1(JSON.stringify(dto), JSON.stringify(report), JSON.stringify(config)));
    expect(plan.planStrictAllowed).toBe(true);
    expect(plan.occurrences.length).toBe(report.counts.noteCount);
    expect(native.planFingerprintV1Gate(JSON.stringify(dto), JSON.stringify(report), JSON.stringify(plan), JSON.stringify(config))).toMatch(/^plan-v1:sha256:/);
    const events = plan.scoreEvents.map((e) => ({ scoreEventId: e.runtimeOccurrenceId, measure: e.measure, beatPosition: 0, pitch: e.pitch, targetOnsetMs: e.targetOnsetUs / 1000, targetDurationMs: e.targetDurationUs / 1000, partId: e.partId }));
    const performed = events.map((e, i) => ({ performedNoteId: `note-${i}`, pitch: e.pitch, onsetMs: e.targetOnsetMs, releaseMs: e.targetOnsetMs + e.targetDurationMs, pairingStatus: 'complete' }));
    const take = takeFor(drill);
    take.assessment.timelineReport.scoreV1 = native.scorePerformance(events, performed);
    expect(reviewProgram(drill, take).sections.every((s) => s.accuracy === 1 && s.status === 'stable')).toBe(true);
    take.assessment.timelineReport.scoreV1 = native.scorePerformance(events, performed.map((p, i) => i % 3 === 0 ? { ...p, pitch: p.pitch + 1 } : p));
    expect(reviewProgram(drill, take).sections.some((s) => s.accuracy < 1)).toBe(true);
    const spam = performed.map((p, i) => ({ ...p, performedNoteId: `extra-${i}`, pitch: (p.pitch + 6) % 128, onsetMs: p.onsetMs + 30, releaseMs: p.releaseMs + 30 }));
    take.assessment.timelineReport.scoreV1 = native.scorePerformance(events, [...performed, ...spam]);
    expect(reviewProgram(drill, take).label).not.toBe('本轮基本功较稳定');
    take.assessment.timelineReport.scoreV1 = native.scorePerformance(events, []);
    take.evidence.captureDiagnostics.scoreInputNoteCount = 0;
    expect(reviewProgram(drill, take).assessable).toBe(false);
  });
  it.each(['right', 'left', 'both'])('generates complete metered voices for %s with randomized complete phrases', (hand) => {
    const drill = generateProgram({ ...base, hand });
    const result = importScoreText(drill.xml, 'program.musicxml');
    expect(result.report.strictAllowed).toBe(true);
    expect(result.report.issues).toEqual([]);
    expect(drill.program.seconds).toBeGreaterThanOrEqual(60);
    expect(drill.program.seconds).toBeLessThan(85);
    expect(drill.program.remainingSeconds + drill.program.seconds).toBe(120);
    expect(new Set(drill.program.sections.map((s) => `${s.id}:${s.key}`)).size).toBeGreaterThan(1);
    expect(drill.xml).toBe(generateProgram({ ...base, hand }).xml);
    const notes = result.doc.notes;
    if (hand !== 'both') expect(notes.every((note) => note.hand === hand)).toBe(true);
  });
  it('has a fixed six-domain baseline and a bounded continuous segment', () => {
    const test = generateProgram({ mode: 'assessment' });
    expect(test.program.sections).toHaveLength(6);
    expect(test.program.seconds).toBe(96);
    expect(test.bpm).toBe(60);
    expect(importScoreText(test.xml, 'baseline.musicxml').report.issues).toEqual([]);
    const continuous = generateProgram({ ...base, mode: 'continuous' });
    expect(continuous.program.seconds).toBeGreaterThanOrEqual(60);
    expect(continuous.program.seconds).toBeLessThan(85);
  });
  it.each([{ bpm: 0 }, { ids: [] }, { keys: ['D'] }, { hand: 'auto' }, { level: 4 }, { minutes: 120 }, { seed: -1 }, { unsupported: true }])('rejects invalid server options %j', (patch) => {
    expect(() => generateProgram({ ...base, ...patch })).toThrow();
  });
});

describe('evidence-backed ability review', () => {
  it('penalizes extra notes and never hides extras that lack a measure locator', () => {
    const drill = generateProgram({ mode: 'assessment' }); const take = takeFor(drill);
    const events = take.assessment.timelineReport.scoreV1.eventResults;
    events.push({ result: 'EXTRA', measure: 1 }, { result: 'EXTRA', measure: 1 });
    expect(reviewProgram(drill, take).sections[0].accuracy).toBeCloseTo(10 / 12);
    events.splice(-2); events.push({ result: 'EXTRA', measure: null });
    const review = reviewProgram(drill, take);
    expect(review.unlocatedExtras).toBe(1); expect(review.label).not.toBe('本轮基本功较稳定');
    expect(review.advice).toContain('不建议提速');
  });
  it('measures correct, wrong and missing pitches separately from rhythm-only hits', () => {
    const drill = generateProgram({ mode: 'assessment' });
    const take = takeFor(drill);
    const events = take.assessment.timelineReport.scoreV1.eventResults;
    events[0].result = 'WRONG_PITCH'; events[1].result = 'MISSING';
    const review = reviewProgram(drill, take);
    expect(review.assessable).toBe(true);
    expect(review.sections[0]).toMatchObject({ accuracy: .8, correct: 8, wrong: 1, missing: 1, status: 'developing', meanAbsoluteMs: 20 });
    expect(review.advice).toContain('五指');
  });
  it('targets timing weaknesses even when all sections have perfect pitch accuracy', () => {
    const drill = generateProgram({ mode: 'assessment' });
    const take = takeFor(drill);
    const section = drill.program.sections.find((item) => item.id === 'scales');
    for (const event of take.assessment.timelineReport.scoreV1.eventResults) {
      if (event.measure >= section.startBar && event.measure <= section.endBar) event.onsetErrorMs = 120;
    }
    const result = reviewProgram(drill, take);
    expect(result.assessable).toBe(true);
    expect(result.advice).toContain('音阶');
    expect(result.advice).toContain('起音');
    expect(result.advice).not.toContain('提高');
  });
  it('does not accept a baseline whose effective engine feedback was live', () => {
    const drill = generateProgram({ mode: 'assessment' });
    const take = takeFor(drill);
    take.assessment.timelineReport.assisted = true;
    take.assessment.timelineReport.scoringConfig.feedback = 'live';
    expect(reviewProgram(drill, take).assessable).toBe(false);
  });
  it('does not drop ambiguous target notes to manufacture a perfect baseline', () => {
    const drill = generateProgram({ mode: 'assessment' });
    const take = takeFor(drill);
    take.assessment.timelineReport.scoreV1.eventResults[0].result = 'AMBIGUOUS';
    const result = reviewProgram(drill, take);
    expect(result.assessable).toBe(false);
    expect(result.sections.every((section) => section.accuracy === null)).toBe(true);
    expect(result.label).toContain('证据不足');
  });
  it('never awards a level for no input, interrupted, degraded or untrusted evidence', () => {
    const drill = generateProgram({ mode: 'assessment' });
    const takes = [takeFor(drill, { evidence: { captureDiagnostics: { scoreInputNoteCount: 0 } } }), takeFor(drill, { lifecycle: { endReason: 'interrupted' } }), takeFor(drill, { context: { plannerAuthority: 'rts' } })];
    const degraded = takeFor(drill); degraded.assessment.timelineReport.scoreV1.dataDegraded = true; takes.push(degraded);
    for (const take of takes) {
      const result = reviewProgram(drill, take);
      expect(result.assessable).toBe(false);
      expect(result.sections.every((s) => s.accuracy === null)).toBe(true);
      expect(result.label).toContain('证据不足');
    }
  });
  it('binds saved takes to exact XML and server configuration, persists reviews and rejects fabricated client scores', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-program-'));
    let current; let xml;
    try {
      const store = new TrainingProgramStore({ dir, readTake: () => current, readScoreXml: () => xml });
      const drill = store.create({ mode: 'assessment' }); current = takeFor(drill); xml = drill.xml;
      const result = store.review(drill.program.id, { takeId: current.takeId });
      expect(result.assessable).toBe(true);
      expect(store.review(drill.program.id, { takeId: current.takeId })).toEqual(result);
      expect(() => store.review(drill.program.id, { takeId: current.takeId, accuracy: 1 })).toThrow();
      xml = '<score-partwise/>';
      expect(() => store.review(drill.program.id, { takeId: current.takeId })).toThrow('不一致');
      xml = drill.xml; current.context.practiceConfigSnapshot.tempo = 120;
      expect(() => store.review(drill.program.id, { takeId: current.takeId })).toThrow('配置');
      expect(() => store.review('../bad', { takeId: current.takeId })).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('rechecks old cached reviews instead of preserving an ambiguous perfect result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-review-upgrade-'));
    let take; let xml;
    try {
      const store = new TrainingProgramStore({ dir, readTake: () => take, readScoreXml: () => xml });
      const drill = store.create({ mode: 'assessment' }); take = takeFor(drill); xml = drill.xml;
      store.review(drill.program.id, { takeId: take.takeId });
      const file = path.join(dir, drill.program.id + '.json');
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete record.reviews[take.takeId].reviewVersion;
      fs.writeFileSync(file, JSON.stringify(record));
      take.assessment.timelineReport.scoreV1.eventResults[0].result = 'AMBIGUOUS';
      expect(store.review(drill.program.id, { takeId: take.takeId })).toMatchObject({ assessable: false, reviewVersion: 'piano-program-review-2' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('prevents an old or already-consumed take from skipping another identical exercise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-unique-'));
    let take; let xml;
    try {
      const store = new TrainingProgramStore({ dir, readTake: () => take, readScoreXml: () => xml });
      const first = store.create({ mode: 'assessment' }); const second = store.create({ mode: 'assessment' });
      take = takeFor(first); xml = first.xml;
      store.review(first.program.id, { takeId: take.takeId });
      expect(() => store.review(second.program.id, { takeId: take.takeId })).toThrow('其他训练段');
      take = takeFor(second); take.takeId = 'take-old'; take.lifecycle.startedAtIso = '2020-01-01T00:00:00Z';
      expect(() => store.review(second.program.id, { takeId: take.takeId })).toThrow('旧演奏');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('advances a timed budget exactly once per saved take and stops at the last phrase', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-next-'));
    let current, xml;
    try {
      const store = new TrainingProgramStore({ dir, readTake: () => current, readScoreXml: () => xml });
      let drill = store.create(base);
      const rootId = drill.program.rootId;
      let rounds = 0;
      while (drill) {
        current = takeFor(drill); current.takeId = `take-${rounds}`; xml = drill.xml;
        const next = store.next(drill.program.id, { takeId: current.takeId });
        expect(store.next(drill.program.id, { takeId: current.takeId })).toEqual(next);
        if (next) { expect(next.program.rootId).toBe(rootId); expect(next.program.remainingSeconds).toBeLessThan(drill.program.remainingSeconds); }
        drill = next; rounds++; if (rounds > 4) throw new Error('Timed program did not terminate');
      }
      expect(rounds).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('compares repeated baseline tests using only previously committed comparable evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-baseline-'));
    let current, xml;
    try {
      const store = new TrainingProgramStore({ dir, readTake: () => current, readScoreXml: () => xml });
      const first = store.create({ mode: 'assessment' }); current = takeFor(first); xml = first.xml;
      current.lifecycle.finishedAtIso = '2026-10-30T00:00:00.000Z';
      current.assessment.timelineReport.scoreV1.eventResults[0].result = 'WRONG_PITCH';
      expect(store.review(first.program.id, { takeId: current.takeId }).comparison).toBeUndefined();
      const second = store.create({ mode: 'assessment' }); current = takeFor(second); current.takeId = 'take-next'; xml = second.xml;
      current.lifecycle.finishedAtIso = '2026-10-30T01:00:00.000Z';
      expect(store.review(second.program.id, { takeId: current.takeId }).comparison).toMatchObject({ previousTakeId: 'take-test', now: 1 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
