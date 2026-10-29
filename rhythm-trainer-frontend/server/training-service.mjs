// Domain authority for exercise content. UI sends intent; Node chooses notes,
// rhythms, spelling, fingering, register and review material. Rust still owns
// timed planning/scoring. There is no browser generator fallback.
import { createSkillDrill } from './training/skill-drills.mjs';
import { SKILL_DRILLS, DRILL_KEYS } from './training/skill-drill-catalog.mjs';
import { generateFreeQuestions, generateReviewQuestions, generateRhythmScore, READING_GENERATOR_VERSION } from './training/reading-generator.mjs';
import { spelledLabel, READING_KEY_LOW, READING_KEY_HIGH } from '../shared/reading-keys.mjs';

export const TRAINING_SCHEMA_VERSION = 1;
export const SKILL_GENERATOR_VERSION = 'skill-drills-node-1';
const TEMPO = { min: 40, max: 140, step: 5, default: 60 };

export class TrainingServiceError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function requireValue(condition, message) {
  if (!condition) throw new TrainingServiceError('INVALID_TRAINING_REQUEST', message);
}
function object(value, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label}必须是对象`);
  return value;
}
function fields(value, allowed) {
  requireValue(Object.keys(value).every((key) => allowed.includes(key)), '请求包含不支持的字段');
}

export function getTrainingCatalog() {
  return structuredClone({
    schemaVersion: TRAINING_SCHEMA_VERSION,
    generatorVersion: SKILL_GENERATOR_VERSION,
    drills: SKILL_DRILLS.map((entry) => ({ ...entry, hasReferenceFingering: ['five-finger', 'scales'].includes(entry.id) })),
    keys: Object.entries(DRILL_KEYS).map(([id, key]) => ({ id, label: key.label })),
    hands: [{ id: 'right', label: '右手' }, { id: 'left', label: '左手' }, { id: 'both', label: '双手同向' }],
    tempo: TEMPO,
  });
}

export function generateSkillExercise(input) {
  object(input, '请求');
  fields(input, ['id', 'level', 'bpm', 'options']);
  const definition = SKILL_DRILLS.find((entry) => entry.id === input.id);
  requireValue(definition && [1, 2, 3].includes(input.level), '训练项目或级别无效');
  requireValue(Number.isInteger(input.bpm) && input.bpm >= TEMPO.min && input.bpm <= TEMPO.max, '专项训练速度必须为 40–140 BPM 的整数');
  let options;
  if (definition.category === 'fundamentals') {
    options = input.options === undefined ? { key: 'C', hand: 'right' } : object(input.options, '训练选项');
    fields(options, ['key', 'hand']);
    requireValue(Object.hasOwn(DRILL_KEYS, options.key) && ['right', 'left', 'both'].includes(options.hand), '调性或手别无效');
  } else requireValue(input.options === undefined, '节奏训练的手别与调性由训练项目决定');
  const material = createSkillDrill(input.id, input.level, input.bpm, options);
  const key = options?.key ?? 'C';
  return {
    schemaVersion: TRAINING_SCHEMA_VERSION, generatorVersion: SKILL_GENERATOR_VERSION,
    id: input.id, level: input.level, bpm: input.bpm, key, ...material,
    startPitchLabels: Object.fromEntries(Object.entries(material.startPitches).map(([hand, midi]) => [hand, spelledLabel(midi, DRILL_KEYS[key].fifths)])),
    countInMs: 3000,
  };
}

function readingConfig(raw) {
  const config = object(raw, '识谱配置');
  fields(config, ['mode', 'ranges', 'notesPerEvent', 'seed', 'task', 'questionCount', 'key', 'staffPreference', 'timeSignature', 'bpm', 'complexity', 'measures', 'countInMeasures']);
  requireValue(['free', 'rhythm'].includes(config.mode), '识谱模式无效');
  requireValue([1, 2, 3, 4].includes(config.notesPerEvent), '每题音符数必须为 1–4');
  requireValue(Number.isSafeInteger(config.seed), '随机种子必须是安全整数');
  requireValue(Array.isArray(config.ranges) && config.ranges.length > 0 && config.ranges.length <= 81, '音区数量无效');
  for (const range of config.ranges) {
    object(range, '音区'); fields(range, ['startMidi', 'endMidi']);
    requireValue(Number.isInteger(range.startMidi) && Number.isInteger(range.endMidi) && range.startMidi >= READING_KEY_LOW && range.endMidi <= READING_KEY_HIGH && range.startMidi <= range.endMidi, '音区超出支持范围');
  }
  if (config.key !== undefined && config.key !== null) {
    object(config.key, '调性'); fields(config.key, ['root', 'mode']);
    requireValue(['C', 'D', 'E', 'F', 'G', 'A', 'B'].includes(config.key.root) && ['major', 'minor'].includes(config.key.mode), '识谱调性无效');
  }
  requireValue(config.task === undefined || ['practice', 'test'].includes(config.task), '识谱任务无效');
  requireValue(config.staffPreference === undefined || ['auto', 'treble', 'bass'].includes(config.staffPreference), '谱表选项无效');
  if (config.mode === 'free') {
    requireValue(config.questionCount === undefined || [10, 20, 40].includes(config.questionCount), '题目数量必须是 10、20 或 40');
  } else {
    const time = config.timeSignature ?? [4, 4];
    requireValue(Array.isArray(time) && time.length === 2 && [2, 3, 4].includes(time[0]) && time[1] === 4, '拍号只支持 2/4、3/4、4/4');
    requireValue(config.complexity === undefined || ['basic', 'intermediate', 'advanced'].includes(config.complexity), '节奏级别无效');
    requireValue(config.bpm === undefined || (typeof config.bpm === 'number' && Number.isFinite(config.bpm) && config.bpm >= 40 && config.bpm <= 180), '节奏识谱速度范围为 40–180 BPM');
    requireValue(config.measures === undefined || [2, 4, 8].includes(config.measures), '小节数必须是 2、4 或 8');
    requireValue(config.countInMeasures === undefined || [1, 2].includes(config.countInMeasures), '预备拍只能是 1 或 2 小节');
  }
  return structuredClone(config);
}

export function generateReadingExercise(input, { findReadingAttempt } = {}) {
  object(input, '请求'); fields(input, ['config', 'reviewAttemptId']);
  const config = readingConfig(input.config);
  let groups;
  if (input.reviewAttemptId !== undefined) {
    requireValue(config.mode === 'free' && config.task !== 'test', '复习仅适用于自由识谱练习');
    requireValue(typeof input.reviewAttemptId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.reviewAttemptId), '识谱记录 ID 无效');
    const attempt = findReadingAttempt?.(input.reviewAttemptId);
    if (!attempt) throw new TrainingServiceError('READING_ATTEMPT_NOT_FOUND', '请先保存识谱记录，再开始薄弱音复习', 404);
    // Review selection comes from server-replayed evidence, never client stats.
    groups = attempt.summary.reviewGroups;
  }
  const common = { schemaVersion: TRAINING_SCHEMA_VERSION, generatorVersion: READING_GENERATOR_VERSION, mode: config.mode };
  if (config.mode === 'free') return { ...common, questions: groups ? generateReviewQuestions(config, groups) : generateFreeQuestions(config) };
  return { ...common, score: generateRhythmScore(config) };
}
