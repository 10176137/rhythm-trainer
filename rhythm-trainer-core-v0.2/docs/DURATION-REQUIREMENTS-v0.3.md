# Rhythm Trainer 需求规格 v0.3：按键时长与节奏评估

- 文档类型：可交付给 Codex / Zcode 的产品需求 + 引擎实现规格
- 适用项目：Rhythm Trainer
- 前端基线：React + TypeScript + Vite
- 核心评估基线：Rust Core
- 输入：MIDI 键盘事件 + MusicXML 乐谱（第一阶段）
- 默认练习场景：乐谱跟练，80 BPM，双手，实时反馈
- 本版本重点：以 MIDI Note On / Note Off 计算实际按键时长；同时保留起音时刻与相邻起音间隔，三者不得混为一个指标。

---

## 1. 变更背景与关键结论

此前的简单节奏判断容易把“前后两个音符的起音间隔”当作音符本身的时值。v0.3 要修正这一点。

**实际按键时长的定义：** 对一个已配对的 MIDI 音符事件，`actualKeyDownMs = noteOffTimestampMs - noteOnTimestampMs`。

**起音间隔的定义：** `interOnsetIntervalMs = nextNoteOnTimestampMs - currentNoteOnTimestampMs`。该值描述连续起音之间隔了多久，并不等于当前音符被按住了多久。

**目标时值的定义：** 从 MusicXML 得到音符在乐谱时间轴上的理论时值，再按节拍定义与当前速度换算成目标时值。四分音符/八分音符的类别首先由乐谱语义决定，而不是单靠实测时长猜测。

例如 4/4 拍、80 BPM 时，以四分音符为一拍：

- 一拍 = `60,000 / 80 = 750 ms`
- 四分音符理论时值 = 1 拍 = 750 ms
- 八分音符理论时值 = 0.5 拍 = 375 ms

但演奏中的真实按键时长可能因为断奏、连奏、相邻音符重叠、演奏习惯或踏板而与理论时值不同。因此：

1. **判断按键时值是否符合目标时值时，按键时长是核心观测量。**
2. **判断音符是否弹在正确拍点时，起音时间偏差是核心观测量。**
3. **判断节奏是否稳定、是否漏拍或挤拍时，相邻起音间隔是辅助观测量。**
4. 不得单靠任一项指标替代另外两项。
5. MIDI 只能直接测到按键按下/释放事件；它不能单独准确测量琴弦/采样声音的实际响声时长。踏板控制的是声音延续，不等同于手指仍按住琴键。

---

## 2. 产品目标

### 2.1 目标

构建可解释、可复现的练习评估基础能力，能够针对每个目标音符分别回答：

- 音高是否正确？
- 是否在目标拍点附近起音？提前或滞后多少毫秒？
- 实际按键持续了多久？相对于乐谱目标时值是偏短还是偏长？
- 当前音符与下一个音符的起音间隔是否符合节奏结构？
- 证据是否足够支持明确反馈？如果不足，应当显示“无法判断”，而不是强行判错。

### 2.2 非目标

v0.3 不要求：

- 仅凭 MIDI 估计音色、力度控制的全部音乐表现或琴键机械触感。
- 从 MIDI 起音间隔自动推测乐谱上音符原本是四分音符还是八分音符。
- 通过踏板 MIDI CC 直接推断真实声学衰减时间。
- 在首个版本中完成音频识别、摄像头手势判断、完整教学大模型。
- 将简单规则诊断包装成确定的“错误原因”。

---

## 3. 术语与数据语义

