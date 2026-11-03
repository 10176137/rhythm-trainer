import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importMusicXml } from '../src/score-engine/import/musicxml-importer';
import { toNumber } from '../src/score-engine/domain/rational';
const native = createRequire(import.meta.url)('../../rhythm-trainer-core-v0.2/bindings/node');
// Synthetic local data only; keep the directory for an optional visual QA run.
const dir = mkdtempSync(join(tmpdir(), 'rhythm-note-review-'));
const port = 9500 + Math.floor(Math.random() * 300);
const xml = readFileSync('src/features/score/fixtures/c-major-practice.musicxml', 'utf8');
const score = importMusicXml(xml).scoreDocument!;
const notes = score.parts[0].measures.flatMap(m => m.events.filter(e => e.kind === 'note'));
const targets = notes.map((e, i) => ({ scoreEventId: `runtime:p0:${e.id}`, measure: e.source.measureOrdinal, beatPosition: toNumber(e.onsetBeat), pitch: e.pitch!.midiNote,
  targetOnsetMs: toNumber(e.onsetBeat) * 500, targetDurationMs: toNumber(e.durationBeat) * 500, partId: 'P1', index: i }));
const performed = targets.filter((_, i) => i % 7 !== 6).map((t, i) => ({ performedNoteId: `press-${i}`, pitch: i % 9 === 8 ? t.pitch + 1 : t.pitch,
  onsetMs: t.targetOnsetMs + [0, 90, -100][i % 3], releaseMs: t.targetOnsetMs + [0, 90, -100][i % 3] + t.targetDurationMs, pairingStatus: 'complete' }));
const scoreV1 = native.scorePerformance(targets, performed);
const take = { schemaVersion: 1, takeId: 'take-note-review-qa', score: { scoreFingerprint: score.fingerprint, scoreSnapshotRef: `score-snapshots/${score.fingerprint}.musicxml` },
  lifecycle: { startedAtIso: '2026-11-03T00:00:00Z', finishedAtIso: '2026-11-03T00:01:00Z', endReason: 'completed', modeId: 'score' },
  context: { plannerAuthority: 'rust', practiceConfigSnapshot: { tempo: 120 } }, evidence: {}, assessment: { trustworthy: true, scoreStatus: 'AVAILABLE', timelineReport: {
    schemaVersion: 1, sessionId: 'review-qa', bpm: 120, modeId: 'score', finishedAtIso: '2026-11-03T00:01:00Z', scoreEvents: targets, scoreV1,
    keyLifecycles: { observations: performed.map((p, i) => ({ pressId: p.performedNoteId, status: 'complete', noteOnSourceSeq: i, keyDownDurationMs: p.releaseMs - p.onsetMs })) },
    report: { trustworthy: true, targetCount: targets.length, judgments: [], stats: { targetHitRate: .7 } },
  } } };
let child: ChildProcess;
beforeAll(async () => {
  mkdirSync(join(dir, 'takes')); mkdirSync(join(dir, 'score-snapshots'));
  writeFileSync(join(dir, 'takes', `${take.takeId}.json`), JSON.stringify(take));
  writeFileSync(join(dir, 'score-snapshots', `${score.fingerprint}.musicxml`), xml);
  child = spawn(process.execPath, ['server/engine-server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', RHYTHM_MIDI_BACKEND: 'mock', RHYTHM_PLANNER: 'rust', RHYTHM_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('server start timeout')), 10000); child.stdout!.on('data', data => { if (String(data).includes(`:${port}`)) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
  writeFileSync('node_modules/.tmp/note-review-qa-path.txt', dir);
}, 15000);
afterAll(() => child?.kill());
it('serves saved native note evidence with the immutable score and rejects unknown Takes', async () => {
  const response = await fetch(`http://localhost:${port}/api/takes/${take.takeId}/note-review`);
  expect(response.status).toBe(200); const review = await response.json();
  expect(review.xml).toBe(xml); expect(review.scoreFingerprint).toBe(score.fingerprint);
  expect(review.items).toHaveLength(scoreV1.eventResults.length);
  expect(review.items.some((n: { state: string }) => n.state === 'attention')).toBe(true);
  expect(review.items.some((n: { state: string }) => n.state === 'error')).toBe(true);
  expect((await fetch(`http://localhost:${port}/api/takes/unknown/note-review`)).status).toBe(404);
});
