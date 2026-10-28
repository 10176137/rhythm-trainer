// 81-key note-reading setup page (task spec §4). Owns ONLY configuration
// state; generation and session state live in App / feature modules. Single
// screen, fixed action area, no page-level scrolling on desktop.

import { useMemo, useState } from 'react';
import {
  RANGE_PRESETS,
  clampReadingRange,
  keyLabel,
  midiLabel,
  readingPool,
  rangeLabel,
  type KeyMode,
  type KeyRoot,
  type KeySelection,
  type PitchRange,
} from '../features/reading/readingKeys';
import { readingPoolLabel } from '../features/reading/readingGenerator';
import type { ReadingStaffPreference } from '../features/reading/readingGenerator';

export type ReadingModeChoice = 'free' | 'rhythm';
export type ReadingComplexityChoice = 'basic' | 'intermediate' | 'advanced';
export type ReadingKeyChoice = 'chromatic' | 'major' | 'minor';

export interface ReadingSetupValue {
  mode: ReadingModeChoice;
  ranges: PitchRange[];
  notesPerEvent: 1 | 2 | 3 | 4;
  seed: number;
  /** null = 不限调（半音阶）. */
  key: KeySelection | null;
  keyChoice: ReadingKeyChoice;
  keyRoot: KeyRoot;
  staffPreference: ReadingStaffPreference;
  questionCount: 10 | 20 | 40;
  timeSignature: [2 | 3 | 4, 4];
  bpm: number;
  complexity: ReadingComplexityChoice;
  measures: 2 | 4 | 8;
  countInMeasures: 1 | 2;
}

