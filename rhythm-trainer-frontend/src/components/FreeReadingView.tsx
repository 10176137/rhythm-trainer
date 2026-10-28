// Free note-reading practice + result view (task spec §5/§7.1). Presentation
// over FreeReadingSession; all decisions come from the session module, never
// from ad-hoc UI state. Real notation via OSMD; the keyboard is feedback and
// simulator input, never a target pre-highlight.

import { useEffect, useMemo, useRef, useState } from 'react';
import OsmdScoreView from './OsmdScoreView';
import ReadingKeyboard, { type ReadingKeyState } from './ReadingKeyboard';
import { questionStaff, questionXml, type ReadingStaffPreference } from '../features/reading/readingGenerator';
import { midiLabel, type KeySelection } from '../features/reading/readingKeys';
import { FreeReadingSession, type FreeReadingSnapshot } from '../features/reading/freeReadingSession';
import { importScoreText } from '../features/score/scoreImport';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';

export interface FreeReadingInputEvent {
  midi: number;
  isRelease: boolean;
  seq: number;
  result: 'hit' | 'duplicate' | 'wrong' | 'ignored';
}

interface Props {
  session: FreeReadingSession;
  /** The setup the session was generated from (key/staff preference for rendering). */
  setup: { key: KeySelection | null; staffPreference: ReadingStaffPreference } | null;
  /** Bumps whenever App forwards a new MIDI note-on/off. */
  input: FreeReadingInputEvent | null;
  deviceConnected: boolean;
  onInput: (midi: number, isRelease: boolean) => void;
  onFinish: (status: 'completed' | 'ended-early') => void;
  onRetrySameConfig: () => void;
  onReviewWeak: (() => void) | null;
  onChangeConfig: () => void;
  onExit: () => void;
  saveStatus: { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string };
  onRetrySave: () => void;
  onStartTest: (() => void) | null;
  onNextLevel: (() => void) | null;
}

function useSnapshot(session: FreeReadingSession, input: FreeReadingInputEvent | null): {
  snapshot: FreeReadingSnapshot;
  lastResult: 'hit' | 'duplicate' | 'wrong' | null;
  lastMidi: number | null;
  wrongFlash: number;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<FreeReadingSnapshot>(() => session.snapshot());
  const [lastResult, setLastResult] = useState<'hit' | 'duplicate' | 'wrong' | null>(null);
  const [lastMidi, setLastMidi] = useState<number | null>(null);
  const [wrongFlash, setWrongFlash] = useState(0);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!input || input.seq === lastSeqRef.current) return;
    lastSeqRef.current = input.seq;
    if (input.isRelease) { setSnapshot(session.snapshot()); return; }
    const result = input.result;
    setLastMidi(input.midi);
    setLastResult(result === 'ignored' ? null : result);
    if (result === 'wrong') setWrongFlash((value) => value + 1);
    setSnapshot(session.snapshot());
  }, [input, session]);

  return { snapshot, lastResult, lastMidi, wrongFlash, refresh: () => setSnapshot(session.snapshot()) };
}

