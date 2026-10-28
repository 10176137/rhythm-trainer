// 81-key note-reading setup page (task spec §4). Owns ONLY configuration
// state; generation and session state live in App / feature modules. Single
// screen, fixed action area, no page-level scrolling on desktop.

import { useMemo, useState } from 'react';
import {
  READING_OCTAVES,
  keyLabel,
  readingPool,
} from '../features/reading/readingKeys';

import { defaultReadingSetup, type ReadingSetupValue, type ReadingModeChoice, type ReadingComplexityChoice } from '../features/reading/readingSettings';
export type { ReadingSetupValue } from '../features/reading/readingSettings';

interface Props {
  initialValue?: ReadingSetupValue | null;
  initialMode?: ReadingModeChoice;
  busy: boolean;
  error: string | null;
  deviceConnected: boolean;
  deviceLabel: string;
  handMappingReady: boolean;
  onStart: (value: ReadingSetupValue) => void;
}

const COMPLEXITY_CN: Record<ReadingComplexityChoice, string> = {
  basic: '基础（四分/二分与休止）',
  intermediate: '进阶（加入八分与附点）',
  advanced: '高级（十六分与拍内切分）',
};

const KEY_ROOTS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const STAFF_CN = { auto: '自动（按音高分谱表）', treble: '右手 · 高音谱表', bass: '左手 · 低音谱表' } as const;

