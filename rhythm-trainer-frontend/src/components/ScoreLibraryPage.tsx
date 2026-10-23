import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScoreDocument } from '../core/sampleScore';
import type { ImportIssue } from '../score-engine/domain/types';
import {
  createScoreLibraryEntry,
  deleteScoreLibraryEntry,
  getScoreLibraryEntry,
  listScoreLibraryDetailed,
  updateScoreLibraryEntry,
  type ScoreLibraryEntry,
} from '../features/score/scoreLibrary';
import { importScoreText } from '../features/score/scoreImport';
import {
  SCORE_DISPLAY_STATUS_LABEL,
  canPracticeWithEntry,
  displayStatusForEntry,
  summarizeImportReport,
  type ScoreDisplayStatus,
  type StoredImportSummary,
} from '../features/score/scoreStatus';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

interface ImportPreview {
  fileName: string;
  fileSize: number;
  xml: string;
  doc?: ScoreDocument;
  summary: StoredImportSummary;
  issues: readonly ImportIssue[];
  defaultName: string;
  name: string;
  saveError: string | null;
}

interface Props {
  activeLibraryId: string | null;
  onOpenScore: (entry: ScoreLibraryEntry, doc: ScoreDocument) => boolean;
  onLibraryChanged: () => void;
  onActiveScoreRemoved: (id: string) => void;
  onBackToWorkbench: () => void;
}

const statusClass = (status: ScoreDisplayStatus) => `score-status score-status-${status.toLowerCase()}`;

const fmtDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || '—';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const fmtBytes = (bytes: number) => bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const baseNameFromFile = (fileName: string) =>
  fileName.replace(/\.musicxml$/i, '').replace(/\.xml$/i, '').trim() || '未命名乐谱';

const issueLocation = (issue: ImportIssue) =>
  issue.measureOrdinal != null ? `第 ${issue.measureOrdinal} 小节` : '位置未提供';

const groupedIssues = (issues: readonly ImportIssue[]) => ({
  error: issues.filter((issue) => issue.severity === 'error'),
  warning: issues.filter((issue) => issue.severity === 'warning'),
  info: issues.filter((issue) => issue.severity === 'info'),
});