| 名称 | 字段建议 | 定义 | 主要用途 |
|---|---|---|---|
| 目标起音拍位 | `expectedOnsetBeats` | 音符在乐谱时间轴上的目标起音位置 | 对齐与节拍定位 |
| 目标时值拍数 | `expectedDurationBeats` | 乐谱音符持续的理论拍数 | 时值目标 |
| 目标起音时间 | `expectedOnsetMs` | 由起始时间、速度和拍位换算得到的目标时间 | 计算提前/滞后 |
| 目标按键时长 | `targetKeyDownMs` | 目标时值经时值策略换算后的期望按键时长 | 按键时长评分 |
| 实际起音时间 | `actualOnsetMs` | MIDI Note On 的单调时钟时间戳 | 起音偏差 |
| 实际释放时间 | `actualOffsetMs` | 与 Note On 匹配的 MIDI Note Off 时间戳 | 计算实际按键时长 |
| 实际按键时长 | `actualKeyDownMs` | `actualOffsetMs - actualOnsetMs` | 时值评估 |
| 起音间隔 | `interOnsetIntervalMs` | 当前 Note On 到后一个 Note On 的时间差 | 节奏比例与节奏稳定性 |
| 起音误差 | `onsetErrorMs` | `actualOnsetMs - expectedOnsetMs` | 提前/滞后反馈 |
| 时值比率 | `durationRatio` | `actualKeyDownMs / targetKeyDownMs` | 偏短/偏长判断 |
| 释放间隙 | `releaseGapMs` | 下一音起音与当前音释放的差值：`nextOnset - currentOffset` | 观察断开/重叠，不直接等价于音乐错误 |
| 声音持续时间 | — | 实际可听声音持续多久 | v0.3 的 MIDI 输入无法可靠直接测量 |

时间戳统一采用单调时钟域，避免系统时间被校准或改变导致时间差失真。数据模型中应明确单位，禁止混用秒、毫秒与拍数。

---

## 4. 核心评分原则

### 4.1 分开计算三条时间线

引擎要独立计算：

1. **起音时间线**：实际 Note On 相对目标起音的偏差。
2. **按键持续时间线**：实际 Note Off 减 Note On，并与目标时值策略比较。
3. **起音序列时间线**：连续 Note On 之间的间隔，用于辅助判断节奏比例、漏拍、挤拍或速度漂移。

不得把 `nextOnset - currentOnset` 当作 `actualKeyDownMs`。
不得把 `noteOff - noteOn` 当作起音偏差。

### 4.2 先对齐，再评估时值

处理顺序建议：

1. 采集并校验原始 MIDI 事件。
2. 将 Note On / Note Off 配对，产生实际按键区间。
3. 从 MusicXML 提取目标音符和乐谱时间轴。
4. 基于音高、声部、目标起音窗口和演奏顺序，把实际按键事件匹配到目标音符。
5. 计算起音误差、按键时长误差、起音间隔等特征。
6. 根据模式选择的时值策略判定结果。
7. 生成带证据与置信度的反馈。

如果匹配关系不可靠（例如同音重复、持续和弦、MIDI 事件丢失），不得将该事件直接作为高置信度时值错误。

### 4.3 不要把全局延迟当成时值错误

如果用户每个音都晚约 100 ms，但按键时长和相对间隔正常，应主要提示“整体偏晚”，而不是“音符都弹短了/弹长了”。

如果用户 Note On 准确但 Note Off 提前，应提示按键持续时间偏短，而不是起音抢拍。

如果 Note On 均匀但相邻间隔长期变大/变小，应分析速度漂移，而不能只看按键时长。

---

## 5. 时值评估策略

### 5.1 模式配置

练习模式必须可以声明目标时值的解释策略。建议第一阶段支持：

```ts
export type DurationEvaluationPolicy =
  | 'strict-keydown'
  | 'articulation-aware'
  | 'disabled';
```

- `strict-keydown`：对初学者专项“按键时值训练”使用。目标时值直接转换为目标按键时长，使用明确容差判断偏短/合格/偏长。
- `articulation-aware`：用于一般乐谱跟练。根据连线、断奏标记、音符重叠关系和当前曲目策略调整目标按键窗口；在 v0.3 无法可靠解释的音乐语境中应降低置信度或只报告测量值，不应强罚。
- `disabled`：自由弹奏或未提供可信目标时值时，不对按键时长评分，但仍可记录实际按键时长。

默认建议：