export default function NoteReadingSetup({
  initialValue,
  initialMode = 'free',
  busy,
  error,
  deviceConnected,
  deviceLabel,
  handMappingReady,
  onStart,
}: Props) {
  const [value, setValue] = useState<ReadingSetupValue>(() => initialValue ?? { ...defaultReadingSetup(initialMode), mode: initialMode });

  const pool = useMemo(() => readingPool(value.ranges, value.key), [value.ranges, value.key]);
  const poolReady = pool.length >= value.notesPerEvent;
  const bpmReady = value.mode !== 'rhythm' || (Number.isFinite(value.bpm) && value.bpm >= 40 && value.bpm <= 180);
  const seedReady = Number.isInteger(value.seed);
  const ready = poolReady && bpmReady && seedReady && !busy;

  const patch = (changes: Partial<ReadingSetupValue>) => setValue((prev) => ({ ...prev, ...changes }));

  const toggleOctave = (id: string) => {
    const octave = READING_OCTAVES.find((item) => item.id === id);
    if (!octave) return;
    setValue((prev) => {
      const selected = prev.ranges.some((range) => range.startMidi === octave.range.startMidi && range.endMidi === octave.range.endMidi);
      const ranges = selected
        ? prev.ranges.filter((range) => range.startMidi !== octave.range.startMidi || range.endMidi !== octave.range.endMidi)
        : [...prev.ranges, octave.range].sort((a, b) => a.startMidi - b.startMidi);
      return { ...prev, ranges };
    });
  };

  return (
    <section className="reading-setup" aria-label="81 键识谱训练配置">
      <header className="reading-setup-head">
        <div>
          <div className="eyebrow">81-KEY READING</div>
          <h2>识谱练习</h2>
          <p>选择音区和练习方式，然后开始识谱。</p>
        </div>
      </header>

      {value.mode === 'free' && <div className="reading-task-choice" role="group" aria-label="训练方式">
        <button type="button" aria-pressed={value.task === 'practice'} onClick={() => patch({ task: 'practice' })}>练习 · 可请求提示</button>
        <button type="button" aria-pressed={value.task === 'test'} onClick={() => patch({ task: 'test' })}>小测 · 结束后反馈</button>
      </div>}
      <div className="reading-setup-block" aria-label="音域选择">
        <h3>选择八度 <small>可多选</small></h3>
        <div className="reading-preset-row">
          {READING_OCTAVES.map((octave) => {
            const selected = value.ranges.some((range) => range.startMidi === octave.range.startMidi && range.endMidi === octave.range.endMidi);
            return <button key={octave.id} type="button" className={selected ? 'active' : ''} aria-pressed={selected} onClick={() => toggleOctave(octave.id)}>{octave.label}</button>;
          })}
        </div>
        <p className="reading-pool-count">
          已选 {value.ranges.length} 个音区 · {pool.length} 个音{value.key ? `（${keyLabel(value.key)} 调内音）` : '（含黑键）'}
        </p>
      </div>

      <div className="reading-setup-block" aria-label="调性与谱表">
        <h3>调性与谱表 <small>升降号与音池随调号；谱表决定写在哪只手一侧</small></h3>
        <div className="reading-rhythm-grid">
          <label>
            调性
            <select
              value={value.key ? value.key.mode : 'chromatic'}
              onChange={(event) => {
                const choice = event.target.value;
                patch({
                  key: choice === 'chromatic' ? null : { root: value.key?.root ?? 'C', mode: choice as 'major' | 'minor' },
                });
              }}
            >
              <option value="chromatic">不限调（半音阶）</option>
              <option value="major">大调</option>
              <option value="minor">小调</option>
            </select>
          </label>
          <label>
            调（根音）
            <select
              value={value.key?.root ?? 'C'}
              disabled={!value.key}
              onChange={(event) => {
                const root = event.target.value as (typeof KEY_ROOTS)[number];
                patch({ key: value.key ? { root, mode: value.key.mode } : null });
              }}
            >
              {KEY_ROOTS.map((root) => (
                <option key={root} value={root}>
                  {root}{value.key?.mode === 'minor' ? ' 小调' : ' 大调'}
                </option>
              ))}
            </select>
          </label>
          <label>
            谱表（手别）
            <select
              value={value.staffPreference}
              onChange={(event) => patch({ staffPreference: event.target.value as ReadingSetupValue['staffPreference'] })}
            >
              {(Object.keys(STAFF_CN) as Array<keyof typeof STAFF_CN>).map((pref) => (
                <option key={pref} value={pref}>{STAFF_CN[pref]}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="reading-setup-block" aria-label="目标音符数量">
        <h3>每题几个音</h3>
        <div className="reading-count-row" role="radiogroup">
          {([1, 2, 3, 4] as const).map((count) => (
            <button
              key={count}
              type="button"
              role="radio"
              aria-checked={value.notesPerEvent === count}
              className={value.notesPerEvent === count ? 'active' : ''}
              onClick={() => patch({ notesPerEvent: count })}
            >
              {count} 音
            </button>
          ))}
        </div>
        {!poolReady && (
          <p className="report-warning" role="status">
            目标池只有 {pool.length} 个音，无法支撑每事件 {value.notesPerEvent} 个不同目标音；请扩大音域。开始已禁用。
          </p>
        )}
      </div>

      {value.mode === 'free' ? (
        <div className="reading-setup-block" aria-label="自由识谱设置">
          <h3>题目数量</h3>
          <div className="reading-count-row" role="radiogroup">
            {([10, 20, 40] as const).map((count) => (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={value.questionCount === count}
                className={value.questionCount === count ? 'active' : ''}
                onClick={() => patch({ questionCount: count })}
              >
                {count} 题
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="reading-setup-block" aria-label="节奏识谱设置">
          <h3>节奏设置</h3>
          <div className="reading-rhythm-grid">
            <label>
              拍号
              <select
                value={value.timeSignature[0]}
                onChange={(event) => patch({ timeSignature: [Number(event.target.value) as 2 | 3 | 4, 4] })}
              >
                <option value={2}>2/4</option>
                <option value={3}>3/4</option>
                <option value={4}>4/4</option>
              </select>
            </label>
            <label>
              速度（40–180 BPM，四分音符为一拍）
              <input
                type="number"
                min={40}
                max={180}
                value={value.bpm}
                onChange={(event) => patch({ bpm: Number(event.target.value) || 0 })}
              />
            </label>
            <label>
              节奏复杂度
              <select
                value={value.complexity}
                onChange={(event) => patch({ complexity: event.target.value as ReadingComplexityChoice })}
              >
                <option value="basic">{COMPLEXITY_CN.basic}</option>
                <option value="intermediate">{COMPLEXITY_CN.intermediate}</option>
                <option value="advanced">{COMPLEXITY_CN.advanced}</option>
              </select>
            </label>
            <label>
              练习长度
              <select
                value={value.measures}
                onChange={(event) => patch({ measures: Number(event.target.value) as 2 | 4 | 8 })}
              >
                <option value={2}>2 小节</option>
                <option value={4}>4 小节</option>
                <option value={8}>8 小节</option>
              </select>
            </label>
            <label>
              预备拍
              <select
                value={value.countInMeasures}
                onChange={(event) => patch({ countInMeasures: Number(event.target.value) as 1 | 2 })}
              >
                <option value={1}>1 小节</option>
                <option value={2}>2 小节</option>
              </select>
            </label>
          </div>
        </div>
      )}

      <details className="reading-setup-block reading-advanced" aria-label="更多选项"><summary>更多选项</summary>
        <h3>seed（同一配置 + seed 生成完全一致的目标）</h3>
        <div className="reading-custom-row">
          <label>
            seed
            <input
              type="number"
              step={1}
              value={value.seed}
              onChange={(event) => patch({ seed: Number(event.target.value) })}
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => patch({ seed: Math.floor(Math.random() * 1_000_000) })}
          >
            换一个
          </button>
        </div>
      </details>

      <div className="reading-summary" aria-label="配置摘要">
        <span>模式 <b>{value.mode === 'free' ? '自由识谱' : '节奏识谱'}</b></span>
        <span>音区 <b>{value.ranges.length} 个 · {pool.length} 音</b></span>
        <span>每事件 <b>{value.notesPerEvent}</b> 音</span>
        {value.mode === 'free'
          ? <span>题目 <b>{value.questionCount}</b> 题</span>
          : (
            <>
              <span><b>{value.timeSignature[0]}/4</b> · <b>{value.bpm}</b> BPM</span>
              <span>{COMPLEXITY_CN[value.complexity]}</span>
              <span><b>{value.measures}</b> 小节 · 预备拍 <b>{value.countInMeasures}</b> 小节</span>
            </>
          )}
        <span>MIDI <b>{deviceConnected ? '已连接' : '未连接（可用虚拟键盘）'}</b></span>
        {value.mode === 'rhythm' && !handMappingReady && (
          <span className="reading-summary-warn">尚未确认「谱表→手别映射」；开始时需先在练习设置确认。</span>
        )}
      </div>

      {error && <p className="report-warning" role="alert">{error}</p>}

      <div className="reading-setup-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!ready}
          onClick={() => onStart(value)}
        >
          {busy ? '正在生成…' : value.mode === 'free' ? '开始自由识谱' : '生成节奏谱并准备'}
        </button>
        <span className="reading-setup-note">
          {deviceConnected ? `输入设备：${deviceLabel}` : '未连接 MIDI；练习中可用底部 81 键虚拟键盘输入。'}
        </span>
      </div>
    </section>
  );
}
