'use strict';

/**
 * Teaching Orchestrator V1 — application-layer lesson workflow.
 *
 * Responsibilities:
 * - Persist lesson progress and decisions, never duplicate Take contents.
 * - Read authoritative assessment evidence from the Take repository.
 * - Turn eligible Rust-produced reports into explainable teaching actions.
 * - Return UI-ready DTOs; no React/UI state lives here.
 *
 * Non-responsibilities:
 * - No score matching, timing calculation, MIDI interpretation or scoring.
 * - No mutation of a Take or a score plan.
 * - No persistent PracticeSession aggregate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TEACHING_RUN_SCHEMA_VERSION = 1;
export const TEACHING_POLICY_VERSION = 'teaching-policy-v1';
export const MAX_COMMAND_RECEIPTS = 128;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const HANDS = new Set(['left', 'right', 'both']);

export class TeachingOrchestratorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TeachingOrchestratorError';
    this.code = code;
    this.status = status;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TeachingOrchestratorError('INVALID_ID', `${label} 非法`);
  }
  return value;
}

function requireInt(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new TeachingOrchestratorError('INVALID_INPUT', `${label} 必须是 ${min}–${max} 之间的整数`);
  }
  return n;
}

function normalizeCreateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TeachingOrchestratorError('INVALID_INPUT', '创建教学流程的请求必须是对象');
  }
  const scoreFingerprint = typeof input.scoreFingerprint === 'string' ? input.scoreFingerprint.trim() : '';
  if (!scoreFingerprint || scoreFingerprint.length > 160) {
    throw new TeachingOrchestratorError('INVALID_SCORE_FINGERPRINT', '缺少有效的曲谱指纹');
  }
  const scoreBarCount = requireInt(input.scoreBarCount, 1, 10000, 'scoreBarCount');
  const bpm = requireInt(input.bpm ?? 72, 20, 300, 'BPM');
  const hand = input.hand == null ? 'right' : input.hand;
  if (!HANDS.has(hand)) {
    throw new TeachingOrchestratorError('INVALID_HAND', 'hand 必须是 left/right/both');
  }
  const startMeasure = requireInt(input.startMeasure ?? 1, 1, scoreBarCount, 'startMeasure');
  const endMeasure = requireInt(input.endMeasure ?? scoreBarCount, startMeasure, scoreBarCount, 'endMeasure');
  const goal = ['learn-score', 'rhythm', 'pitch', 'duration', 'rehearse'].includes(input.goal)
    ? input.goal
    : 'learn-score';
  return {
    scoreFingerprint,
    scoreBarCount,
    bpm,
    hand,
    startMeasure,
    endMeasure,
    goal,
    referenceAvailable: input.referenceAvailable === true,
    profile: ['strict', 'standard', 'relaxed'].includes(input.profile) ? input.profile : 'standard',
    durationPolicy: ['strict-keydown', 'disabled'].includes(input.durationPolicy) ? input.durationPolicy : 'disabled',
    feedback: ['live', 'after'].includes(input.feedback) ? input.feedback : 'live',
  };
}

function roundBpm(value) {
  return Math.min(300, Math.max(20, Math.round(value / 5) * 5));
}

function makeStep({ id, kind, title, instruction, range, hands, bpm, required = true, status = 'ready' }) {
  return {
    stepRunId: id,
    kind,
    title,
    instruction,
    status,
    required,
    attemptCount: 0,
    ...(range ? { measureRange: { ...range } } : {}),
    ...(hands ? { hands } : {}),
    ...(Number.isFinite(bpm) ? { tempoBpm: bpm } : {}),
  };
}

function initialSteps(input) {
  const firstEnd = Math.min(input.endMeasure, input.startMeasure + 3);
  const range = { startMeasure: input.startMeasure, endMeasure: firstEnd };
  const steps = [makeStep({
    id: 'understand-score',
    kind: 'study_score',
    title: '先认识这段乐谱',
    instruction: '先看清调号、拍号、音符走向和小节边界。准备好后再进入示范或带练。',
  })];
  if (input.referenceAvailable) {
    steps.push(makeStep({
      id: 'listen-demonstration',
      kind: 'demonstrate',
      title: '先听一遍示范',
      instruction: '先完整听过当前片段，留意每拍的落点与音符之间的间隔。',
      range,
      hands: input.hand,
      bpm: input.bpm,
      required: false,
    }));
  }
  steps.push(makeStep({
    id: 'guided-practice',
    kind: 'guided_practice',
    title: '跟着提示练习',
    instruction: '先练短片段。跟随乐谱位置和节拍提示演奏，结束后系统会根据这次 Take 的引擎报告决定下一步。',
    range,
    hands: input.hand,
    bpm: input.bpm,
  }));
  steps.push(makeStep({
    id: 'independent-performance',
    kind: 'independent_performance',
    title: '不依赖提示再弹一次',
    instruction: '尝试独立完成所选范围。系统会检查本次演奏证据是否足够；证据不足时不会宣称已经掌握。',
    range: { startMeasure: input.startMeasure, endMeasure: input.endMeasure },
    hands: input.hand,
    bpm: input.bpm,
  }));
  return steps;
}

/**
 * Upper bound for measures this policy may target. Only the run's own score
 * size and the report's per-measure summary rows define it; a bad or hostile
 * `eventResults[].measure` value can never widen the range the engine's
 * measure table established.
 */
