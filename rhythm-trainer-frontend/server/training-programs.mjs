import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { generateSkillExercise, TrainingServiceError } from './training-service.mjs';
import { SKILL_DRILLS } from './training/skill-drill-catalog.mjs';

const REVIEW_VERSION = 'piano-program-review-2';
const hash = (xml) => createHash('sha256').update(xml).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new TrainingServiceError('INVALID_PROGRAM', message); };
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const REST = (staff) => `<note><rest measure="yes"/><duration>1920</duration><voice>${staff}</voice><type>whole</type><staff>${staff}</staff></note>`;
const BACKUP = '<backup><duration>1920</duration></backup>';
const BENCHMARK = [
  ['five-finger', 'right', 'C'], ['five-finger', 'left', 'C'],
  ['scales', 'right', 'G'], ['arpeggios', 'left', 'C'],
  ['triads', 'right', 'F'], ['coordination', 'both', 'C'],
];

export function normalizeProgram(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), '训练配置必须是对象');
  requireValue(Object.keys(input).every((key) => ['mode', 'minutes', 'variation', 'ids', 'keys', 'hand', 'level', 'bpm', 'seed'].includes(key)), '训练配置含未知字段');
  requireValue(['timed', 'continuous', 'assessment'].includes(input.mode), '训练方式无效');
  if (input.mode === 'assessment') return { mode: 'assessment', minutes: 2, variation: 'repeat', ids: BENCHMARK.map(([id]) => id), keys: ['C', 'G', 'F'], hand: 'both', level: 1, bpm: 60, seed: 20261030 };
  requireValue([2, 5, 10].includes(input.minutes), '时长请选择 2、5 或 10 分钟');
  requireValue(['repeat', 'shuffle'].includes(input.variation), '出题方式无效');
  requireValue(Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 10 && new Set(input.ids).size === input.ids.length && input.ids.every((id) => SKILL_DRILLS.some((d) => d.id === id)), '请选择有效且不重复的训练项目');
  requireValue(Array.isArray(input.keys) && input.keys.length > 0 && input.keys.length <= 3 && new Set(input.keys).size === input.keys.length && input.keys.every((key) => ['C', 'G', 'F'].includes(key)), '请选择调性范围');
  requireValue(['left', 'right', 'both'].includes(input.hand) && [1, 2, 3].includes(input.level), '手别或难度无效');
  requireValue(Number.isInteger(input.bpm) && input.bpm >= 40 && input.bpm <= 140, '速度范围为 40–140 BPM');
  requireValue(input.seed === undefined || (Number.isInteger(input.seed) && input.seed >= 0 && input.seed <= 0xffffffff), '随机种子无效');
  return { ...structuredClone(input), seed: input.seed ?? randomInt(0x100000000) };
}