- 乐谱跟练：`articulation-aware`，如果尚无足够的乐谱标记支持，则先展示 measured duration，不强行扣分。
- 独立时值训练：`strict-keydown`。
- 自由弹奏：`disabled`。

### 5.2 目标时值换算

若四分音符为一拍、速度为 `bpm`：

`quarterMs = 60_000 / bpm`

`targetNominalMs = expectedDurationBeats * quarterMs`

目标按键时长要由策略进一步确定：

`targetKeyDownMs = durationPolicy.mapTargetDuration(targetNominalMs, articulationContext)`

其中 `articulationContext` 可包括 staccato、tenuto、tie/slur、声部重叠和用户所选训练目标。MusicXML 中的分母拍值、附点、连音、跨小节延音等必须先规范化为 `expectedDurationBeats`。不能用音符符号的字面类型写死时长，因为拍号、附点与 tuplets 都会改变时值。

### 5.3 时值判定

配置应支持两个门限：

- `durationToleranceMs`：绝对时间容差。
- `durationToleranceRatio`：相对目标时长的比例容差。

建议判定容差取两者中较宽者，避免高速下容差过小、低速下比例过度放宽：

`allowedErrorMs = max(durationToleranceMs, targetKeyDownMs * durationToleranceRatio)`

`durationErrorMs = actualKeyDownMs - targetKeyDownMs`

- `durationErrorMs < -allowedErrorMs`：`too_short`
- `durationErrorMs > allowedErrorMs`：`too_long`
- 其余：`within_tolerance`

建议初始默认只作为可配置实验值，而非医学/音乐学意义的标准：`durationToleranceMs = 50 ms`，`durationToleranceRatio = 0.15`。实际门限应基于真实键盘设备、用户测试和不同速度做校准，并允许练习类型单独配置。

### 5.4 时值与起音错误组合

至少要支持以下独立结论：

- 起音准确 + 时值准确。
- 起音偏早 + 时值准确。
- 起音偏晚 + 时值准确。
- 起音准确 + 按键过短。
- 起音准确 + 按键过长。
- 起音偏差 + 时值偏差（同时报告两个问题）。
- 数据不完整 / 匹配置信度低 / 无法判定。

不要把多个问题压成一个含义不明的“节奏准确率”。可以另提供总分，但必须同时保留分项指标。

---

## 6. MIDI 事件与 Note On / Note Off 配对

### 6.1 输入处理

每条原始事件应尽量保存：

```ts
interface MidiEvent {
  timestampMs: number;       // 单调时钟，相对于本次 session
  type: 'note_on' | 'note_off' | 'control_change' | 'device_connected' | 'device_disconnected';
  channel?: number;
  note?: number;             // MIDI pitch
  velocity?: number;
  controller?: number;
  value?: number;
  sourceId: string;
  sequence: number;          // 单个 source 内单调递增，用于稳定排序/复放
}
```

处理规则：

- 许多 MIDI 设备用 velocity=0 的 Note On 表示 Note Off，适配器必须统一为 `note_off`。
- 通过设备/source、MIDI channel、pitch 与配对顺序匹配 Note On / Note Off；要考虑同音重复、不同通道和可能的重叠音符。
- Note Off 找不到对应 Note On 时记为 `orphan_note_off`，不能生成负时长。
- 会话结束或设备断开仍未收到 Note Off 的音符标记为 `open_note_interrupted`，不得作为正常时值样本。
- 如果时钟倒退、事件乱序或时间戳异常，先依时间戳与 sequence 执行明确的排序/校验规则；无法恢复时标记数据质量问题。
- 保留原始事件日志，规范化与配对结果由确定性纯函数产生，便于回放复现与单元测试。

### 6.2 同音重复

对于同一 MIDI pitch 的连续/重叠事件，不允许简单使用 `Map<pitch, noteOn>` 覆盖上一个起音。需按设备、通道、pitch 建立可处理重复事件的队列或栈，并根据协议可辨识程度定义配对策略。若设备行为导致配对有歧义，应输出歧义标志并降低相关时值评价置信度。