function safeMaxMeasure(scoreReport, scoreBarCount) {
  const values = [scoreBarCount ?? 0];
  for (const item of scoreReport?.measures ?? []) values.push(Number(item.measure) || 0);
  for (const item of scoreReport?.practiceRanges ?? []) values.push(Number(item.endMeasure) || 0);
  return Math.max(0, ...values.filter(Number.isFinite));
}

function isReport(value) {
  return !!value && typeof value === 'object' && !('error' in value)
    && Array.isArray(value.eventResults) && Array.isArray(value.measures);
}

function confidenceUsable(report) {
  return report && report.confidence !== 'low'
    && report.confidence !== 'not-assessable' && report.dataDegraded !== true;
}

function validMeasure(value, maxMeasure) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maxMeasure;
}

function evidenceRef(take, metric, value, measure, detail, eventId) {
  return {
    source: eventId ? 'score-event' : 'score-measure',
    metric,
    value,
    ...(validMeasure(measure, Number.MAX_SAFE_INTEGER) ? { measure } : {}),
    ...(typeof eventId === 'string' && eventId ? { eventId } : {}),
    ...(detail ? { detail } : {}),
    takeId: take.takeId,
  };
}

/**
 * Reads existing authoritative Rust assessment fields and chooses at most one
 * remediation. It intentionally does not compute new scoring features.
 */
