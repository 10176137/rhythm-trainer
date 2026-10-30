import { useEffect, useRef, useState } from 'react';
import type { DrillId, GeneratedSkillDrill, TrainingProgramConfig, TrainingProgramReview } from '../../shared/training-contract';
import { trainingRepository } from '../services/trainingRepository';

const OPTIONS: Array<[DrillId, string]> = [['five-finger', '五指均匀'], ['scales', '音阶换指'], ['broken-chords', '分解和弦'], ['triads', '和弦齐奏'], ['arpeggios', '琶音移动'], ['leaps', '跳进找键'], ['pulse', '稳定拍点'], ['subdivision', '八分均分'], ['syncopation', '切分节奏'], ['coordination', '双手配合']];
const DEFAULT: TrainingProgramConfig = { mode: 'timed', minutes: 5, variation: 'shuffle', ids: ['five-finger', 'scales', 'broken-chords'], keys: ['C'], hand: 'right', level: 1, bpm: 60 };
function loadPreferences(): TrainingProgramConfig {
  try {
    const v = JSON.parse(localStorage.getItem('training-program-preferences-v1') ?? 'null');
    if (v && ['timed', 'continuous', 'assessment'].includes(v.mode) && [2, 5, 10].includes(v.minutes) && [1, 2, 3].includes(v.level) && Number.isInteger(v.bpm) && v.bpm >= 40 && v.bpm <= 140 && ['repeat', 'shuffle'].includes(v.variation) && ['left', 'right', 'both'].includes(v.hand) && Array.isArray(v.ids) && v.ids.length && v.ids.every((id: string) => OPTIONS.some(([known]) => known === id)) && Array.isArray(v.keys) && v.keys.length && v.keys.every((key: string) => ['C', 'F', 'G'].includes(key))) return { mode: v.mode, minutes: v.minutes, variation: v.variation, hand: v.hand, level: v.level, bpm: v.bpm, ids: [...new Set(v.ids)] as DrillId[], keys: [...new Set(v.keys)] as TrainingProgramConfig['keys'] };
  } catch { /* A broken preference must never stop the training page. */ }
  return DEFAULT;
}

