// Final practice report rendered from the Rust core's deterministic replay
// result plus the rule-based coaching analysis. The UI only presents engine
// output; it never recomputes grades. v0.3 adds key-down duration assessment
// (Note Off − Note On) as a SEPARATE dimension from onset timing.

import type { EngineDurationReport, EngineReport, EngineScoringConfig, EngineScoreStatus, EngineSessionScoreReport, EngineTimingAnalysis } from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { RetryComparison } from '../types/teaching';
import FullScoreReport from './FullScoreReport';
import TargetedPracticePanel from './TargetedPracticePanel';
import type { TeachingRunDTO } from '../services/teachingRunRepository';

interface Props {
  report: EngineReport;
  analysis: EngineTimingAnalysis | { error: string } | null;
  durations?: EngineDurationReport | { error: string } | null;
  scoreV1?: EngineSessionScoreReport | { error: string } | null;
  scoreStatus?: EngineScoreStatus | null;
  scoringConfig?: EngineScoringConfig | null;
  scoreConfigVersion?: string | null;
  scoreAlgorithmVersion?: string | null;
  scoreInputNoteCount?: number;
  scoreUnmappedNoteCount?: number;
  pauseAdjusted?: boolean;
  sessionId?: string | null;
  takeId?: string | null;
  scoreFingerprint?: string | null;
  activeScoreFingerprint?: string | null;
  scoreBarCount?: number | null;
  practiceBpm?: number;
  practiceHand?: HandSelection;
  retryComparison?: RetryComparison | null;
  /** Flow B: Node accepted the from-take request and created a lesson run. */
  onTeachingRunCreated?: (run: TeachingRunDTO) => void;
  onNavigateTeaching?: () => void;
}

const ISSUE_CN: Record<string, string> = {
  global_late_bias: '整体偏晚',
  global_early_bias: '整体偏早',
  unstable_timing: '节奏不稳',
  tempo_drift: '速度漂移',
  frequent_misses: '漏击偏多',
  frequent_extras: '多击偏多',
  rest_reentry_timing: '休止后重进不稳',
  offbeat_timing: '弱拍偏差',
  measurement_untrusted: '测量不可信',
  insufficient_evidence: '样本不足',
};

const EXERCISE_CN: Record<string, string> = {
  verify_input_measurement: '先检查输入与测量链路',
  collect_more_evidence: '再收集一段干净样本',
  slow_loop_with_metronome: '慢速循环 + 每拍节拍器',
  count_subdivision: '出声数细分拍',
  rest_reentry_drill: '休止符重进专项循环',
  offbeat_subdivision_drill: '弱拍细分专项',
  controlled_attack_drill: '控制多余击打练习',
  review_event_alignment: '检查事件对齐',
};

const fmtMs = (value: number | null | undefined, digits = 1) =>
  value == null ? '—' : `${value.toFixed(digits)}ms`;

