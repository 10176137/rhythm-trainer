import { AppButton } from './ui/controls';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteReview, NoteReviewItem } from '../../shared/note-review';
import { practiceRepository } from '../services/practiceRepository';
import { importMusicXml } from '../score-engine/import/musicxml-importer';
import { locateReviewItems, reviewHighlights } from '../features/practice/noteReviewPresentation';
import OsmdScoreView from './OsmdScoreView';
import './noteReview.css';

const EMPTY: string[] = [];
const labels = { good: '已达标', attention: '需改进', error: '漏弹 / 错音 / 多弹', unknown: '未完整判定' };
const itemLabel = (item: NoteReviewItem) => ({ MISSING: '漏弹', WRONG_PITCH: '音高不符', EXTRA: '多弹', AMBIGUOUS: '匹配不确定' }[item.result] ?? labels[item.state]);
const ms = (value: number | null) => value === null ? '未记录' : `${Math.round(value)} ms`;
export default function NoteReviewPanel({ takeId }: { takeId: string }) {
  const [review, setReview] = useState<NoteReview | null>(null);
  const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issuesOnly, setIssuesOnly] = useState(true); const [page, setPage] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let stale = false; setReview(null); setError(''); setSelectedId(null); setPage(0);
    practiceRepository.getNoteReview(takeId).then(data => {
      if (stale) return; setReview(data);
      setSelectedId((data.items.find(n => n.state === 'error' || n.state === 'attention') ?? data.items[0])?.id ?? null);
    }).catch(reason => { if (!stale) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { stale = true; };
  }, [takeId, retry]);
  const imported = useMemo(() => review?.xml ? importMusicXml(review.xml) : null, [review?.xml]);
  const score = imported?.scoreDocument?.fingerprint === review?.scoreFingerprint ? imported?.scoreDocument : undefined;
  const locations = useMemo(() => review && score ? locateReviewItems(review.items, score) : new Map<string, string | null>(), [review, score]);
  const highlights = useMemo(() => reviewHighlights(review?.items ?? [], locations), [review, locations]);
  const selected = review?.items.find(n => n.id === selectedId);
  const filtered = review?.items.filter(n => !issuesOnly || n.state !== 'good') ?? [];
  const position = filtered.findIndex(n => n.id === selectedId);
  const activeId = selected ? locations.get(selected.id) : null;
  const choose = (item: NoteReviewItem) => { setSelectedId(item.id); const index = filtered.findIndex(n => n.id === item.id); if (index >= 0) setPage(Math.floor(index / 100)); };
  const step = (direction: number) => { if (!filtered.length) return; choose(filtered[(Math.max(position, 0) + direction + filtered.length) % filtered.length]); };
  if (error) return <section className="note-review"><h3>逐音符复盘</h3><p role="alert">{error}</p><AppButton onClick={() => setRetry(n => n + 1)}>重试载入</AppButton></section>;
  if (!review) return <section className="note-review" aria-busy="true">正在载入逐音符反馈…</section>;
  return <section className="note-review" aria-label="逐音符复盘">
    <header><div><div className="eyebrow">NOTE REVIEW</div><h3>逐音符复盘</h3><p>{review.notice}</p></div></header>
    <div className="note-review-legend">{(Object.keys(labels) as Array<keyof typeof labels>).map(state => <span className={`nr-${state}`} key={state}><i />{labels[state]} {review.items.filter(n => n.state === state).length}</span>)}</div>
    <div className="note-review-tools"><label><input type="checkbox" checked={issuesOnly} onChange={e => { setIssuesOnly(e.target.checked); setPage(0); }} />只看需关注音符</label><span>{filtered.length} 条 · 蓝色为当前查看位置</span><AppButton disabled={!filtered.length} onClick={() => step(-1)}>上一个</AppButton><AppButton disabled={!filtered.length} onClick={() => step(1)}>下一个</AppButton></div>
    {score && review.xml ? <div className="note-review-score" ref={scrollRef}><OsmdScoreView xml={review.xml} engine={score} fitWidth activeNoteIds={activeId ? [activeId] : EMPTY}
      follow followSignal={review.items.findIndex(n => n.id === selectedId)} systemNoteIds={EMPTY} userNoteIds={EMPTY} colorSystemNotes={false} reviewStates={highlights}
      scrollRef={scrollRef} onSelectEvent={id => { const item = review.items.find(n => locations.get(n.id) === id); if (item) choose(item); }} /></div>
      : <p className="note-review-notice">{review.xml ? '谱面指纹不匹配，已停止定位，避免标错音符。' : '这条记录没有保存原始谱面，下面仍可查看全部已记录的音符反馈。'}</p>}
    <div className="note-review-body"><div className="note-review-list" aria-label="音符反馈列表">
      {!filtered.length && <p>{review.items.length ? '没有需要关注的音符，可以取消筛选查看全部。' : '没有可用的逐音符证据。'}</p>}
      {filtered.slice(page * 100, (page + 1) * 100).map(item => <AppButton key={item.id} className={`note-review-row nr-${item.state}`} aria-pressed={item.id === selectedId} onClick={() => choose(item)}>
        <strong>{item.measure ? `第 ${item.measure} 小节` : '未定位'} · {item.pitchLabel}</strong><span>{itemLabel(item)}</span></AppButton>)}
      {filtered.length > 100 && <nav aria-label="音符列表分页"><AppButton disabled={page === 0} onClick={() => setPage(p => p - 1)}>上一页</AppButton><span>{page + 1} / {Math.ceil(filtered.length / 100)}</span><AppButton disabled={(page + 1) * 100 >= filtered.length} onClick={() => setPage(p => p + 1)}>下一页</AppButton></nav>}
    </div><div className="note-review-inspector" aria-live="polite">
      {selected ? <><span className={`note-review-tag nr-${selected.state}`}>{itemLabel(selected)}</span><h4>{selected.measure ? `第 ${selected.measure} 小节 · ` : ''}{selected.pitchLabel}</h4>
        <ul>{selected.messages.map((message, index) => <li key={index}>{message}</li>)}</ul>
        {review.kind === 'timeline' && <dl><div><dt>起音偏差</dt><dd>{selected.onsetErrorMs === null ? '未判定' : `${selected.onsetErrorMs > 0 ? '+' : ''}${ms(selected.onsetErrorMs)}`}</dd></div><div><dt>目标按键时值</dt><dd>{ms(selected.expectedDurationMs)}</dd></div><div><dt>实际按键时值</dt><dd>{ms(selected.actualDurationMs)}</dd></div></dl>}
        {!locations.get(selected.id) && <p className="note-review-notice">本项没有可靠的谱面位置，未强行标到其他音符上。</p>}
      </> : <p>点击谱面音符或左侧条目，查看这次弹奏的具体反馈。</p>}
    </div></div>
  </section>;
}
