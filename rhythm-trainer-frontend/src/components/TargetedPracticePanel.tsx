import { useMemo, useState } from 'react';
import type { EngineDurationReport, EngineScoreStatus, EngineSessionScoreReport } from '../types/engine';
import type { HandSelection } from '../types/practice';
import type { TargetedPracticeStartRequest, TeachingPrescription } from '../types/teaching';
import {
  buildManualPrescription,
  buildTeachingPrescriptions,
} from '../features/practice/teachingPrescription';

interface Props {
  scoreV1: EngineSessionScoreReport | { error: string } | null;
  scoreStatus: EngineScoreStatus | null;
  durations?: EngineDurationReport | { error: string } | null;
  sourceReportId: string | null;
  sourceTakeId: string | null;
  sourceScoreFingerprint: string | null;
  activeScoreFingerprint: string | null;
  practiceBpm: number;
  practiceHand: HandSelection;
  scoreBarCount: number | null;
  onStartTargetedPractice?: (request: TargetedPracticeStartRequest) => Promise<boolean> | boolean;
}

const PROBLEM_CN: Record<string, string> = {
  'local-onset': '局部起音',
  'missing-notes': '漏音',
  duration: '按键时值',
  'pitch-errors': '错音',
  'extra-notes': '额外音',
  'manual-range': '手动选择范围',
};

const CONFIDENCE_CN: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
  'not-assessable': '不可评估',
};

const fmtEvidenceValue = (value: string | number | null): string => {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return value;
};

const fmtRange = (range: { startMeasure: number; endMeasure: number }): string =>
  range.startMeasure === range.endMeasure
    ? `第 ${range.startMeasure} 小节`
    : `第 ${range.startMeasure}–${range.endMeasure} 小节`;