export default function TrainingProgramPanel({ onStart }: { onStart: (drill: GeneratedSkillDrill) => boolean }) {
  const [config, setConfig] = useState(loadPreferences);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { try { localStorage.setItem('training-program-preferences-v1', JSON.stringify(config)); } catch { /* Storage is optional; the server still validates the request. */ } }, [config]);
  const change = <K extends keyof TrainingProgramConfig>(key: K, value: TrainingProgramConfig[K]) => setConfig((old) => ({ ...old, [key]: value }));
  const start = async () => {
    if (busy) return; setBusy(true); setError('');
    controller.current = new AbortController();
    try { const drill = await trainingRepository.program(config, controller.current.signal); if (active.current && !onStart(drill)) throw new Error('请先结束当前练习，再开始训练计划。'); }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : '训练计划生成失败'); }
    finally { if (active.current) setBusy(false); }
  };
  return <section className="card training-program-panel" aria-label="训练计划与能力测试">
    <h2>持续训练与基础测试</h2><p>围绕音高准确、起音均匀、和弦完整和双手配合，按完整音型练习并保留真实测量结果。</p>
    <div className="skill-hand-key">
      <label>训练方式<select value={config.mode} disabled={busy} onChange={(e) => change('mode', e.target.value as TrainingProgramConfig['mode'])}><option value="timed">定时训练</option><option value="continuous">连续训练 · 手动结束</option><option value="assessment">基础能力测试 · 约 2 分钟</option></select></label>
      {config.mode === 'timed' && <label>目标时长<select value={config.minutes} disabled={busy} onChange={(e) => change('minutes', Number(e.target.value) as 2 | 5 | 10)}>{[2, 5, 10].map((n) => <option key={n} value={n}>约 {n} 分钟</option>)}</select></label>}
    </div>
    {config.mode !== 'assessment' ? <fieldset disabled={busy}><legend>练习配置</legend>
      <div className="program-projects">{OPTIONS.map(([id, title]) => <label key={id}><input type="checkbox" checked={config.ids.includes(id)} onChange={(e) => change('ids', e.target.checked ? [...config.ids, id] : config.ids.filter((x) => x !== id))}/>{title}</label>)}</div>
      <div className="settings-grid">
        <label>出题方式<select value={config.variation} onChange={(e) => change('variation', e.target.value as 'repeat' | 'shuffle')}><option value="shuffle">轮换项目、调性与乐句</option><option value="repeat">重复第一个项目与调性</option></select></label>
        <label>练习手<select value={config.hand} onChange={(e) => change('hand', e.target.value as TrainingProgramConfig['hand'])}><option value="right">右手</option><option value="left">左手</option><option value="both">双手</option></select></label>
        <label>难度<select value={config.level} onChange={(e) => change('level', Number(e.target.value) as 1 | 2 | 3)}><option value={1}>入门 · 基础音型</option><option value={2}>普通 · 音型与节奏变式</option><option value={3}>进阶 · 扩展音域与组合</option></select></label>
        <label>速度 BPM<input type="number" min={40} max={140} value={config.bpm} onChange={(e) => change('bpm', Number(e.target.value))}/></label>
      </div>
      <div className="program-projects" role="group" aria-label="随机调性范围">{(['C', 'G', 'F'] as const).map((key) => <label key={key}><input type="checkbox" checked={config.keys.includes(key)} onChange={(e) => change('keys', e.target.checked ? [...config.keys, key] : config.keys.filter((x) => x !== key))}/>{key} 大调</label>)}</div>
      <small>按完整乐句编排，时长略有取整。每段约一分钟，保存后自动接续，段间保留预备拍；点「结束」即停止接续。节奏项目使用项目规定的手别。</small>
    </fieldset> : <p>固定 60 BPM，依次测试右手五指、左手五指、G 大调音阶、左手琶音、F 大调和弦、双手配合。关闭伴弹与即时答案，结果来自后端已保存的演奏记录。可重复测试作同条件比较，不能换算考级等级。</p>}
    <button type="button" className="button button-primary" disabled={busy || (config.mode !== 'assessment' && (!config.ids.length || !config.keys.length))} onClick={() => void start()}>{busy ? '正在编排训练…' : config.mode === 'assessment' ? '开始基础能力测试' : '开始训练计划'}</button>
    {error && <p role="alert">{error}</p>}
    <details className="skill-research-notes"><summary>练习依据与测量范围</summary><p><a href="https://www.abrsm.org/en-gb/piano" target="_blank" rel="noreferrer">ABRSM</a>、<a href="https://www.rcmusic.com/learning/about-the-royal-conservatory-certificate-program/curriculum-and-disciplines" target="_blank" rel="noreferrer">RCM</a> 的钢琴技术训练包含音阶、和弦和琶音。这里用完整音型练准确和均匀，再通过不同调性检验迁移；不以练习时长代替掌握程度。</p><p>测试只评价 MIDI 能观察的音高、漏音和起音时间。参考指法、手腕动作、姿态、音色与放松程度需要自行检查或请老师观察，不生成这些项目的虚拟分数。</p></details>
  </section>;
}

export function ProgramReview({ review }: { review: TrainingProgramReview }) {
  return <section className="training-program-review" aria-label="后端专项能力评估"><h3>{review.label}</h3><p>{review.advice}</p>
    {!!review.unlocatedExtras && <p>另有 {review.unlocatedExtras} 个多余音无法定位到具体小节，已计入整体比较，本轮不评为稳定。</p>}
    {review.comparison && <p>与上次相同基线相比：音高正确率 {Math.round(review.comparison.before * 100)}% → {Math.round(review.comparison.now * 100)}%（{review.comparison.changePoints >= 0 ? '+' : ''}{review.comparison.changePoints.toFixed(1)} 个百分点）。</p>}
    <div className="program-review-table"><table><thead><tr><th>项目</th><th>音高正确</th><th>错／漏／多音</th><th>起音偏差</th></tr></thead><tbody>{review.sections.map((s) => <tr key={s.startBar}><th>{s.title}</th><td>{s.accuracy === null ? '证据不足' : `${Math.round(s.accuracy * 100)}%`}</td><td>{s.accuracy === null ? '—' : `${s.wrong} / ${s.missing} / ${s.extra}`}</td><td>{s.meanAbsoluteMs === null ? '—' : `${Math.round(s.meanAbsoluteMs)} ms`}</td></tr>)}</tbody></table></div><small>{review.criteria}</small>
  </section>;
}
