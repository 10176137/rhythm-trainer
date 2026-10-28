import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReadingAttemptStore } from './reading-attempts.mjs';
const dirs = [];
const store = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reading-')); dirs.push(dir); return { dir, service: new ReadingAttemptStore({ dir }) }; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function attempt() {
  return { id: 'reading-test-1', startedAtIso: '2026-10-28T00:00:00.000Z', finishedAtIso: '2026-10-28T00:05:00.000Z',
    config: { mode: 'free', task: 'practice', ranges: [{ startMidi: 60, endMidi: 71 }], notesPerEvent: 1, questionCount: 10, seed: 1 },
    source: 'virtual', questions: Array.from({ length: 10 }, () => [70]), events: [{ type: 'note', midi: 69 }], endReason: 'ended-early' };
}
describe('reading attempts', () => {
  it('replays evidence rather than accepting client metrics, and survives reopening', () => {
    const { dir, service } = store(); const payload = attempt();
    const saved = service.save({ ...payload, summary: { firstTryAccuracy: 100 } });
    expect(saved.summary).toMatchObject({ firstTryAccuracy: 0, hitAccuracy: 0, completedQuestions: 0, totalWrongPresses: 1 });
    expect(saved.summary.confusions[0]).toMatchObject({ remainingTargets: [70], pressed: 69 });
    const reopened = new ReadingAttemptStore({ dir });
    expect(reopened.get(payload.id)).toEqual(saved);
    expect(reopened.save(payload)).toEqual(saved);
    expect(reopened.list()).toHaveLength(1);
    expect(() => reopened.save({ ...payload, events: [] })).toThrow(/冲突/);
  });
  it('uses null metrics for an empty attempt', () => {
    const { service } = store();
    expect(service.save({ ...attempt(), events: [] }).summary).toMatchObject({ firstTryAccuracy: null, hitAccuracy: null });
  });
  it('rejects fake completions, out-of-pool targets and assistance in tests', () => {
    const { service } = store(); const p = attempt();
    expect(() => service.save({ ...p, endReason: 'completed' })).toThrow();
    expect(() => service.save({ ...p, questions: p.questions.map(() => [59]) })).toThrow();
    expect(() => service.save({ ...p, config: { ...p.config, task: 'test' }, events: [{ type: 'hint' }] })).toThrow();
    expect(() => service.save({ ...p, id: '../escape' })).toThrow();
  });
});