### 6.3 踏板语义

- Note On / Note Off 测量的是物理按键按下区间的 MIDI 表达。
- Sustain Pedal（通常 CC64）可以在 Note Off 后延长声音；它不会延长 `actualKeyDownMs`。
- UI 应将“按键时长”与“踏板延音”分开显示。
- 在没有音频分析的情况下，禁止把按键释放时间解释为声音停止时间。

---

## 7. 目标数据模型

核心层建议以 Rust 类型作为权威模型，TypeScript 只保留兼容的 DTO。

```rust
pub struct TargetNote {
    pub id: String,
    pub pitch: u8,
    pub voice_id: String,
    pub onset_beats: f64,
    pub duration_beats: f64,
    pub expected_onset_ms: f64,
    pub nominal_duration_ms: f64,
    pub articulation: Articulation,
}

pub struct PerformedNote {
    pub id: String,
    pub pitch: u8,
    pub channel: u8,
    pub onset_ms: f64,
    pub offset_ms: Option<f64>,
    pub key_down_ms: Option<f64>,
    pub quality: NoteEventQuality,
}

pub struct NoteAssessment {
    pub target_note_id: Option<String>,
    pub performed_note_id: Option<String>,
    pub pitch_result: PitchResult,
    pub onset_error_ms: Option<f64>,
    pub expected_duration_beats: Option<f64>,
    pub target_key_down_ms: Option<f64>,
    pub actual_key_down_ms: Option<f64>,
    pub duration_error_ms: Option<f64>,
    pub duration_result: DurationResult,
    pub inter_onset_interval_ms: Option<f64>,
    pub confidence: f32,
    pub evidence: Vec<AssessmentEvidence>,
}
```

该示例是语义草案，不要求与现有代码逐字一致。最终应确保同一概念只有一个权威定义，Rust Core 是最终评分结果的唯一权威来源。

---

## 8. 反馈与前端要求

### 8.1 实时练习视图

每个正在评估的音符至少能展示：

- 乐谱目标音符和当前匹配到的演奏音符。
- 起音反馈：准、偏早、偏晚（毫秒）。
- 按键时长反馈：实际时长、目标时长、偏短/合格/偏长。
- 数据状态：有效、等待 Note Off、配对异常、无法判定。
- 仅在置信度超过配置门限时显示明确错误判断。

示例：

> D4：起音 +12 ms（合格）；按键 290 ms / 目标 375 ms（偏短 85 ms）。

该反馈必须让用户知道按键起得准但释放得过早，避免含糊地显示“节奏错误”。

### 8.2 练习结束报告

分开汇总：

- 音高匹配率。
- 起音偏差平均值与分布（区分系统性早/晚与随机波动）。
- 按键时长偏差平均值、过短比例、过长比例。
- 起音间隔的稳定性与速度漂移。
- 无法评分/不完整事件比例。
- 左右手分项数据（如果乐谱声部或 MIDI channel/手部映射可信）。

不得只用一个综合百分比掩盖不同时值与起音问题。

### 8.3 交互规则

- 用户可以开启/关闭实时反馈，但采集事件不应因此改变。
- 暂停、恢复、结束时，事件时钟与 Note Off 收尾策略必须明确；暂停时不能把整个暂停时间算作按键时长。
- 模式切换不得将上一 session 的 Note On 与下一 session 的 Note Off 错误配对。
- 练习设置中提供时值评估策略和容差配置；普通用户默认使用预设档位，开发者/高级模式可查看详细数据。

---

## 9. Rust Core API 要求

建议把逻辑拆成可回放、无 UI 依赖的模块：

