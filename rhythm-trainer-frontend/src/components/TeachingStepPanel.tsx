// Teacher panel for the current LessonRun: explanation, evidence-backed
// feedback, and the single primary action. Presentation only — actions,
// practice config, ranges and diagnoses all come from the server run. No
// local teaching rule is evaluated here.

import type {
  TeachingActionName,
  TeachingDecision,
  TeachingLessonView,
  TeachingRunDTO,
  TeachingStep,
} from '../services/teachingRunRepository';

const KIND_CN: Record<TeachingStep['kind'], string> = {
  study_score: '读谱',
  demonstrate: '示范',
  guided_practice: '带练',
  focused_practice: '针对性练习',
  independent_performance: '独立演奏',
};

const DECISION_ACTION_CN: Record<TeachingDecision['action'], string> = {
  focus_range: '针对薄弱片段再练一次',
  check_input: '先检查输入',
  collect_more_evidence: '证据不足，暂不下结论',
  advance: '可以进入下一步',
  ask_learner: '请你来决定下一步',
};

const PROBLEM_CN: Record<string, string> = {
  'missing-notes': '漏音',
  'pitch-errors': '错音',
  'extra-notes': '额外音',
  duration: '按键时值',
  'local-onset': '局部节奏',
};

const CONFIDENCE_CN: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
  'not-assessable': '不可评估',
};

function fmtRange(range: { startMeasure: number; endMeasure: number }): string {
  return range.startMeasure === range.endMeasure
    ? `第 ${range.startMeasure} 小节`
    : `第 ${range.startMeasure}–${range.endMeasure} 小节`;
}

function handLabel(hand: 'left' | 'right' | 'both' | null | undefined): string {
  return hand === 'left' ? '左手' : hand === 'right' ? '右手' : '双手';
}

interface Props {
  run: TeachingRunDTO;
  fingerprintMatch: boolean;
  busyAction: TeachingActionName | null;
  error: string | null;
  onAction: (action: TeachingActionName) => void;
  /** Only rendered for practice steps with a Node-authored practiceRequest. */
  onStartPractice: () => void;
  /**
   * Why the practice step cannot start right now (score without engine data,
   * unconfirmed hand mapping, another practice in progress). Null = ready.
   */
  practiceStartBlock?: string | null;
  /** Present when a practice Take exists and needs to be handed to the server. */
  takePending: { takeId: string; persisted: boolean; status: string } | null;
  onRestart: () => void;
  onExit: () => void;
}

