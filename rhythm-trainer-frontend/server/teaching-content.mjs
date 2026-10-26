'use strict';

/**
 * Teaching content catalog V1 — versioned, structured lesson definitions.
 *
 * Content lives on the Node/app layer (not in React): the UI only renders
 * what this module returns. Every lesson is validated on import and again in
 * tests; a missing required field must fail in development, never render an
 * empty lesson for a learner.
 *
 * Course flow (user-approved design): for a learner-chosen A–B range, each
 * lesson runs a HANDS-PROGRESSION of practice steps
 *   hand-1 (慢速带练) → hand-2 (慢速带练) → hands-together (慢速) →
 *   hands-together 原速独立演奏（= 练习通过检查）
 * with per-step evidence gating from the orchestrator (pass / targeted
 * remediation on the wrong measures / collect more evidence). "循环" is the
 * selected A–B range practiced once per launch; each repeat is a NEW Take.
 *
 * Evidence types reference what the Rust engine can actually produce today:
 *   onset-timing        — eventResults/measures onset metrics (Timeline)
 *   pitch-events        — eventResults MISSING/WRONG_PITCH/EXTRA
 *   duration-assessment — key-down duration assessments (strict-keydown)
 *   input-health        — captureDiagnostics.inputHealth / clock mapping
 * Evidence-gated lessons MUST degrade to "collect more evidence" when their
 * evidence type is unavailable; the orchestrator owns that gate.
 */

export const LESSON_CATALOG_SCHEMA_VERSION = 1;

/** Completion honesty: V1 never runs a transfer check automatically, so the
 * completion decision must say so instead of claiming mastery. */
export const TRANSFER_NOTE_V1 = '迁移检查使用未练过的新片段；V1 未执行时会如实标注「迁移未执行」，不会自动计为通过。';

/** Hands-progression step template shared by every lesson. Order of hand-1/
 * hand-2 is the learner's choice at run creation; the template is symmetric. */
export const HANDS_PROGRESSION_TEMPLATE = Object.freeze([
  {
    stepRunId: 'hand-1',
    phaseName: 'hand-single-1',
    title: '单手带练：第一只手',
    required: true,
    tempoFactor: 0.75,
    instruction: '先只弹一只手，慢速把音和拍点弹稳。循环范围只表示选定的 A–B 小节，练一遍；想再练就再开始一遍。',
  },
  {
    stepRunId: 'hand-2',
    phaseName: 'hand-single-2',
    title: '单手带练：另一只手',
    required: true,
    tempoFactor: 0.75,
    instruction: '换另一只手，同样慢速弹稳这一段。注意休止和时值。',
  },
  {
    stepRunId: 'hands-together',
    phaseName: 'hands-together',
    title: '合手慢速带练',
    required: true,
    tempoFactor: 0.85,
    instruction: '双手合在一起，仍然慢速。对不齐就退回单手，稳了再合。',
  },
  {
    stepRunId: 'pass-check',
    phaseName: 'pass-check',
    title: '合手原速 · 练习通过检查',
    required: true,
    tempoFactor: 1,
    instruction: '按目标速度独立完成整段。这一遍的证据决定「通过」或需要针对性纠错。',
  },
]);

const LESSON_IDS = new Set();
const DIFFICULTIES = new Set(['intro', 'basic', 'intermediate']);
const PHASES = new Set([
  'explain', 'hand-single-1', 'hand-single-2', 'hands-together',
  'pass-check', 'feedback', 'transfer', 'review',
]);
/** Run step ids of the hands progression → script phase. */
export const STEP_ID_TO_PHASE = Object.freeze({
  'hand-1': 'hand-single-1',
  'hand-2': 'hand-single-2',
  'hands-together': 'hands-together',
  'pass-check': 'pass-check',
  'study_score': 'explain',
});
/** Diagnosis reason codes the orchestrator can emit. */
const KNOWN_DIAGNOSIS_CODES = new Set([
  'MISSING_NOTES_V1', 'PITCH_ERRORS_V1', 'EXTRA_NOTES_V1', 'DURATION_V1',
  'LOCAL_ONSET_V1', 'INPUT_OR_ATTEMPT_UNTRUSTED', 'INSUFFICIENT_SCORE_EVIDENCE',
  'NO_TARGETED_REMEDIATION', 'REMEDIATION_LIMIT_REACHED',
]);
/** Evidence types the engine can actually produce. */
const KNOWN_EVIDENCE_TYPES = new Set([
  'onset-timing', 'pitch-events', 'duration-assessment', 'input-health',
]);