```text
rust-core/src/
├── midi/
│   ├── normalize.rs      # velocity=0 Note On、设备事件统一
│   ├── pair_notes.rs     # Note On / Note Off 配对与异常质量
│   └── event_log.rs      # 可确定性回放的原始事件
├── score/
│   ├── musicxml.rs       # 乐谱读入与规范化
│   └── timeline.rs       # 目标音符拍位/时值/目标时间轴
├── alignment/
│   └── matcher.rs        # 实际音符与目标音符对齐
├── assessment/
│   ├── onset.rs          # 起音误差
│   ├── duration.rs       # 按键时长评估
│   ├── rhythm.rs         # 起音间隔与节奏模式辅助分析
│   └── confidence.rs     # 置信度与证据
└── session.rs            # session 状态/时钟策略
```

建议的纯函数接口：

```rust
fn normalize_midi(events: &[RawMidiEvent]) -> Vec<NormalizedMidiEvent>;
fn pair_note_events(events: &[NormalizedMidiEvent]) -> Vec<PerformedNote>;
fn build_score_timeline(score: &ParsedScore, tempo_bpm: f64) -> Vec<TargetNote>;
fn align_performance(targets: &[TargetNote], performed: &[PerformedNote]) -> AlignmentResult;
fn assess_note_pairs(alignment: &AlignmentResult, policy: &DurationPolicy) -> Vec<NoteAssessment>;
```

要求：

- 不要在 React 中复制另一套评分算法。
- Rust Core 的结果必须可由同一输入稳定复现。
- 实时评估与练习结束后的回放评估应调用同一核心逻辑，避免实时结果和最终报告互相矛盾。
- 所有阈值必须进入版本化配置，不得散落硬编码魔法数字。
- API 要带 `engineVersion` 与 `policyVersion`，以便评估历史记录和回归行为。

---

## 10. 核心验收标准

### 10.1 计算正确性

1. 对同一目标音符，Note On 为 1000 ms、Note Off 为 1400 ms，实际按键时长应为 400 ms。
2. 当前音符 Note On 为 1000 ms、下一音符 Note On 为 1450 ms，起音间隔应为 450 ms，与 400 ms 的按键时长分开存储。
3. `Note On velocity=0` 被规范化为释放事件。
4. 如果 Note Off 缺失，时值结果应为未知/无效，而不是 0 ms 或默认时长。
5. 若起音误差为 +100 ms、按键时长误差为 0 ms，应只报告起音偏晚，不报告按键过长或过短。
6. 若起音误差为 0 ms、按键时长比目标短 100 ms 且超出容差，应报告“按键偏短”，不应报告抢拍。
7. 调整 tempo 后，目标毫秒时值按新的 BPM 重新生成，但源 MusicXML 中以拍数表达的时值保持不变。
8. 附点、三连音、休止符、tie、跨小节延音都必须有针对性测试；不支持或无法解析的 MusicXML 语义要明确降级，不得静默当作普通音符。

### 10.2 稳定性

1. 重复 MIDI 事件、错序时间戳、孤立 Note Off、未闭合 Note On、设备断开均有明确结果状态。
2. 相同输入事件与配置重复运行，结果完全一致。
3. 暂停期间不累计到任何一个音符的按键持续时间。
4. 同音重复事件不得因使用单个 pitch 键值而互相覆盖。
5. 实时评价与结束后批量复算，在相同事件窗口和配置下，结果一致。

### 10.3 产品可解释性

1. 任一“偏短/偏长”结论都能查看目标时长、实测时长、误差和门限。
2. 任一“偏早/偏晚”结论都能查看目标起音、实际起音和误差。
3. 当数据不完整或匹配置信度不足时，系统不强行判错。
4. 报告分别给出音高、起音、按键时值、间隔稳定性数据。

---

## 11. 必须覆盖的测试场景

以 80 BPM、四分音符为一拍作为基础样例，四分音符目标名义时值 750 ms，八分音符目标名义时值 375 ms。以下实测值只是测试输入，不表示所有真实演奏必须按住整整相同毫秒数；只有使用 `strict-keydown` 时才按明确目标和容差判定。

