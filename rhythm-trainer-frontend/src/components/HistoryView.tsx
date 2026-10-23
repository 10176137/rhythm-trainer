// Practice history view: lists persisted sessions from the engine service,
// expandable to the full engine replay report. The UI only presents stored
// engine output.

import { useCallback, useEffect, useState } from 'react';
import ReportPanel from './ReportPanel';
import { practiceRepository, MODE_CN, fmtSigned, fmtAbs } from '../services/practiceRepository';
import type { SessionDetail, SessionSummary } from '../services/practiceRepository';
import type { EngineReport } from '../types/engine';
import type { EngineTimingAnalysis } from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { TargetedPracticeStartRequest } from '../types/teaching';

interface Props {
  refreshKey: number;
  activeScoreFingerprint: string | null;
  onStartTargetedPractice: (request: TargetedPracticeStartRequest) => Promise<boolean> | boolean;
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
  onStartTargetedPractice,
}: Props) {
  const [items, setItems] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(() => {
    practiceRepository.listSessions(50)
      .then((res) => setItems(res.items))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = async (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(sessionId);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await practiceRepository.getSession(sessionId));
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
        {items.map((item) => (
          <div className="history-item" key={item.sessionId}>
            <button className="history-row" onClick={() => toggle(item.sessionId)}>
              <span className="history-date">{fmtTime(item.finishedAtIso)}</span>
              <span className="history-mode">{MODE_CN[item.modeId] ?? item.modeId}</span>
              {item.sourceReportId && <span className="badge badge-ok">复练</span>}
              {item.takeTemplateName && <span className="badge history-take-badge" title={item.takeTemplateName}>Take</span>}
              {item.interrupted && <span className="badge badge-bad">中断</span>}
              <span className="history-meta">{item.bpm ?? '—'} BPM</span>
              <span className="history-meta">{Math.round((item.targetHitRate ?? 0) * 100)}% 命中</span>
              <span className="history-meta">MAE {fmtAbs(item.meanAbsoluteMs)}</span>
              <span className="history-meta">偏差 {fmtSigned(item.meanSignedMs)}</span>
              <span className={`badge ${item.trustworthy ? 'badge-ok' : 'badge-bad'}`}>{item.trustworthy ? '可信' : '不可信'}</span>
              <span className="history-arrow">{expandedId === item.sessionId ? '▾' : '▸'}</span>
            </button>
            {expandedId === item.sessionId && (
              <div className="history-detail">
                {detailLoading && <p className="history-empty">载入报告中…</p>}
                {detail?.takeTemplateName && (
                  <p className="history-take-link">关联 Take：{detail.takeTemplateName}</p>
                )}
                {detail && detail.report && (
                  <ReportPanel
                    report={detail.report as EngineReport}
                    analysis={detail.analysis as EngineTimingAnalysis | { error: string } | null}
                    durations={detail.durations ?? null}
                    scoreV1={detail.scoreV1 ?? null}
                    scoreStatus={detail.scoreStatus ?? null}
                    scoringConfig={detail.scoringConfig ?? null}
                    scoreConfigVersion={detail.scoreConfigVersion ?? null}
                    scoreAlgorithmVersion={detail.scoreAlgorithmVersion ?? null}
                    scoreInputNoteCount={detail.scoreInputNoteCount ?? 0}
                    scoreUnmappedNoteCount={detail.scoreUnmappedNoteCount ?? 0}
                    pauseAdjusted={detail.pauseAdjusted ?? false}
                    sessionId={detail.sessionId}
                    takeId={detail.takeId ?? null}
                    scoreFingerprint={detail.scoreFingerprint ?? null}
                    activeScoreFingerprint={activeScoreFingerprint}
                    scoreBarCount={detail.scoreBarCount ?? null}
                    practiceBpm={detail.bpm ?? 72}
                    practiceHand={storedHand(detail.hand)}
                    retryComparison={detail.retryComparison ?? null}
                    onStartTargetedPractice={onStartTargetedPractice}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="report-footnote">记录以 JSON 原子写入本机引擎服务数据目录;原始击打事件保留在报告内,可作确定性重放。</p>
    </section>
  );
}