export class TeachingContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TeachingContentError';
  }
}

function requireString(value, field, lessonId) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TeachingContentError(`${lessonId}: ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireArray(value, field, lessonId, min = 1) {
  if (!Array.isArray(value) || value.length < min) {
    throw new TeachingContentError(`${lessonId}: ${field} 必须是至少 ${min} 个元素的数组`);
  }
  return value;
}

/** Validates one lesson definition; throws TeachingContentError on any gap. */
export function validateLessonDefinition(raw) {
  const lessonId = requireString(raw.lessonId, 'lessonId', raw.lessonId ?? '(unknown)');
  if (!/^[a-z0-9-]{3,64}$/.test(lessonId)) {
    throw new TeachingContentError(`${lessonId}: lessonId 只能是小写字母/数字/连字符（3–64）`);
  }
  if (LESSON_IDS.has(lessonId)) {
    throw new TeachingContentError(`重复的 lessonId: ${lessonId}`);
  }
  LESSON_IDS.add(lessonId);
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    throw new TeachingContentError(`${lessonId}: version 必须是正整数`);
  }
  requireString(raw.title, 'title', lessonId);
  requireString(raw.description, 'description', lessonId);
  if (!DIFFICULTIES.has(raw.difficulty)) {
    throw new TeachingContentError(`${lessonId}: difficulty 必须是 intro|basic|intermediate`);
  }
  requireArray(raw.skillTags, 'skillTags', lessonId).forEach((tag) => requireString(tag, 'skillTags[]', lessonId));
  if (!Array.isArray(raw.prerequisites)) {
    throw new TeachingContentError(`${lessonId}: prerequisites 必须是数组`);
  }

  const objectives = requireArray(raw.learningObjectives, 'learningObjectives', lessonId);
  for (const objective of objectives) {
    requireString(objective.id, 'learningObjectives[].id', lessonId);
    requireString(objective.statement, 'learningObjectives[].statement', lessonId);
    requireString(objective.evidenceType, 'learningObjectives[].evidenceType', lessonId);
    if (!KNOWN_EVIDENCE_TYPES.has(objective.evidenceType)) {
      throw new TeachingContentError(`${lessonId}: 未知 evidenceType ${objective.evidenceType}`);
    }
  }

  requireString(raw.explainScript?.title, 'explainScript.title', lessonId);
  requireString(raw.explainScript?.explanation, 'explainScript.explanation', lessonId);
  if (!Array.isArray(raw.explainScript.prompts)) {
    throw new TeachingContentError(`${lessonId}: explainScript.prompts 必须是字符串数组`);
  }
  requireArray(raw.explainScript.successCriteria, 'explainScript.successCriteria', lessonId);
  // Per-phase coaching tips keyed by the hands-progression phase names; each
  // needs at least a coaching line for that phase of THIS lesson.
  for (const phaseName of ['hand-single-1', 'hand-single-2', 'hands-together', 'pass-check']) {
    const tip = raw.coachingByPhase?.[phaseName];
    if (!tip || typeof tip.coaching !== 'string' || tip.coaching.trim() === '') {
      throw new TeachingContentError(`${lessonId}: coachingByPhase.${phaseName}.coaching 缺失`);
    }
  }

  const template = raw.practiceTemplate ?? {};
  if (template.advanceMode !== 'timeline') {
    throw new TeachingContentError(`${lessonId}: practiceTemplate.advanceMode V1 仅支持 timeline`);
  }
  if (!Number.isInteger(template.defaultBpm) || template.defaultBpm < 20 || template.defaultBpm > 300) {
    throw new TeachingContentError(`${lessonId}: practiceTemplate.defaultBpm 必须在 20–300`);
  }
  if (!Array.isArray(template.bpmRange) || template.bpmRange.length !== 2
    || template.bpmRange[0] < 20 || template.bpmRange[1] > 300 || template.bpmRange[0] > template.bpmRange[1]) {
    throw new TeachingContentError(`${lessonId}: practiceTemplate.bpmRange 非法`);
  }

  const feedbackRules = requireArray(raw.feedbackRules, 'feedbackRules', lessonId);
  for (const rule of feedbackRules) {
    if (!KNOWN_DIAGNOSIS_CODES.has(rule.diagnosisCode)) {
      throw new TeachingContentError(`${lessonId}: 未知 diagnosisCode ${rule.diagnosisCode}`);
    }
    requireString(rule.learnerMessage, 'feedbackRules[].learnerMessage', lessonId);
    requireString(rule.nextAction, 'feedbackRules[].nextAction', lessonId);
  }

  if (typeof raw.completionPolicy?.allowProvisionalCompletion !== 'boolean') {
    throw new TeachingContentError(`${lessonId}: completionPolicy.allowProvisionalCompletion 必须是布尔`);
  }
  requireArray(raw.completionPolicy.requiredEvidence, 'completionPolicy.requiredEvidence', lessonId);

  requireString(raw.reviewPolicy?.trigger, 'reviewPolicy.trigger', lessonId);
  if (!Array.isArray(raw.reviewPolicy.suggestedIntervalDays)
    || raw.reviewPolicy.suggestedIntervalDays.some((days) => !Number.isInteger(days) || days <= 0)) {
    throw new TeachingContentError(`${lessonId}: reviewPolicy.suggestedIntervalDays 必须是正整数数组`);
  }
  return lessonId;
}

const RAW_LESSONS = [
  {
    lessonId: 'steady-beat-hands',
    version: 1,
    title: '建立稳定拍点（左手→右手→合手）',
    description: '把拍点变成身体感觉，再按 单手→单手→合手→原速通过 的顺序弹稳你选的乐段。',
    difficulty: 'intro',
    skillTags: ['pulse', 'onset-stability', 'hands-progression'],
    prerequisites: [],
    learningObjectives: [
      { id: 'obj-pulse-single', statement: '单手慢速弹奏时，起音都落在拍点附近（以引擎起音偏差为证据）', evidenceType: 'onset-timing' },
      { id: 'obj-pulse-both', statement: '合手原速演奏通过检查：无达到纠错门槛的逐小节问题', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '什么是“稳”',
      explanation: '节拍像走路：不是快，而是每一步间隔一样。先别弹，跟我口数：1 2 3 4，速度不变地数两遍。然后按 左手→右手→合手 的顺序，把这份稳定带进琴键。',
      prompts: ['先口数 8 拍两遍，不加力度变化', '单手时也小声数拍', '觉得要赶就放慢，稳定比速度重要'],
      successCriteria: ['单手阶段起音偏差小而均匀', '合手原速通过检查'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '单手最容易犯的错是越弹越快。每个音都落在口数的拍点上，错了不停下来，先弹完整段。' },
      'hand-single-2': { coaching: '换一只手通常会更生疏：允许自己比第一只手更慢。休止也要数出来。' },
      'hands-together': { coaching: '合手对不齐是正常的。退回单手各再练一遍，稳了再合；合手时速度降到单手的八成。' },
      'pass-check': { coaching: '这是通过检查：按原速、独立完成。弹之前心里先数两拍再开始。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 60, bpmRange: [40, 80] },
    feedbackRules: [
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '整体拍点不错，但个别小节开始赶/拖了。我们单独慢练那个小节。', nextAction: '按建议速度针对性慢练被点名的小节，再回到当前阶段整段弹。' },
      { diagnosisCode: 'MISSING_NOTES_V1', learnerMessage: '有几个音没有出声。先别管快慢，把每个键都弹响。', nextAction: '慢速补齐漏掉的音，确认每个起音都出声后继续本阶段。' },
      { diagnosisCode: 'INPUT_OR_ATTEMPT_UNTRUSTED', learnerMessage: '这次输入数据不可靠，老师不能下结论。先检查设备/连接再弹一遍。', nextAction: '检查输入健康后重弹本阶段。' },
      { diagnosisCode: 'INSUFFICIENT_SCORE_EVIDENCE', learnerMessage: '这次有效样本不够，不能下结论。完整弹完这一段，别中断。', nextAction: '重弹本阶段，收集完整证据。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '这一阶段过关！进入下一步。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 1 天后', suggestedIntervalDays: [1, 3, 7] },
  },
  {
    lessonId: 'duration-rest-hands',
    version: 1,
    title: '音符时值与休止（左手→右手→合手）',
    description: '把“按下”和“保持”分开：音有多长、休止有多长。单手各自按满时值，合手时也不偷短。',
    difficulty: 'intro',
    skillTags: ['duration', 'rest', 'hands-progression'],
    prerequisites: ['steady-beat-hands'],
    learningObjectives: [
      { id: 'obj-duration', statement: '开启时值评估后，各阶段多数按键时值落在目标容差内', evidenceType: 'duration-assessment' },
      { id: 'obj-rest', statement: '休止位置能松键留白，不把休止弹成音', evidenceType: 'duration-assessment' },
    ],
    explainScript: {
      title: '按下 ≠ 弹完',
      explanation: '四分音符是“按住一拍”，不是“按一下”。休止符是“这一拍手离开键盘”，静默也是音乐。我们按 左手→右手→合手 的顺序，把时值弹满。',
      prompts: ['弹一个音，心里数“1 哦”再松手', '休止时手指真的离键', '时值太短是最常见错误，宁长勿短'],
      successCriteria: ['各阶段时值评估以 within_tolerance 为主'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '单手时把每个音的时值心里默数出来。时值评估要在练习设置里开启，否则这课只能给练习提示。' },
      'hand-single-2': { coaching: '另一只手的时值通常更短——注意力在音准时，手容易提前松。刻意多按住一点。' },
      'hands-together': { coaching: '合手时只顾对齐会牺牲时值。慢速合，时值优先于速度。' },
      'pass-check': { coaching: '通过检查按原速：时值不达标会点名，通过了才进入下一课。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 60, bpmRange: [40, 80] },
    feedbackRules: [
      { diagnosisCode: 'DURATION_V1', learnerMessage: '有音松得太早、休止没留够。按满时值再松手。', nextAction: '按建议速度慢练，专门注意按满时值与休止留白。' },
      { diagnosisCode: 'INSUFFICIENT_SCORE_EVIDENCE', learnerMessage: '有效时值样本不足，老师不下结论。完整弹一遍，别中断。', nextAction: '重弹本阶段收集足够样本。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '时值保持得很好！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['duration-assessment'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 2 天后', suggestedIntervalDays: [2, 5, 10] },
  },
  {
    lessonId: 'subdivision-count-hands',
    version: 1,
    title: '细分拍与口数节奏（左手→右手→合手）',
    description: '一拍里有“半拍”：每只手先各自数清楚，合手时细分位置才不会含糊。',
    difficulty: 'basic',
    skillTags: ['subdivision', 'counting', 'hands-progression'],
    prerequisites: ['steady-beat-hands'],
    learningObjectives: [
      { id: 'obj-subdiv', statement: '单手阶段能在口数“1 哒 2 哒”下把半拍起音放准', evidenceType: 'onset-timing' },
      { id: 'obj-both', statement: '合手原速检查中，起音分布与谱面节奏型一致', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '把一拍切成两半',
      explanation: '数“1 哒 2 哒 3 哒 4 哒”——数字是整拍，“哒”是半拍。难的不是快，是“哒”也要准。先口数，再单手，最后合手。',
      prompts: ['先拍手：数字重、“哒”轻', '半拍容易越数越快，想象拍点之间有等距的点'],
      successCriteria: ['单手与合手阶段的半拍起音都落在“哒”上'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '第一只手边数边弹，数不出来就再降速度。' },
      'hand-single-2': { coaching: '第二只手的节奏型常常不同，先单独把它的“哒”位置点出来再弹。' },
      'hands-together': { coaching: '合手时嘴里只数整拍，半拍交给手。' },
      'pass-check': { coaching: '原速检查：半拍不抢不拖才算过。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 56, bpmRange: [40, 90] },
    feedbackRules: [
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '细分位置在个别小节不稳，单独抽出来数清楚。', nextAction: '单独慢练被点名小节，口数后再回到本阶段。' },
      { diagnosisCode: 'MISSING_NOTES_V1', learnerMessage: '半拍上的音容易漏。空手数到那个位置再上琴。', nextAction: '慢练补齐漏音，重点在半拍起音。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '细分很扎实！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 2 天后', suggestedIntervalDays: [2, 4, 9] },
  },
  {
    lessonId: 'early-late-onset-hands',
    version: 1,
    title: '解决起音过早/过晚（左手→右手→合手）',
    description: '看懂偏差方向：正号拖、负号抢。单手各自修正方向，合手后保持，原速验证通过。',
    difficulty: 'basic',
    skillTags: ['onset-correction', 'hands-progression'],
    prerequisites: ['steady-beat-hands'],
    learningObjectives: [
      { id: 'obj-direction', statement: '能说出自己偏早还是偏晚（依据引擎平均偏差符号）', evidenceType: 'onset-timing' },
      { id: 'obj-correct', statement: '通过检查时，整段平均起音偏差绝对值比最初明显下降', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '早与晚是方向',
      explanation: '引擎的偏差有正负：正=比拍点晚（拖），负=早（抢）。方向认清了，修正才有抓手。流程：单手各自修方向 → 合手保持 → 原速通过。',
      prompts: ['看反馈里“平均偏差”的正负号', '抢拍的人想着“等半拍”，拖拍的人想着“提前准备”'],
      successCriteria: ['通过检查时偏差回到小范围'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '单手慢速，把每个起音往拍点上放。记住你的方向口诀。' },
      'hand-single-2': { coaching: '两只手的偏差方向可能不同，分别确认。' },
      'hands-together': { coaching: '合手会放大拖拍，慢速合手时也别忘了口诀。' },
      'pass-check': { coaching: '原速验证：修正保住了才算数。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 56, bpmRange: [40, 90] },
    feedbackRules: [
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '还有小节在抢/拖。用方向口诀继续慢练那一小节。', nextAction: '针对性慢练被点名小节，稳定三遍再继续。' },
      { diagnosisCode: 'INPUT_OR_ATTEMPT_UNTRUSTED', learnerMessage: '这次输入不可靠，不能判断快慢。先检查设备。', nextAction: '检查输入健康后重弹本阶段。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '起音落回拍点附近了！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 2 天后', suggestedIntervalDays: [2, 4, 8] },
  },
  {
    lessonId: 'even-rhythm-hands',
    version: 1,
    title: '让节奏更均匀（左手→右手→合手）',
    description: '“平均速度对”不等于“全程稳”。单手各自做到拍间均匀，合手后不漂移，原速通过。',
    difficulty: 'basic',
    skillTags: ['stability', 'jitter', 'hands-progression'],
    prerequisites: ['steady-beat-hands', 'subdivision-count-hands'],
    learningObjectives: [
      { id: 'obj-even', statement: '各阶段拍间波动保持在小的范围内', evidenceType: 'onset-timing' },
      { id: 'obj-drift', statement: '通过检查的整段演奏无明显渐快/渐慢趋势', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '平均 ≠ 稳定',
      explanation: '平均 120 可能是前两小节 130、后两小节 110。我们要每一拍都一样：单手各自均匀 → 合手保持 → 原速通过。',
      prompts: ['感觉要乱就主动降一档速度', '不稳多半出现在换手/换位置，提前半拍准备'],
      successCriteria: ['通过检查时开头与结尾速度感一致'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '同一小段反复弹，留意“哪一遍开始不稳”。' },
      'hand-single-2': { coaching: '另一只手单独练到同样均匀，别急着合。' },
      'hands-together': { coaching: '合手漂移多半来自较弱的那只手，退回单手补。' },
      'pass-check': { coaching: '原速整段：开头和结尾速度感一致才算通过。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 60, bpmRange: [40, 90] },
    feedbackRules: [
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '整体均匀，个别位置例外。单独圈出来慢练。', nextAction: '针对性慢练被点名的小节。' },
      { diagnosisCode: 'INSUFFICIENT_SCORE_EVIDENCE', learnerMessage: '干净的可比样本不够，完整弹一遍。', nextAction: '重弹本阶段，不要中途停。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '波动很小，节奏均匀！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 3 天后', suggestedIntervalDays: [3, 6, 12] },
  },
  {
    lessonId: 'pitch-missed-hands',
    version: 1,
    title: '音高与漏音检查（左手→右手→合手）',
    description: '分清漏音、错音、多余音。单手各自清零错误，合手后保持，原速通过检查。',
    difficulty: 'basic',
    skillTags: ['pitch-accuracy', 'missing-notes', 'hands-progression'],
    prerequisites: ['steady-beat-hands'],
    learningObjectives: [
      { id: 'obj-read', statement: '能根据事件级反馈说出主要错误类型（漏/错/多余）', evidenceType: 'pitch-events' },
      { id: 'obj-fix', statement: '通过检查中被点名小节的同类错误不再出现', evidenceType: 'pitch-events' },
    ],
    explainScript: {
      title: '三种“不对”',
      explanation: '漏音=该弹没出声；错音=出声但不是这个音；多余音=弹了谱上没有的。练法完全不同：漏音练准备，错音练读谱，多余音练手型。按 单手各自清零 → 合手 → 原速通过 来。',
      prompts: ['回忆你的错误更像哪一种', '看反馈里的事件级列表'],
      successCriteria: ['通过检查无同类错误'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '单手慢速把每个键按到底，先清零漏音。' },
      'hand-single-2': { coaching: '错音常因看错行或把位。确认音名再下键。' },
      'hands-together': { coaching: '合手出现的新错音，多半是让位互相干扰，放慢并注意手型。' },
      'pass-check': { coaching: '原速检查：同类错误消失才算通过。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 56, bpmRange: [40, 90] },
    feedbackRules: [
      { diagnosisCode: 'MISSING_NOTES_V1', learnerMessage: '还有音没出声。放慢，把每个键按到底。', nextAction: '慢练补齐漏音后再继续本阶段。' },
      { diagnosisCode: 'PITCH_ERRORS_V1', learnerMessage: '有按错的音。单独把正确的音找出来，再连前后两拍。', nextAction: '针对错音小节慢练。' },
      { diagnosisCode: 'EXTRA_NOTES_V1', learnerMessage: '有谱上没有的多余音，检查是否碰到邻键。', nextAction: '放慢，注意手型，只弹谱上的音。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '音都弹对了！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['pitch-events'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 2 天后', suggestedIntervalDays: [2, 5, 9] },
  },
  {
    lessonId: 'weak-section-fix-hands',
    version: 1,
    title: '困难片段专项修复（左手→右手→合手）',
    description: '整段总断在某几小节？把困难片段切片慢练，单手修好，合手缝合，原速验收。',
    difficulty: 'intermediate',
    skillTags: ['section-practice', 'hands-progression'],
    prerequisites: ['steady-beat-hands', 'pitch-missed-hands'],
    learningObjectives: [
      { id: 'obj-section', statement: '困难片段慢练后，该片段在合手中不再出现同类错误', evidenceType: 'pitch-events' },
      { id: 'obj-merge', statement: '通过检查中，原困难小节的起音与时值保持达标', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '先切片，再缝合',
      explanation: '把最没把握的 1–2 小节切出来：单手慢练到连续 3 遍无误，再接前一小节、后一小节，最后整段。循环范围就选这一片。',
      prompts: ['圈出困难片段（用范围选择）', '缝合时先带前一小节，再带后一小节'],
      successCriteria: ['通过检查中原片段无新问题'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '只练困难片段的第一只手，慢到不会错。' },
      'hand-single-2': { coaching: '第二只手同样切片慢练，两遍稳了才合。' },
      'hands-together': { coaching: '合手从“片段±1 小节”开始，稳了再扩回整段。' },
      'pass-check': { coaching: '原速整段验收：老地方不出问题才是真的修好了。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 52, bpmRange: [40, 90] },
    feedbackRules: [
      { diagnosisCode: 'MISSING_NOTES_V1', learnerMessage: '整合后旧问题回来了：退回片段慢练，再重新缝合。', nextAction: '回到困难片段慢练三遍，再继续本阶段。' },
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '缝合处节奏变不稳，说明还没缝合好。放慢扩范围的速度。', nextAction: '降低速度重复 片段→上下文 流程。' },
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '片段修复成功！进入下一阶段。', nextAction: '继续 hands-progression 的下一个阶段。' },
    ],
    completionPolicy: { requiredEvidence: ['pitch-events', 'onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '通过检查完成 3 天后', suggestedIntervalDays: [3, 7, 14] },
  },
  {
    lessonId: 'transfer-review',
    version: 1,
    title: '迁移与复习',
    description: '在没练过的新片段上冷读一遍，检查技能是否真的迁移；隔天复习旧片段。重复同一片段的成功不等于掌握。',
    difficulty: 'intermediate',
    skillTags: ['transfer', 'review', 'hands-progression'],
    prerequisites: ['even-rhythm-hands', 'weak-section-fix-hands'],
    learningObjectives: [
      { id: 'obj-transfer', statement: '在未练过的新片段上冷读一遍即达到当前技能证据门槛', evidenceType: 'onset-timing' },
      { id: 'obj-review', statement: '隔天复习时，先前通过的内容仍保持达标', evidenceType: 'onset-timing' },
    ],
    explainScript: {
      title: '换个片段还算数吗',
      explanation: '同一片段弹对 100 遍不代表技能会用在新地方。迁移检查=换一个没练过的相近难度片段冷读一遍。V1 的迁移由你选择新范围触发；没有执行时系统会如实标注“迁移未执行”，不会自动计为通过。之后按建议间隔复习旧片段。',
      prompts: ['选一段没练过的、难度相近的范围', '读谱 30 秒后按原速冷读', '隔天回来复习旧片段'],
      successCriteria: ['新片段冷读达标；旧片段复习仍达标'],
    },
    coachingByPhase: {
      'hand-single-1': { coaching: '冷读也按 单手→合手 的顺序快速过一遍，只给一次正式冷读。' },
      'hand-single-2': { coaching: '第二只手冷读时把拍点数出来，别猜。' },
      'hands-together': { coaching: '合手冷读是迁移的核心证据，正常速度、不预先慢练。' },
      'pass-check': { coaching: '冷读结果达标=迁移成立；不足=回到针对性练习，如实记录。' },
    },
    practiceTemplate: { advanceMode: 'timeline', defaultBpm: 60, bpmRange: [40, 100] },
    feedbackRules: [
      { diagnosisCode: 'NO_TARGETED_REMEDIATION', learnerMessage: '新片段上也稳，迁移成立。按建议间隔安排复习。', nextAction: '按复习建议安排下一次复习。' },
      { diagnosisCode: 'LOCAL_ONSET_V1', learnerMessage: '新片段上有局部不稳：迁移还不完整，回针对性练习。', nextAction: '对新片段做针对性慢练。' },
      { diagnosisCode: 'INSUFFICIENT_SCORE_EVIDENCE', learnerMessage: '新片段证据不足，这次不算迁移结果。完整弹一遍再判断。', nextAction: '重弹新片段，收集完整证据。' },
    ],
    completionPolicy: { requiredEvidence: ['onset-timing'], allowProvisionalCompletion: true },
    reviewPolicy: { trigger: '迁移检查后', suggestedIntervalDays: [1, 3, 7, 14] },
  },
];

/** Validated public catalog (frozen). */
export const LESSON_CATALOG = (() => {
  LESSON_IDS.clear();
  const ids = RAW_LESSONS.map((lesson) => validateLessonDefinition(lesson));
  const known = new Set(ids);
  for (const lesson of RAW_LESSONS) {
    for (const prerequisite of lesson.prerequisites) {
      if (!known.has(prerequisite)) {
        throw new TeachingContentError(`${lesson.lessonId}: 前置课程 ${prerequisite} 不在目录中`);
      }
    }
  }
  return RAW_LESSONS.map((lesson) => deepFreeze(structuredClone(lesson)));
})();

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    Object.freeze(value);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Public listing for the UI catalog picker (full content; bounded size). */
export function getLessonCatalog() {
  return LESSON_CATALOG.map((lesson) => ({
    lessonId: lesson.lessonId,
    version: lesson.version,
    title: lesson.title,
    description: lesson.description,
    difficulty: lesson.difficulty,
    skillTags: [...lesson.skillTags],
    prerequisites: [...lesson.prerequisites],
    learningObjectives: lesson.learningObjectives.map((objective) => ({ ...objective })),
    explainScript: {
      ...lesson.explainScript,
      prompts: [...lesson.explainScript.prompts],
      successCriteria: [...lesson.explainScript.successCriteria],
    },
    coachingByPhase: Object.fromEntries(
      Object.entries(lesson.coachingByPhase).map(([phase, tip]) => [phase, { ...tip }]),
    ),
    practiceTemplate: { ...lesson.practiceTemplate, bpmRange: [...lesson.practiceTemplate.bpmRange] },
    feedbackRules: lesson.feedbackRules.map((rule) => ({ ...rule })),
    completionPolicy: { ...lesson.completionPolicy, requiredEvidence: [...lesson.completionPolicy.requiredEvidence] },
    reviewPolicy: { ...lesson.reviewPolicy, suggestedIntervalDays: [...lesson.reviewPolicy.suggestedIntervalDays] },
  }));
}

export function getLessonById(lessonId) {
  return LESSON_CATALOG.find((lesson) => lesson.lessonId === lessonId) ?? null;
}

/**
 * The slice of a lesson a running LessonRun needs: the explain script plus
 * per-phase coaching keyed by hands-progression step id, so the UI renders
 * the matching teacher words without importing the catalog.
 */
export function lessonViewForRun(lesson) {
  if (!lesson) return null;
  const coachingByStepId = {};
  for (const step of HANDS_PROGRESSION_TEMPLATE) {
    const tip = lesson.coachingByPhase[step.phaseName];
    if (tip) coachingByStepId[step.stepRunId] = { coaching: tip.coaching };
  }
  return {
    lessonId: lesson.lessonId,
    version: lesson.version,
    title: lesson.title,
    description: lesson.description,
    objectives: lesson.learningObjectives.map((objective) => ({ ...objective })),
    explainScript: {
      ...lesson.explainScript,
      prompts: [...lesson.explainScript.prompts],
      successCriteria: [...lesson.explainScript.successCriteria],
    },
    coachingByStepId,
    transferNote: TRANSFER_NOTE_V1,
    reviewPolicy: { trigger: lesson.reviewPolicy.trigger, suggestedIntervalDays: [...lesson.reviewPolicy.suggestedIntervalDays] },
  };
}

/**
 * Maps an orchestrator decision onto the lesson's own words: try the decision
 * reasonCode first (stage-level codes), then the selected prescription's
 * ruleId (problem-level codes). Falls back to the policy reason text.
 */
export function learnerMessageFor(lesson, decision, fallbackMessage) {
  if (lesson && decision) {
    const codes = [decision.reasonCode, decision.prescription?.ruleId].filter(Boolean);
    for (const code of codes) {
      const rule = lesson.feedbackRules.find((item) => item.diagnosisCode === code);
      if (rule) return { message: rule.learnerMessage, nextAction: rule.nextAction, source: 'lesson' };
    }
  }
  return { message: fallbackMessage, nextAction: null, source: 'policy' };
}
