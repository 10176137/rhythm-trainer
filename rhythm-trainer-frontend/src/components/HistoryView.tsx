// Practice history view: lists unified Takes from the engine service. The UI
// only presents stored engine output. Timeline Takes render the existing
// report; Follow Takes render the server's Follow report and are never
// dressed up as fixed-clock strict scores.

import { useCallback, useEffect, useState } from 'react';
import ReportPanel from './ReportPanel';
import FollowReportPanel from './FollowReportPanel';
import { practiceRepository, MODE_CN, fmtSigned, fmtAbs } from '../services/practiceRepository';
import type { SessionSummary, TakeRecordDetail } from '../services/practiceRepository';
import type { EngineReport } from '../types/engine';
import type { EngineTimingAnalysis } from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { TeachingRunDTO } from '../services/teachingRunRepository';

interface Props {
  refreshKey: number;
  activeScoreFingerprint: string | null;
  /** Flow B: Node accepted the from-take request and created a lesson run. */
  onTeachingRunCreated: (run: TeachingRunDTO) => void;
  onNavigateTeaching: () => void;
}

function storedHand(value: string | null | undefined): HandSelection {
  return value === 'left' || value === 'right' || value === 'both' ? value : 'both';
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function HistoryView({
  refreshKey,
  activeScoreFingerprint,
  onTeachingRunCreated,
  onNavigateTeaching,
}: Props) {
  const [items, setItems] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TakeRecordDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    practiceRepository.listTakes(50)
      .then((res) => setItems(res.items))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = async (takeId: string) => {
    if (expandedId === takeId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(takeId);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await practiceRepository.getTake(takeId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  };

  if (error) {
    return <section className="card history-card"><p className="report-warning">载入失败:{error}(引擎服务需要在执行中)</p></section>;
  }
  if (items === null) {
    return <section className="card history-card"><p className="history-empty">载入中…</p></section>;
  }
  if (items.length === 0) {
    return <section className="card history-card"><p className="history-empty">还没有练习记录——完成一次练习后,报告会自动保存在本机。</p></section>;
  }

  const timeline = detail?.assessment?.timelineReport ?? null;
  const followReport = detail?.assessment?.followReport ?? null;
  const snapshot = detail?.context?.practiceConfigSnapshot ?? null;
  const snapshotTempo = snapshot && typeof snapshot.tempo === 'number' ? snapshot.tempo : null;
  const provenanceAuthority = detail?.context?.plannerAuthority ?? timeline?.plannerAuthority ?? null;
  const provenanceVersion = detail?.context?.plannerVersion ?? timeline?.plannerVersion ?? null;
  const provenanceFingerprint = detail?.context?.planFingerprint ?? timeline?.planFingerprint ?? null;
  const provenanceRunId = detail?.context?.planRunId ?? timeline?.playbackPlanId ?? null;

  return (
    <section className="card history-card">
      <div className="card-heading">
        <div>
          <div className="eyebrow">PRACTICE HISTORY</div>
          <h3>练习记录({items.length})</h3>
        </div>
        <button className="text-button" onClick={load}>重新整理</button>
      </div>
      <div className="history-list">
        {items.map((item) => {
          const rowId = item.takeId ?? item.sessionId;
          const isFollow = item.reportKind === 'follow';
          return (
            <div className="history-item" key={rowId}>
              <button className="history-row" onClick={() => toggle(rowId)}>
                <span className="history-date">{fmtTime(item.finishedAtIso)}</span>
                <span className="history-mode">{MODE_CN[item.modeId] ?? item.modeId}</span>
                {isFollow && <span className="badge">Follow</span>}
                {item.plannerAuthority === 'rust' && <span className="badge badge-ok">Rust 计划</span>}
                {item.plannerAuthority === 'rts' && <span className="badge">RTS 计划</span>}
                {item.sourceReportId && <span className="badge badge-ok">复练</span>}
                {item.takeTemplateName && <span className="badge history-take-badge" title={item.takeTemplateName}>Take</span>}
                {item.endReason === 'interrupted' && <span className="badge badge-bad">中断</span>}
                <span className="history-meta">{item.bpm ?? '—'} BPM</span>
                {isFollow ? (
                  <>
                    <span className="history-meta">{item.followCompletedTargets ?? 0}/{item.targetCount ?? 0} 目标</span>
                    <span className="history-meta">标准 {item.followStandardTargets ?? 0}</span>
                    <span className="history-meta">错误音 {item.followWrongNoteCount ?? 0}</span>
                    <span className="history-meta">节奏 MAE {fmtAbs(item.meanAbsoluteMs)}</span>
                  </>
                ) : (
                  <>
                    <span className="history-meta">{Math.round((item.targetHitRate ?? 0) * 100)}% 命中</span>
                    <span className="history-meta">MAE {fmtAbs(item.meanAbsoluteMs)}</span>
                    <span className="history-meta">偏差 {fmtSigned(item.meanSignedMs)}</span>
                  </>
                )}
                <span className={`badge ${item.trustworthy ? 'badge-ok' : 'badge-bad'}`}>{item.trustworthy ? '可信' : '不可信'}</span>
                <span className="history-arrow">{expandedId === rowId ? '▾' : '▸'}</span>
              </button>
              {expandedId === rowId && (
                <div className="history-detail">
                  {detailLoading && <p className="history-empty">载入报告中…</p>}
                  {!detailLoading && detail && (
                    <>
                      <p className="history-take-link">
                        Take {detail.takeId} · {detail.lifecycle.modeId} · {detail.lifecycle.endReason === 'interrupted' ? '中断' : '完成'}
                        {detail.legacy?.sessionId ? ` · 旧记录 ${detail.legacy.sessionId}` : ''}
                      </p>
                      {timeline?.takeTemplateName && (
                        <p className="history-take-link">关联 Take：{timeline.takeTemplateName}</p>
                      )}
                      {(provenanceAuthority || provenanceFingerprint || provenanceRunId) && (
                        <p className="history-take-link">
                          规划器：{provenanceAuthority ?? '未记录'}
                          {provenanceVersion ? ` · ${provenanceVersion}` : ''}
                          {provenanceFingerprint ? ` · 计划指纹 ${provenanceFingerprint}` : ''}
                          {provenanceRunId ? ` · 运行 ID ${provenanceRunId}` : ''}
                        </p>
                      )}
                      {followReport && (
                        <>
                          <p className="history-take-link">
                            评估范围：Follow（自定步速）· 由引擎服务 Rust FollowRuntime 结算
                            {detail.assessment.trustworthy ? '' : ' · 不可信'}
                          </p>
                          <FollowReportPanel report={followReport} />
                        </>
                      )}
                      {timeline?.report && (
                        <ReportPanel
                          report={timeline.report as EngineReport}
                          analysis={timeline.analysis as EngineTimingAnalysis | { error: string } | null}
                          durations={timeline.durations ?? null}
                          scoreV1={timeline.scoreV1 ?? null}
                          scoreStatus={timeline.scoreStatus ?? null}
                          scoringConfig={timeline.scoringConfig ?? null}
                          scoreConfigVersion={timeline.scoreConfigVersion ?? null}
                          scoreAlgorithmVersion={timeline.scoreAlgorithmVersion ?? null}
                          scoreInputNoteCount={timeline.scoreInputNoteCount ?? 0}
                          scoreUnmappedNoteCount={timeline.scoreUnmappedNoteCount ?? 0}
                          pauseAdjusted={timeline.pauseAdjusted ?? false}
                          sessionId={timeline.sessionId ?? detail.takeId}
                          takeId={detail.takeId}
                          scoreFingerprint={detail.score?.scoreFingerprint ?? timeline.scoreFingerprint ?? null}
                          activeScoreFingerprint={activeScoreFingerprint}
                          scoreBarCount={timeline.scoreBarCount ?? null}
                          practiceBpm={timeline.bpm ?? snapshotTempo ?? 72}
                          practiceHand={storedHand(timeline.hand)}
                          retryComparison={timeline.retryComparison ?? null}
                          onTeachingRunCreated={onTeachingRunCreated}
                          onNavigateTeaching={onNavigateTeaching}
                        />
                      )}
                      {!followReport && !timeline?.report && (
                        <p className="history-empty">该 Take 没有可展示的报告。</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="report-footnote">记录以 JSON 原子写入本机引擎服务数据目录;原始击打事件保留在报告内,可作确定性重放。Follow 记录只保存自定步速报告,不生成时间线 strict 成绩。</p>
    </section>
  );
}