export default function ReportPanel({
  report,
  analysis,
  durations,
  scoreV1,
  scoreStatus,
  scoringConfig,
  scoreConfigVersion,
  scoreAlgorithmVersion,
  scoreInputNoteCount = 0,
  scoreUnmappedNoteCount = 0,
  pauseAdjusted = false,
  sessionId = null,
  takeId = null,
  scoreFingerprint = null,
  activeScoreFingerprint = null,
  scoreBarCount = null,
  practiceBpm = 72,
  practiceHand = 'both',
  retryComparison = null,
  onTeachingRunCreated,
  onNavigateTeaching,
}: Props) {
  const stats = report.stats;
  const cells: [string, string][] = [
    ['目标数', String(stats.targetCount)],
    ['Perfect', String(stats.perfectCount)],
    ['Good', String(stats.goodCount)],
    ['Miss', String(stats.missCount)],
    ['Extra', String(stats.extraCount)],
    ['命中率', `${Math.round((stats.targetHitRate ?? 0) * 100)}%`],
    ['平均偏差', stats.meanSignedMs == null ? '—' : `${stats.meanSignedMs.toFixed(1)}ms(正=晚)`],
    ['平均绝对偏差', fmtMs(stats.meanAbsoluteMs)],
    ['标准差', fmtMs(stats.standardDeviationMs)],
  ];

  const timing = analysis && !('error' in analysis) ? analysis : null;
  const diagnostics = timing?.report?.diagnostics ?? [];
  const prescription = timing?.prescription ?? null;
  const analysisError = analysis && 'error' in analysis ? analysis.error : null;

  // v0.3 key-down duration aggregates (only strict-keydown produces verdicts).
  const durationReport = durations && !('error' in durations) ? durations : null;
  const durationError = durations && 'error' in durations ? durations.error : null;
  const judged = durationReport?.assessments.filter((a) =>
    a.result === 'within_tolerance' || a.result === 'too_short' || a.result === 'too_long') ?? [];
  const shortCount = judged.filter((a) => a.result === 'too_short').length;
  const longCount = judged.filter((a) => a.result === 'too_long').length;
  const unknownCount = durationReport?.assessments.filter((a) => a.result === 'unknown').length ?? 0;
  const avgKeyDown = (() => {
    const values = judged.map((a) => a.actualKeyDownMs).filter((v): v is number => v != null);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  })();
  const avgDurationError = (() => {
    const values = judged.map((a) => a.durationErrorMs).filter((v): v is number => v != null);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  })();

  return (
    <section className="card report-card" aria-label="练习报告">
      <div className="card-heading">
        <div>
          <div className="eyebrow">SESSION REPORT</div>
          <h3>练习报告(引擎重放结果)</h3>
        </div>
        <span className={`badge ${report.trustworthy ? 'badge-ok' : 'badge-bad'}`}>
          {report.trustworthy ? '数据可信' : '数据不可信'}
        </span>
      </div>

      <div className="report-grid">
        {cells.map(([label, value]) => (
          <div className="report-cell" key={label}>
            <strong>{value}</strong>
            <small>{label}</small>
          </div>
        ))}
      </div>

      {!report.trustworthy && (
        <p className="report-warning">本次会话存在输入完整性或时序异常,结果仅供参考,不作为能力评估依据。</p>
      )}

      <FullScoreReport
        scoreV1={scoreV1}
        scoreStatus={scoreStatus}
        scoringConfig={scoringConfig}
        scoreConfigVersion={scoreConfigVersion}
        scoreAlgorithmVersion={scoreAlgorithmVersion}
        scoreInputNoteCount={scoreInputNoteCount}
        scoreUnmappedNoteCount={scoreUnmappedNoteCount}
        pauseAdjusted={pauseAdjusted}
        retryComparison={retryComparison}
      />

      {(scoreV1 || scoreStatus) && (
        <TargetedPracticePanel
          sourceReportId={sessionId}
          sourceTakeId={takeId}
          sourceScoreFingerprint={scoreFingerprint}
          activeScoreFingerprint={activeScoreFingerprint}
          practiceBpm={practiceBpm}
          practiceHand={practiceHand}
          scoreBarCount={scoreBarCount}
          onTeachingRunCreated={onTeachingRunCreated ?? (() => {})}
          onNavigateTeaching={onNavigateTeaching ?? (() => {})}
        />
      )}

      {analysisError && <p className="report-warning">教学分析暂不可用:{analysisError}</p>}

      {durationReport && judged.length > 0 && (
        <div className="duration-block">
          <h4>按键时长（Note Off − Note On，独立于起音判定）</h4>
          <div className="duration-summary">
            <span>合格 <b>{judged.length - shortCount - longCount}</b></span>
            <span className="dur-short">偏短 <b>{shortCount}</b>（{Math.round((shortCount / judged.length) * 100)}%）</span>
            <span className="dur-long">偏长 <b>{longCount}</b>（{Math.round((longCount / judged.length) * 100)}%）</span>
            <span>平均按键 {avgKeyDown == null ? '—' : `${Math.round(avgKeyDown)}ms`}</span>
            <span>平均时值误差 {avgDurationError == null ? '—' : `${avgDurationError > 0 ? '+' : ''}${Math.round(avgDurationError)}ms`}</span>
            {unknownCount > 0 && <span className="dur-unknown">无法评分 {unknownCount}（缺 Note Off 等）</span>}
            {(durationReport.orphanNoteOffCount > 0 || durationReport.openNoteCount > 0) && (
              <span className="dur-unknown">异常事件：孤立 Off {durationReport.orphanNoteOffCount} · 未闭合 On {durationReport.openNoteCount}</span>
            )}
          </div>
          <table className="duration-table">
            <thead><tr><th>目标</th><th>目标时值</th><th>实际按键</th><th>误差</th><th>结果</th><th>起音间隔</th></tr></thead>
            <tbody>
              {durationReport.assessments.slice(0, 12).map((a, i) => (
                <tr key={`${a.onsetSeq ?? 'x'}-${i}`}>
                  <td>{a.targetIndex != null ? `#${a.targetIndex + 1}` : '—'}{a.pitch != null ? ` · ${a.pitch}` : ''}</td>
                  <td>{a.nominalDurationMs == null ? '—' : `${Math.round(a.nominalDurationMs)}ms`}</td>
                  <td>{a.actualKeyDownMs == null ? '—' : `${Math.round(a.actualKeyDownMs)}ms`}</td>
                  <td>{a.durationErrorMs == null ? '—' : `${a.durationErrorMs > 0 ? '+' : ''}${Math.round(a.durationErrorMs)}ms`}</td>
                  <td className={a.result === 'too_short' ? 'dur-short' : a.result === 'too_long' ? 'dur-long' : ''}>
                    {a.result === 'within_tolerance' ? '合格'
                      : a.result === 'too_short' ? '偏短'
                      : a.result === 'too_long' ? '偏长'
                      : a.result === 'disabled' ? '只记录'
                      : '无法判定'}
                    {a.quality === 'overlapping_same_pitch' ? '（同音重叠）' : a.quality === 'open_note_interrupted' ? '（未松键）' : ''}
                  </td>
                  <td>{a.interOnsetIntervalMs == null ? '—' : `${Math.round(a.interOnsetIntervalMs)}ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {durationReport.assessments.length > 12 && <p className="report-footnote">仅显示前 12 条,完整数据在已保存的会话 JSON 中。</p>}
        </div>
      )}

      {durationError && <p className="report-warning">时值评估暂不可用:{durationError}</p>}

      {diagnostics.length > 0 && (
        <div className="report-coach">
          {diagnostics.map((d, i) => (
            <p key={`${d.issue}-${i}`}>
              <strong>我观察到({ISSUE_CN[d.issue] ?? d.issue},{d.severity}):</strong>
              <span className="report-evidence">{d.evidence}</span>
            </p>
          ))}
          {prescription && (
            <p>
              <strong>这次先练:{EXERCISE_CN[prescription.exercise] ?? prescription.exercise}</strong>
              ({prescription.suggestedBpm ? `建议 BPM ${prescription.suggestedBpm}` : '保持当前 BPM'},
              每组 {prescription.loopsPerSet} 遍,连续 {prescription.requiredConsecutivePasses} 遍达标再提速)
              <span className="report-evidence">{prescription.rationale}</span>
            </p>
          )}
          {prescription && (
            <p><strong>接下来验证:</strong>按处方练习后,再做一次同样的练习复测对比。</p>
          )}
        </div>
      )}

      <p className="report-footnote">节奏评分与统计全部来自本地 Rust 内核的确定性重放;音高匹配只在练习中作为独立提示,不参与节奏成绩。</p>
      <p className="calibration-note" role="note">音频输出延迟尚未校准（uncalibrated）。本报告的 onset/时值统计用于练习反馈，不代表采样级物理时间精度。</p>
    </section>
  );
}
