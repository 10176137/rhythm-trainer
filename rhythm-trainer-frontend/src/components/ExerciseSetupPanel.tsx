// C: exercise catalog/config. This panel only edits an ExerciseSpec and asks
// the app to generate; it does not build a second score or a second plan.

import { useMemo, useState } from 'react';
import {
  type ArpeggioDirection,
  type ArpeggioQuality,
  type ExerciseHand,
  type ExerciseKind,
  type ExerciseSpec,
  type RhythmPatternId,
  type RootNote,
} from '../features/exercises/exerciseGenerator';

interface Props {
  busy: boolean;
  error: string | null;
  onGenerate: (spec: ExerciseSpec) => void;
}

const KIND_CN: Record<ExerciseKind, string> = { rhythm: '节奏型', arpeggio: '琶音' };
const PATTERNS: Array<{ id: RhythmPatternId; label: string; hint: string }> = [
  { id: 'quarter', label: '四分音符', hint: '每拍一个音' },
  { id: 'eighth', label: '八分音符', hint: '每半拍一个音' },
  { id: 'eighth-rest', label: '八分 + 休止', hint: '音与休止交替' },
  { id: 'dotted', label: '附点节奏', hint: '附点四分 + 八分（4/4）' },
];
const ROOTS: RootNote[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const DIRECTIONS: Array<{ id: ArpeggioDirection; label: string }> = [
  { id: 'up', label: '上行' },
  { id: 'down', label: '下行' },
  { id: 'up-down', label: '上下行' },
];
const QUALITIES: Array<{ id: ArpeggioQuality; label: string }> = [
  { id: 'major', label: '大三和弦' },
  { id: 'minor', label: '小三和弦' },
];

export default function ExerciseSetupPanel({ busy, error, onGenerate }: Props) {
  const [kind, setKind] = useState<ExerciseKind>('rhythm');
  const [hand, setHand] = useState<ExerciseHand>('right');
  const [bpm, setBpm] = useState(80);
  const [beats, setBeats] = useState(4);
  const [bars, setBars] = useState<2 | 4 | 8>(4);
  const [pattern, setPattern] = useState<RhythmPatternId>('quarter');
  const [pitchMode, setPitchMode] = useState<'fixed' | 'five-note'>('fixed');
  const [root, setRoot] = useState<RootNote>('C');
  const [quality, setQuality] = useState<ArpeggioQuality>('major');
  const [direction, setDirection] = useState<ArpeggioDirection>('up');
  const [seedText, setSeedText] = useState(String(Date.now() % 1_000_000));

  const seed = Number(seedText);
  const seedValid = Number.isInteger(seed);
  const patternAvailable = pattern !== 'dotted' || beats === 4;
  const spec: ExerciseSpec | null = useMemo(() => {
    if (!seedValid || !Number.isInteger(bpm) || bpm < 20 || bpm > 300) return null;
    const common = { seed, bpm, hand, timeSignature: [beats, 4] as [number, number], bars, rhythmPattern: pattern };
    if (kind === 'rhythm') return { kind, ...common, pitchMode };
    return { kind, ...common, root, quality, direction, octaves: 1 };
  }, [seedValid, seed, bpm, hand, beats, bars, pattern, kind, pitchMode, root, quality, direction]);

  const randomSeed = () => setSeedText(String(Math.floor(Math.random() * 1_000_000)));

  return (
    <section className="exercise-setup" aria-label="生成练习设置">
      <header className="exercise-setup-head">
        <div>
          <div className="eyebrow">GENERATED EXERCISE</div>
          <h2>节奏型与技巧训练</h2>
          <p>选择规则和 seed，确定性生成一份可练习的乐谱，然后进入固定判定线练习。</p>
        </div>
        <div className="exercise-kind-tabs" role="tablist" aria-label="练习类型">
          {(Object.keys(KIND_CN) as ExerciseKind[]).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={kind === item}
              className={kind === item ? 'active' : ''}
              onClick={() => setKind(item)}
            >
              {KIND_CN[item]}
            </button>
          ))}
        </div>
      </header>

      <div className="exercise-setup-grid">
        <label>
          拍号
          <select value={beats} onChange={(event) => setBeats(Number(event.target.value))}>
            <option value={2}>2/4</option>
            <option value={3}>3/4</option>
            <option value={4}>4/4</option>
          </select>
        </label>
        <label>
          小节数
          <select value={bars} onChange={(event) => setBars(Number(event.target.value) as 2 | 4 | 8)}>
            <option value={2}>2 小节</option>
            <option value={4}>4 小节</option>
            <option value={8}>8 小节</option>
          </select>
        </label>
        <label>
          BPM
          <input
            type="number"
            min={20}
            max={300}
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value) || 0)}
          />
        </label>
        <label>
          手别
          <select value={hand} onChange={(event) => setHand(event.target.value as ExerciseHand)}>
            <option value="right">右手</option>
            <option value="left">左手</option>
          </select>
        </label>
        <label>
          节奏型
          <select value={pattern} onChange={(event) => setPattern(event.target.value as RhythmPatternId)}>
            {PATTERNS.map((item) => (
              <option key={item.id} value={item.id} disabled={item.id === 'dotted' && beats !== 4}>
                {item.label} · {item.hint}
              </option>
            ))}
          </select>
        </label>
        {kind === 'rhythm' ? (
          <label>
            音高
            <select value={pitchMode} onChange={(event) => setPitchMode(event.target.value as 'fixed' | 'five-note')}>
              <option value="fixed">固定音高（隔离节奏）</option>
              <option value="five-note">五音集合（C D E F G）</option>
            </select>
          </label>
        ) : (
          <>
            <label>
              根音
              <select value={root} onChange={(event) => setRoot(event.target.value as RootNote)}>
                {ROOTS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>
              和弦性质
              <select value={quality} onChange={(event) => setQuality(event.target.value as ArpeggioQuality)}>
                {QUALITIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>
              方向
              <select value={direction} onChange={(event) => setDirection(event.target.value as ArpeggioDirection)}>
                {DIRECTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </>
        )}
        <label>
          seed
          <span className="exercise-seed-row">
            <input
              type="number"
              step={1}
              value={seedText}
              aria-invalid={!seedValid}
              onChange={(event) => setSeedText(event.target.value)}
            />
            <button type="button" className="text-button" onClick={randomSeed}>换一个</button>
          </span>
        </label>
      </div>

      <div className="exercise-setup-summary">
        <span>{KIND_CN[kind]} · {beats}/4 · {bars} 小节 · {bpm} BPM · {hand === 'right' ? '右手' : '左手'}</span>
        <span>同一 spec + seed + {EXERCISE_GENERATOR_VERSION_LABEL} 始终生成同一份乐谱</span>
      </div>

      {!patternAvailable && (
        <p className="report-warning" role="status">附点节奏只支持 4/4；请改拍号或换节奏型。</p>
      )}
      {!seedValid && <p className="report-warning" role="status">seed 必须是整数。</p>}
      {error && <p className="report-warning" role="alert">{error}</p>}

      <div className="exercise-setup-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !spec || !patternAvailable || !seedValid}
          onClick={() => spec && onGenerate(spec)}
        >
          {busy ? '正在生成…' : '生成练习'}
        </button>
        <span className="exercise-setup-note">生成后会保存到曲谱库，并直接进入固定判定线视图。</span>
      </div>
    </section>
  );
}

const EXERCISE_GENERATOR_VERSION_LABEL = 'generator v1';
