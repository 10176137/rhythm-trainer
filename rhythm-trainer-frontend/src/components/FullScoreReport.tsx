import type {
  EngineScoringConfig,
  EngineScoreStatus,
  EngineSessionScoreReport,
} from '../types/engine';
import type { RetryComparison } from '../types/teaching';

interface Props {
  scoreV1?: EngineSessionScoreReport | { error: string } | null;
  scoreStatus?: EngineScoreStatus | null;
  scoringConfig?: EngineScoringConfig | null;
  scoreConfigVersion?: string | null;
  scoreAlgorithmVersion?: string | null;
  scoreInputNoteCount?: number;
  scoreUnmappedNoteCount?: number;
  pauseAdjusted?: boolean;
  retryComparison?: RetryComparison | null;
}

const SCORE_STATUS_CN: Record<string, string> = {
  AVAILABLE: '完整评分可用',
  DEGRADED: '数据降级',
  INSUFFICIENT_DATA: '数据不足',
  UNAVAILABLE: '完整评分不可用',
  INVALID: '评分输入无效',
};

const CONFIDENCE_CN: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
  'not-assessable': '不可评估',
};

const EVENT_RESULT_CN: Record<string, string> = {
  MATCH: '匹配',
  WRONG_PITCH: '错音',
  MISSING: '漏音',
  EXTRA: '额外音',
  AMBIGUOUS: '不确定',
};

const fmtMs = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : `${value.toFixed(digits)}ms`;
const fmtPct = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
const fmtRatio = (value: number | null | undefined, digits = 3) =>
  value == null ? '—' : value.toFixed(digits);

/**
 * B1 presentation for the Rust scoring_v1 report. It only renders fields that
 * actually came back from the core; unavailable metrics are never rendered as
 * zero, and the Overall score is withheld for degraded/renormalized reports.
 */
