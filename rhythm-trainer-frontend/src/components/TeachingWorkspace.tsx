// Teaching workspace: create/resume a LessonRun, drive its steps through the
// Node orchestrator, and hand persisted Takes back via record-take.
//
// State authority: the server run (fetched via GET). React only caches the
// last response; localStorage at most remembers the last runId as a recovery
// pointer. No teaching rule, prescription or step legality is decided here.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import TeachingStepPanel from './TeachingStepPanel';
import OsmdScoreView from './OsmdScoreView';
import { buildScoreRangeBriefing } from '../features/teaching/scoreBriefing';
import type { ScoreDocument as EngineScoreDocument } from '../score-engine/domain/types';
import {
  loadLastRunId,
  saveLastRunId,
  TeachingApiError,
  teachingRunRepository,
  type CreateRunInput,
  type TeachingActionName,
  type TeachingPracticeRequest,
  type TeachingRunDTO,
} from '../services/teachingRunRepository';

const GOALS: Array<{ value: NonNullable<CreateRunInput['goal']>; label: string }> = [
  { value: 'learn-score', label: '学会这首曲子' },
  { value: 'rhythm', label: '重点练节奏' },
  { value: 'pitch', label: '重点练音高' },
  { value: 'duration', label: '重点练按键时值' },
  { value: 'rehearse', label: '连贯排练' },
];

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

