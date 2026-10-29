import { useMemo, useState } from 'react';
import { createSkillDrill, SKILL_DRILLS, DRILL_KEYS, type DrillId, type DrillLevel, type DrillKey, type DrillHand, type DrillOptions } from '../features/practice/skillDrills';
import { spelledLabel } from '../features/reading/readingKeys';
import SkillDrillPreview from './SkillDrillPreview';

const HAND_LABELS = { right: '右手', left: '左手', both: '双手同向' };

export default function SkillTrainingPage({ onStart }: { onStart: (id: DrillId, level: DrillLevel, bpm: number, options?: DrillOptions) => boolean }) {
  const [selected, setSelected] = useState<DrillId>('five-finger');
  const [category, setCategory] = useState<'fundamentals' | 'rhythm'>('fundamentals');
  const [level, setLevel] = useState<DrillLevel>(1);
  const [bpm, setBpm] = useState(60);
  const [key, setKey] = useState<DrillKey>('C');
  const [hand, setHand] = useState<DrillHand>('right');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState('');
  const drill = SKILL_DRILLS.find((entry) => entry.id === selected)!;
  const basic = drill.category === 'fundamentals';
  const options = useMemo(() => basic ? { key, hand } : undefined, [basic, key, hand]);
  const generated = useMemo(() => createSkillDrill(selected, level, bpm, options), [selected, level, bpm, options]);
  const fingered = selected === 'five-finger' || selected === 'scales';
  const choose = (id: DrillId) => { setSelected(id); setLevel(1); setPreviewOpen(false); setError(''); };

  return <div className="page-content skill-training-page">
    <header className="page-heading"><div><div className="eyebrow">FOCUSED PRACTICE</div><h1>专项训练</h1><p>从五指位置到音阶与和弦，把基本功拆成能听、能看、能练的小步骤。</p></div></header>
    <div className="skill-category-switch" role="group" aria-label="专项训练分类">
      <button type="button" aria-pressed={category === 'fundamentals'} onClick={() => { setCategory('fundamentals'); choose('five-finger'); }}>键盘基本功 <small>五指 · 音阶 · 和弦</small></button>
      <button type="button" aria-pressed={category === 'rhythm'} onClick={() => { setCategory('rhythm'); choose('pulse'); }}>节奏与配合 <small>拍点 · 均分 · 切分</small></button>
    </div>
    {basic && <p className="skill-starter-path">不知道先练什么？先从「五指练习」开始，再试一八度音阶和分解和弦。每次先练单手。</p>}
    <div className={`skill-drill-grid ${basic ? 'fundamentals-grid' : ''}`} role="group" aria-label="选择训练目标">{SKILL_DRILLS.filter((entry) => entry.category === category).map((entry, index) => <button type="button" key={entry.id} aria-pressed={selected === entry.id} onClick={() => choose(entry.id)}><span className="skill-drill-icon" aria-hidden="true">{entry.icon}</span><strong>{entry.title}</strong><small>{entry.subtitle}</small>{basic && <span className="skill-drill-number">{String(index + 1).padStart(2, '0')}</span>}</button>)}</div>
    <section className="card skill-drill-detail" aria-label="专项练习计划"><div>
      <span className="eyebrow">练什么 · 怎样练</span><h2>{drill.title}</h2><p>{drill.goal}</p>
      <ol className="skill-instructions">{drill.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      {basic && <div className="skill-start-notes"><strong>本轮起点</strong><p>{hand !== 'left' && `右手：${spelledLabel(generated.startPitches.right!, DRILL_KEYS[key].fifths)}`}{hand === 'both' && '　·　'}{hand !== 'right' && `左手：${spelledLabel(generated.startPitches.left!, DRILL_KEYS[key].fifths)}`}</p>
        {fingered && <small>谱面数字：1 拇指 · 2 食指 · 3 中指 · 4 无名指 · 5 小指。数字为参考指法。</small>}</div>}
      <div className="skill-review"><strong>练完看什么</strong><p>{drill.review}</p></div>
      <div className="skill-self-check"><strong>自己检查</strong><p>{drill.selfCheck}</p></div>
    </div>
      <div className="skill-drill-controls">
        <label>训练级别<select value={level} onChange={(event) => setLevel(Number(event.target.value) as DrillLevel)}>{drill.levels.map((label, index) => <option key={label} value={index + 1}>{index + 1} · {label}</option>)}</select></label>
        {basic && <div className="skill-hand-key"><label>练习手<select value={hand} onChange={(event) => setHand(event.target.value as DrillHand)}>{(Object.keys(HAND_LABELS) as DrillHand[]).map((value) => <option key={value} value={value}>{HAND_LABELS[value]}</option>)}</select></label>
          <label>调性<select value={key} onChange={(event) => setKey(event.target.value as DrillKey)}>{(Object.keys(DRILL_KEYS) as DrillKey[]).map((value) => <option key={value} value={value}>{DRILL_KEYS[value].label}</option>)}</select></label></div>}
        <label>速度 <b>{bpm} BPM</b><input aria-label="专项训练速度" type="range" min={40} max={140} step={5} value={bpm} onChange={(event) => setBpm(Number(event.target.value))} /></label>
        <p>{generated.bars} 小节 · {generated.keyLabel} · {HAND_LABELS[generated.hand]} · 3 秒预备</p>
        <button type="button" className="button button-primary" onClick={() => { if (!onStart(selected, level, bpm, options)) setError('暂时无法开始，请先结束当前练习或检查曲谱生成结果。'); }}>开始专项训练</button>
        {error && <p role="alert">{error}</p>}
        <small>先用 40–60 BPM 练稳，再单独增加速度或难度；级别由你选择，不自动判定已掌握。</small>
      </div>
    </section>
    <section className="card skill-preview-card"><button type="button" className="skill-preview-toggle" aria-expanded={previewOpen} onClick={() => setPreviewOpen((value) => !value)}>{previewOpen ? '收起练习谱' : `先看练习谱${fingered ? ' · 含参考指法' : ''}`} <span aria-hidden="true">{previewOpen ? '⌃' : '⌄'}</span></button>
      {previewOpen && <SkillDrillPreview xml={generated.xml} />}</section>
    <details className="skill-research-notes"><summary>基本功的设计依据与反馈范围</summary><p>练习谱为本应用编排的短音型，不是考级试题。内容分类参考 <a href="https://www.rcmusic.com/learning/about-the-royal-conservatory-certificate-program/curriculum-and-disciplines" target="_blank" rel="noreferrer">RCM 的技术训练分类</a> 和 <a href="https://www.esm.rochester.edu/classpiano/overview/" target="_blank" rel="noreferrer">Eastman 的钢琴课程说明</a>；音阶参考指法可查 <a href="https://www.pianoscales.org/major.html" target="_blank" rel="noreferrer">Piano Scales</a>。</p><p>报告依据 MIDI 音高、起音和松键时间。指法、姿态、是否放松以及真实音色均衡不能靠这些数据确认；本应用不为这些项目生成分数。</p></details>
  </div>;
}
