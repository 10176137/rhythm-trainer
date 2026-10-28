import { useEffect, useState } from 'react';
import { listReadingAttempts, pendingReadingAttempts, saveReadingAttempt, type ReadingRecord } from '../services/readingRepository';
import { midiLabel } from '../features/reading/readingKeys';
import { readingConfigLabel } from '../features/reading/readingSettings';
export default function ReadingHistory({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<ReadingRecord[]>([]);
  const [pending, setPending] = useState(pendingReadingAttempts);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setPending(pendingReadingAttempts());
    void listReadingAttempts().then((value) => { if (alive) { setItems(value); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [refreshKey, revision]);
  const retry = async () => {
    setSaving(true);
    try { for (const item of pendingReadingAttempts()) await saveReadingAttempt(item); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); setRevision((v) => v + 1); }
  };
  return <details className="reading-history"><summary>识谱记录 {items.length > 0 ? `· 最近 ${items.length} 次` : ''}{pending.length > 0 ? ` · ${pending.length} 条待保存` : ''}</summary>
    {pending.length > 0 && <p role="status">有 {pending.length} 条记录待保存。<button type="button" disabled={saving} onClick={() => void retry()}>{saving ? '保存中…' : '重试保存'}</button></p>}
    {error && <p role="status">{error}</p>}
    {!items.length && !error && <p>完成识谱练习后，结果会保存在本机。</p>}
    {items.map((item) => <details className="reading-history-item" key={item.id}><summary>{new Date(item.finishedAtIso).toLocaleString()} · {item.config.task === 'test' ? '小测' : '练习'} · {item.summary.completedQuestions}/{item.summary.questionCount} 题 · 首次答对 {item.summary.firstTryAccuracy == null ? '—' : `${item.summary.firstTryAccuracy}%`}</summary>
      <p>{readingConfigLabel(item.config)} · {item.source === 'midi' ? 'MIDI 键盘' : item.source === 'mixed' ? '混合输入' : '虚拟键盘'} · {item.endReason === 'completed' ? '已完成' : '提前结束'}</p>
      <p>用过提示 {item.summary.hintedQuestions} 题 · 已完成题目覆盖 {item.summary.coveredPitches}/{item.summary.poolSize} 音</p>
      <p>{item.summary.confusions.length ? item.summary.confusions.slice(0, 8).map((c) => `目标 ${c.remainingTargets.map(midiLabel).join('＋')} → 误按 ${midiLabel(c.pressed)}`).join('；') : '没有错误输入记录'}</p>
    </details>)}
  </details>;
}
