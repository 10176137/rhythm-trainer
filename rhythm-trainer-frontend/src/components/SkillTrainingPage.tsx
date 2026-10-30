import { Capacitor } from '@capacitor/core';
import SettingsDialog from './SettingsDialog';
import { useMemo, useState } from 'react';
import type { DrillId, DrillLevel, DrillKey, DrillHand, GeneratedSkillDrill } from '../../shared/training-contract';
import { useSkillDrill } from '../features/practice/useSkillDrill';
import SkillDrillPreview from './SkillDrillPreview';
import TrainingProgramPanel from './TrainingProgramPanel';

const HAND_LABELS = { right: '右手', left: '左手', both: '双手同向' };

export default function SkillTrainingPage({ onStart }: { onStart: (drill: GeneratedSkillDrill) => boolean }) {
  const [native] = useState(() => Capacitor.isNativePlatform());
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<DrillId>('five-finger');
  const [view, setView] = useState<'program' | 'single'>('program');
  const [category, setCategory] = useState<'fundamentals' | 'rhythm'>('fundamentals');
  const [level, setLevel] = useState<DrillLevel>(1);
  const [bpm, setBpm] = useState(60);
  const [key, setKey] = useState<DrillKey>('C');
  const [hand, setHand] = useState<DrillHand>('right');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [seed, setSeed] = useState(0);
  const [error, setError] = useState('');
  const basic = category === 'fundamentals';
  const options = useMemo(() => basic ? { key, hand } : undefined, [basic, key, hand]);
  const request = useMemo(() => ({ id: selected, level, bpm, seed, ...(options ? { options } : {}) }), [selected, level, bpm, seed, options]);
  const { catalog, catalogError, generated, generationError, retryCatalog, retryGeneration } = useSkillDrill(request);
  const drill = catalog?.drills.find((entry) => entry.id === selected);
  const fingered = drill?.hasReferenceFingering ?? false;
  const choose = (id: DrillId) => { setSelected(id); setLevel(1); setSeed(0); setPreviewOpen(false); setError(''); };

  if (!catalog || !drill) return <div className="page-content skill-training-page"><header className="page-heading"><h1>专项训练</h1></header><section className="card"><p role={catalogError ? 'alert' : 'status'}>{catalogError || '正在载入训练项目…'}</p>{catalogError && <button type="button" className="button button-outline" onClick={retryCatalog}>重新载入</button>}</section></div>;

  const details = <>
    <section className="card skill-drill-detail" aria-label="专项练习计划"><div>
      <span className="eyebrow">练什么 · 怎样练</span><h2>{drill.title}</h2><p>{drill.goal}</p>
      {generated && <p className="skill-round-pattern"><strong>本轮 · {generated.lesson.label}</strong></p>}
      <ol className="skill-instructions">{(generated?.lesson.instructions ?? []).map((step) => <li key={step}>{step}</li>)}</ol>
      {basic && <div className="skill-start-notes"><strong>本轮起点</strong><p>{generated ? Object.entries(generated.startPitchLabels).map(([side, label]) => `${side === 'left' ? '左手' : '右手'}：${label}`).join('　·　') : '正在更新练习谱…'}</p>
        {fingered && <small>谱面数字：1 拇指 · 2 食指 · 3 中指 · 4 无名指 · 5 小指。数字为参考指法。</small>}</div>}
      <div className="skill-review"><strong>练完看什么</strong><p>{generated?.lesson.review ?? drill.review}</p></div>
      <div className="skill-self-check"><strong>自己检查</strong><p>{generated?.lesson.selfCheck ?? drill.selfCheck}</p></div>
    </div>
      <div className="skill-drill-controls">
        <label>训练级别<select value={level} onChange={(event) => setLevel(Number(event.target.value) as DrillLevel)}>{drill.levels.map((label, index) => <option key={label} value={index + 1}>{index + 1} · {label}</option>)}</select></label>
        {basic && <div className="skill-hand-key"><label>练习手<select value={hand} onChange={(event) => setHand(event.target.value as DrillHand)}>{catalog.hands.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
          <label>调性<select value={key} onChange={(event) => setKey(event.target.value as DrillKey)}>{catalog.keys.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label></div>}
        <label>速度 <b>{bpm} BPM</b><input aria-label="专项训练速度" type="range" min={catalog.tempo.min} max={catalog.tempo.max} step={catalog.tempo.step} value={bpm} onChange={(event) => setBpm(Number(event.target.value))} /></label>
        <p role="status">{generated ? `${generated.bars} 小节 · ${generated.keyLabel} · ${generated.hand === 'both' && !basic ? '双手配合' : HAND_LABELS[generated.hand]} · ${generated.countInMs / 1000} 秒预备` : generationError ? '练习谱尚未就绪' : '正在生成练习谱…'}</p>
        <button type="button" className="button button-primary" disabled={!generated} onClick={() => { if (!generated) return; if (onStart(generated)) setDetailOpen(false); else setError('暂时无法开始，请先结束当前练习或检查曲谱生成结果。'); }}>开始专项训练</button>
        {selected !== 'pulse' && <button type="button" className="text-button" disabled={!generated} onClick={() => setSeed((value) => (value + 1) >>> 0)}>换一组乐句</button>}
        {generationError && <div><p role="alert">{generationError}</p><button type="button" className="text-button" onClick={retryGeneration}>重新生成</button></div>}
        {error && <p role="alert">{error}</p>}
        <small>先用 40–60 BPM 练稳，再单独增加速度或难度；级别由你选择，不自动判定已掌握。</small>
      </div>
    </section>
    <section className="card skill-preview-card"><button type="button" className="skill-preview-toggle" aria-expanded={previewOpen} onClick={() => setPreviewOpen((value) => !value)}>{previewOpen ? '收起练习谱' : `先看练习谱${fingered ? ' · 含参考指法' : ''}`} <span aria-hidden="true">{previewOpen ? '⌃' : '⌄'}</span></button>
      {previewOpen && (generated ? <SkillDrillPreview xml={generated.xml} /> : <p role="status">{generationError || '正在准备练习谱…'}</p>)}</section>
    <details className="skill-research-notes"><summary>基本功的设计依据与反馈范围</summary><p>练习谱为本应用编排的短音型，不是考级试题。内容分类参考 <a href="https://www.rcmusic.com/learning/about-the-royal-conservatory-certificate-program/curriculum-and-disciplines" target="_blank" rel="noreferrer">RCM 的技术训练分类</a> 和 <a href="https://www.esm.rochester.edu/classpiano/overview/" target="_blank" rel="noreferrer">Eastman 的钢琴课程说明</a>；音阶参考指法可查 <a href="https://www.pianoscales.org/major.html" target="_blank" rel="noreferrer">Piano Scales</a>。</p><p>报告依据 MIDI 音高、起音和松键时间。指法、姿态、是否放松以及真实音色均衡不能靠这些数据确认；本应用不为这些项目生成分数。</p></details>
  </>;

  return <div className="page-content skill-training-page">
    <header className="page-heading"><div><div className="eyebrow">FOCUSED PRACTICE</div><h1>专项训练</h1><p>从五指位置到音阶与和弦，把基本功拆成能听、能看、能练的小步骤。</p></div></header>
    <div className="skill-category-switch" role="group" aria-label="训练工作区"><button type="button" aria-pressed={view === 'program'} onClick={() => setView('program')}>训练计划与测试</button><button type="button" aria-pressed={view === 'single'} onClick={() => setView('single')}>单项打磨</button></div>
    {view === 'program' ? <TrainingProgramPanel onStart={onStart} /> : <>
    <div className="skill-category-switch" role="group" aria-label="专项训练分类">
      <button type="button" aria-pressed={category === 'fundamentals'} onClick={() => { setCategory('fundamentals'); choose('five-finger'); }}>键盘基本功 <small>五指 · 音阶 · 和弦</small></button>
      <button type="button" aria-pressed={category === 'rhythm'} onClick={() => { setCategory('rhythm'); choose('pulse'); }}>节奏与配合 <small>拍点 · 均分 · 切分</small></button>
    </div>
    {basic && <p className="skill-starter-path">不知道先练什么？先从「五指练习」开始，再试一八度音阶和分解和弦。每次先练单手。</p>}
    <div className={`skill-drill-grid ${basic ? 'fundamentals-grid' : ''}`} role="group" aria-label="选择训练目标">{catalog.drills.filter((entry) => entry.category === category).map((entry, index) => <button type="button" key={entry.id} aria-pressed={selected === entry.id} onClick={() => { choose(entry.id); setDetailOpen(true); }}><span className="skill-drill-icon" aria-hidden="true">{entry.icon}</span><strong>{entry.title}</strong><small>{entry.subtitle}</small>{basic && <span className="skill-drill-number">{String(index + 1).padStart(2, '0')}</span>}</button>)}</div>
    {native ? detailOpen && <SettingsDialog label="专项练习配置" onClose={() => setDetailOpen(false)}>
      <header className="tablet-sheet-header"><h2>专项练习配置</h2><button type="button" className="button button-outline" onClick={() => setDetailOpen(false)}>完成配置</button></header>
      {details}
    </SettingsDialog> : details}
    </>}
  </div>;
}