export default function FreeReadingView({
  session,
  setup,
  input,
  deviceConnected,
  onInput,
  onFinish,
  onRetrySameConfig,
  onReviewWeak,
  onChangeConfig,
  onExit,
  saveStatus, onRetrySave, onStartTest, onNextLevel,
}: Props) {
  const { snapshot, lastResult, lastMidi, wrongFlash, refresh } = useSnapshot(session, input);
  const finishedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const [hintedIndex, setHintedIndex] = useState<number | null>(null);
  const scoreScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if ((snapshot.status === 'completed' || snapshot.status === 'ended-early') && !finishedRef.current) {
      finishedRef.current = true;
      onFinish(snapshot.status === 'completed' ? 'completed' : 'ended-early');
    }
  }, [snapshot.status, onFinish]);

  const question = session.questions[snapshot.currentIndex] ?? [];
  const staff = useMemo(
    () => (question.length ? questionStaff(question, setup?.staffPreference ?? 'auto') : 1),
    [question, setup?.staffPreference],
  );
  const xml = useMemo(
    () => (question.length ? questionXml(question, staff, setup?.key ?? null) : null),
    [question, staff, setup?.key],
  );
  const engineDoc = useMemo<EngineScoreDocument | null>(() => {
    if (!xml) return null;
    return importScoreText(xml, 'question.musicxml').doc?.engine ?? null;
  }, [xml]);

  const keyStates = useMemo(() => {
    const states = new Map<number, ReadingKeyState>();
    if (lastMidi !== null) {
      if (lastResult === 'wrong') states.set(lastMidi, 'wrong');
      else if (lastResult === 'hit' || lastResult === 'duplicate') states.set(lastMidi, 'hit');
    }
    if (!paused && lastResult === 'wrong' && lastMidi !== null) {
      // wrongFlash drives a re-render; CSS transition handles the fade.
      void wrongFlash;
    }
    return states;
  }, [lastMidi, lastResult, paused, wrongFlash]);

  const hitCount = snapshot.currentHits.length;
  const total = snapshot.currentTargets.length;
  const finished = snapshot.status === 'completed' || snapshot.status === 'ended-early';

  if (finished) {
    const weak = session.weakestPitches(6);
    return (
      <section className="reading-result" aria-label="自由识谱结果">
        <header className="reading-result-head">
          <div>
            <div className="eyebrow">RESULT</div>
            <h2>{snapshot.status === 'completed' ? '自由识谱完成' : '已提前结束'}</h2>
            <p>{snapshot.status === 'completed' ? '全部题目完成。' : '保留了已作答题目的真实记录。'}</p>
          </div>
        </header>
        <div className="reading-result-grid">
          <div className="reading-result-card">
            <span>完成题数</span>
            <b>{snapshot.completedQuestions} / {snapshot.questionCount}</b>
          </div>
          <div className="reading-result-card">
            <span>首次答对率</span>
            <b>{snapshot.firstTryAccuracy == null ? '尚未评估' : `${snapshot.firstTryAccuracy}%`}</b>
          </div>
          <div className="reading-result-card">
            <span>需要再练</span>
            <b>{session.reviewQuestions().length} 题</b>
          </div>

        </div>
        <div className="reading-result-weak">
          <h3>再巩固这些目标音</h3>
          {weak.length ? (
            <ul>
              {weak.map((item) => (
                <li key={item.midi}>{midiLabel(item.midi)} · 出错时尚未完成的目标</li>
              ))}
            </ul>
          ) : (
            <p className="reading-muted">没有错误输入记录。</p>
          )}
          <p className="reading-muted">和弦只记录出错时尚未完成的目标组，不猜测你想按哪个音。</p>
        </div>
        <p className={`reading-save-state ${saveStatus.status === 'error' ? 'text-bad' : ''}`} role="status">
          {saveStatus.status === 'saved' ? '结果已保存到本机' : saveStatus.status === 'saving' ? '正在保存…' : saveStatus.status === 'error' ? (saveStatus.message ?? '结果尚未保存') : ''}
          {saveStatus.status === 'error' && <button type="button" onClick={onRetrySave}>重试保存</button>}
        </p>
        <div className="reading-result-actions">
          {onReviewWeak ? <button type="button" className="button button-primary" onClick={onReviewWeak}>复习这些错题</button>
            : onStartTest ? <button type="button" className="button button-primary" onClick={onStartTest}>换一组题开始小测</button>
            : onNextLevel ? <button type="button" className="button button-primary" onClick={onNextLevel}>尝试更多同时音符</button> : null}
          <button type="button" className={`button ${onReviewWeak || onStartTest || onNextLevel ? 'button-outline' : 'button-primary'}`} onClick={onRetrySameConfig}>换题再练</button>
          <button type="button" className="button button-outline" onClick={onChangeConfig}>修改配置</button>
          <button type="button" className="text-button" onClick={onExit}>返回识谱</button>
        </div>
        <details className="reading-evidence"><summary>查看详细结果</summary>
          <p>{snapshot.task === 'test' ? '小测 · 无提示' : '练习'} · 用过提示 {snapshot.hintedQuestions} 题 · 错误输入 {snapshot.totalWrongPresses} 次</p>
          <p>首次答对 {snapshot.firstTryCorrectQuestions}/{snapshot.attemptedQuestions} 道已作答题；实际按键命中率 {snapshot.hitAccuracy == null ? '尚未评估' : `${snapshot.hitAccuracy}%`}。重复按已命中的键不重复计数。</p>
          {snapshot.confusions.slice(0, 12).map((c, i) => <p key={i}>第 {c.questionIndex + 1} 题：目标 {c.remainingTargets.map(midiLabel).join('＋')} → 误按 {midiLabel(c.pressed)}</p>)}
        </details>

      </section>
    );
  }

  return (
    <section className="reading-practice" aria-label="自由识谱练习">
      <header className="reading-topbar">
        <div className="reading-topbar-title">
          <span className="eyebrow">{session.task === 'test' ? '识谱小测' : '识谱练习'}</span>
          <strong>第 {snapshot.currentIndex + 1} / {snapshot.questionCount} 题</strong>
          <span className="reading-topbar-meta">不限时 · 弹对全部目标音进入下一题</span>
        </div>
        <div className="reading-topbar-actions">
          <button
            type="button"
            className="button button-outline button-small"
            onClick={() => {
              if (paused) { session.resume(); setPaused(false); } else { session.pause(); setPaused(true); }
              refresh();
            }}
          >
            {paused ? '▶ 继续' : 'Ⅱ 暂停'}
          </button>
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={() => { session.endEarly(); refresh(); }}
          >
            结束并查看结果
          </button>
        </div>
      </header>

      <div className="reading-score-stage">
        {xml && engineDoc ? (
          <OsmdScoreView
            xml={xml}
            engine={engineDoc}
            activeNoteIds={[]}
            follow={false}
            followSignal={0}
            systemNoteIds={[]}
            userNoteIds={[]}
            colorSystemNotes={false}
            zoom={2.4}
            scrollRef={scoreScrollRef}
            onSelectEvent={() => {}}
          />
        ) : (
          <p className="report-warning">题目渲染缺失。</p>
        )}
        {paused && <div className="reading-paused-overlay">已暂停 — 输入被忽略，按「继续」恢复</div>}
      </div>

      {session.task === 'practice' && <div className="reading-feedback" aria-live="polite">
        <span>已命中 <b>{hitCount} / {total}</b></span>
        <span>
          最近输入：
          {lastResult === 'hit' && <b className="text-good">✓ {lastMidi !== null ? midiLabel(lastMidi) : ''} 命中</b>}
          {lastResult === 'duplicate' && <b>重复（已计过，不重复计分）</b>}
          {lastResult === 'wrong' && <b className="text-bad">✗ {lastMidi !== null ? midiLabel(lastMidi) : ''} 不是当前目标音</b>}
          {lastResult === null && <b>—</b>}
        </span>
      </div>}
      {session.task === 'test' && <p className="reading-muted">小测不提供答案提示，结果在结束后显示。</p>}
      {session.task === 'practice' && <div className="reading-hint-action">
        <button type="button" className="text-button" disabled={paused || hintedIndex === snapshot.currentIndex} onClick={() => { if (session.hint()) { setHintedIndex(snapshot.currentIndex); refresh(); } }}>查看本题提示</button>
        {hintedIndex === snapshot.currentIndex && <span>目标：{question.map(midiLabel).join('＋')}（本题记录为使用过提示）</span>}
      </div>}

      <ReadingKeyboard
        states={session.task === 'test' ? new Map() : keyStates}
        disabled={deviceConnected || paused}
        onPress={(midi) => onInput(midi, false)}
        onRelease={(midi) => onInput(midi, true)}
      />
      <p className="reading-hint">
        {deviceConnected
          ? '已连接 MIDI 设备：直接在琴上弹奏；下方键盘仅作反馈显示。'
          : '未连接 MIDI：点击下方键盘输入（按下即 Note On）。目标音不会预先高亮。'}
      </p>
    </section>
  );
}
