import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importScoreText } from '../src/features/score/scoreImport';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache');
mkdirSync(CACHE, { recursive: true });
const DATA = mkdtempSync(path.join(CACHE, 'training-api-'));
let server;
let base;
async function api(method, url, body) {
  const response = await fetch(`${base}${url}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
beforeAll(async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server/engine-server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('training API server startup timeout')), 20000);
    let logs = '';
    server.stdout.on('data', (chunk) => { logs += String(chunk); if (logs.includes('引擎服务:')) { clearTimeout(timeout); resolve(); } });
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`training API server exited (${code})`)); });
  });
}, 30000);
afterAll(async () => {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  if (path.dirname(path.resolve(DATA)) !== CACHE) throw new Error('Refusing cleanup outside test cache');
  rmSync(DATA, { recursive: true, force: true });
});
const free = { mode: 'free', ranges: [{ startMidi: 60, endMidi: 71 }], notesPerEvent: 1, seed: 7, questionCount: 10, key: { root: 'C', mode: 'major' }, staffPreference: 'treble', task: 'practice' };

describe('server-owned training HTTP API', () => {
  it('creates a real six-domain assessment and rejects fabricated result submissions', async () => {
    const created = await api('POST', '/api/training/programs', { mode: 'assessment' });
    expect(created.status).toBe(200);
    expect(created.data.drill.program.sections).toHaveLength(6);
    expect(importScoreText(created.data.drill.xml, 'baseline.musicxml').report.strictAllowed).toBe(true);
    const review = `/api/training/programs/${created.data.drill.program.id}/review`;
    expect((await api('POST', review, { takeId: 'missing-take' })).status).toBe(400);
    expect((await api('POST', review, { takeId: 'missing-take', accuracy: 1 })).status).toBe(400);
    expect((await api('POST', '/api/training/programs', { mode: 'timed', minutes: 1000 })).status).toBe(400);
  });
  it('serves one authoritative catalog and generates reproducible, playable material', async () => {
    const catalog = await api('GET', '/api/training/catalog');
    expect(catalog.status).toBe(200);
    expect(catalog.data.catalog.drills).toHaveLength(10);
    expect(catalog.data.catalog.keys.map((key) => key.id)).toEqual(['C', 'G', 'F']);
    const input = { id: 'scales', level: 3, bpm: 60, options: { key: 'F', hand: 'left' } };
    const generated = await api('POST', '/api/training/drills', input);
    expect(generated.status).toBe(200);
    expect(generated.data.drill).toMatchObject({ id: 'scales', hand: 'left', bars: 8, startPitchLabels: { left: 'F2' }, generatorVersion: 'skill-drills-node-3' });
    expect(importScoreText(generated.data.drill.xml, 'server.musicxml').report.strictAllowed).toBe(true);
    expect((await api('POST', '/api/training/drills', input)).data.drill).toEqual(generated.data.drill);
  });
  it('binds lesson instructions to the selected key, hand and level', async () => {
    const { data } = await api('POST', '/api/training/drills', { id: 'five-finger', level: 2, bpm: 55, options: { key: 'F', hand: 'left' } });
    expect(data.drill.lesson).toMatchObject({ label: '普通 · 五音内间隔与节奏变式' });
    expect(data.drill.lesson.instructions[0]).toContain('左手');
    expect(data.drill.lesson.instructions[0]).toContain('F 大调');
    expect(data.drill.lesson.instructions[0]).toContain(data.drill.startPitchLabels.left);
    expect(data.drill.lesson.pattern).toContain('1–3–2–4');
    expect(data.drill.lesson.review).toBeTruthy();
  });
  for (const input of [
    { id: 'missing', level: 1, bpm: 60 }, { id: 'scales', level: 4, bpm: 60 },
    { id: 'scales', level: 1, bpm: '60' }, { id: 'scales', level: 1, bpm: 0 },
    { id: 'scales', level: 1, bpm: 60, options: { key: 'D', hand: 'right' } },
    { id: 'scales', level: 1, bpm: 60, options: { key: 'C', hand: 'none' } },
    { id: 'scales', level: 1, bpm: 60, xml: '<client-authored/>' },
  ]) it(`rejects client overrides or invalid intent: ${JSON.stringify(input)}`, async () => {
    expect((await api('POST', '/api/training/drills', input)).status).toBe(400);
  });
  it('generates both free-reading questions and a strict-playable rhythm score', async () => {
    const questions = await api('POST', '/api/training/reading', { config: free });
    expect(questions.status).toBe(200);
    expect(questions.data.exercise.questions).toHaveLength(10);
    expect((await api('POST', '/api/training/reading', { config: free })).data).toEqual(questions.data);
    const rhythm = await api('POST', '/api/training/reading', { config: { ...free, mode: 'rhythm', measures: 4, complexity: 'intermediate', timeSignature: [3, 4], bpm: 60 } });
    expect(rhythm.status).toBe(200);
    expect(rhythm.data.exercise.score.summary.measureCount).toBe(4);
    expect(importScoreText(rhythm.data.exercise.score.xml, 'rhythm.musicxml').report.strictAllowed).toBe(true);
  });
  it('selects review questions from persisted server-replayed evidence, not client diagnostics', async () => {
    const generated = (await api('POST', '/api/training/reading', { config: free })).data.exercise.questions.map((question) => question.midiNotes);
    const first = generated[0][0];
    const saved = await api('POST', '/api/reading-attempts', {
      id: 'reading-server-review', startedAtIso: '2026-10-29T00:00:00.000Z', finishedAtIso: '2026-10-29T00:01:00.000Z', config: free, questions: generated,
      events: [{ type: 'note', midi: first === 61 ? 62 : 61 }, ...generated.map(([midi]) => ({ type: 'note', midi }))], source: 'virtual', endReason: 'completed',
      summary: { firstTryAccuracy: 100, progression: { canReview: false } },
    });
    expect(saved.status).toBe(200);
    expect(saved.data.record.summary.firstTryAccuracy).toBe(90);
    expect(saved.data.record.summary.progression.canReview).toBe(true);
    const review = await api('POST', '/api/training/reading', { config: { ...free, seed: 9 }, reviewAttemptId: 'reading-server-review' });
    expect(review.status).toBe(200);
    expect(review.data.exercise.questions.slice(0, 2).map((question) => question.midiNotes)).toEqual([[first], [first]]);
    expect((await api('POST', '/api/training/reading', { config: free, reviewGroups: [[60]] })).status).toBe(400);
    expect((await api('POST', '/api/training/reading', { config: free, reviewAttemptId: 'missing-reading' })).status).toBe(404);
  });
  it('rejects unbounded pools, invalid meter and too-small question pools', async () => {
    for (const config of [{ ...free, ranges: [{ startMidi: 0, endMidi: 1000 }] }, { ...free, mode: 'rhythm', timeSignature: [4, 8] }, { ...free, ranges: [{ startMidi: 60, endMidi: 60 }], notesPerEvent: 4 }]) {
      expect((await api('POST', '/api/training/reading', { config })).status).toBe(400);
    }
    expect((await api('GET', '/api/training/drills')).status).toBe(405);
  });
});
