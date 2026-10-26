// Current teaching step + decision rendering. This component is deliberately
// presentation-only: every action it can offer comes from the server run's
// `availableActions`, and the practice request it displays is the one Node
// authored. No local diagnosis, BPM choice or step legality is computed here.

import type {
  TeachingDecision,
  TeachingRunDTO,
  TeachingStep,
} from '../services/teachingRunRepository';
import type { TeachingActionName } from '../services/teachingRunRepository';

const STATUS_CN: Record<TeachingRunDTO['status'], string> = {
  ready: '准备开始',
  in_progress: '学习中',
  awaiting_evidence: '等待更多证据',
  completed: '课程已完成',
  abandoned: '已结束学习',
};

const KIND_CN: Record<TeachingStep['kind'], string> = {
  study_score: '读谱',
  demonstrate: '示范',
  guided_practice: '带练',
  focused_practice: '针对性练习',
  independent_performance: '独立演奏',
};

const DECISION_ACTION_CN: Record<TeachingDecision['action'], string> = {
  focus_range: '建议针对薄弱片段练习',
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

function fmtFingerprint(fingerprint: string | null | undefined): string {
  return fingerprint ? `${fingerprint.slice(0, 12)}…` : '—';
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
  onBackToWorkbench: () => void;
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
  onBackToWorkbench,
}: Props) {
  const step = run.currentStep;
  const practiceStep = step && ['guided_practice', 'focused_practice', 'independent_performance'].includes(step.kind);
  const completedSteps = run.steps.filter((item) => item.status === 'completed' || item.status === 'skipped').length;
  const decision = run.latestDecision;
  const isBusy = busyAction !== null;
  const actionEnabled = (action: TeachingActionName) =>
    !isBusy && run.availableActions.some((item) => item.action === action && item.enabled);

  return (
    <section className="card teaching-card" aria-label="教学工作区">
      <div className="card-heading">
        <div>
          <div className="eyebrow">TEACHING WORKSPACE</div>
          <h3>老师带练 · <span className={run.status === 'completed' ? 'text-good' : ''}>{STATUS_CN[run.status]}</span></h3>
        </div>
        <button type="button" className="text-button" onClick={onBackToWorkbench}>返回练习工作台</button>
      </div>

      <div className="teaching-meta">
        <span>进度 {completedSteps}/{run.steps.length}</span>
        <span>课程 {run.runId.slice(0, 13)}…</span>
        <span>曲谱指纹 {fmtFingerprint(run.scoreFingerprint)}{fingerprintMatch ? '' : '（与当前打开曲谱不一致）'}</span>
        {run.sourceTakeId && <span>来源 Take {run.sourceTakeId.slice(0, 13)}…</span>}
        <span>策略 {run.policyVersion} · rev {run.revision}</span>
      </div>
      {!fingerprintMatch && (
        <p className="report-warning" role="status">
          当前打开的曲谱与本课程不一致。请先打开原曲谱再开始本步骤的练习，否则无法创建计划。
        </p>
      )}

      <ol className="teaching-steps">
        {run.steps.map((item) => (
          <li
            key={item.stepRunId}
            className={[
              'teaching-step',
              item.stepRunId === run.currentStepId ? 'current' : '',
              item.status,
            ].join(' ')}
          >
            <span className="teaching-step-kind">{KIND_CN[item.kind]}</span>
            <span className="teaching-step-title">{item.title}</span>
            {!item.required && <small className="teaching-step-optional">可选</small>}
            {item.status === 'completed' && <small className="text-good">已完成</small>}
            {item.status === 'skipped' && <small>已跳过</small>}
          </li>
        ))}
      </ol>

      {step && run.status !== 'completed' && run.status !== 'abandoned' && (
        <div className="teaching-current" aria-label="当前教学步骤">
          <h4>{step.title}</h4>
          <p>{step.instruction}</p>
          {step.measureRange && (
            <p className="teaching-range">
              范围 {fmtRange(step.measureRange)}
              {step.hands ? ` · ${step.hands === 'both' ? '双手' : step.hands === 'right' ? '右手' : '左手'}` : ''}
              {step.tempoBpm ? ` · ${step.tempoBpm} BPM` : ''}
            </p>
          )}

          {practiceStep && step.practiceRequest && (
            <div className="teaching-practice" aria-label="本步练习配置">
              <span>
                将按 Node 下发的配置开始一次固定时间练习：
                {step.practiceRequest.tempo} BPM ·
                {step.practiceRequest.hand === 'both' ? '双手' : step.practiceRequest.hand === 'right' ? '右手' : '左手'} ·
                第 {step.practiceRequest.loopStartBar}–{step.practiceRequest.loopEndBar} 小节（loop 只表示选定范围，一次练习）
              </span>
              {practiceStartBlock ? (
                <p className="report-warning" role="status">
                  暂时无法开始这一步：{practiceStartBlock}
                </p>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={!fingerprintMatch || isBusy}
                  onClick={onStartPractice}
                >
                  开始这一步的练习
                </button>
              )}
            </div>
          )}

          {takePending && (
            <p className="report-warning" role="status">
              {takePending.persisted
                ? `最近一次演奏已保存（Take ${takePending.takeId.slice(0, 13)}…），正在登记到课程…`
                : `最近一次演奏尚未成功保存（${takePending.status}），课程暂不能推进。请保留页面并重试保存。`}
            </p>
          )}
        </div>
      )}

      {run.status === 'completed' && (
        <p className="teaching-complete" role="status">
          本课程的必需步骤已完成。完成表示当前范围内的练习流程走完，不代表已经掌握；可以开始新课程继续巩固。
        </p>
      )}

      {decision && (
        <div className="teaching-decision" aria-label="最近教学决策">
          <h4>{DECISION_ACTION_CN[decision.action] ?? decision.action}</h4>
          <p>{decision.reason}</p>
          {decision.prescription && (
            <p className="teaching-prescription">
              {PROBLEM_CN[decision.prescription.problemType] ?? decision.prescription.problemType} ·
              {' '}{fmtRange(decision.prescription.measureRange)} ·
              {' '}建议 {decision.prescription.recommendedBpm} BPM ·
              {' '}证据置信 {CONFIDENCE_CN[decision.prescription.confidenceStatus] ?? decision.prescription.confidenceStatus}
            </p>
          )}
          <details className="teaching-evidence">
            <summary>证据详情（{decision.evidenceRefs.length} 条）</summary>
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
          </details>
        </div>
      )}

      <div className="teaching-actions" aria-label="可用操作">
        {run.availableActions.map((action) => (
          <button
            key={action.action}
            type="button"
            className={action.action === 'begin' || action.action === 'retry-current-step' ? 'button button-primary' : 'button button-outline'}
            disabled={!actionEnabled(action.action)}
            onClick={() => onAction(action.action)}
          >
            {busyAction === action.action ? '处理中…' : action.label}
          </button>
        ))}
      </div>

      {error && <p className="report-warning" role="alert">{error}</p>}
    </section>
  );
}