export default function TeachingStepPanel({
  run,
  fingerprintMatch,
  busyAction,
  error,
  onAction,
  onStartPractice,
  practiceStartBlock = null,
  takePending,
  onRestart,
  onExit,
}: Props) {
  const step = run.currentStep;
  const lesson: TeachingLessonView | null = run.lesson ?? null;
  const decision = run.latestDecision;
  const practiceStep = !!step && ['guided_practice', 'focused_practice', 'independent_performance'].includes(step.kind);
  const isBusy = busyAction !== null;
  const actionEnabled = (action: TeachingActionName) =>
    !isBusy && run.availableActions.some((item) => item.action === action && item.enabled);
  const terminal = run.status === 'completed' || run.status === 'abandoned';
  const waitForTake = !!takePending && !takePending.persisted;

  const explanation = step?.kind === 'study_score' && lesson ? lesson.explainScript : null;
  const coaching = step && lesson ? lesson.coachingByStepId[step.stepRunId]?.coaching ?? null : null;

  // Exactly one primary action: practice start when the step is runnable,
  // otherwise the first server-allowed action that advances the lesson.
  const serverActions = run.availableActions.filter((item) => item.action !== 'abandon');
  const canStartPractice = practiceStep && !!step?.practiceRequest && !practiceStartBlock && !waitForTake;
  const serverPrimary = serverActions.find((item) => actionEnabled(item.action)) ?? null;
  const primary = canStartPractice
    ? { kind: 'practice' as const, label: '开始这一步的练习', disabled: !fingerprintMatch || isBusy }
    : serverPrimary
      ? { kind: 'server' as const, action: serverPrimary.action, label: serverPrimary.label, disabled: !actionEnabled(serverPrimary.action) }
      : null;
  const secondary = serverActions.filter((item) => !primary || primary.kind !== 'server' || item.action !== primary.action);
  const canAbandon = run.availableActions.some((item) => item.action === 'abandon');

  return (
    <section className="teaching-coach" aria-label="老师讲解与反馈">
      <div className="teaching-coach-scroll">
        <div className="teaching-coach-head">
          <div>
            <div className="eyebrow">TEACHER</div>
            <h2>{step?.title ?? lesson?.title ?? '自由带练'}</h2>
            {lesson && step?.kind === 'study_score' && (
              <p className="teaching-coach-sub">{lesson.description}</p>
            )}
          </div>
          <span className={`teaching-status-pill status-${run.status}`}>
            {run.status === 'ready' ? '准备开始'
              : run.status === 'in_progress' ? '进行中'
                : run.status === 'awaiting_evidence' ? '等待演奏结果'
                  : run.status === 'completed' ? '课程已完成' : '已结束'}
          </span>
        </div>

        {!fingerprintMatch && (
          <p className="report-warning" role="status">
            当前打开的曲谱与本课程不一致。请先打开原曲谱再开始本步骤的练习，否则无法创建计划。
          </p>
        )}

        {step && !terminal && (
          <div className="teacher-block teacher-explain" aria-label="老师讲解">
            <div className="teacher-block-head">
              <span className="teacher-badge">{step.kind === 'study_score' ? '讲解' : KIND_CN[step.kind]}</span>
              <h3>{step.title}</h3>
            </div>
            {!explanation && step.kind !== 'focused_practice' && <p className="teacher-lead">{step.instruction}</p>}
            {explanation && (
              <>
                <p className="teacher-body">{explanation.explanation}</p>
                {explanation.prompts.length > 0 && (
                  <ul className="teacher-points">
                    {explanation.prompts.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                )}
                {explanation.successCriteria.length > 0 && (
                  <div className="teacher-criteria">
                    <strong>过关标准</strong>
                    <ul>
                      {explanation.successCriteria.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}
            {!explanation && coaching && <p className="teacher-body">{coaching}</p>}
            {step.measureRange && (
              <p className="teaching-range">
                本阶段 {fmtRange(step.measureRange)} · {handLabel(step.hands)}
                {step.tempoBpm ? ` · ${step.tempoBpm} BPM` : ''}
                {step.practiceRequest?.loopEnabled ? ' · 循环只表示选定范围，每次练习都是新的 Take' : ''}
              </p>
            )}
          </div>
        )}

        {terminal && (
          <div className="teacher-block teacher-complete" role="status">
            <h3>{run.status === 'completed' ? '课程已完成' : '本次学习已结束'}</h3>
            <p>
              完成表示当前范围内的练习流程走完，不代表已经掌握。可以复述一遍要点，再开始一段新的练习。
            </p>
            {decision?.transfer && (
              <p className="teacher-note">
                迁移检查：{decision.transfer.status === 'not-executed' ? '未执行' : decision.transfer.status}
                {decision.transfer.note ? ` — ${decision.transfer.note}` : ''}
              </p>
            )}
            {decision?.reviewSuggestion && (
              <p className="teacher-note">
                复习建议：{decision.reviewSuggestion.trigger}
                {decision.reviewSuggestion.suggestedIntervalDays.length > 0
                  ? `（间隔 ${decision.reviewSuggestion.suggestedIntervalDays.join(' / ')} 天）`
                  : ''}
              </p>
            )}
          </div>
        )}

        {decision ? (
          <div className="teacher-block teacher-feedback" aria-label="老师反馈">
            <div className="teacher-block-head">
              <span className="teacher-badge feedback">反馈</span>
              <h3>{DECISION_ACTION_CN[decision.action] ?? decision.action}</h3>
              <small className="teacher-source">来自 Take {decision.sourceTakeId.slice(0, 13)}…</small>
            </div>

            <div className="teacher-feedback-section good">
              <h4>做得好</h4>
              {(decision.highlights ?? []).length > 0 ? (
                <ul className="teacher-evidence-list">
                  {(decision.highlights ?? []).map((ref, index) => (
                    <li key={`good-${ref.metric}-${index}`}>
                      {ref.measure != null && <b>第 {ref.measure} 小节</b>}
                      {ref.measure == null && <b>本次演奏</b>}
                      {ref.detail ? <span> {ref.detail}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="teacher-muted">这次没有足够可靠的证据做正面评价，老师不编造结论。</p>
              )}
            </div>

            <div className="teacher-feedback-section fix">
              <h4>{decision.prescription ? '一处要改' : decision.action === 'advance' ? '这一阶段' : '这次先不改'}</h4>
              {decision.prescription ? (
                <>
                  <p>{decision.learnerFeedback?.message ?? decision.prescription.reason}</p>
                  <p className="teaching-prescription">
                    {PROBLEM_CN[decision.prescription.problemType] ?? decision.prescription.problemType}
                    {' · '}{fmtRange(decision.prescription.measureRange)}
                    {' · 建议 '}{decision.prescription.recommendedBpm} BPM
                    {' · 证据置信 '}{CONFIDENCE_CN[decision.prescription.confidenceStatus] ?? decision.prescription.confidenceStatus}
                  </p>
                </>
              ) : decision.action === 'advance' ? (
                <p>{decision.learnerFeedback?.message ?? '这一阶段没有达到教学规则门槛的遗留问题。'}</p>
              ) : (
                <p>{decision.learnerFeedback?.message ?? decision.reason}</p>
              )}
            </div>

            <div className="teacher-feedback-section next">
              <h4>下一步</h4>
              <p>
                {decision.learnerFeedback?.nextAction
                  ?? decision.prescription?.action
                  ?? decision.reason}
              </p>
              {run.status === 'awaiting_evidence' && (
                <p className="teacher-muted">重新演奏本阶段后，老师会根据新的 Take 再判断；不会沿用旧结论。</p>
              )}
            </div>

            <details className="teaching-evidence">
              <summary>证据详情（{decision.evidenceRefs.length} 条）</summary>
              {decision.evidenceRefs.length > 0 ? (
                <ul>
                  {decision.evidenceRefs.map((ref, index) => (
                    <li key={`${ref.metric}-${index}`}>
                      <b>{ref.metric}</b>
                      {ref.measure != null && <span> 第 {ref.measure} 小节</span>}
                      {ref.value != null && <em> {typeof ref.value === 'number' ? ref.value.toFixed(1) : ref.value}</em>}
                      {ref.detail && <small> {ref.detail}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="teacher-muted">本次没有可用于定位问题的逐小节证据。</p>
              )}
            </details>
          </div>
        ) : step && !terminal ? (
          <div className="teacher-block teacher-feedback" aria-label="老师反馈">
            <div className="teacher-block-head">
              <span className="teacher-badge feedback">反馈</span>
              <h3>还没有这次演奏的结果</h3>
            </div>
            <p className="teacher-muted">
              老师只根据已保存的 Take 说话。按下面的主按钮开始本阶段练习；演奏结束后会先保存，
              再自动登记到课程并生成反馈。
            </p>
          </div>
        ) : null}
      </div>

      <div className="teaching-action-bar" aria-label="主要操作">
        {takePending && (
          <p className={takePending.persisted ? 'teaching-action-note' : 'report-warning'} role="status">
            {takePending.persisted
              ? `最近一次演奏已保存（Take ${takePending.takeId.slice(0, 13)}…），正在登记到课程…`
              : `最近一次演奏尚未成功保存（${takePending.status}），课程暂不能推进。请保留页面并重试保存。`}
          </p>
        )}
        {practiceStartBlock && practiceStep && (
          <p className="report-warning" role="status">暂时无法开始这一步：{practiceStartBlock}</p>
        )}
        {error && <p className="report-warning" role="alert">{error}</p>}
        <div className="teaching-action-row">
          {terminal ? (
            <button type="button" className="button button-primary teaching-primary-action" onClick={onRestart}>
              开始新课程
            </button>
          ) : primary ? (
            <button
              type="button"
              className="button button-primary teaching-primary-action"
              disabled={primary.kind === 'server' ? primary.disabled : primary.disabled}
              onClick={() => {
                if (primary.kind === 'practice') onStartPractice();
                else onAction(primary.action);
              }}
            >
              {busyAction ? '处理中…' : primary.label}
            </button>
          ) : (
            <button type="button" className="button button-primary teaching-primary-action" onClick={onExit}>
              返回自由练习
            </button>
          )}
          <div className="teaching-action-links">
            {secondary.map((item) => (
              <button
                key={item.action}
                type="button"
                className="text-button"
                disabled={!actionEnabled(item.action)}
                onClick={() => onAction(item.action)}
              >
                {busyAction === item.action ? '处理中…' : item.label}
              </button>
            ))}
            {canAbandon && !terminal && (
              <button type="button" className="text-button" disabled={isBusy} onClick={() => onAction('abandon')}>
                结束学习
              </button>
            )}
            {terminal && (
              <button type="button" className="text-button" onClick={onExit}>返回自由练习</button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
