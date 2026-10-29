// Teaching workspace V1: one screen for the whole lesson — course picker or
// live lesson, score on the left, teacher on the right, one primary action.
//
// State authority: the server LessonRun (fetched via GET). React only caches
// the last response; localStorage at most remembers the last runId as a
// recovery pointer. No teaching rule, prescription, practice config or step
// legality is decided here.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import TeachingStepPanel from './TeachingStepPanel';
import TeachingStepTrack from './TeachingStepTrack';
import OsmdScoreView from './OsmdScoreView';
import { buildScoreRangeBriefing } from '../features/teaching/scoreBriefing';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';
import {
  loadLastRunId,
  saveLastRunId,
  TeachingApiError,
  teachingRunRepository,
  type TeachingActionName,
  type TeachingLessonSummary,
  type TeachingMeasureRange,
  type TeachingPracticeRequest,
  type TeachingRunDTO,
} from '../services/teachingRunRepository';

interface ScoreContext {
  fingerprint: string | null;
  title: string;
  barCount: number;
  /** Current practice config defaults the setup form starts from. */
  bpm: number;
  hand: 'left' | 'right' | 'both';
  /** Original MusicXML + semantic engine doc for the read-only score view. */
  sourceXml: string | null;
  engine: EngineScoreDocument | null;
  /** Why the current score cannot start a practice step right now (null = ok). */
  practiceStartBlock: string | null;
}

export interface TeachingTakeNotice {
  takeId: string;
  persisted: boolean;
  status: string;
  fingerprint: string | null;
}

export type TeachingInputStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface Props {
  score: ScoreContext;
  /** Latest finished practice Take of this visit, if any (flow A handoff). */
  takeNotice: TeachingTakeNotice | null;
  inputStatus: TeachingInputStatus;
  /**
   * Pins the Node-authored practiceRequest onto the practice room config.
   * Return false (config mismatch / practice in progress) to stay put.
   */
  onStartPractice: (request: TeachingPracticeRequest) => boolean;
  onBackToWorkbench: () => void;
}

type Phase =
  | { kind: 'setup' }
  | { kind: 'loading'; runId: string }
  | { kind: 'run'; run: TeachingRunDTO };

const INPUT_CN: Record<TeachingInputStatus, string> = {
  connected: 'MIDI 已连接',
  connecting: 'MIDI 连接中',
  error: 'MIDI 错误',
  disconnected: 'MIDI 未连接',
};

const DIFFICULTY_CN: Record<TeachingLessonSummary['difficulty'], string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
};