interface Props {
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

const KEY_ROOTS: KeyRoot[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const STAFF_CN: Record<ReadingStaffPreference, string> = {
  auto: '自动（按音高分谱表）',
  treble: '右手 · 高音谱表',
  bass: '左手 · 低音谱表',
};

function defaultSetup(): ReadingSetupValue {
  return {
    mode: 'free',
    ranges: [{ startMidi: 60, endMidi: 72 }],
    notesPerEvent: 1,
    seed: Date.now() % 1_000_000,
    key: null,
    keyChoice: 'chromatic',
    keyRoot: 'C',
    staffPreference: 'auto',
    questionCount: 20,
    timeSignature: [4, 4],
    bpm: 60,
    complexity: 'basic',
    measures: 4,
    countInMeasures: 1,
  };
}

export default function NoteReadingSetup({
  busy,
  error,
  deviceConnected,
  deviceLabel,
  handMappingReady,
  onStart,
}: Props) {
  const [value, setValue] = useState<ReadingSetupValue>(defaultSetup);
  const [customRange, setCustomRange] = useState<{ start: number; end: number }>({ start: 60, end: 72 });

  const pool = useMemo(() => readingPool(value.ranges, value.key), [value.ranges, value.key]);
  const poolReady = pool.length >= value.notesPerEvent;
  const bpmReady = value.mode !== 'rhythm' || (Number.isFinite(value.bpm) && value.bpm >= 40 && value.bpm <= 180);
  const seedReady = Number.isInteger(value.seed);
  const ready = poolReady && bpmReady && seedReady && !busy;

  const patch = (changes: Partial<ReadingSetupValue>) => setValue((prev) => ({ ...prev, ...changes }));

  const togglePreset = (presetId: string) => {
    const preset = RANGE_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    setValue((prev) => ({ ...prev, ranges: preset.ranges.map((range) => ({ ...range })) }));
  };

  const addCustomRange = () => {
    const range = clampReadingRange({ startMidi: customRange.start, endMidi: customRange.end });
    if (!range) return;
    setValue((prev) => {
      // Merge into the existing set; overlaps are unioned at pool time.
      const merged = [...prev.ranges, range];
      return { ...prev, ranges: merged };
    });
  };

  const removeRange = (index: number) => {
    setValue((prev) => ({ ...prev, ranges: prev.ranges.filter((_, i) => i !== index) }));
  };

  return (
    <section className="reading-setup" aria-label="81 键识谱训练配置">
      <header className="reading-setup-head">
        <div>
          <div className="eyebrow">81-KEY READING</div>
          <h2>81 键识谱训练</h2>
          <p>选择练习模式与音域，配置每题/每事件的目标音数量；目标谱面由真实五线谱渲染，节奏识谱走现有 Rust 评分链路。</p>
        </div>
      </header>

      <div className="reading-mode-cards" role="radiogroup" aria-label="练习模式">
        <button
          type="button"
          role="radio"
          aria-checked={value.mode === 'free'}
          className={`reading-mode-card ${value.mode === 'free' ? 'selected' : ''}`}
          onClick={() => patch({ mode: 'free' })}
        >
          <strong>自由识谱</strong>
          <span>不限时识别目标音符。弹出当前题目的全部目标琴键后进入下一题，不按反应速度评分。</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value.mode === 'rhythm'}
          className={`reading-mode-card ${value.mode === 'rhythm' ? 'selected' : ''}`}
          onClick={() => patch({ mode: 'rhythm' })}
        >
          <strong>节奏识谱</strong>
          <span>按照乐谱、拍号和速度演奏。系统评价音高、起音时间、按键时长与同时起音准确性。</span>
        </button>
      </div>

      <div className="reading-setup-block" aria-label="音域选择">
        <h3>音域（可多选区间，并集为目标池）</h3>
        <div className="reading-preset-row">
          {RANGE_PRESETS.map((preset) => {
            const active = value.ranges.length === preset.ranges.length
              && value.ranges.every((range, index) => range.startMidi === preset.ranges[index].startMidi
                && range.endMidi === preset.ranges[index].endMidi);
            return (
              <button
                key={preset.id}
                type="button"
                className={active ? 'active' : ''}
                onClick={() => togglePreset(preset.id)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <div className="reading-custom-row">
          <label>
            自定义起音
            <select
              value={customRange.start}
              onChange={(event) => setCustomRange((prev) => ({ ...prev, start: Number(event.target.value) }))}
            >
              {Array.from({ length: 81 }, (_, i) => 28 + i).map((midi) => (
                <option key={midi} value={midi}>{midiLabel(midi)}</option>
              ))}
            </select>
          </label>
          <label>
            自定义止音
            <select
              value={customRange.end}
              onChange={(event) => setCustomRange((prev) => ({ ...prev, end: Number(event.target.value) }))}
            >
              {Array.from({ length: 81 }, (_, i) => 28 + i).map((midi) => (
                <option key={midi} value={midi}>{midiLabel(midi)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="button button-outline button-small" onClick={addCustomRange}>
            添加区间
          </button>
        </div>
        <div className="reading-range-list">
          {value.ranges.map((range, index) => (
            <span key={`${range.startMidi}-${range.endMidi}-${index}`} className="reading-range-chip">
              {rangeLabel(range)}
              <button type="button" aria-label={`移除区间 ${rangeLabel(range)}`} onClick={() => removeRange(index)}>×</button>
            </span>
          ))}
          <span className="reading-pool-count">
            目标池 {value.key ? `${keyLabel(value.key)} · ${pool.length} 音（已按调性筛选）` : readingPoolLabel(value.ranges)}
          </span>
        </div>
      </div>

      <div className="reading-setup-block" aria-label="调性与谱表">
        <div className="reading-rhythm-grid">
          <label>
            调性（升降号与音池随调号；不限 = 半音阶）
            <select
              value={value.keyChoice}
              onChange={(event) => {
                const choice = event.target.value as ReadingKeyChoice;
                patch({
                  keyChoice: choice,
                  key: choice === 'chromatic' ? null : { root: value.keyRoot, mode: choice as KeyMode },
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
              value={value.keyRoot}
              disabled={value.keyChoice === 'chromatic'}
              onChange={(event) => {
                const root = event.target.value as KeyRoot;
                patch({
                  keyRoot: root,
                  key: value.keyChoice === 'chromatic' ? null : { root, mode: value.keyChoice },
                });
              }}
            >
              {KEY_ROOTS.map((root) => (
                <option key={root} value={root}>
                  {root}{value.keyChoice === 'minor' ? ' 小调' : ' 大调'}
                </option>
              ))}
            </select>
          </label>
          <label>
            谱表（手别）
            <select
              value={value.staffPreference}
              onChange={(event) => patch({ staffPreference: event.target.value as ReadingStaffPreference })}
            >
              {(Object.keys(STAFF_CN) as ReadingStaffPreference[]).map((pref) => (
                <option key={pref} value={pref}>{STAFF_CN[pref]}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="reading-setup-block" aria-label="目标音符数量">
        <h3>每个时间点/音符组的目标音数量</h3>
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

      <div className="reading-setup-block" aria-label="seed">
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
      </div>

      <div className="reading-summary" aria-label="配置摘要">
        <span>模式 <b>{value.mode === 'free' ? '自由识谱' : '节奏识谱'}</b></span>
        <span>目标池 <b>{value.key ? `${keyLabel(value.key)} · ${pool.length} 音` : readingPoolLabel(value.ranges)}</b></span>
        <span>每事件 <b>{value.notesPerEvent}</b> 音</span>
        <span>谱表 <b>{STAFF_CN[value.staffPreference]}</b></span>
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