export default function TargetedPracticePanel({
  scoreV1,
  scoreStatus,
  durations,
  sourceReportId,
  sourceTakeId,
  sourceScoreFingerprint,
  activeScoreFingerprint,
  practiceBpm,
  practiceHand,
  scoreBarCount,
  onStartTargetedPractice,
}: Props) {
  const analysis = useMemo(() => buildTeachingPrescriptions({
    scoreReport: scoreV1,
    scoreStatus,
    durations,
    sourceReportId,
    sourceTakeId,
    bpm: practiceBpm,
    hand: practiceHand,
    sourceScoreFingerprint,
    scoreBarCount,
  }), [
    scoreV1, scoreStatus, durations, sourceReportId, sourceTakeId,
    practiceBpm, practiceHand, sourceScoreFingerprint, scoreBarCount,
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { bpm: number; hand: HandSelection }>>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBpm, setManualBpm] = useState(practiceBpm);
  const [manualHand, setManualHand] = useState<HandSelection>(practiceHand);
  const [manualStart, setManualStart] = useState(1);
  const [manualEnd, setManualEnd] = useState(1);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const maxMeasure = Math.max(
    1,
    Number.isInteger(scoreBarCount) && scoreBarCount ? scoreBarCount : 0,
    ...(scoreV1 && !('error' in scoreV1) ? scoreV1.measures.map((item) => item.measure) : [0]),
    ...(scoreV1 && !('error' in scoreV1) ? scoreV1.practiceRanges.map((item) => item.endMeasure) : [0]),
  );
  const selected = analysis.prescriptions.find((item) => item.prescriptionId === selectedId)
    ?? analysis.prescriptions[0]
    ?? null;
  const selectedEdit = selected ? edits[selected.prescriptionId] : undefined;
  const selectedBpm = selectedEdit?.bpm ?? selected?.recommendedBpm ?? practiceBpm;
  const selectedHand = selectedEdit?.hand ?? selected?.recommendedHand ?? practiceHand;
  const fingerprintMismatch = !sourceScoreFingerprint
    || !activeScoreFingerprint
    || sourceScoreFingerprint !== activeScoreFingerprint;
  const cannotStart = fingerprintMismatch || !sourceReportId || !sourceTakeId
    || !onStartTargetedPractice || creating;

  const selectPrescription = (prescription: TeachingPrescription) => {
    setSelectedId(prescription.prescriptionId);
    setMessage(null);
  };

  const updateSelected = (patch: Partial<{ bpm: number; hand: HandSelection }>) => {
    if (!selected) return;
    setEdits((prev) => ({
      ...prev,
      [selected.prescriptionId]: {
        bpm: patch.bpm ?? selectedBpm,
        hand: patch.hand ?? selectedHand,
      },
    }));
  };

  const startTask = async (prescription: TeachingPrescription) => {
    if (!onStartTargetedPractice || !sourceReportId || !sourceTakeId || !sourceScoreFingerprint) return;
    setCreating(true);
    setMessage(null);
    try {
      const ok = await onStartTargetedPractice({
        scoreFingerprint: sourceScoreFingerprint,
        sourceReportId,
        sourceTakeId,
        prescription,
        bpm: prescription.recommendedBpm,
        hand: prescription.recommendedHand,
        measureRange: prescription.measureRange,
        scoreBarCount: maxMeasure,
      });
      if (!ok) {
        setCreating(false);
        setMessage('复练任务未创建；请查看页面提示并重试。');
      } else {
        setMessage('复练任务已准备；请在练习室点“开始练习”后再开始倒数。');
        window.setTimeout(() => setCreating(false), 4000);
      }
    } catch (error) {
      setCreating(false);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const startAuto = () => {
    if (!selected || cannotStart) return;
    const updated: TeachingPrescription = {
      ...selected,
      recommendedBpm: selectedBpm,
      recommendedHand: selectedHand,
      action: selected.action.replace(/建议 \d+ BPM；/, `建议 ${selectedBpm} BPM；`),
    };
    void startTask(updated);
  };

  const openManual = () => {
    const initial = selected?.measureRange;
    setManualBpm(selectedBpm);
    setManualHand(selectedHand);
    setManualStart(initial?.startMeasure ?? 1);
    setManualEnd(initial?.endMeasure ?? Math.min(maxMeasure, Math.max(1, initial?.startMeasure ?? 1)));
    setManualOpen(true);
    setMessage(null);
  };

  const startManual = () => {
    if (!sourceReportId || !sourceTakeId || !sourceScoreFingerprint) return;
    const start = Math.max(1, Math.min(maxMeasure, Math.floor(manualStart)));
    const end = Math.max(start, Math.min(maxMeasure, Math.floor(manualEnd)));
    const prescription = buildManualPrescription({
      sourceReportId,
      sourceTakeId,
      startMeasure: start,
      endMeasure: end,
      bpm: manualBpm,
      hand: manualHand,
      sourceScoreFingerprint,
    });
    if (!prescription) {
      setMessage('手动小节范围或 BPM 非法。');
      return;
    }
    void startTask(prescription);
  };

  return (
    <section className="targeted-practice" aria-label="针对性复练">
      <div className="targeted-practice-head">
        <div>
          <div className="eyebrow">TARGETED PRACTICE · P09</div>
          <h4>针对性复练</h4>
        </div>
        <button
          type="button"
          className="text-button targeted-practice-toggle"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '展开针对性复练' : '取消并返回报告'}
        </button>
      </div>
      {collapsed ? (
        <p className="targeted-footnote">针对性复练已收起；报告内容未改变。</p>
      ) : (
        <>
      <p className="targeted-practice-intro">
        只使用本次报告中真实存在的 Rust 诊断、小节统计、事件结果和时值配对。创建后是新 Session/Take，原报告不会被修改。
      </p>

      {fingerprintMismatch && (
        <p className="report-warning" role="status">
          当前打开曲谱与这份报告不一致（或缺少曲谱指纹），不能自动创建复练任务。请先打开原曲谱再回到报告。
        </p>
      )}

      {(analysis.blocks.length > 0) && (
        <div className="targeted-practice-blocks">
          <h5>不可自动执行</h5>
          {analysis.blocks.map((block) => (
            <div className="targeted-block" key={block.ruleId}>
              <strong>{block.ruleId}</strong>
              <p>{block.reason}</p>
            </div>
          ))}
        </div>
      )}

      {analysis.prescriptions.length > 0 ? (
        <div className="targeted-prescription-list">
          <div className="targeted-prescription-tabs">
            {analysis.prescriptions.map((prescription) => (
              <button
                key={prescription.prescriptionId}
                type="button"
                className={`targeted-tab ${selected?.prescriptionId === prescription.prescriptionId ? 'selected' : ''}`}
                onClick={() => selectPrescription(prescription)}
              >
                <strong>{PROBLEM_CN[prescription.problemType] ?? prescription.problemType}</strong>
                <small>{fmtRange(prescription.measureRange)}</small>
              </button>
            ))}
          </div>

          {selected && (
            <article className="targeted-card" aria-label="系统处方">
              <div className="targeted-card-head">
                <div>
                  <strong>{PROBLEM_CN[selected.problemType] ?? selected.problemType}</strong>
                  <small>
                    {fmtRange(selected.measureRange)} · 规则 {selected.ruleId}
                  </small>
                </div>
                <span className="targeted-confidence">证据置信 {CONFIDENCE_CN[selected.confidenceStatus] ?? selected.confidenceStatus}</span>
              </div>
              <p className="targeted-reason">{selected.reason}</p>
              <p className="targeted-action">{selected.action}</p>
              <ul className="targeted-evidence">
                {selected.evidence.map((evidence, index) => (
                  <li key={`${evidence.metric}-${index}`}>
                    <span>{evidence.source}</span>
                    <b>{evidence.metric}</b>
                    <em>{fmtEvidenceValue(evidence.value)}</em>
                    {evidence.measure != null && <small>第 {evidence.measure} 小节</small>}
                    {evidence.detail && <small>{evidence.detail}</small>}
                  </li>
                ))}
              </ul>
              <div className="targeted-config">
                <label>
                  练习 BPM
                  <input
                    type="number"
                    min={40}
                    max={300}
                    step={5}
                    value={selectedBpm}
                    disabled={creating}
                    onChange={(event) => updateSelected({ bpm: Math.max(40, Math.min(300, Number(event.target.value) || 40)) })}
                  />
                </label>
                <label>
                  练习手别
                  <select
                    value={selectedHand}
                    disabled={creating}
                    onChange={(event) => updateSelected({ hand: event.target.value as HandSelection })}
                  >
                    <option value="both">双手</option>
                    <option value="right">右手</option>
                    <option value="left">左手</option>
                  </select>
                </label>
                <span className="targeted-mode">模式：乐句循环（一次练习所选范围）</span>
              </div>
              <button
                type="button"
                className="button button-primary"
                disabled={cannotStart}
                onClick={startAuto}
              >
                {creating ? '正在创建…' : '确认创建复练任务'}
              </button>
            </article>
          )}
        </div>
      ) : (
        <p className="targeted-empty">
          本次没有足够证据生成针对性复练建议。
        </p>
      )}

      {analysis.canCreateManual && !fingerprintMismatch && (
        <div className="targeted-manual">
          <div className="targeted-manual-head">
            <div>
              <strong>手动选择小节</strong>
              <small>这不是系统诊断，只是用户选择；不会从总分推断薄弱点。</small>
            </div>
            <button type="button" className="text-button" onClick={() => (manualOpen ? setManualOpen(false) : openManual())}>
              {manualOpen ? '收起' : '手动选择'}
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
                  onChange={(event) => setManualEnd(Math.max(1, Math.min(maxMeasure, Number(event.target.value) || 1)))}
                />
              </label>
              <label>
                BPM
                <input
                  type="number"
                  min={40}
                  max={300}
                  step={5}
                  value={manualBpm}
                  disabled={creating}
                  onChange={(event) => setManualBpm(Math.max(40, Math.min(300, Number(event.target.value) || 40)))}
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
              <button type="button" className="button button-outline" disabled={cannotStart} onClick={startManual}>
                {creating ? '正在创建…' : '按手动范围创建'}
              </button>
            </div>
          )}
        </div>
      )}

      {!analysis.canCreateManual && analysis.manualBlockReason && (
        <p className="targeted-footnote">手动复练不可用：{analysis.manualBlockReason}</p>
      )}
      <p className="targeted-footnote">
        复练会沿用原曲谱指纹和来源报告引用；loop 只练所选范围一次，不会自动重复。当前未实现跨 Take 恢复或运行中变速。
      </p>
      {message && <p className="targeted-message" role="status">{message}</p>}
        </>
      )}
    </section>
  );
}