interface Props {
  score: ScoreContext;
  /** Latest finished practice Take of this visit, if any (flow A handoff). */
  takeNotice: TeachingTakeNotice | null;
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

function errorMessage(error: unknown): string {
  if (error instanceof TeachingApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export default function TeachingWorkspace({ score, takeNotice, onStartPractice, onBackToWorkbench }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' });
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<TeachingActionName | null>(null);
  const [creating, setCreating] = useState(false);
  const [recoverableRunId, setRecoverableRunId] = useState<string | null>(null);

  const [goal, setGoal] = useState<NonNullable<CreateRunInput['goal']>>('learn-score');
  const [bpm, setBpm] = useState(score.bpm);
  const [hand, setHand] = useState<CreateRunInput['hand']>(score.hand);
  const [startMeasure, setStartMeasure] = useState(1);
  const [endMeasure, setEndMeasure] = useState(score.barCount);

  // Commands get one stable id per logical action; a timeout retry reuses it
  // so the server's idempotency — not a UI counter — deduplicates.
  const commandSeqRef = useRef(0);
  const commandIdFor = useCallback((action: string) => {
    commandSeqRef.current += 1;
    return `ui-${action}-${commandSeqRef.current}-${Math.random().toString(36).slice(2, 8)}`;
  }, []);
  const lastCommandByActionRef = useRef<Map<TeachingActionName, { id: string; revision: number }>>(new Map());
  const runRef = useRef<TeachingRunDTO | null>(null);
  runRef.current = phase.kind === 'run' ? phase.run : null;

  useEffect(() => {
    const last = loadLastRunId();
    if (last) setRecoverableRunId(last);
  }, []);

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

  const createRun = async () => {
    if (!score.fingerprint || creating) return;
    setCreating(true);
    setError(null);
    try {
      const run = await teachingRunRepository.createRun({
        scoreFingerprint: score.fingerprint,
        scoreBarCount: score.barCount,
        bpm,
        hand,
        startMeasure,
        endMeasure,
        goal,
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

  const act = async (runId: string, expectedRevision: number, action: TeachingActionName, takeId?: string): Promise<TeachingRunDTO | null> => {
    setBusyAction(action);
    setError(null);
    const commandId = commandIdFor(action);
    lastCommandByActionRef.current.set(action, { id: commandId, revision: expectedRevision });
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

  const run = phase.kind === 'run' ? phase.run : null;
  const fingerprintMatch = !!score.fingerprint && run?.scoreFingerprint === score.fingerprint;

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

  const setupInvalid = !score.fingerprint
    || !Number.isInteger(startMeasure) || startMeasure < 1
    || !Number.isInteger(endMeasure) || endMeasure < startMeasure || endMeasure > score.barCount
    || bpm < 20 || bpm > 300;

  if (phase.kind === 'loading') {
    return <section className="card teaching-card"><p>载入课程中…</p></section>;
  }

  if (phase.kind === 'setup') {
    return (
      <section className="card teaching-card" aria-label="创建教学课程">
        <div className="card-heading">
          <div>
            <div className="eyebrow">TEACHING WORKSPACE</div>
            <h3>老师带练</h3>
          </div>
          <button type="button" className="text-button" onClick={onBackToWorkbench}>返回练习工作台</button>
        </div>
        {!score.fingerprint ? (
          <p className="report-warning" role="status">
            还没有可用曲谱。请先在曲谱库打开或导入一份 MusicXML 曲谱，再开始教学；本页面不会用示例数据伪装课程。
          </p>
        ) : (
          <p className="teaching-score-line">
            当前曲谱：<strong>{score.title}</strong> · {score.barCount} 小节 · 指纹 {score.fingerprint.slice(0, 12)}…
          </p>
        )}
        <div className="teaching-setup" aria-label="课程设置">
          <label>
            学习目标
            <select value={goal} onChange={(event) => setGoal(event.target.value as typeof goal)}>
              {GOALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>
            开始小节
            <input type="number" min={1} max={score.barCount} value={startMeasure}
              onChange={(event) => setStartMeasure(Math.max(1, Math.min(score.barCount, Number(event.target.value) || 1)))} />
          </label>
          <label>
            结束小节
            <input type="number" min={1} max={score.barCount} value={endMeasure}
              onChange={(event) => setEndMeasure(Math.max(startMeasure, Math.min(score.barCount, Number(event.target.value) || startMeasure)))} />
          </label>
          <label>
            速度（BPM）
            <input type="number" min={20} max={300} step={1} value={bpm}
              onChange={(event) => setBpm(Math.max(20, Math.min(300, Number(event.target.value) || 72)))} />
          </label>
          <label>
            手别
            <select value={hand} onChange={(event) => setHand(event.target.value as CreateRunInput['hand'])}>
              <option value="both">双手</option>
              <option value="right">右手</option>
              <option value="left">左手</option>
            </select>
          </label>
        </div>
        <div className="teaching-actions">
          <button type="button" className="button button-primary" disabled={!score.fingerprint || setupInvalid || creating} onClick={() => void createRun()}>
            {creating ? '正在创建…' : '创建课程并开始'}
          </button>
          {recoverableRunId && (
            <button type="button" className="button button-outline" onClick={() => void refresh(recoverableRunId)}>
              恢复上次课程（{recoverableRunId.slice(0, 13)}…）
            </button>
          )}
        </div>
        {error && <p className="report-warning" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <>
      <TeachingStepPanel
        run={run!}
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
        onBackToWorkbench={onBackToWorkbench}
      />
      <TeachingScoreContent score={score} run={run!} />
    </>
  );
}

/** Read-only score facts + engraved score for the current teaching step. */
function TeachingScoreContent({ score, run }: { score: ScoreContext; run: TeachingRunDTO }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const step = run.currentStep;
  const range = step?.measureRange ?? { startMeasure: 1, endMeasure: score.barCount };
  const briefing = score.engine ? buildScoreRangeBriefing(score.engine, range) : null;

  return (
    <>
      {briefing && (
        <section className="card teaching-card teaching-briefing" aria-label="这段乐谱速览">
          <div className="card-heading">
            <div>
              <div className="eyebrow">SCORE BRIEFING</div>
              <h3>这段乐谱速览（第 {range.startMeasure}–{range.endMeasure} 小节）</h3>
            </div>
          </div>
          <div className="teaching-facts">
            <span>调号 <b>{briefing.keySignature ?? '—'}</b></span>
            <span>拍号 <b>{briefing.timeSignature ?? '—'}</b></span>
            <span>音符 <b>{briefing.noteCount}</b> 个</span>
            {briefing.restCount > 0 && <span>休止 <b>{briefing.restCount}</b> 个</span>}
            {briefing.lowestSpelling && briefing.highestSpelling && (
              <span>音域 <b>{briefing.lowestSpelling} – {briefing.highestSpelling}</b></span>
            )}
            {briefing.staffCounts.map((item) => (
              <span key={item.staff}>谱表 {item.staff} <b>{item.notes}</b> 音</span>
            ))}
            {briefing.busiestMeasure && (
              <span>音符最多 <b>第 {briefing.busiestMeasure.measure} 小节（{briefing.busiestMeasure.notes} 音）</b></span>
            )}
          </div>
          <p className="teaching-facts-note">
            以上是这段谱面的客观事实，供读谱参考；练习安排与下一步建议由教学服务根据已保存的演奏结果给出。
          </p>
        </section>
      )}
      {score.sourceXml && score.engine && (
        <section className="card teaching-card teaching-score-card" aria-label="乐谱视图">
          <div className="card-heading">
            <div>
              <div className="eyebrow">SCORE</div>
              <h3>乐谱（范围外小节已遮罩）</h3>
            </div>
            <span className="teaching-score-hint">左右滚动查看完整谱面</span>
          </div>
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
        </section>
      )}
    </>
  );
}
