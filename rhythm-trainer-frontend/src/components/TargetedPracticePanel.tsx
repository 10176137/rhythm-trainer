// Flow B: targeted follow-up started from an already-persisted Take.
//
// This component is interaction-only. It sends the Take id plus the user's
// range/BPM/hand choice to `POST /api/teaching/runs/from-take`; the Node
// orchestrator reads the authoritative Take itself and runs the teaching
// strategy. No local diagnosis, weak-spot selection or BPM recommendation is
// computed here — that logic deliberately lives only in Node.

import { useState } from 'react';
import type { HandSelection } from '../types/practice';
import {
  TeachingApiError,
  teachingRunRepository,
} from '../services/teachingRunRepository';
import type { TeachingRunDTO } from '../services/teachingRunRepository';

interface Props {
  /** Ids of the report the user is reading; only the Take id is authoritative. */
  sourceReportId: string | null;
  sourceTakeId: string | null;
  sourceScoreFingerprint: string | null;
  activeScoreFingerprint: string | null;
  practiceBpm: number;
  practiceHand: HandSelection;
  scoreBarCount: number | null;
  /** Called when Node accepted the request and a lesson run was created. */
  onTeachingRunCreated: (run: TeachingRunDTO) => void;
  onNavigateTeaching: () => void;
}

export default function TargetedPracticePanel({
  sourceReportId: _sourceReportId,
  sourceTakeId,
  sourceScoreFingerprint,
  activeScoreFingerprint,
  practiceBpm,
  practiceHand,
  scoreBarCount,
  onTeachingRunCreated,
  onNavigateTeaching,
}: Props) {
  const maxMeasure = Math.max(1, Number.isInteger(scoreBarCount) && scoreBarCount ? scoreBarCount : 1);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBpm, setManualBpm] = useState(practiceBpm);
  const [manualHand, setManualHand] = useState<HandSelection>(practiceHand);
  const [manualStart, setManualStart] = useState(1);
  const [manualEnd, setManualEnd] = useState(Math.min(maxMeasure, 4));
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [createdRun, setCreatedRun] = useState<TeachingRunDTO | null>(null);
  const fingerprintMismatch = !sourceScoreFingerprint
    || !activeScoreFingerprint
    || sourceScoreFingerprint !== activeScoreFingerprint;
  const cannotStart = fingerprintMismatch || !sourceTakeId || creating;

  const openManualDefaults = () => {
    setManualBpm(practiceBpm);
    setManualHand(practiceHand);
    setManualStart(1);
    setManualEnd(Math.min(maxMeasure, 4));
    setManualOpen(true);
    setMessage(null);
  };

  const createFromTake = async (manualRange: boolean, startMeasure: number, endMeasure: number, bpm: number, hand: HandSelection) => {
    if (!sourceTakeId) return;
    setCreating(true);
    setMessage(null);
    try {
      const run = await teachingRunRepository.createRunFromTake({
        takeId: sourceTakeId,
        // Validated against the persisted Take server-side; mismatch = 409.
        scoreFingerprint: activeScoreFingerprint ?? undefined,
        scoreBarCount: maxMeasure,
        bpm,
        hand,
        startMeasure,
        endMeasure,
        manualRange,
      });
      setCreatedRun(run);
      onTeachingRunCreated(run);
      setMessage(`课程已创建（${run.runId.slice(0, 13)}…）。教学决策将在你把保存好的 Take 登记到课程后生成。`);
    } catch (error) {
      setMessage(error instanceof TeachingApiError ? error.message : `无法创建教学课程：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCreating(false);
    }
  };

  const startManual = () => {
    const start = Math.max(1, Math.min(maxMeasure, Math.floor(manualStart)));
    const end = Math.max(start, Math.min(maxMeasure, Math.floor(manualEnd)));
    void createFromTake(true, start, end, manualBpm, manualHand);
  };

  return (
    <section className="targeted-practice" aria-label="针对性复练">
      <div className="targeted-practice-head">
        <div>
          <div className="eyebrow">TARGETED PRACTICE · P09</div>
          <h4>基于这次结果开始教学</h4>
        </div>
        <button
          type="button"
          className="text-button targeted-practice-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '展开教学入口' : '收起'}
        </button>
      </div>
      {collapsed ? (
        <p className="targeted-footnote">教学入口已收起；报告内容未改变。</p>
      ) : (
        <>
          <p className="targeted-practice-intro">
            教学诊断由本地教学服务（Node）读取已保存的 Take 后给出；本页面只收集你的选择，不再在浏览器里计算薄弱小节或推荐速度。
          </p>

          {fingerprintMismatch && (
            <p className="report-warning" role="status">
              当前打开曲谱与这份报告不一致（或缺少曲谱指纹），不能创建教学课程。请先打开原曲谱再回到报告。
            </p>
          )}
          {!sourceTakeId && (
            <p className="report-warning" role="status">
              这份记录还没有 Take 标识，不能作为教学课程来源。
            </p>
          )}

          <div className="targeted-manual">
            <div className="targeted-manual-head">
              <div>
                <strong>从这份 Take 开始教学</strong>
                <small>范围只是你的选择，不是系统诊断；教学决策由 Node 在收到已保存 Take 后生成。</small>
              </div>
              <button type="button" className="text-button" onClick={() => (manualOpen ? setManualOpen(false) : openManualDefaults())}>
                {manualOpen ? '收起' : '选择范围并开始'}
              </button>
            </div>
            {manualOpen && (
              <div className="targeted-config targeted-manual-config">
                <label>
                  起始小节
                  <input
                    type="number"
                    min={1}
                    max={maxMeasure}
                    value={manualStart}
                    disabled={creating}
                    onChange={(event) => setManualStart(Math.max(1, Math.min(maxMeasure, Number(event.target.value) || 1)))}
                  />
                </label>
                <label>
                  结束小节
                  <input
                    type="number"
                    min={1}
                    max={maxMeasure}
                    value={manualEnd}
                    disabled={creating}
                    onChange={(event) => setManualEnd(Math.max(manualStart, Math.min(maxMeasure, Number(event.target.value) || manualStart)))}
                  />
                </label>
                <label>
                  BPM
                  <input
                    type="number"
                    min={20}
                    max={300}
                    step={1}
                    value={manualBpm}
                    disabled={creating}
                    onChange={(event) => setManualBpm(Math.max(20, Math.min(300, Number(event.target.value) || 72)))}
                  />
                </label>
                <label>
                  手别
                  <select value={manualHand} disabled={creating} onChange={(event) => setManualHand(event.target.value as HandSelection)}>
                    <option value="both">双手</option>
                    <option value="right">右手</option>
                    <option value="left">左手</option>
                  </select>
                </label>
                <button type="button" className="button button-primary" disabled={cannotStart} onClick={startManual}>
                  {creating ? '正在创建…' : '按所选范围创建教学课程'}
                </button>
              </div>
            )}
          </div>

          {createdRun && (
            <p className="targeted-message" role="status">
              课程 {createdRun.runId.slice(0, 13)}… 已就绪 ·{' '}
              <button type="button" className="text-button" onClick={onNavigateTeaching}>打开老师带练</button>
            </p>
          )}
          {message && <p className="targeted-message" role="status">{message}</p>}
          <p className="targeted-footnote">
            实际练习仍由既有 Rust 计划/评分链路执行；loop 只练所选范围一次，不会自动重复。当前未实现跨 Take 恢复或运行中变速。
          </p>
        </>
      )}
    </section>
  );
}