function findRemediation(take, run) {
  const assessment = take?.assessment ?? {};
  const timeline = assessment.timelineReport;
  const scoreReport = timeline?.scoreV1;
  const status = assessment.scoreStatus ?? timeline?.scoreStatus ?? 'UNAVAILABLE';
  const maxMeasure = safeMaxMeasure(scoreReport, run.scoreBarCount);
  const confidence = isReport(scoreReport) ? scoreReport.confidence : 'not-assessable';

  // Confidence/evidence quality gates must run before interpreting a mistake as
  // a learner skill issue. Unknown/legacy provenance does not automatically
  // block the attempt; score/input evidence must still be trustworthy.
  const endedInterrupted = take?.lifecycle?.endReason === 'interrupted';
  if (endedInterrupted || assessment.attemptStatus === 'interrupted'
    || assessment.trustworthy !== true || assessment.inputQuality === 'unscorable'
    || assessment.inputQuality === 'degraded') {
    return {
      action: 'check_input',
      reasonCode: 'INPUT_OR_ATTEMPT_UNTRUSTED',
      reason: '本次演奏的输入或完整性证据不足，先检查设备/连接，再重新尝试；暂不判断演奏能力。',
      candidate: null,
      scoreStatus: status,
      confidence,
    };
  }
  if (status !== 'AVAILABLE' || !isReport(scoreReport) || !confidenceUsable(scoreReport)) {
    return {
      action: 'collect_more_evidence',
      reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE',
      reason: '当前报告不足以支持可靠的逐小节教学诊断。可以重新练习一次，或手动选择片段；不自动断言薄弱点。',
      candidate: null,
      scoreStatus: status,
      confidence,
    };
  }

  const candidates = [];
  const pushEventCandidates = (result, priority, ruleId, problemType, factor, actionText) => {
    const groups = new Map();
    for (const event of scoreReport.eventResults) {
      if (event.result !== result || !validMeasure(event.measure, maxMeasure)) continue;
      const list = groups.get(event.measure) ?? [];
      list.push(event);
      groups.set(event.measure, list);
    }
    for (const [measure, events] of groups) {
      candidates.push({
        priority,
        ruleId,
        problemType,
        range: { startMeasure: measure, endMeasure: measure },
        factor,
        confidence: confidenceFor(scoreReport, problemType),
        reason: `第 ${measure} 小节有 ${events.length} 个事件被引擎判定为 ${result}。此建议依据事件级报告，不从数量差反推音符错误。`,
        action: actionText,
        evidence: events.slice(0, 8).map(event => evidenceRef(
          take, result, event.expectedPitch ?? event.actualPitch ?? event.result,
          event.measure, event.reason ?? result, event.scoreEventId ?? event.performedNoteId ?? undefined,
        )),
      });
    }
  };

  pushEventCandidates('MISSING', 0, 'MISSING_NOTES_V1', 'missing-notes', 0.8, '降低速度，补齐目标音符');
  pushEventCandidates('WRONG_PITCH', 1, 'PITCH_ERRORS_V1', 'pitch-errors', 0.9, '慢练错误音符，确认音高');
  pushEventCandidates('EXTRA', 2, 'EXTRA_NOTES_V1', 'extra-notes', 0.9, '慢练起音与休止的边界');

  // Duration results are already computed by the Rust assessment. This layer
  // only groups those results by measure; it never derives duration error.
  const durations = timeline?.durations;
  const durationGroups = new Map();
  for (const item of durations?.assessments ?? []) {
    if (!['too_short', 'too_long'].includes(item.result) || item.quality !== 'ok'
      || !validMeasure(item.bar, maxMeasure)) continue;
    const list = durationGroups.get(item.bar) ?? [];
    list.push(item);
    durationGroups.set(item.bar, list);
  }
  for (const [measure, issues] of durationGroups) {
    const graded = (durations?.assessments ?? []).filter(item => item.bar === measure
      && item.quality === 'ok' && ['within_tolerance', 'too_short', 'too_long'].includes(item.result));
    if (graded.length < 2) continue;
    const shortCount = issues.filter(item => item.result === 'too_short').length;
    const longCount = issues.filter(item => item.result === 'too_long').length;
    candidates.push({
      priority: 2,
      ruleId: 'DURATION_V1',
      problemType: 'duration',
      range: { startMeasure: measure, endMeasure: measure },
      factor: 0.8,
      confidence: confidenceFor(scoreReport, 'duration'),
      reason: `第 ${measure} 小节有 ${issues.length}/${graded.length} 个有效按键时值偏离目标（偏短 ${shortCount}，偏长 ${longCount}）。`,
      action: '慢练这个小节，按满目标时值',
      evidence: issues.slice(0, 3).map(item => evidenceRef(
        take, 'durationErrorMs', item.durationErrorMs, measure,
        `actual ${item.actualKeyDownMs ?? '?'}ms / target ${item.nominalDurationMs ?? '?'}ms; ${item.result}`,
        item.targetId,
      )),
    });
  }

  const measured = scoreReport.measures
    .filter(item => validMeasure(item.measure, maxMeasure) && Number.isFinite(item.meanAbsOnsetErrorMs)
      && Number.isFinite(item.matched) && item.matched >= 2 && (item.missed ?? 0) === 0)
    .map(item => ({ measure: item.measure, mae: item.meanAbsOnsetErrorMs, matched: item.matched }));
  if (measured.length) {
    const sorted = measured.map(item => item.mae).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const baseline = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    for (const item of measured) {
      if (item.mae <= 60 || (measured.length > 1 && item.mae - baseline < 20)) continue;
      candidates.push({
        priority: 3,
        ruleId: 'LOCAL_ONSET_V1',
        problemType: 'local-onset',
        range: { startMeasure: item.measure, endMeasure: item.measure },
        factor: 0.8,
        confidence: scoreReport.confidence,
        reason: `第 ${item.measure} 小节平均绝对起音误差 ${item.mae.toFixed(1)}ms（${measured.length === 1 ? '报告只有一个可比较小节' : `可比较小节中位数 ${baseline.toFixed(1)}ms`}，匹配 ${item.matched} 个目标）。`,
        action: '降低速度练习这个小节，让每个起音落在同一拍点',
        evidence: [evidenceRef(take, 'meanAbsOnsetErrorMs', item.mae, item.measure,
          `matched ${item.matched}; baseline ${baseline.toFixed(1)}ms`)],
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority
    || a.range.startMeasure - b.range.startMeasure
    || a.ruleId.localeCompare(b.ruleId));
  const selected = candidates[0] ?? null;
  if (!selected) {
    return {
      action: 'advance',
      reasonCode: 'NO_TARGETED_REMEDIATION',
      reason: '当前报告没有发现达到 V1 教学规则门槛的逐小节问题。继续独立演奏检查，而不是直接宣称已经掌握。',
      candidate: null,
      scoreStatus: status,
      confidence,
    };
  }
  return {
    action: 'focus_range',
    reasonCode: 'REMEDIATION_REQUIRED',
    reason: selected.reason,
    candidate: selected,
    scoreStatus: status,
    confidence,
  };
}

function confidenceFor(report, category) {
  const aliases = {
    'missing-notes': 'missed-notes',
    'pitch-errors': 'pitch-errors',
    duration: 'duration',
    'extra-notes': 'extra-notes',
  };
  const item = report?.diagnostics?.find(d => d.category === (aliases[category] ?? category));
  const value = item?.confidence ?? report?.confidence;
  return ['high', 'medium', 'low', 'not-assessable'].includes(value) ? value : 'not-assessable';
}

function toPublicRun(run) {
  const current = run.steps.find(step => step.stepRunId === run.currentStepId) ?? null;
  const isPracticeStep = current && ['guided_practice', 'focused_practice', 'independent_performance'].includes(current.kind);
  const range = current?.measureRange ?? { startMeasure: run.config.startMeasure, endMeasure: run.config.endMeasure };
  const actions = [];
  if (run.status === 'ready') actions.push({ action: 'begin', enabled: true, label: '开始学习' });
  if (run.status === 'in_progress' && current?.status === 'active' && !isPracticeStep) {
    actions.push({ action: 'complete-step', enabled: true, label: current.kind === 'demonstrate' ? '完成示范' : '继续' });
    if (!current.required) actions.push({ action: 'skip-step', enabled: true, label: '跳过此步' });
  }
  if (run.status === 'awaiting_evidence') actions.push({ action: 'retry-current-step', enabled: true, label: '再练一次' });
  if (!['completed', 'abandoned'].includes(run.status)) actions.push({ action: 'abandon', enabled: true, label: '结束学习' });
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    templateVersion: run.templateVersion,
    policyVersion: run.policyVersion,
    revision: run.revision,
    status: run.status,
    scoreFingerprint: run.scoreFingerprint,
    scoreBarCount: run.scoreBarCount,
    // Set only for runs created from an existing persisted Take (flow B).
    sourceTakeId: run.sourceTakeId ?? null,
    sourceSelection: run.sourceSelection ?? null,
    createdAtIso: run.createdAtIso,
    updatedAtIso: run.updatedAtIso,
    currentStepId: run.currentStepId,
    steps: run.steps.map(({ stepRunId, kind, title, status, required, attemptCount, measureRange, hands, tempoBpm }) => ({
      stepRunId, kind, title, status, required, attemptCount,
      ...(measureRange ? { measureRange } : {}),
      ...(hands ? { hands } : {}),
      ...(Number.isFinite(tempoBpm) ? { tempoBpm } : {}),
    })),
    currentStep: current ? {
      ...cloneJson(current),
      ...(isPracticeStep ? { practiceRequest: {
        scoreFingerprint: run.scoreFingerprint,
        scoreBarCount: run.scoreBarCount,
        modeId: 'score',
        advanceMode: 'timeline',
        tempo: current.tempoBpm ?? run.config.bpm,
        hand: current.hands ?? run.config.hand,
        feedback: run.config.feedback,
        profile: run.config.profile,
        durationPolicy: run.config.durationPolicy,
        // In this app loopEnabled selects the configured A–B range; it does not
        // promise multiple automatic passes. Enable it for any partial range.
        loopEnabled: current.kind === 'focused_practice'
          || range.startMeasure > 1 || range.endMeasure < run.scoreBarCount,
        loopStartBar: range.startMeasure,
        loopEndBar: range.endMeasure,
      } } : {}),
    } : null,
    availableActions: actions,
    takeRefs: run.takeRefs.map(ref => ({ ...ref })),
    decisions: run.decisions.map(decision => ({ ...decision })),
    latestDecision: latestDecisionOf(run),
  };
}

function currentStep(run) {
  return run.steps.find(step => step.stepRunId === run.currentStepId) ?? null;
}

/** Public DTOs always carry the run's most recent decision, so create/get and
 * applyAction stay consistent for UI consumers. */
function latestDecisionOf(run) {
  return run.decisions.length ? cloneJson(run.decisions[run.decisions.length - 1]) : null;
}

function moveToNextStep(run) {
  const index = run.steps.findIndex(step => step.stepRunId === run.currentStepId);
  for (let i = index + 1; i < run.steps.length; i += 1) {
    if (run.steps[i].status !== 'completed' && run.steps[i].status !== 'skipped') {
      run.currentStepId = run.steps[i].stepRunId;
      run.steps[i].status = 'ready';
      return;
    }
  }
  run.currentStepId = null;
  run.status = 'completed';
}

function buildDecision({ run, take, result, nowIso, index }) {
  const candidate = result.candidate;
  const decision = {
    decisionId: `decision-${randomUUID()}`,
    policyVersion: TEACHING_POLICY_VERSION,
    sourceTakeId: take.takeId,
    sourceScoreFingerprint: take.score?.scoreFingerprint ?? null,
    stepRunId: run.currentStepId,
    action: result.action,
    reasonCode: result.reasonCode,
    reason: result.reason,
    evidenceRefs: candidate?.evidence ?? [],
    createdAtIso: nowIso,
  };
  if (candidate) {
    const originalBpm = run.steps[index].tempoBpm ?? run.config.bpm;
    const suggestedBpm = roundBpm(originalBpm * candidate.factor);
    decision.prescription = {
      prescriptionId: `rx-${take.takeId}-${candidate.ruleId}-${candidate.range.startMeasure}-${candidate.range.endMeasure}`,
      sourceTakeId: take.takeId,
      sourceReportId: take.legacy?.sessionId ?? take.takeId,
      sourceScoreFingerprint: take.score?.scoreFingerprint ?? null,
      ruleId: candidate.ruleId,
      problemType: candidate.problemType,
      confidenceStatus: candidate.confidence,
      measureRange: candidate.range,
      recommendedBpm: suggestedBpm,
      recommendedHand: run.steps[index].hands ?? run.config.hand,
      recommendedMode: 'loop',
      reason: candidate.reason,
      action: `${candidate.action}；建议 ${suggestedBpm} BPM。此处循环配置需由调用方按现有产品语义执行。`,
      status: 'EXECUTABLE',
      evidence: candidate.evidence,
      createdAtIso: nowIso,
    };
  }
  return decision;
}

export class TeachingOrchestrator {
  #dir;
  #fs;
  #readTake;
  #now;
  #id;

  constructor({ dir, readTake, fsImpl = fs, now = () => new Date().toISOString(), id = () => `lesson-${randomUUID()}` } = {}) {
    if (typeof dir !== 'string' || !dir) throw new Error('TeachingOrchestrator: dir is required');
    if (typeof readTake !== 'function') throw new Error('TeachingOrchestrator: readTake callback is required');
    this.#dir = dir;
    this.#readTake = readTake;
    this.#fs = fsImpl;
    this.#now = now;
    this.#id = id;
    this.#fs.mkdirSync(this.#dir, { recursive: true });
  }

  #file(runId) {
    return path.join(this.#dir, `${requireId(runId, 'runId')}.json`);
  }

  #read(runId) {
    const file = this.#file(runId);
    if (!this.#fs.existsSync(file)) return null;
    try {
      const value = JSON.parse(this.#fs.readFileSync(file, 'utf8'));
      if (value?.schemaVersion !== TEACHING_RUN_SCHEMA_VERSION || value.runId !== runId
        || !Array.isArray(value.steps) || !Array.isArray(value.takeRefs)) return null;
      return value;
    } catch {
      return null;
    }
  }

  #write(run) {
    const file = this.#file(run.runId);
    const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    let fd;
    try {
      fd = this.#fs.openSync(tmp, 'w');
      this.#fs.writeFileSync(fd, JSON.stringify(run, null, 2), 'utf8');
      this.#fs.fsyncSync(fd);
      this.#fs.closeSync(fd);
      fd = undefined;
      this.#fs.renameSync(tmp, file);
    } catch (error) {
      if (fd !== undefined) {
        try { this.#fs.closeSync(fd); } catch { /* best effort */ }
      }
      try { this.#fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw new TeachingOrchestratorError('TEACHING_PERSISTENCE_FAILED', '教学进度保存失败，请重试当前操作。', 500);
    }
  }

  createRun(input) {
    const config = normalizeCreateInput(input);
    const now = this.#now();
    const runId = requireId(this.#id(), 'runId');
    if (this.#fs.existsSync(this.#file(runId))) throw new TeachingOrchestratorError('RUN_ID_CONFLICT', '教学流程 ID 已存在', 409);
    const steps = initialSteps(config);
    const run = {
      schemaVersion: TEACHING_RUN_SCHEMA_VERSION,
      runId,
      templateVersion: 'guided-score-v1',
      policyVersion: TEACHING_POLICY_VERSION,
      revision: 0,
      status: 'ready',
      scoreFingerprint: config.scoreFingerprint,
      scoreBarCount: config.scoreBarCount,
      config,
      steps,
      currentStepId: steps[0].stepRunId,
      takeRefs: [],
      decisions: [],
      appliedCommands: [],
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.#write(run);
    return toPublicRun(run);
  }

  getRun(runId) {
    const run = this.#read(runId);
    if (!run) throw new TeachingOrchestratorError('TEACHING_RUN_NOT_FOUND', '教学流程不存在', 404);
    return toPublicRun(run);
  }

  /**
   * Starts a lesson from an ALREADY-PERSISTED Take (flow B). The browser only
   * sends the takeId and user intent; the diagnosis comes from this Node's own
   * read of the Take store via the same findRemediation used by record-take.
   * Never accepts a client-provided report/diagnostic/prescription.
   */
  createRunFromTake(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TeachingOrchestratorError('INVALID_INPUT', '创建教学流程的请求必须是对象');
    }
    const takeId = requireId(input.takeId, 'takeId');
    const take = this.#readTake(takeId);
    if (!take || take.takeId !== takeId) {
      throw new TeachingOrchestratorError('TAKE_NOT_FOUND', '找不到已持久化的来源 Take', 404);
    }
    if (take.assessment?.persistenceStatus
      && take.assessment.persistenceStatus !== 'persisted') {
      throw new TeachingOrchestratorError(
        'TAKE_NOT_PERSISTED',
        '来源 Take 尚未成功落盘，不能据此开始教学。',
        409,
      );
    }
    const fingerprint = take.score?.scoreFingerprint ?? null;
    if (!fingerprint) {
      throw new TeachingOrchestratorError('SCORE_FINGERPRINT_MISSING', '来源 Take 缺少曲谱指纹，无法绑定教学流程。', 409);
    }
    if (typeof input.scoreFingerprint === 'string' && input.scoreFingerprint.trim()
      && input.scoreFingerprint.trim() !== fingerprint) {
      throw new TeachingOrchestratorError('SCORE_FINGERPRINT_MISMATCH', '来源 Take 与当前曲谱不一致，不能开始教学。', 409);
    }

    const sourceReport = isReport(take.assessment?.timelineReport?.scoreV1)
      ? take.assessment.timelineReport.scoreV1
      : null;
    const fallbackBarCount = Math.max(1, safeMaxMeasure(sourceReport, 10000));
    const scoreBarCount = requireInt(input.scoreBarCount ?? fallbackBarCount, 1, 10000, 'scoreBarCount');

    // The strategy reads the take; the run is created at the source range so
    // the diagnosis lands on a guided step covering it. This path skips the
    // study/demonstrate prologue: the learner came here with a concrete take.
    const config = normalizeCreateInput({
      scoreFingerprint: fingerprint,
      scoreBarCount,
      bpm: input.bpm,
      hand: input.hand,
      startMeasure: input.startMeasure,
      endMeasure: input.endMeasure,
      goal: input.goal,
      referenceAvailable: input.referenceAvailable === true,
      profile: input.profile,
      durationPolicy: input.durationPolicy,
      feedback: input.feedback,
    });

    const now = this.#now();
    const runId = requireId(this.#id(), 'runId');
    if (this.#fs.existsSync(this.#file(runId))) throw new TeachingOrchestratorError('RUN_ID_CONFLICT', '教学流程 ID 已存在', 409);
    const steps = initialSteps({ ...config, referenceAvailable: false });
    const run = {
      schemaVersion: TEACHING_RUN_SCHEMA_VERSION,
      runId,
      templateVersion: 'guided-score-v1',
      policyVersion: TEACHING_POLICY_VERSION,
      revision: 0,
      status: 'ready',
      scoreFingerprint: config.scoreFingerprint,
      scoreBarCount: config.scoreBarCount,
      config,
      steps,
      currentStepId: steps[0].stepRunId,
      takeRefs: [],
      decisions: [],
      appliedCommands: [],
      sourceTakeId: takeId,
      sourceSelection: input.manualRange === true ? 'user-selection' : 'take-evidence',
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.#write(run);
    return toPublicRun(run);
  }

  applyAction(runId, request) {
    const run = this.#read(runId);
    if (!run) throw new TeachingOrchestratorError('TEACHING_RUN_NOT_FOUND', '教学流程不存在', 404);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TeachingOrchestratorError('INVALID_ACTION', '教学操作请求必须是对象');
    }
    const commandId = requireId(request.commandId, 'commandId');
    if (run.appliedCommands.includes(commandId)) {
      return { ...toPublicRun(run), duplicateCommand: true };
    }
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== run.revision) {
      throw new TeachingOrchestratorError('STALE_TEACHING_REVISION', '教学进度已被更新，请刷新后重试。', 409);
    }
    if (run.status === 'completed' || run.status === 'abandoned') {
      throw new TeachingOrchestratorError('TEACHING_RUN_TERMINAL', '教学流程已经结束，不能继续操作', 409);
    }

    const action = request.action;
    const step = currentStep(run);
    const now = this.#now();

    if (action === 'begin') {
      if (run.status !== 'ready' || !step || step.status !== 'ready') {
        throw new TeachingOrchestratorError('INVALID_TEACHING_TRANSITION', '当前状态不能开始教学流程', 409);
      }
      run.status = 'in_progress';
      step.status = 'active';
    } else if (action === 'complete-step') {
      if (run.status !== 'in_progress' || !step || step.status !== 'active'
        || ['guided_practice', 'focused_practice', 'independent_performance'].includes(step.kind)) {
        throw new TeachingOrchestratorError('INVALID_TEACHING_TRANSITION', '当前步骤不能通过此操作完成', 409);
      }
      step.status = 'completed';
      moveToNextStep(run);
      const next = currentStep(run);
      if (next && next.status === 'ready') next.status = 'active';
    } else if (action === 'skip-step') {
      if (!step || step.required || step.status === 'completed' || step.status === 'skipped') {
        throw new TeachingOrchestratorError('STEP_NOT_SKIPPABLE', '当前步骤不能跳过', 409);
      }
      step.status = 'skipped';
      moveToNextStep(run);
      const next = currentStep(run);
      if (next && next.status === 'ready' && run.status === 'in_progress') next.status = 'active';
    } else if (action === 'record-take') {
      if (run.status !== 'in_progress' || !step || step.status !== 'active'
        || !['guided_practice', 'focused_practice', 'independent_performance'].includes(step.kind)) {
        throw new TeachingOrchestratorError('INVALID_TEACHING_TRANSITION', '当前步骤不接受演奏结果', 409);
      }
      const takeId = requireId(request.takeId, 'takeId');
      const take = this.#readTake(takeId);
      if (!take || take.takeId !== takeId) {
        throw new TeachingOrchestratorError('TAKE_NOT_FOUND', '找不到已持久化的来源 Take', 404);
      }
      if (take.assessment?.persistenceStatus
        && take.assessment.persistenceStatus !== 'persisted') {
        throw new TeachingOrchestratorError(
          'TAKE_NOT_PERSISTED',
          '来源 Take 尚未成功落盘，不能据此推进教学。',
          409,
        );
      }
      const takeFingerprint = take.score?.scoreFingerprint ?? null;
      if (!takeFingerprint || takeFingerprint !== run.scoreFingerprint) {
        throw new TeachingOrchestratorError('SCORE_FINGERPRINT_MISMATCH', 'Take 使用的曲谱与本堂课不一致，不能推进教学。', 409);
      }
      if (run.takeRefs.some(item => item.takeId === takeId)) {
        // A Take is attached to at most one attempt in this run. Reusing the
        // same immutable Take is idempotent but cannot produce a second decision.
        // The existing decision is already in run.decisions, so the DTO's
        // latestDecision keeps pointing at it.
      } else {
        run.takeRefs.push({ takeId, stepRunId: step.stepRunId, addedAtIso: now });
        step.attemptCount += 1;
        const result = findRemediation(take, run);
        const decision = buildDecision({ run, take, result, nowIso: now, index: run.steps.indexOf(step) });
        run.decisions.push(decision);
        if (result.action === 'check_input' || result.action === 'collect_more_evidence') {
          step.status = 'ready';
          run.status = 'awaiting_evidence';
          // Keep the same step active only after the UI confirms retry.
          step.instruction = result.reason;
        } else if (result.action === 'focus_range' && result.candidate) {
          if (step.kind === 'focused_practice') {
            // Do not loop silently forever. Permit two guided remediation
            // iterations, then return control to the learner with a manual choice.
            if (step.attemptCount <= 2) {
              step.status = 'ready';
              step.tempoBpm = decision.prescription.recommendedBpm;
              step.instruction = `${result.reason} 再慢练一次；若仍未改善，请改选更短片段或查看详细报告。`;
              run.status = 'awaiting_evidence';
            } else {
              step.status = 'ready';
              step.instruction = `${result.reason} 已连续尝试多次，请手动选择更短片段或结束本次教学，不再自动降速。`;
              run.status = 'awaiting_evidence';
              decision.action = 'ask_learner';
              decision.reasonCode = 'REMEDIATION_LIMIT_REACHED';
              decision.reason = step.instruction;
            }
          } else {
            // Add a single focused step before the independent transfer test.
            const focusId = `focus-${result.candidate.ruleId.toLowerCase()}-${result.candidate.range.startMeasure}-${result.candidate.range.endMeasure}`;
            const existing = run.steps.find(item => item.stepRunId === focusId);
            if (!existing) {
              const focus = makeStep({
                id: focusId,
                kind: 'focused_practice',
                title: `针对性练习：${problemLabel(result.candidate.problemType)}`,
                instruction: result.reason,
                range: result.candidate.range,
                hands: step.hands ?? run.config.hand,
                bpm: decision.prescription.recommendedBpm,
              });
              const independentIndex = run.steps.findIndex(item => item.kind === 'independent_performance');
              run.steps.splice(independentIndex < 0 ? run.steps.length : independentIndex, 0, focus);
            }
            // A failed guided attempt is complete as a diagnostic sample. A failed
            // independent transfer test remains pending so it must be attempted
            // again after remediation rather than being silently skipped.
            step.status = step.kind === 'independent_performance' ? 'ready' : 'completed';
            run.currentStepId = existing?.stepRunId ?? focusId;
            run.steps.find(item => item.stepRunId === run.currentStepId).status = 'active';
          }
        } else {
          step.status = 'completed';
          if (step.kind === 'independent_performance') {
            run.status = 'completed';
            run.currentStepId = null;
          } else {
            moveToNextStep(run);
            const next = currentStep(run);
            if (next) next.status = 'active';
          }
        }
      }
    } else if (action === 'retry-current-step') {
      if (run.status !== 'awaiting_evidence' || !step || step.status !== 'ready') {
        throw new TeachingOrchestratorError('INVALID_TEACHING_TRANSITION', '当前状态不能重试', 409);
      }
      run.status = 'in_progress';
      step.status = 'active';
    } else if (action === 'abandon') {
      run.status = 'abandoned';
      run.currentStepId = null;
      if (step && !['completed', 'skipped'].includes(step.status)) step.status = 'skipped';
    } else {
      throw new TeachingOrchestratorError('UNKNOWN_TEACHING_ACTION', `未知教学操作：${String(action)}`);
    }

    run.revision += 1;
    run.updatedAtIso = now;
    run.appliedCommands.push(commandId);
    if (run.appliedCommands.length > MAX_COMMAND_RECEIPTS) {
      run.appliedCommands.splice(0, run.appliedCommands.length - MAX_COMMAND_RECEIPTS);
    }
    this.#write(run);
    const dto = toPublicRun(run);
    return dto;
  }
}

function problemLabel(type) {
  const labels = {
    'missing-notes': '漏音',
    'pitch-errors': '错音',
    'extra-notes': '额外音',
    duration: '按键时值',
    'local-onset': '局部节奏',
  };
  return labels[type] ?? '薄弱片段';
}
