import type { GeneratedSkillDrill, TrainingProgramReview } from '../../shared/training-contract';
import type { usePracticeSession } from '../features/practice/usePracticeSession';
import type { SessionStatus } from '../types/practice';
import ReportPanel from './ReportPanel';
import { ProgramReview } from './TrainingProgramPanel';
interface Props {
  trainingDrill: GeneratedSkillDrill; session: ReturnType<typeof usePracticeSession>; status: SessionStatus;
  programReview: TrainingProgramReview | null; programCompleted: boolean; programBusy: boolean; programError: string; reportUnsaved: boolean;
  onRetry: () => void; onStop: () => void; onAdjust: () => void;
}
/** Presents only saved server evidence; no grading or continuation decisions. */
export default function TrainingRoundPanel({ trainingDrill, session, status, programReview, programCompleted, programBusy, programError,
  reportUnsaved, onRetry, onStop, onAdjust }: Props) {
  return <section className="card training-round-context" aria-label="本轮专项">
            <strong>{trainingDrill.title}</strong>
            <p>{trainingDrill.lesson.pattern}</p>
            {programReview && <ProgramReview review={programReview} />}
            {programCompleted && <p role="status">本次定时训练计划已完成，结果已保存。</p>}
            {trainingDrill.program?.remainingSeconds != null && !programCompleted && <p>本段约 {Math.round(trainingDrill.program.seconds)} 秒；完成后计划还剩约 {Math.ceil(trainingDrill.program.remainingSeconds / 60)} 分钟。</p>}
            {programBusy && <p role="status">正在读取已保存的引擎结果{trainingDrill.program?.config.mode === 'continuous' ? '，合格证据确认后自动准备下一段' : ''}…</p>}
            {programError && <div role="alert"><p>{programError}</p><button className="button button-outline" onClick={onRetry}>重试读取结果</button></div>}
            {trainingDrill.program && trainingDrill.program.config.mode !== 'assessment' && programBusy && <button className="button button-outline" onClick={onStop}>停止接续</button>}
            {status === 'completed' && <>
              <h2>本轮已结束</h2>
              <p>本轮关注：{trainingDrill.lesson.review}</p>
              {session.report && session.scoreInputNoteCount > 0 && <div className="training-result-stats" aria-label="本轮引擎统计">
                <span>节奏命中率 <b>{Math.round(session.report.stats.targetHitRate * 100)}%</b></span>
                <span>漏击 <b>{session.report.stats.missCount}</b></span>
                <span>平均起音偏差 <b>{session.report.stats.meanAbsoluteMs == null ? '—' : `${session.report.stats.meanAbsoluteMs.toFixed(1)} ms`}</b></span>
              </div>}
              {session.report && session.scoreInputNoteCount === 0 && <p role="status">本轮未记录到演奏输入，尚不能评估练习效果。连接键盘后再试一次。</p>}
              {session.report && !session.report.trustworthy && <p role="status">本轮测量可信度不足，请展开报告查看原因；这些数值不能用于判断是否掌握。</p>}
              {session.report && <details className="training-round-report">
                <summary>本轮结果 · {session.reportPersisted ? '已保存' : '等待保存'}</summary>
                <ReportPanel report={session.report} analysis={session.analysis} durations={session.durations}
                  scoreV1={session.scoreV1} scoreStatus={session.scoreStatus} scoringConfig={session.scoringConfig}
                  practiceBpm={trainingDrill.bpm} practiceHand={trainingDrill.hand} />
              </details>}
              <p className="training-self-check">自查：{trainingDrill.lesson.selfCheck}</p>
              <div className="training-result-actions">
                <button type="button" className="button button-outline" disabled={reportUnsaved} onClick={onAdjust}>调整本专项</button>
              </div>
            </>}
          </section>;
}
