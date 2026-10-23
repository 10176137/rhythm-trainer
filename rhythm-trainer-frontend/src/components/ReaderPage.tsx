import { useMemo, useState } from 'react';
import type { ScoreDocument } from '../core/sampleScore';
import { getUnsupportedNotes } from '../features/score/staffMapping';
import {
  SCORE_DISPLAY_STATUS_LABEL,
  canPracticeWithReport,
  displayStatusForImportStatus,
} from '../features/score/scoreStatus';
import ScoreReader from './ScoreReader';

interface Props {
  doc: ScoreDocument;
  activeLibraryId: string | null;
  restoring: boolean;
  onBackToLibrary: () => void;
  onStartPractice: () => void;
}

const fmtBytes = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function ReaderPage({
  doc,
  activeLibraryId,
  restoring,
  onBackToLibrary,
  onStartPractice,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const report = doc.importReport;
  const status = report ? displayStatusForImportStatus(report.status) : 'UNVERIFIED';
  const maxBar = Math.max(1, doc.meta.barCount, ...doc.notes.map((note) => note.bar));
  const unsupported = useMemo(
    () => getUnsupportedNotes(doc.notes, maxBar),
    [doc.notes, maxBar],
  );
  const practiceAllowed = canPracticeWithReport(report) && unsupported.length === 0;
  const blockReason = !report
    ? '缺少 ImportReport，无法确认该曲谱是否能进入严格练习。'
    : report.status === 'REJECTED'
      ? '导入报告为失败，不能进入练习。'
      : !report.strictAllowed
        ? '该曲谱存在阻断严格练习的未支持能力；可以阅读，但不能创建评分练习。'
        : unsupported.length > 0
          ? `有 ${unsupported.length} 个音符超出当前谱表/音高支持范围；为避免错误评分，练习入口已禁用。`
          : '';
  const warningIssues = report?.issues.filter((issue) => issue.severity !== 'info') ?? [];

  if (restoring) {
    return (
      <div className="page-content reader-page">
        <section className="card reader-empty"><p>正在恢复上次打开的乐谱…</p></section>
      </div>
    );
  }

  if (!activeLibraryId) {
    return (
      <div className="page-content reader-page">
        <div className="page-heading">
          <div><div className="eyebrow">SCORE READER</div><h1>曲谱阅读</h1><p>请先从曲谱库打开一份已保存的 MusicXML。</p></div>
        </div>
        <section className="card reader-empty">
          <strong>还没有打开曲谱</strong>
          <p>阅读页不会把默认示例冒充为已打开的曲谱。请回到曲谱库选择或导入。</p>
          <button type="button" className="button button-primary" onClick={onBackToLibrary}>打开曲谱库</button>
        </section>
      </div>
    );
  }

  if (!doc.sourceXml) {
    return (
      <div className="page-content reader-page">
        <div className="page-heading"><div><div className="eyebrow">SCORE READER</div><h1>{doc.meta.title}</h1><p>当前记录没有原始 MusicXML，无法渲染专业谱面。</p></div></div>
        <section className="card reader-empty">
          <strong>缺少原始 MusicXML</strong>
          <p>请从曲谱库重新导入或替换这份曲谱。</p>
          <button type="button" className="button button-outline" onClick={onBackToLibrary}>返回曲谱库</button>
        </section>
      </div>
    );
  }

  return (
    <div className="page-content reader-page">
      <div className="reader-heading">
        <div>
          <div className="eyebrow">SCORE READER</div>
          <h1>{doc.meta.title}</h1>
          <p>
            {doc.meta.composer || '作曲者未知'}
            {` · ${doc.meta.timeSignature[0]}/${doc.meta.timeSignature[1]} · ${doc.meta.barCount} 小节 · ${doc.meta.staves === 2 ? '钢琴大谱表' : '单谱表'}`}
          </p>
        </div>
        <div className="reader-heading-actions">
          <button type="button" className="button button-ghost" onClick={onBackToLibrary}>返回曲谱库</button>
          <button
            type="button"
            className="button button-primary"
            onClick={onStartPractice}
            disabled={!practiceAllowed}
            title={practiceAllowed ? '进入工作台练习设置' : blockReason}
          >
            开始练习
          </button>
        </div>
      </div>

      <div className="reader-status-row">
        <span className={`score-status score-status-${status.toLowerCase()}`}>{SCORE_DISPLAY_STATUS_LABEL[status]}</span>
        <span className="reader-meta">{doc.notes.length} 音符 · {doc.meta.staves === 2 ? '双手' : '单谱表'} · {fmtBytes(doc.sourceXml.length)} XML</span>
        {report && <span className="reader-meta">parser {report.parserVersion}</span>}
      </div>

      {blockReason && <section className="card reader-restriction" role="status"><strong>{practiceAllowed ? '' : '练习入口受限'}</strong><p>{blockReason}</p></section>}
      {warningIssues.length > 0 && (
        <details className="card reader-warnings">
          <summary>导入报告：{warningIssues.length} 条警告/错误</summary>
          <ul>
            {warningIssues.slice(0, 12).map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <span>{issue.measureOrdinal != null ? `第 ${issue.measureOrdinal} 小节` : '位置未提供'}</span>
                {issue.message}
                {issue.blocksStrict && <em> · 阻断严格练习</em>}
              </li>
            ))}
          </ul>
          {warningIssues.length > 12 && <p>仅显示前 12 条，完整报告见导入结果。</p>}
        </details>
      )}

      <section className="card reader-card">
        <div className="reader-toolbar" aria-label="阅读缩放">
          <div className="reader-zoom-group">
            <button type="button" className="button button-outline button-small" onClick={() => { setFitWidth(false); setZoom((value) => Math.max(0.6, Math.round((value - 0.1) * 10) / 10)); }} aria-label="缩小">−</button>
            <button type="button" className="button button-outline button-small" onClick={() => { setFitWidth(true); setZoom(1); }} aria-label="适应宽度">适应宽度</button>
            <button type="button" className="button button-outline button-small" onClick={() => { setFitWidth(false); setZoom((value) => Math.min(2, Math.round((value + 0.1) * 10) / 10)); }} aria-label="放大">＋</button>
            <button type="button" className="button button-ghost button-small" onClick={() => { setFitWidth(true); setZoom(1); }}>重置</button>
            <span className="reader-zoom-value">{fitWidth ? '适应宽度' : `${Math.round(zoom * 100)}%`}</span>
          </div>
          <span className="reader-note">显示由 OSMD/Bravura 渲染；阅读成功不代表评分能力已接通。</span>
        </div>
        <ScoreReader xml={doc.sourceXml} zoom={zoom} fitWidth={fitWidth} />
      </section>
    </div>
  );
}