function errorMessage(error: unknown): string {
  if (error instanceof TeachingApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export default function TeachingWorkspace({
  score,
  takeNotice,
  inputStatus,
  onStartPractice,
  onBackToWorkbench,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<TeachingActionName | null>(null);
  const [creating, setCreating] = useState(false);
  const [recoverableRunId, setRecoverableRunId] = useState<string | null>(null);

  const [lessons, setLessons] = useState<TeachingLessonSummary[] | null>(null);
  const [lessonsError, setLessonsError] = useState<string | null>(null);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const [firstHand, setFirstHand] = useState<'left' | 'right'>(score.hand === 'left' ? 'left' : 'right');
  const [bpm, setBpm] = useState(score.bpm);
  const [startMeasure, setStartMeasure] = useState(1);
  const [endMeasure, setEndMeasure] = useState(score.barCount);

  const loadLessons = useCallback(() => {
    setLessonsError(null);
    teachingRunRepository.listLessons()
      .then((list) => {
        setLessons(list);
        setLessonId((current) => current && list.some((item) => item.lessonId === current)
          ? current
          : list[0]?.lessonId ?? null);
      })
      .catch((err) => setLessonsError(`课程目录载入失败：${errorMessage(err)}`));
  }, []);
  useEffect(() => { loadLessons(); }, [loadLessons]);

  // Commands get one stable id per logical action; a timeout retry reuses it
  // so the server's idempotency — not a UI counter — deduplicates.
  const commandSeqRef = useRef(0);
  const commandIdFor = useCallback((action: string) => {
    commandSeqRef.current += 1;
    return `ui-${action}-${commandSeqRef.current}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);
  const runRef = useRef<TeachingRunDTO | null>(null);
  runRef.current = phase.kind === 'run' ? phase.run : null;

  useEffect(() => {
    const last = loadLastRunId();
    if (last) setRecoverableRunId(last);
  }, []);

  // The score loads asynchronously after the route mounts; when it changes,
  // re-default the range to the new score instead of keeping the placeholder.
  const scoreKeyRef = useRef(`${score.fingerprint}:${score.barCount}`);
  useEffect(() => {
    const key = `${score.fingerprint}:${score.barCount}`;
    if (scoreKeyRef.current === key) return;
    scoreKeyRef.current = key;
    setStartMeasure(1);
    setEndMeasure(score.barCount);
    setBpm(score.bpm);
    setFirstHand(score.hand === 'left' ? 'left' : 'right');
  }, [score.fingerprint, score.barCount, score.bpm, score.hand]);

  const applyRun = useCallback((run: TeachingRunDTO) => {
    saveLastRunId(run.runId);
    setRecoverableRunId(run.runId);
    setPhase({ kind: 'run', run });
  }, []);

  const refresh = useCallback(async (runId: string) => {
    setPhase({ kind: 'loading', runId });
    try {
      applyRun(await teachingRunRepository.getRun(runId));
      setError(null);
    } catch (err) {
      setPhase({ kind: 'setup' });
      setError(err instanceof TeachingApiError && err.status === 404
        ? '上次的课程不存在或已被清理，请重新创建。'
        : `读取课程失败：${errorMessage(err)}`);
    }
  }, [applyRun]);

  const act = async (runId: string, expectedRevision: number, action: TeachingActionName, takeId?: string): Promise<TeachingRunDTO | null> => {
    setBusyAction(action);
    setError(null);
    const commandId = commandIdFor(action);
    try {
      const run = await teachingRunRepository.applyAction(runId, {
        commandId,
        expectedRevision,
        action,
        ...(takeId ? { takeId } : {}),
      });
      applyRun(run);
      return run;
    } catch (err) {
      if (err instanceof TeachingApiError && err.code === 'STALE_TEACHING_REVISION') {
        // Do not blind-retry an old action: refetch, let the user look.
        await refresh(runId);
        setError('课程已在其他地方更新，已刷新到最新状态；请重新确认操作。');
      } else {
        setError(errorMessage(err));
      }
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const createRun = async () => {
    if (!score.fingerprint || !lessonId || creating) return;
    setCreating(true);
    setError(null);
    try {
      const run = await teachingRunRepository.createRun({
        scoreFingerprint: score.fingerprint,
        scoreBarCount: score.barCount,
        lessonId,
        firstHand,
        bpm,
        startMeasure,
        endMeasure,
        // V1: the reference playback binding is not wired into this workspace
        // yet; an unavailable reference must never become a silent button.
        referenceAvailable: false,
      });
      applyRun(run);
      await act(run.runId, run.revision, 'begin');
    } catch (err) {
      setError(`无法创建课程：${errorMessage(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleAction = (action: TeachingActionName) => {
    const run = runRef.current;
    if (!run || busyAction) return;
    void act(run.runId, run.revision, action);
  };

  const handleStartPractice = () => {
    const run = runRef.current;
    const request = run?.currentStep?.practiceRequest;
    if (!request) {
      onBackToWorkbench();
      return;
    }
    // Pin the exact server-authored range/tempo/hand onto the practice room;
    // the actual engine launch still runs there through the existing gates.
    const ok = onStartPractice(request);
    if (ok) onBackToWorkbench();
  };

  const handleRestart = () => {
    saveLastRunId(null);
    setRecoverableRunId(null);
    setError(null);
    setPhase({ kind: 'setup' });
  };

  const run = phase.kind === 'run' ? phase.run : null;
  const fingerprintMatch = !!score.fingerprint && run?.scoreFingerprint === score.fingerprint;
  const lessonTitle = run?.lesson?.title
    ?? lessons?.find((item) => item.lessonId === lessonId)?.title
    ?? '选择课程';

  // Flow A handoff: a freshly persisted Take from the practice room is
  // recorded into the active practice step exactly once (revision-guarded).
  const recordedTakeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!run || !takeNotice || takeNotice.takeId === recordedTakeRef.current) return;
    const step = run.currentStep;
    if (run.status !== 'in_progress' || !step
      || !['guided_practice', 'focused_practice', 'independent_performance'].includes(step.kind)) return;
    if (!takeNotice.persisted) return; // pending-retry: never submitted
    if (run.takeRefs.some((ref) => ref.takeId === takeNotice.takeId)) return;
    if (takeNotice.fingerprint && takeNotice.fingerprint !== run.scoreFingerprint) return;
    recordedTakeRef.current = takeNotice.takeId;
    void act(run.runId, run.revision, 'record-take', takeNotice.takeId);
  }, [run, takeNotice]);

  const completedSteps = run ? run.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length : 0;
  const totalSteps = run?.steps.length ?? 0;
  const currentTitle = run?.currentStep?.title ?? (run?.status === 'completed' ? '课程已完成' : '准备开始');
  const range: TeachingMeasureRange = run?.currentStep?.measureRange
    ?? run?.steps.find((step) => step.measureRange)?.measureRange
    ?? { startMeasure: 1, endMeasure: score.barCount };

  const setupInvalid = !score.fingerprint
    || !lessonId
    || !Number.isInteger(startMeasure) || startMeasure < 1
    || !Number.isInteger(endMeasure) || endMeasure < startMeasure || endMeasure > score.barCount
    || bpm < 20 || bpm > 300;

  return (
    <div className="teaching-workspace">
      <header className="teaching-topbar">
        <div className="teaching-topbar-title">
          <span className="eyebrow">学习</span>
          <strong>{phase.kind === 'setup' ? '选择一节课程' : lessonTitle}</strong>
          {phase.kind !== 'setup' && <span className="teaching-topbar-step">{currentTitle}</span>}
        </div>
        <div className="teaching-topbar-meta">
          <span className={`teaching-input ${inputStatus === 'connected' ? 'ok' : ''}`}>
            <i />{INPUT_CN[inputStatus]}
          </span>
          {run && <span className="teaching-topbar-progress">进度 {completedSteps}/{totalSteps}</span>}
          <button type="button" className="text-button" onClick={onBackToWorkbench}>退出学习</button>
        </div>
      </header>

      {phase.kind === 'loading' && <p className="teaching-loading">载入课程中…</p>}

      {phase.kind === 'setup' && (
        <div className="teaching-body teaching-setup-body">
          <TeachingScorePane score={score} range={{ startMeasure, endMeasure }} heading="课程范围预览" />
          <section className="teaching-coach" aria-label="课程选择">
            <div className="teaching-coach-scroll">
              <div className="teaching-coach-head">
                <div>
                  <div className="eyebrow">LESSONS</div>
                  <h2>选一节要练的课</h2>
                  <p className="teaching-coach-sub">每节课都会按 单手 → 另一只手 → 合手 → 原速通过检查 的顺序带练；你选定的小节范围每阶段练一遍。</p>
                </div>
              </div>

              {lessonsError && (
                <p className="report-warning" role="alert">
                  {lessonsError}{' '}
                  <button type="button" className="text-button" onClick={loadLessons}>重试</button>
                </p>
              )}
              {!lessonsError && !lessons && <p className="teaching-muted">载入课程目录…</p>}
              {lessons && (
                <div className="lesson-picker" role="radiogroup" aria-label="课程目录">
                  {lessons.map((item) => (
                    <button
                      key={item.lessonId}
                      type="button"
                      role="radio"
                      aria-checked={lessonId === item.lessonId}
                      className={`lesson-card ${lessonId === item.lessonId ? 'selected' : ''}`}
                      onClick={() => setLessonId(item.lessonId)}
                    >
                      <span className="lesson-card-top">
                        <strong>{item.title}</strong>
                        <small>{DIFFICULTY_CN[item.difficulty]} · v{item.version}</small>
                      </span>
                      <span className="lesson-card-desc">{item.description}</span>
                      <span className="lesson-card-foot">
                        目标：{item.learningObjectives.map((objective) => objective.statement).join(' / ')}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {!score.fingerprint && (
                <p className="report-warning" role="status">
                  还没有可用曲谱。请先在曲谱库打开或导入一份 MusicXML 曲谱，再开始教学；本页面不会用示例数据伪装课程。
                </p>
              )}

              <details className="teaching-setup-details"><summary>调整课程 <span>第 {startMeasure}–{endMeasure} 小节 · {bpm} BPM · {firstHand === 'right' ? '先右手' : '先左手'}</span></summary>
              <div className="teaching-setup" aria-label="课程设置">
                <label>
                  循环范围（开始小节）
                  <input
                    type="number" min={1} max={score.barCount} value={startMeasure}
                    onChange={(event) => {
                      const start = Math.max(1, Math.min(score.barCount, Number(event.target.value) || 1));
                      setStartMeasure(start);
                      setEndMeasure((end) => Math.max(start, end));
                    }}
                  />
                </label>
                <label>
                  循环范围（结束小节）
                  <input
                    type="number" min={1} max={score.barCount} value={endMeasure}
                    onChange={(event) => setEndMeasure(Math.max(startMeasure, Math.min(score.barCount, Number(event.target.value) || startMeasure)))}
                  />
                </label>
                <label>
                  目标速度（BPM）
                  <input
                    type="number" min={20} max={300} step={1} value={bpm}
                    onChange={(event) => setBpm(Math.max(20, Math.min(300, Number(event.target.value) || 72)))}
                  />
                </label>
                <label>
                  先练哪只手
                  <select value={firstHand} onChange={(event) => setFirstHand(event.target.value as 'left' | 'right')}>
                    <option value="right">先右手</option>
                    <option value="left">先左手</option>
                  </select>
                </label>
              </div>
              </details>
              <p className="teaching-muted">
                当前曲谱：{score.title} · {score.barCount} 小节
              </p>
            </div>
            <div className="teaching-action-bar" aria-label="开始学习">
              {error && <p className="report-warning" role="alert">{error}</p>}
              <div className="teaching-action-row">
                <button
                  type="button"
                  className="button button-primary teaching-primary-action"
                  disabled={setupInvalid || creating}
                  onClick={() => void createRun()}
                >
                  {creating ? '正在创建…' : '开始学习'}
                </button>
                <div className="teaching-action-links">
                  {recoverableRunId && (
                    <button type="button" className="text-button" onClick={() => void refresh(recoverableRunId)}>
                      恢复上次课程（{recoverableRunId.slice(0, 13)}…）
                    </button>
                  )}
                  <button type="button" className="text-button" onClick={onBackToWorkbench}>返回自由练习</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {run && (
        <div className="teaching-body">
          <div className="teaching-score-column">
            <TeachingStepTrack run={run} />
            <TeachingScorePane score={score} range={range} heading="本阶段乐谱" />
          </div>
          <TeachingStepPanel
            run={run}
            fingerprintMatch={fingerprintMatch}
            busyAction={busyAction}
            error={error}
            onAction={handleAction}
            onStartPractice={handleStartPractice}
            practiceStartBlock={score.practiceStartBlock}
            takePending={takeNotice ? {
              takeId: takeNotice.takeId,
              persisted: takeNotice.persisted,
              status: takeNotice.status,
            } : null}
            onRestart={handleRestart}
            onExit={onBackToWorkbench}
          />
        </div>
      )}
    </div>
  );
}

/** Read-only score facts + engraved score for the current teaching step. */
function TeachingScorePane({ score, range, heading }: { score: ScoreContext; range: TeachingMeasureRange; heading: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const briefing = score.engine ? buildScoreRangeBriefing(score.engine, range) : null;

  return (
    <section className="teaching-score-pane" aria-label={heading}>
      <div className="teaching-pane-head">
        <div>
          <div className="eyebrow">SCORE</div>
          <h3>{heading} · 第 {range.startMeasure}–{range.endMeasure} 小节</h3>
        </div>
        <span className="teaching-score-hint">谱面只在框内滚动</span>
      </div>
      {briefing && (
        <div className="teaching-facts" aria-label="这段乐谱速览">
          <span>调号 <b>{briefing.keySignature ?? '—'}</b></span>
          <span>拍号 <b>{briefing.timeSignature ?? '—'}</b></span>
          <span>音符 <b>{briefing.noteCount}</b></span>
          {briefing.restCount > 0 && <span>休止 <b>{briefing.restCount}</b></span>}
          {briefing.lowestSpelling && briefing.highestSpelling && (
            <span>音域 <b>{briefing.lowestSpelling}–{briefing.highestSpelling}</b></span>
          )}
          {briefing.staffCounts.map((item) => (
            <span key={item.staff}>谱表 {item.staff} <b>{item.notes}</b> 音</span>
          ))}
          {briefing.busiestMeasure && (
            <span>最密 <b>第 {briefing.busiestMeasure.measure} 小节</b></span>
          )}
        </div>
      )}
      {score.sourceXml && score.engine ? (
        <div className="teaching-score-scroll" ref={scrollRef as RefObject<HTMLDivElement>}>
          <OsmdScoreView
            xml={score.sourceXml}
            engine={score.engine}
            activeNoteIds={[]}
            follow={false}
            followSignal={0}
            systemNoteIds={[]}
            userNoteIds={[]}
            loopCoveredMeasures={Array.from({ length: score.barCount }, (_, index) => index + 1)
              .filter((measure) => measure < range.startMeasure || measure > range.endMeasure)}
            colorSystemNotes={false}
            scrollRef={scrollRef}
            onSelectEvent={() => {}}
          />
        </div>
      ) : (
        <p className="report-warning" role="status">
          当前曲谱没有可用的语义数据，无法显示谱面。请先在曲谱库打开或导入 MusicXML。
        </p>
      )}
    </section>
  );
}
