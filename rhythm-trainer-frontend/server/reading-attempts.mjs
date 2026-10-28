import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FreeReadingSession } from '../shared/reading-session.mjs';

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export class ReadingAttemptError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const reject = (message) => { throw new ReadingAttemptError(message); };
const validDate = (text) => typeof text === 'string' && Number.isFinite(Date.parse(text));
function normalize(input) {
  if (!input || typeof input.id !== 'string' || !ID.test(input.id)) reject('识谱记录 ID 非法');
  const c = input.config;
  if (!c || c.mode !== 'free' || !['practice', 'test'].includes(c.task ?? 'practice') || ![1, 2, 3, 4].includes(c.notesPerEvent)
    || ![10, 20, 40].includes(c.questionCount) || !Number.isSafeInteger(c.seed)) reject('识谱配置非法');
  if (!Array.isArray(c.ranges) || !c.ranges.length || c.ranges.length > 81) reject('音区非法');
  const pool = new Set();
  const ranges = c.ranges.map((r) => {
    if (!r || !Number.isInteger(r.startMidi) || !Number.isInteger(r.endMidi) || r.startMidi < 28 || r.endMidi > 108 || r.startMidi > r.endMidi) reject('音区非法');
    for (let midi = r.startMidi; midi <= r.endMidi; midi++) pool.add(midi);
    return { startMidi: r.startMidi, endMidi: r.endMidi };
  });
  if (!['midi', 'virtual', 'mixed'].includes(input.source)) reject('输入来源非法');
  if (!validDate(input.startedAtIso) || !validDate(input.finishedAtIso) || Date.parse(input.finishedAtIso) < Date.parse(input.startedAtIso)) reject('记录时间非法');
  if (!Array.isArray(input.questions) || input.questions.length !== c.questionCount
    || input.questions.some((q) => !Array.isArray(q) || q.length !== c.notesPerEvent || new Set(q).size !== q.length || q.some((m) => !pool.has(m)))) reject('题目与配置不一致');
  if (!Array.isArray(input.events) || input.events.length > 5080) reject('输入事件过多或非法');
  const task = c.task ?? 'practice';
  const session = new FreeReadingSession(input.questions, { task });
  const events = [];
  for (const event of input.events) {
    if (!event || session.status !== 'running') reject('完成后不能继续输入');
    if (event.type === 'note') {
      if (!Number.isInteger(event.midi) || event.midi < 28 || event.midi > 108) reject('音符输入非法');
      session.noteOn(event.midi); events.push({ type: 'note', midi: event.midi });
    } else if (event.type === 'hint') {
      if (!session.hint()) reject('测验不允许提示或重复提示');
      events.push({ type: 'hint' });
    } else reject('未知输入事件');
  }
  if (!['completed', 'ended-early'].includes(input.endReason)) reject('结束原因非法');
  if (input.endReason === 'ended-early') session.endEarly();
  if (session.status !== input.endReason) reject('完成状态与实际输入不一致');
  const config = { mode: 'free', task, ranges, notesPerEvent: c.notesPerEvent, questionCount: c.questionCount, seed: c.seed };
  const evidence = { id: input.id, startedAtIso: input.startedAtIso, finishedAtIso: input.finishedAtIso, config,
    source: input.source, questions: input.questions, events, endReason: input.endReason };
  const snapshot = session.snapshot();
  const { perPitch, wrongByPitch, currentHits, currentTargets, ...summary } = snapshot;
  void perPitch; void wrongByPitch; void currentHits; void currentTargets;
  summary.weakTargets = session.weakestPitches();
  summary.coveredPitches = new Set(input.questions.slice(0, snapshot.completedQuestions).flat()).size;
  summary.poolSize = pool.size;
  summary.reviewGroups = session.reviewQuestions();
  return { schemaVersion: 1, ...evidence, summary,
    evidenceFingerprint: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') };
}
export class ReadingAttemptStore {
  constructor({ dir }) { this.dir = dir; }
  save(input) {
    const record = normalize(input);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${record.id}.json`);
    const existing = this.get(record.id);
    if (existing) {
      if (existing.evidenceFingerprint !== record.evidenceFingerprint) throw new ReadingAttemptError('识谱记录 ID 冲突', 409);
      return existing;
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(record), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Atomic no-clobber commit: a concurrent writer cannot overwrite this ID.
      try { fs.linkSync(tmp, file); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const saved = this.get(record.id);
        if (saved?.evidenceFingerprint !== record.evidenceFingerprint) throw new ReadingAttemptError('识谱记录 ID 冲突', 409);
        return saved;
      }
    } finally { try { fs.unlinkSync(tmp); } catch { /* no partial record exposed */ } }
    return record;
  }
  get(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new ReadingAttemptError('识谱记录 ID 非法');
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((file) => file.endsWith('.json') && ID.test(file.slice(0, -5)))
      .flatMap((file) => { try { const r = this.get(file.slice(0, -5)); return r?.schemaVersion === 1 ? [r] : []; } catch { return []; } })
      .sort((a, b) => Date.parse(b.finishedAtIso) - Date.parse(a.finishedAtIso)).slice(0, 30)
      .map(({ id, startedAtIso, finishedAtIso, config, source, endReason, summary }) => ({ id, startedAtIso, finishedAtIso, config, source, endReason, summary }));
  }
}