/** Whole authored phrases, randomized on Node; no random notes or fingering changes. */
export function generateProgram(input, { remainingSeconds } = {}) {
  const config = normalizeProgram(input);
  let seed = config.seed >>> 0;
  const choose = (values) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]; };
  const sections = [];
  const measures = [];
  let seconds = 0;
  let lastChoice = '';
  // Bound tablet engraving cost even for a ten-minute high-tempo program.
  // The server advances the remaining budget only after a bound saved Take.
  const budget = remainingSeconds ?? config.minutes * 60;
  const targetSeconds = Math.min(60, budget);
  for (let index = 0; config.mode === 'assessment' ? index < BENCHMARK.length : seconds < targetSeconds; index++) {
    let id, hand, key;
    if (config.mode === 'assessment') [id, hand, key] = BENCHMARK[index];
    else {
      const candidates = config.ids.flatMap((id) => config.keys.map((key) => ({ id, key, signature: `${id}:${key}` })));
      const pool = candidates.filter((c) => c.signature !== lastChoice);
      const item = config.variation === 'repeat' ? candidates[0] : choose(pool.length ? pool : candidates);
      ({ id, key } = item); hand = config.hand; lastChoice = item.signature;
    }
    const definition = SKILL_DRILLS.find((d) => d.id === id);
    const drill = generateSkillExercise({ id, level: config.level, bpm: config.bpm, ...(definition.category === 'fundamentals' ? { options: { key, hand } } : {}) });
    const startBar = measures.length + 1;
    const stageName = `${index + 1}. ${drill.title}`;
    for (const [bar, match] of [...drill.xml.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].entries()) {
      let music = match[1].replace(/<attributes>[\s\S]*?<\/attributes>/g, '').replace(/<direction\b[^>]*>[\s\S]*?<\/direction>/g, '');
      if (drill.staffHands.length === 1) {
        if (drill.hand === 'left') music = REST(1) + BACKUP + music.replaceAll('<staff>1</staff>', '<staff>2</staff>').replaceAll('<voice>1</voice>', '<voice>2</voice>');
        else music += BACKUP + REST(2);
      }
      const fifths = { C: 0, G: 1, F: -1 }[drill.key];
      const attributes = bar === 0 ? `<attributes><divisions>480</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><words>${escape(stageName)}</words></direction-type><staff>1</staff></direction>` : '';
      const tempo = measures.length === 0 ? `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${config.bpm}</per-minute></metronome></direction-type><sound tempo="${config.bpm}"/></direction>` : '';
      measures.push(`<measure number="${measures.length + 1}">${attributes}${tempo}${music}</measure>`);
    }
    seconds += drill.bars * 4 * 60 / config.bpm;
    sections.push({ id, title: drill.title, startBar, endBar: measures.length, key: drill.key, hand: drill.hand });
  }
  const title = config.mode === 'assessment' ? '基础能力测试 · 六项基线' : config.mode === 'continuous' ? '连续基本功 · 自动换段' : `定时基本功 · 约 ${config.minutes} 分钟`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${measures.join('')}</part></score-partwise>`;
  return { schemaVersion: 1, generatorVersion: 'skill-program-node-1', id: config.ids[0], level: config.level, bpm: config.bpm, key: sections[0].key, xml, title, bars: measures.length, staffHands: [{ staffNumber: 1, hand: 'right' }, { staffNumber: 2, hand: 'left' }], hand: 'both', startPitches: {}, startPitchLabels: {}, countInMs: 3000,
    lesson: { label: title, pattern: `${sections.length} 个完整音型 · 约 ${Math.ceil(seconds / 60)} 分钟`, instructions: ['先看每段上方的项目名称、调号和练习手，再按谱演奏。', '保持舒适速度，遇到错误先把本段练稳；随机训练改变完整音型与调性，不随机打乱指法。', config.mode === 'assessment' ? '测试关闭伴弹和即时答案；六项都完成后查看后端能力画像。' : '先单手，再双手；同一速度稳定后再增加难度。'], review: '比较音高正确率、漏音和起音偏差，不只看节奏命中率。', selfCheck: 'MIDI 能验证音高和时间，不能确认实际指法、手腕放松或音色；这不是考级等级鉴定。' },
    program: { id: '', config, sections, seconds, remainingSeconds: config.mode === 'timed' ? Math.max(0, budget - seconds) : null, benchmarkVersion: config.mode === 'assessment' ? 'piano-baseline-1' : null } };
}

function targetedAdvice(drill, section) {
  const tempo = drill.bpm > 40 ? `降到 ${Math.max(40, drill.bpm - 5)} BPM` : '保持 40 BPM';
  const focus = section.accuracy >= .95
    ? '重点练起音均匀与拍点，先把平均起音偏差稳定到 60ms 以内，再考虑变速。'
    : '分手练到音高正确率至少 95%，再比较时间偏差。';
  return `先练「${section.title}」，${tempo}，${focus}`;
}

/** Reviews only committed engine evidence, bound to the exact generated XML. */
export function reviewProgram(drill, take) {
  const report = take.assessment?.timelineReport?.scoreV1;
  const usable = take.context?.plannerAuthority === 'rust' && take.assessment?.trustworthy === true
    && Number.isInteger(take.evidence?.captureDiagnostics?.scoreInputNoteCount) && take.evidence.captureDiagnostics.scoreInputNoteCount > 0
    && take.assessment?.scoreStatus === 'AVAILABLE' && report && Array.isArray(report.eventResults)
    && ['high', 'medium'].includes(report.confidence) && report.dataDegraded !== true
    && report.eventResults.every((event) => ['MATCH', 'WRONG_PITCH', 'MISSING', 'EXTRA'].includes(event.result))
    && take.lifecycle?.endReason === 'completed'
    && (drill.program.config.mode !== 'assessment'
      || (take.assessment.timelineReport.scoringConfig?.feedback === 'after' && take.assessment.timelineReport.assisted === false));
  const sections = drill.program.sections.map((section) => {
    const events = usable ? report.eventResults.filter((e) => e.measure >= section.startBar && e.measure <= section.endBar) : [];
    const targets = events.filter((e) => ['MATCH', 'WRONG_PITCH', 'MISSING'].includes(e.result));
    const matches = events.filter((e) => e.result === 'MATCH');
    const errors = matches.map((e) => e.onsetErrorMs).filter(Number.isFinite).map(Math.abs);
    const extra = events.filter((e) => e.result === 'EXTRA').length;
    const accuracy = targets.length ? matches.length / (targets.length + extra) : null;
    const meanAbsoluteMs = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null;
    const status = accuracy === null ? 'insufficient' : accuracy >= .95 && meanAbsoluteMs !== null && meanAbsoluteMs <= 60 ? 'stable' : accuracy >= .8 ? 'developing' : 'needs-practice';
    return { ...section, targets: targets.length, correct: matches.length, wrong: events.filter((e) => e.result === 'WRONG_PITCH').length, missing: events.filter((e) => e.result === 'MISSING').length, extra, accuracy, meanAbsoluteMs, status };
  });
  const assessable = usable && sections.every((s) => s.targets > 0 && s.correct + s.wrong + s.extra > 0);
  const unlocatedExtras = usable ? report.eventResults.filter((e) => e.result === 'EXTRA' && (!Number.isInteger(e.measure) || e.measure < 1 || e.measure > drill.bars)).length : 0;
  const weakest = sections.filter((s) => s.accuracy !== null).sort((a, b) => Number(a.status === 'stable') - Number(b.status === 'stable') || a.accuracy - b.accuracy || (b.meanAbsoluteMs ?? 0) - (a.meanAbsoluteMs ?? 0))[0];
  return { schemaVersion: 1, reviewVersion: REVIEW_VERSION, programId: drill.program.id, takeId: take.takeId, assessable: Boolean(assessable), sections, unlocatedExtras,
    label: !assessable ? '证据不足，暂不判断水平' : unlocatedExtras === 0 && sections.every((s) => s.status === 'stable') ? '本轮基本功较稳定' : '已建立能力基线',
    advice: !assessable ? '尚有未完成项目，或输入证据不足。确认 MIDI 输入，完整弹完后再测试；没有演奏输入不会获得通过。' : unlocatedExtras > 0 ? '本轮还有无法归到具体小节的多余音。先保持速度，减少额外击键，不建议提速。' : weakest.status !== 'stable' ? targetedAdvice(drill, weakest) : drill.bpm >= 140 ? '保持当前速度，改变调性检验稳定性；不必继续追求更快。' : '保持当前速度，在不同调性下连续三次稳定后，再尝试提高 5 BPM。',
    criteria: '应用内参考：正确音数 ÷（目标音数＋多余音数）至少 95%，平均起音偏差不超过 60ms。仅评价本轮可测能力，不等同钢琴考级。',
  };
}

export class TrainingProgramStore {
  constructor({ dir, snapshotDir, readTake, readScoreXml }) { this.dir = dir; this.snapshotDir = snapshotDir; this.readTake = readTake; this.readScoreXml = readScoreXml; fs.mkdirSync(dir, { recursive: true }); if (snapshotDir) fs.mkdirSync(snapshotDir, { recursive: true }); }
  snapshot(fingerprint, xml) {
    if (!this.snapshotDir) return;
    const file = path.join(this.snapshotDir, `${fingerprint}.musicxml`);
    if (!fs.existsSync(file)) { const tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, xml, 'utf8'); fs.renameSync(tmp, file); }
  }
  create(input, internal = {}) {
    const drill = generateProgram(input, internal); drill.program.id = `program-${randomUUID()}`;
    drill.program.rootId = internal.rootId ?? drill.program.id;
    this.snapshot(hash(drill.xml), drill.xml);
    this.write(drill.program.id, { drill, xmlHash: hash(drill.xml), createdAtIso: new Date().toISOString(), reviews: {} }); return drill;
  }
  write(id, value) { const file = path.join(this.dir, `${id}.json`); const tmp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value), 'utf8'); fs.renameSync(tmp, file); }
  next(id, input) {
    const review = this.review(id, input);
    requireValue(review.assessable, '本段输入或完成证据不足，请先重练，不会自动跳过');
    const record = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
    const program = record.drill.program;
    if (program.config.mode === 'assessment' || (program.config.mode === 'timed' && program.remainingSeconds <= 0)) return null;
    if (record.next?.[input.takeId]) return JSON.parse(fs.readFileSync(path.join(this.dir, `${record.next[input.takeId]}.json`), 'utf8')).drill;
    const { seed, ...config } = program.config;
    const drill = this.create(config, { remainingSeconds: program.remainingSeconds ?? undefined, rootId: program.rootId });
    record.next ??= {}; record.next[input.takeId] = drill.program.id; this.write(id, record);
    return drill;
  }
  review(id, input) {
    requireValue(/^program-[a-f0-9-]{36}$/.test(id), '训练计划 ID 无效');
    requireValue(input && Object.keys(input).length === 1 && typeof input.takeId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(input.takeId), '只接受已保存的演奏记录 ID');
    const file = path.join(this.dir, `${id}.json`);
    requireValue(fs.existsSync(file), '训练计划不存在');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const take = this.readTake(input.takeId);
    requireValue(take?.score?.scoreFingerprint === record.xmlHash, '演奏记录与训练谱指纹不一致');
    requireValue(!record.createdAtIso || Date.parse(take.lifecycle?.startedAtIso) >= Date.parse(record.createdAtIso), '不能使用训练计划创建之前的旧演奏记录');
    this.snapshot(record.xmlHash, record.drill.xml);
    requireValue(take && hash(this.readScoreXml(take) ?? '') === record.xmlHash, '演奏记录与训练谱不一致，不能用于本次测评');
    const config = take.context?.practiceConfigSnapshot;
    requireValue(config?.tempo === record.drill.bpm && config?.profile === 'standard' && config?.hand === 'both' && config?.advanceMode === 'timeline', '演奏配置与训练计划不一致');
    if (record.drill.program.config.mode === 'assessment') requireValue(config.feedback === 'after', '能力测试必须使用结束后反馈');
    if (record.reviews[input.takeId]?.reviewVersion === REVIEW_VERSION) return record.reviews[input.takeId];
    const linksFile = path.join(this.dir, 'take-links.json');
    const links = fs.existsSync(linksFile) ? JSON.parse(fs.readFileSync(linksFile, 'utf8')) : {};
    requireValue(!links[input.takeId] || links[input.takeId] === id, '该演奏记录已用于其他训练段，请重新演奏');
    links[input.takeId] = id; this.write('take-links', links);
    const result = reviewProgram(record.drill, take);
    result.finishedAtIso = take.lifecycle?.finishedAtIso ?? new Date().toISOString();
    if (result.assessable && record.drill.program.config.mode === 'assessment') {
      const prior = [];
      for (const name of fs.readdirSync(this.dir).filter((name) => /^program-[a-f0-9-]+\.json$/.test(name))) {
        try {
          const saved = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
          if (saved.drill.program.benchmarkVersion !== record.drill.program.benchmarkVersion) continue;
          prior.push(...Object.values(saved.reviews).filter((r) => r.reviewVersion === REVIEW_VERSION && r.assessable && r.takeId !== result.takeId && r.finishedAtIso < result.finishedAtIso));
        } catch { /* An unreadable record cannot become comparison evidence. */ }
      }
      prior.sort((a, b) => b.finishedAtIso.localeCompare(a.finishedAtIso));
      const accuracy = (review) => { const targets = review.sections.reduce((n, s) => n + s.targets + s.extra, review.unlocatedExtras ?? 0); return targets ? review.sections.reduce((n, s) => n + s.correct, 0) / targets : null; };
      if (prior.length) result.comparison = { previousTakeId: prior[0].takeId, before: accuracy(prior[0]), now: accuracy(result), changePoints: (accuracy(result) - accuracy(prior[0])) * 100 };
    }
    record.reviews[input.takeId] = result; this.write(id, record); return result;
  }
}
