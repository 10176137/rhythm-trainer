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
    if (input.isRelease) return;
    const result = session.noteOn(input.midi);
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
}: Props) {
  const { snapshot, lastResult, lastMidi, wrongFlash, refresh } = useSnapshot(session, input);
  const finishedRef = useRef(false);
  const [paused, setPaused] = useState(false);
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
  const accuracy = snapshot.totalWrongPresses === 0
    ? 100
    : Math.max(0, Math.round(100 - (snapshot.totalWrongPresses
      / Math.max(1, snapshot.completedQuestions * snapshot.currentTargets.length + snapshot.totalWrongPresses)) * 100));

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
            <span>一次弹对的题</span>
            <b>{snapshot.firstTryCorrectQuestions}</b>
          </div>
          <div className="reading-result-card">
            <span>错误输入次数</span>
            <b>{snapshot.totalWrongPresses}</b>
          </div>
          <div className="reading-result-card">
            <span>音高准确率（按错误输入占比）</span>
            <b>{accuracy}%</b>
          </div>
        </div>
        <div className="reading-result-weak">
          <h3>按被按键统计的错误输入</h3>
          {weak.length ? (
            <ul>
              {weak.map((item) => (
                <li key={item.midi}>{midiLabel(item.midi)} · {item.wrong} 次</li>
              ))}
            </ul>
          ) : (
            <p className="reading-muted">没有错误输入记录。</p>
          )}
          <p className="reading-muted">自由识谱不计时值与反应速度；以上数字全部来自本次真实 MIDI 输入。</p>
        </div>
        <div className="reading-result-actions">
          <button type="button" className="button button-primary" onClick={onRetrySameConfig}>重新练习同一配置</button>
          {onReviewWeak && <button type="button" className="button button-outline" onClick={onReviewWeak}>复习薄弱音</button>}
          <button type="button" className="button button-outline" onClick={onChangeConfig}>修改配置</button>
          <button type="button" className="text-button" onClick={onExit}>返回自由练习</button>
        </div>
      </section>
    );
  }

  return (
    <section className="reading-practice" aria-label="自由识谱练习">
      <header className="reading-topbar">
        <div className="reading-topbar-title">
          <span className="eyebrow">自由识谱</span>
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

      <div className="reading-feedback" aria-live="polite">
        <span>已命中 <b>{hitCount} / {total}</b></span>
        <span>
          最近输入：
          {lastResult === 'hit' && <b className="text-good">✓ {lastMidi !== null ? midiLabel(lastMidi) : ''} 命中</b>}
          {lastResult === 'duplicate' && <b>重复（已计过，不重复计分）</b>}
          {lastResult === 'wrong' && <b className="text-bad">✗ {lastMidi !== null ? midiLabel(lastMidi) : ''} 不是当前目标音</b>}
          {lastResult === null && <b>—</b>}
        </span>
      </div>

      <ReadingKeyboard
        states={keyStates}
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
