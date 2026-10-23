import type { FollowReport, FollowTargetResult } from '../score-engine/practice/follow-session';

interface Props {
  report: FollowReport;
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${Math.round(value)} ms`;
}

function targetStatus(target: FollowTargetResult): string {
  if (!target.completed) return '未完成';
  return target.standard ? '标准' : '有偏差';
}

export default function FollowReportPanel({ report }: Props) {
  const shownTargets = report.targets.slice(0, 24);
  return (
    <section className="card follow-report" aria-label="跟手练习结果">
      <div className="card-heading">
        <div>
          <div className="eyebrow">FOLLOW-ME RESULT</div>
          <h3>跟手练习结果（非固定时间 strict 成绩）</h3>
        </div>
        <span className="status-pill is-complete"><i />光标等待模式</span>
      </div>
      <p className="follow-report-intro">
        光标只由你的正确输入推进；下面的节奏指标比较相邻正确起音的实际间隔与谱面时值，
        不是固定时钟测验的 Perfect/Good/Miss 成绩。
      </p>
      <div className="follow-summary">
        <div><span>完成目标</span><strong>{report.completedTargets} / {report.totalTargets}</strong></div>
        <div><span>标准</span><strong className="text-good">{report.standardTargets}</strong></div>
        <div><span>错误音</span><strong className={report.wrongNoteCount ? 'text-bad' : ''}>{report.wrongNoteCount}</strong></div>
        <div><span>额外音</span><strong>{report.extraNoteCount}</strong></div>
        <div><span>重复音</span><strong>{report.duplicateNoteCount}</strong></div>
        <div><span>节奏 MAE</span><strong>{formatMs(report.timing.meanAbsoluteMs)}</strong><small>{report.timing.samples} 个干净间隔</small></div>
        <div><span>平均偏差</span><strong>{formatMs(report.timing.meanSignedMs)}</strong><small>正 = 偏晚</small></div>
        <div><span>节奏标准差</span><strong>{formatMs(report.timing.standardDeviationMs)}</strong></div>
      </div>
      {report.targets.length > 0 ? (
        <div className="follow-targets">
          <div className="follow-targets-head"><span>#</span><span>小节</span><span>目标音</span><span>结果</span><span>间隔偏差</span><span>和弦间距</span></div>
          {shownTargets.map((target, index) => (
            <div className="follow-targets-row" key={target.targetId}>
              <span>{index + 1}</span>
              <span>{target.bar}</span>
              <span>{target.expectedPitches.join(' / ')}</span>
              <span className={target.standard ? 'text-good' : target.completed ? 'text-warn' : 'muted-text'}>{targetStatus(target)}</span>
              <span>{target.intervalJudged ? formatMs(target.intervalErrorMs) : '首个目标'}</span>
              <span>{target.chordSpreadMs === null ? '—' : `${Math.round(target.chordSpreadMs)} ms`}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="follow-empty">还没有完成任何目标。光标会停在第一个目标，弹对后才会推进。</p>
      )}
      {report.pendingTargetId && (
        <p className="follow-pending">当前仍停在未完成目标；光标不会自动前进。</p>
      )}
    </section>
  );
}