| 场景 | 目标 | MIDI 事件 | 预期结论 |
|---|---|---|---|
| 四分音符时值符合 | 750 ms 目标 | On 1000, Off 1740（740 ms） | 在容差内；不影响起音评估 |
| 八分音符释放过早 | 375 ms 目标 | On 1000, Off 1290（290 ms） | 时值偏短；单独报告 duration error |
| 起音晚但按键时值正常 | 375 ms 目标 | On 1100, Off 1475（375 ms） | 起音晚 100 ms；时值符合 |
| 起音准但按键过长 | 375 ms 目标 | On 1000, Off 1410（410 ms） | 起音准；按键时值偏长（具体看容差） |
| 起音间隔与按键时长不同 | 两音 On 间隔 450 ms | 第一音 On 1000/Off 1400，第二音 On 1450 | 第一音 key-down=400 ms，IOI=450 ms，两者不得混淆 |
| Note Off 缺失 | 任意 | 仅收到 On | 时值不可评分，保留质量错误 |
| 踏板延音 | 任意 | Note Off 后 CC64 仍为 pedal down | key-down 只算到 Note Off；不把踏板时间加到手指按键时长 |
| 全局时间偏移 | 若干目标音 | 每个 On 都晚 100 ms，duration 正常 | 检出系统性滞后，不误报一系列时值错误 |

---

## 12. 推荐实施顺序

### M1：事件语义正确（必须先完成）

- 统一 MIDI Note On / Note Off 表示。
- 建立可处理同音重复的 Note On/Off 配对器。
- 对异常/未闭合事件输出质量状态。
- 保存原始事件并支持确定性回放。

### M2：时值计算和单音评估

- MusicXML 规范化出 `onsetBeats`、`durationBeats`、articulation。
- 建立 tempo 到毫秒的时间轴转换。
- 实现实际按键时长、起音误差和起音间隔三类指标。
- 实现 strict-keydown 与 disabled 策略，并完成单元测试。

### M3：真实乐谱对齐与实时 UI

- 对齐目标音符与演奏音符。
- UI 分别呈现起音与按键时长反馈。
- 连接真实 MIDI 设备，补充硬件事件时延和时间戳质量测试。

### M4：音乐语境与教学诊断

- 根据 MusicXML 连线、断奏、附点、连音等扩展 articulation-aware 策略。
- 分析重复出现的时值问题，生成专项练习建议。
- 加入相似新乐句迁移测试与延迟复测。

M1 和 M2 通过测试前，不应宣称引擎已经可靠地区分并诊断各类音符时值。

---

## 13. 给实现 Agent 的执行指令

实现本需求时遵循以下顺序：

1. 先检查当前仓库现有结构，不得在不理解现有代码时重建整套项目。
2. 先提交设计变更清单：哪些文件新增/修改、现有 API 是否兼容、测试如何覆盖。
3. 先实现纯 Rust 单元测试与 MIDI 事件配对器，再实现时值评分；不得先在前端写一套临时评分逻辑后长期保留。
4. 前端仅负责呈现 Rust 返回的 `onsetResult`、`durationResult`、`confidence` 与 evidence。
5. 保留现有模式注册表；增加 `durationEvaluationPolicy` 与容差配置，让不同模式选择不同策略。
6. 对每一个阈值说明单位、默认值、配置来源，并加边界测试。
7. 实现完成后运行 formatter、lint、单元测试和构建；报告真实执行结果，不能把静态检查描述为完整构建成功。
8. 对未支持的 MusicXML 语义、硬件兼容问题和无法可靠判定的场景明确写入 README，不得默默简化。

---

## 14. 本版本的最终规则

**不要把“起音间隔”改名为“按键时长”，而是正确地增加并评估按键时长。**

按键时长用 `Note Off - Note On` 计算，主要回答“琴键按住了多久”；起音偏差回答“何时弹下”；相邻起音间隔回答“音符之间的节奏间距”。对于四分音符、八分音符的训练，目标时值取自 MusicXML 的节奏语义，再根据选定的时值评估策略，与实际按键时长比较。只有这样，评分才有明确的音乐含义，也能支持后续不同练习模式复用同一引擎。