export default function FullScoreReport({
  scoreV1,
  scoreStatus,
  scoringConfig,
  scoreConfigVersion,
  scoreAlgorithmVersion,
  scoreInputNoteCount = 0,
  scoreUnmappedNoteCount = 0,
  pauseAdjusted = false,
  retryComparison = null,
}: Props) {
  const scoreReport = scoreV1 && !('error' in scoreV1) ? scoreV1 : null;
  const scoreError = scoreV1 && 'error' in scoreV1 ? scoreV1.error : null;
  const status = scoreStatus ?? (scoreReport ? 'AVAILABLE' : 'UNAVAILABLE');
  const overallAvailable = status === 'AVAILABLE'
    && scoreReport?.overall.score != null
    && !scoreReport.overall.renormalized;

  if (!scoreReport) {
    return (
      <section className="score-full-report" aria-label="完整评分">
        <div className="score-report-head">
          <div>
            <div className="eyebrow">RUST SCORING_V1</div>
            <h4>完整评分</h4>
          </div>
          <span className={`score-status score-status-${status.toLowerCase()}`}>{SCORE_STATUS_CN[status] ?? status}</span>
        </div>
        <div className="score-report-unavailable">
          <strong>{scoreError ? '完整评分未生成' : SCORE_STATUS_CN[status] ?? '完整评分不可用'}</strong>
          <p>
            {scoreError
              ? scoreError
              : status === 'UNAVAILABLE'
                ? '本轮没有可用的完整评分目标（或当前模式不生成完整评分）；不显示 0 分或占位综合分。'
                : '当前报告没有保存完整评分结果；下方节奏/时长摘要仍来自真实引擎数据。'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="score-full-report" aria-label="完整评分">
      <div className="score-report-head">
        <div>
          <div className="eyebrow">RUST SCORING_V1</div>
          <h4>完整评分</h4>
        </div>
        <span className={`score-status score-status-${status.toLowerCase()}`}>{SCORE_STATUS_CN[status] ?? status}</span>
      </div>
      <p className="score-report-meta">
        置信度 {CONFIDENCE_CN[scoreReport.confidence] ?? scoreReport.confidence}
        {scoringConfig?.modeLabel ? ` · 模式 ${scoringConfig.modeLabel}` : ''}
        {scoringConfig ? ` · 判定 ${scoringConfig.judgmentProfile}` : ''}
        {scoringConfig ? ` · 时值策略 ${scoringConfig.durationPolicy}` : ''}
        {scoreConfigVersion ? ` · 评分配置 ${scoreConfigVersion}` : ''}
        {scoreAlgorithmVersion ? ` · 算法 ${scoreAlgorithmVersion}` : ''}
        {` · 输入 ${scoreInputNoteCount} 音`}
        {scoreUnmappedNoteCount > 0 ? ` · 未映射 ${scoreUnmappedNoteCount}` : ''}
        {pauseAdjusted ? ' · 已按暂停区间平移目标' : ''}
      </p>
      {status === 'DEGRADED' && (
        <p className="report-warning">输入或时钟质量导致本轮评分降级；分项数据可参考，但总体分不展示为完整成绩。</p>
      )}
      {status === 'INSUFFICIENT_DATA' && (
        <p className="report-warning">可用的匹配样本不足，不能把缺失数据当成 0 分或完整成绩。</p>
      )}
      <div className="score-report-grid">
        <div className="score-report-cell score-overall-cell">
          <small>Overall</small>
          <strong>{overallAvailable ? scoreReport.overall.score!.toFixed(1) : '不可用'}</strong>
          <span>
            {status !== 'AVAILABLE'
              ? '本轮不输出总体分'
              : scoreReport.overall.renormalized
                ? '部分分项缺失，未输出归一化综合分'
                : ' '}
          </span>
        </div>
        <div className="score-report-cell"><small>音高正确率</small><strong>{fmtPct(scoreReport.pitch.recall)}</strong><span>精确率 {fmtPct(scoreReport.pitch.precision)}</span></div>
        <div className="score-report-cell"><small>匹配目标</small><strong>{scoreReport.pitch.correct} / {scoreReport.pitch.targets}</strong><span>错音 {scoreReport.pitch.wrongPitch} · 漏音 {scoreReport.pitch.missed} · 额外 {scoreReport.pitch.extra}</span></div>
        <div className="score-report-cell"><small>平均起音偏差</small><strong>{fmtMs(scoreReport.onset.meanAbsoluteMs)}</strong><span>中位数 {fmtMs(scoreReport.onset.signedMedianMs)}</span></div>
        <div className="score-report-cell"><small>节奏抖动</small><strong>{fmtPct(scoreReport.rhythm.jitterRatioMad)}</strong><span>样本 {scoreReport.rhythm.intervalSamples} · 漂移 {fmtRatio(scoreReport.rhythm.driftRatioSlopePerIndex, 4)}</span></div>
        <div className="score-report-cell"><small>时值评分</small><strong>{scoreReport.duration.graded} 个</strong><span>偏短 {scoreReport.duration.tooShortCount} · 偏长 {scoreReport.duration.tooLongCount}</span></div>
        <div className="score-report-cell"><small>连续性</small><strong>{fmtPct(scoreReport.continuity.coveredRatio)}</strong><span>最长连续 {scoreReport.continuity.longestMatchedStreak} · {scoreReport.continuity.measuresWithAnyMatch}/{scoreReport.continuity.measuresTotal} 小节有匹配</span></div>
      </div>

      <div className="score-subscore-block">
        <h5>分项与权重</h5>
        <div className="score-subscore-list">
          {scoreReport.overall.subscores.map((sub) => (
            <span key={sub.name}>
              {sub.name} <b>{sub.score == null ? '不可用' : sub.score.toFixed(1)}</b>
              <small>w{sub.weight} · n{sub.sampleCount}</small>
            </span>
          ))}
        </div>
      </div>

      <div className="score-metric-block">
        <h5>音高 / 节奏 / 时值原始指标</h5>
        <p>
          音高：correct {scoreReport.pitch.correct} / wrong {scoreReport.pitch.wrongPitch} / missed {scoreReport.pitch.missed} / extra {scoreReport.pitch.extra}；
          onset：signed mean {fmtMs(scoreReport.onset.signedMeanMs)}、median {fmtMs(scoreReport.onset.signedMedianMs)}、p50 {fmtMs(scoreReport.onset.p50AbsoluteMs)}、p90 {fmtMs(scoreReport.onset.p90AbsoluteMs)}、超容差 {fmtPct(scoreReport.onset.outOfToleranceRatio)}；
          rhythm：mean speed ratio {fmtRatio(scoreReport.rhythm.meanSpeedRatio)}、jitter {fmtPct(scoreReport.rhythm.jitterRatioMad)}、补偿疑似 {scoreReport.rhythm.rhythmCompensationSuspected ? '是' : '否'}；
          duration：{scoreReport.duration.graded} 个可评分，mean ratio {fmtRatio(scoreReport.duration.meanRatio, 2)}。
        </p>
      </div>

      <div className="score-measures-block">
        <h5>小节级报告</h5>
        {scoreReport.measures.length === 0 ? <p className="report-warning">本轮没有生成可用的小节级报告。</p> : (
          <table className="score-table">
            <thead><tr><th>小节</th><th>匹配</th><th>漏音</th><th>平均起音误差</th><th>速度比</th></tr></thead>
            <tbody>
              {scoreReport.measures.slice(0, 40).map((measure) => (
                <tr key={measure.measure}>
                  <td>第 {measure.measure} 小节</td>
                  <td>{measure.matched}</td>
                  <td>{measure.missed}</td>
                  <td>{fmtMs(measure.meanAbsOnsetErrorMs)}</td>
                  <td>{fmtRatio(measure.meanSpeedRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {scoreReport.measures.length > 40 && <p className="report-footnote">仅显示前 40 个小节；完整数据在会话 JSON 中。</p>}
      </div>

      <div className="score-events-block">
        <h5>事件级结果</h5>
        <table className="score-table">
          <thead><tr><th>结果</th><th>小节</th><th>目标 / 实际</th><th>音高</th><th>起音误差</th><th>原因</th></tr></thead>
          <tbody>
            {scoreReport.eventResults.slice(0, 40).map((event, index) => (
              <tr key={`${event.result}-${event.scoreEventId ?? event.performedNoteId ?? index}`}>
                <td>{EVENT_RESULT_CN[event.result] ?? event.result}</td>
                <td>{event.measure == null ? '—' : `第 ${event.measure} 小节`}</td>
                <td>{event.scoreEventId ?? '—'} / {event.performedNoteId ?? '—'}</td>
                <td>{event.expectedPitch ?? '—'} / {event.actualPitch ?? '—'}</td>
                <td>{fmtMs(event.onsetErrorMs)}</td>
                <td>{event.reason ?? '—'}{event.pairingStatus ? ` · ${event.pairingStatus}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {scoreReport.eventResults.length > 40 && <p className="report-footnote">仅显示前 40 条事件；完整数据在会话 JSON 中。</p>}
      </div>

      {scoreReport.diagnostics.length > 0 && (
        <div className="score-diagnostics-block">
          <h5>评分诊断</h5>
          {scoreReport.diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.category}-${index}`}>
              <strong>{diagnostic.category} · {diagnostic.confidence}</strong>
              <span>{diagnostic.evidence}</span>
            </p>
          ))}
        </div>
      )}

      {scoreReport.practiceRanges.length > 0 && (
        <div className="score-diagnostics-block">
          <h5>建议练习区间</h5>
          {scoreReport.practiceRanges.map((range) => (
            <p key={`${range.startMeasure}-${range.endMeasure}-${range.priority}`}>
              <strong>第 {range.startMeasure}–{range.endMeasure} 小节 · 优先级 {range.priority}</strong>
              <span>{range.reason}</span>
            </p>
          ))}
        </div>
      )}

      {retryComparison && (
        <div className="retry-comparison" aria-label="复练前后比较">
          <h5>复练前后比较</h5>
          <p className="retry-comparison-meta">
            来源 {retryComparison.sourceReportId ?? '—'} → 复练 {retryComparison.retryReportId ?? '—'}
            {retryComparison.prescriptionId ? ` · 处方 ${retryComparison.prescriptionId}` : ''}
          </p>
          {!retryComparison.comparable ? (
            <p className="report-warning">{retryComparison.blockedReason ?? '两份报告不能直接比较。'}</p>
          ) : (
            <table className="score-table retry-comparison-table">
              <thead><tr><th>指标</th><th>原报告</th><th>复练后</th><th>变化</th></tr></thead>
              <tbody>
                {retryComparison.metrics.map((metric) => (
                  <tr key={metric.key}>
                    <td>{metric.label}</td>
                    <td>{formatComparisonValue(metric.unit, metric.before)}</td>
                    <td>{formatComparisonValue(metric.unit, metric.after)}</td>
                    <td>
                      {formatComparisonValue(metric.unit, metric.delta, true)}
                      {' '}
                      {metric.delta === 0 ? '持平' : metric.delta > 0 ? '上升' : '下降'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {retryComparison.limitations.length > 0 && (
            <ul className="retry-comparison-limits">
              {retryComparison.limitations.map((limit) => <li key={limit}>{limit}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function formatComparisonValue(unit: 'ratio' | 'ms', value: number, delta = false): string {
  const sign = delta && value > 0 ? '+' : '';
  if (unit === 'ratio') return `${sign}${(value * 100).toFixed(1)}%`;
  return `${sign}${value.toFixed(1)}ms`;
}