export default function ScoreLibraryPage({
  activeLibraryId,
  onOpenScore,
  onLibraryChanged,
  onActiveScoreRemoved,
  onBackToWorkbench,
}: Props) {
  const [entries, setEntries] = useState<ScoreLibraryEntry[]>([]);
  const [invalidCount, setInvalidCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listScoreLibraryDetailed();
      setEntries(result.entries);
      setInvalidCount(result.invalidCount);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) =>
      entry.name.toLowerCase().includes(query)
      || entry.fileName.toLowerCase().includes(query));
  }, [entries, search]);

  const handleFile = async (file: File) => {
    setImportError(null);
    setNotice(null);
    if (!/\.musicxml$/i.test(file.name)) {
      setImportError('A1 目前只支持 .musicxml 文件；不使用 .mxl 或 PDF。');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError('文件超过 10 MiB 限制，未读取。');
      return;
    }
    try {
      const xml = await file.text();
      const result = importScoreText(xml, file.name);
      const summary = summarizeImportReport(result.report);
      setPreview({
        fileName: file.name,
        fileSize: file.size,
        xml,
        doc: result.doc,
        summary,
        issues: result.report.issues,
        defaultName: baseNameFromFile(file.name),
        name: baseNameFromFile(file.name),
        saveError: null,
      });
    } catch (err) {
      setPreview(null);
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const savePreview = async () => {
    if (!preview?.doc || preview.summary.status === 'REJECTED') return;
    const name = preview.name.trim();
    if (!name) {
      setPreview({ ...preview, saveError: '请输入曲谱名称。' });
      return;
    }
    setBusyId('import');
    try {
      const entry = await createScoreLibraryEntry({
        name,
        fileName: preview.fileName,
        xml: preview.xml,
        importSummary: preview.summary,
      });
      await load();
      onLibraryChanged();
      setPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setNotice(`《${entry.name}》已保存到曲谱库。`);
    } catch (err) {
      setPreview({ ...preview, saveError: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyId(null);
    }
  };

  const openEntry = async (entry: ScoreLibraryEntry) => {
    const status = displayStatusForEntry(entry);
    if (status === 'MISSING') {
      setNotice(`《${entry.name}》的 MusicXML 文件已丢失，无法打开；可以删除该记录或重新导入。`);
      return;
    }
    if (status === 'FAILED') {
      setNotice(`《${entry.name}》的持久化状态为导入失败，不能作为可用曲谱打开。`);
      return;
    }
    setBusyId(entry.id);
    setNotice(null);
    try {
      const fullEntry = await getScoreLibraryEntry(entry.id);
      const result = importScoreText(fullEntry.xml, fullEntry.fileName);
      if (!result.doc) {
        const reasons = result.report.issues.map((issue) => issue.message).slice(0, 3).join('；');
        setNotice(`《${entry.name}》无法打开：${reasons || '语义解析失败'}`);
        return;
      }
      const summary = summarizeImportReport(result.report);
      // Old records (or a changed parser) are verified only when opened. The
      // list is never reparsed just to render.
      if (status === 'UNVERIFIED' || status === 'STALE' || !fullEntry.importStatus) {
        try {
          await updateScoreLibraryEntry(entry.id, { importSummary: summary });
          await load();
          onLibraryChanged();
        } catch (err) {
          setNotice(`《${entry.name}》已打开，但状态摘要未能保存：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const openedEntry: ScoreLibraryEntry = {
        ...fullEntry,
        importStatus: summary.status,
        importReportSummary: summary,
        parserVersion: summary.parserVersion,
        importedAtIso: summary.importedAtIso,
      };
      const opened = onOpenScore(openedEntry, result.doc);
      if (!opened) setNotice('已取消打开；当前练习保持不变。');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice(`打开《${entry.name}》失败：${message}`);
      if (/404|不存在|文件/.test(message)) await load();
    } finally {
      setBusyId(null);
    }
  };

  const renameEntry = async (entry: ScoreLibraryEntry) => {
    const answer = window.prompt('新的曲谱名称', entry.name);
    if (answer === null) return;
    const name = answer.trim();
    if (!name || name === entry.name) return;
    setBusyId(entry.id);
    setNotice(null);
    try {
      const updated = await updateScoreLibraryEntry(entry.id, { name });
      await load();
      onLibraryChanged();
      setNotice(`已重命名为《${updated.name}》。`);
    } catch (err) {
      setNotice(`重命名失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const deleteEntry = async (entry: ScoreLibraryEntry) => {
    if (!window.confirm(`从曲谱库删除《${entry.name}》？此操作不可撤销。`)) return;
    setBusyId(entry.id);
    setNotice(null);
    try {
      await deleteScoreLibraryEntry(entry.id);
      if (activeLibraryId === entry.id) onActiveScoreRemoved(entry.id);
      await load();
      onLibraryChanged();
      setNotice(`已删除《${entry.name}》。`);
    } catch (err) {
      setNotice(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const grouped = preview ? groupedIssues(preview.issues) : null;

  return (
    <div className="page-content library-page">
      <input
        ref={fileInputRef}
        type="file"
        accept=".musicxml"
        className="file-input-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = '';
        }}
      />

      <div className="page-heading library-heading">
        <div>
          <div className="eyebrow">SCORE LIBRARY</div>
          <h1>曲谱库</h1>
          <p>导入、检查并使用真实解析结果；可阅读不等于可完整评分。</p>
        </div>
        <div className="library-heading-actions">
          <button type="button" className="button button-ghost" onClick={onBackToWorkbench}>返回工作台</button>
          <button type="button" className="button button-outline" onClick={() => void load()} disabled={loading || busyId !== null}>刷新</button>
          <button type="button" className="button button-primary" onClick={() => fileInputRef.current?.click()} disabled={busyId !== null}>导入 .musicxml</button>
        </div>
      </div>

      {error && <section className="card error-strip" role="alert"><strong>曲谱库加载失败</strong><p>{error}</p></section>}
      {invalidCount > 0 && <section className="card library-warning" role="status">有 {invalidCount} 条元数据无法读取；它们不会出现在列表中。请检查数据目录或删除对应文件。</section>}
      {notice && <section className="card library-notice" role="status">{notice}</section>}
      {importError && <section className="card error-strip" role="alert"><strong>导入未开始</strong><p>{importError}</p></section>}

      {preview && grouped && (
        <section className="card import-preview" aria-label="导入结果">
          <div className="panel-heading">
            <div>
              <h3>导入结果 · {preview.fileName}</h3>
              <p>{fmtBytes(preview.fileSize)} · 解析状态来自当前 MusicXML importer，不是 OSMD 渲染结果。</p>
            </div>
            <div className="import-preview-actions">
              <span className={statusClass(displayStatusFromImport(preview.summary.status))}>{SCORE_DISPLAY_STATUS_LABEL[displayStatusFromImport(preview.summary.status)]}</span>
              <button type="button" className="icon-button" aria-label="关闭导入结果" title="关闭导入结果" onClick={() => { setPreview(null); setImportError(null); }}>✕</button>
            </div>
          </div>

          <div className="import-summary-grid">
            <span>音符 <b>{preview.summary.counts.noteCount}</b></span>
            <span>小节 <b>{preview.summary.counts.measureCount}</b></span>
            <span>警告 <b>{preview.summary.counts.warningCount}</b></span>
            <span>错误 <b>{preview.summary.counts.errorCount}</b></span>
            <span>严格练习 <b>{preview.summary.strictAllowed ? '可进入' : '受限'}</b></span>
          </div>

          {preview.doc && (
            <p className="import-score-meta">
              {preview.doc.meta.title}{preview.doc.meta.composer ? ` · ${preview.doc.meta.composer}` : ''} · {preview.doc.meta.timeSignature[0]}/{preview.doc.meta.timeSignature[1]} · {preview.doc.meta.barCount} 小节
            </p>
          )}

          <div className="import-issues">
            {(['error', 'warning', 'info'] as const).map((severity) => grouped[severity].length > 0 && (
              <div key={severity} className={`import-issue-group import-issue-${severity}`}>
                <strong>{severity === 'error' ? '错误' : severity === 'warning' ? '警告' : '提示'} ({grouped[severity].length})</strong>
                <ul>
                  {grouped[severity].map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>
                      <span>{issueLocation(issue)}</span>
                      {issue.message}
                      {issue.blocksStrict && <em> · 阻断严格练习</em>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {preview.issues.length === 0 && <p className="history-empty">无警告；可以保存并在阅读页查看。</p>}
          </div>

          {!preview.doc || preview.summary.status === 'REJECTED' ? (
            <p className="report-warning">解析失败，不能保存为曲谱库记录。请修正 XML 后重新导入。</p>
          ) : (
            <div className="import-save-row">
              <label className="field"><span>保存名称</span><input value={preview.name} maxLength={80} onChange={(event) => setPreview({ ...preview, name: event.target.value, saveError: null })} /></label>
              <div className="import-save-actions">
                <button type="button" className="button button-ghost" onClick={() => { setPreview(null); setImportError(null); }} disabled={busyId !== null}>取消</button>
                <button type="button" className="button button-primary" onClick={() => void savePreview()} disabled={busyId !== null || !preview.name.trim()}>
                  {busyId === 'import' ? '保存中…' : '保存到曲谱库'}
                </button>
              </div>
            </div>
          )}
          {preview.saveError && <p className="report-warning" role="alert">{preview.saveError}</p>}
          {preview.summary.status === 'DISPLAY_ONLY' && <p className="report-warning">可阅读，但存在阻断严格练习的能力；保存后阅读页会禁用开始练习。</p>}
        </section>
      )}

      <div className="library-toolbar">
        <label className="library-search">
          <span>搜索</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="曲名或文件名"
            aria-label="搜索曲谱"
          />
        </label>
        <span className="library-count">{loading ? '载入中…' : `${filtered.length} / ${entries.length} 份`}</span>
      </div>

      {loading ? (
        <section className="card library-empty"><p>正在读取曲谱库…</p></section>
      ) : error ? (
        <section className="card library-empty"><p>载入失败，请检查引擎服务后刷新。</p></section>
      ) : entries.length === 0 ? (
        <section className="card library-empty">
          <strong>曲谱库还是空的</strong>
          <p>导入一个 `.musicxml` 文件开始；A1 不支持 `.mxl`、PDF 或图片识谱。</p>
          <button type="button" className="button button-primary" onClick={() => fileInputRef.current?.click()}>导入第一份曲谱</button>
        </section>
      ) : filtered.length === 0 ? (
        <section className="card library-empty"><p>没有匹配“{search}”的曲谱。</p></section>
      ) : (
        <div className="score-library-grid">
          {filtered.map((entry) => {
            const status = displayStatusForEntry(entry);
            const practice = canPracticeWithEntry(entry);
            const updated = entry.importReportSummary?.counts;
            return (
              <article className="card score-library-card" key={entry.id}>
                <div className="score-card-top">
                  <div>
                    <h3>{entry.name}</h3>
                    <p>{entry.fileName}</p>
                  </div>
                  <span className={statusClass(status)}>{SCORE_DISPLAY_STATUS_LABEL[status]}</span>
                </div>
                <div className="score-card-meta">
                  <span>更新 {fmtDate(entry.updatedAtIso)}</span>
                  <span>{fmtBytes(entry.size)}</span>
                  {entry.id === activeLibraryId && <span className="active-score-mark">当前谱面</span>}
                </div>
                {updated && <p className="score-card-counts">{updated.noteCount} 音符 · {updated.measureCount} 小节 · {updated.warningCount} 警告</p>}
                {entry.fileMissing && <p className="report-warning">MusicXML 文件缺失；记录仍在，可删除或重新导入。</p>}
                {status === 'UNVERIFIED' && <p className="score-card-hint">旧记录没有解析摘要；打开时会校验并补齐。</p>}
                {status === 'STALE' && <p className="score-card-hint">解析器版本已变化；打开时会重新校验。</p>}
                {status === 'RESTRICTED' && <p className="score-card-hint">可以阅读，但当前引擎不能把它当作完整严格练习目标。</p>}
                {status === 'WARNINGS' && <p className="score-card-hint">存在导入警告；严格练习可用性以打开后的计划校验为准。</p>}
                <div className="score-card-actions">
                  <button type="button" className="button button-primary button-small" onClick={() => void openEntry(entry)} disabled={busyId !== null || status === 'MISSING' || status === 'FAILED'}>
                    {busyId === entry.id ? '打开中…' : '打开阅读'}
                  </button>
                  <button type="button" className="button button-outline button-small" onClick={() => void renameEntry(entry)} disabled={busyId !== null}>重命名</button>
                  <button type="button" className="button button-ghost button-small" onClick={() => void deleteEntry(entry)} disabled={busyId !== null}>删除</button>
                </div>
                {!practice && status !== 'MISSING' && status !== 'FAILED' && (
                  <p className="score-card-hint">阅读可用；严格练习入口会在阅读页按真实能力禁用。</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function displayStatusFromImport(status: StoredImportSummary['status']): ScoreDisplayStatus {
  switch (status) {
    case 'READY': return 'READY';
    case 'READY_WITH_WARNINGS': return 'WARNINGS';
    case 'DISPLAY_ONLY': return 'RESTRICTED';
    case 'REJECTED': return 'FAILED';
    default: return 'UNVERIFIED';
  }
}
