# GOLDEN FIXTURES（R1 交付物 5/5）

**日期：** 2026-10-23
**性质：** 真值规范 + 差分纪律。**尚未写入仓库测试**（本轮不改生产代码，也不新增测试文件）。
**Fixture 位置：** `D:\123\audit-r1\fixtures\`
**legacyReference 原始输出：** `D:\123\audit-r1\spike\out\importer-dump.json`（本次实际运行 TS 流水线产生）

> **核心纪律：** 下面每个 expected 值都是**手工推导**的（推导过程写在每节里）。旧 TS 输出只作为 `legacyReference` 差分对象，**不是真值**。任何人修改 expected 必须记录原因、审批与 schema 版本。

---

## 0. 五个 golden case 一览

| Case | 文件 | 拍号 | 覆盖点 | BPM | count-in |
|---|---|---|---|---|---|
| G1 | `g1_single_voice.musicxml` | 4/4 × 2 | 基础 onset/duration、休止、跨小节推进 | 80 | 3 000 000 µs（=4 拍） |
| G2 | `g2_chord.musicxml` | 4/4 × 1 | 同 onset 三音和弦 + **重复同音** + 休止 | 100 | 2 400 000 µs（=4 拍） |
| G3 | `g3_tie_across_bar.musicxml` | 2/4 × 2 | 跨小节 tie：1 次起音、4 拍时值 | 120 | 2 000 000 µs（=4 拍） |
| G4 | `g4_triplet.musicxml` | 4/4 × 1 | 三连音 1/3 拍、精确 tick | 60 | 4 000 000 µs（=4 拍） |
| G5 | `g5_three_four.musicxml` | 3/4 × 2 | 非 4/4 小节长度与 barline 起点 | 90 | 2 666 667 µs（=4 拍四舍五入） |

**为什么 count-in 用 µs 而不是拍：** 见 §1.3。G5 的 4 拍在 90 BPM 下是 2 666 666.67 µs，不是整数；把 count-in 定义为**整数 µs**可以消除双重舍入。

---

## 1. 统一时间规则（`time-conversion-v1`）

### 1.1 单位与定义

| 名称 | 类型 | 定义 | 用途 |
|---|---|---|---|
| `ScorePosition` | `{numerator:int, denominator:int}` | 四分音符拍，**精确有理数**，约分后分母 > 0 | 唯一音乐位置真值 |
| `PlanOffsetUs` | `int64` µs | `round(beat × 60_000_000 / bpm)`，相对**播放起点**（不含 count-in） | plan 排序、目标时刻表 |
| `CountInUs` | `int64` µs | 前置预备段长度，**整数 µs 输入** | count-in |
| `TargetOnsetUs` | `int64` µs | `CountInUs + PlanOffsetUs` | 评分目标起音 |
| `Tick` | `int64` | `beat × PPQ / denominator`，**必须整除** | Rust 时刻表 |
| `PPQ` | `int` | 默认 **960** | — |
| `DisplayMs` | `f64` | `Us / 1000`，**只用于显示**，不参与比较 | UI |

### 1.2 舍入规则（版本化）

```
PlanOffsetUs = sign * floor(|n * 60_000_000| / (bpm * d) + 1/2)      // half away from zero
```
- **只舍入一次**：`TargetOnsetUs = CountInUs + PlanOffsetUs`，不对 `CountInUs` 与 `PlanOffsetUs` 分别舍入后再相加，**也不把舍入后的结果继续用于音乐运算**。
- `Tick`：`(n * PPQ) % d != 0` → **不得四舍五入**；返回 `tick_grid_rounding` 并阻断 strict（当前 `planToTicks` 已如此，`playback-planner.ts:269`）。
- 禁止：`durationUs` 用"相邻 onset 相减"推导（会累积舍入误差）。时值独立按上式换算。
- 禁止：浮点 beat 作为任何真值。`beatPosition: 0.3333333333333333` 这类值只能出现在**显示/兼容**字段。

### 1.3 count-in

- 产品默认 3 s → `CountInUs = 3_000_000`（精确）。
- `countInBeats` 由 `CountInUs × bpm / 60_000_000` 推导，**可含小数**（70 BPM → 3.5），只用于 UI 与节拍器，不参与目标计算。
- 现状差异：当前实现以 `countInBeats`（float）为输入再乘拍长（`countdown.ts:14`、`score-events.ts:16`、`engine-server.mjs:1281`）。契约要求改为以 `CountInUs` 为输入；**这是 R2 的接口变更**。
- count-in 期间的输入：`scoringStartUs = TargetOnsetUs(first) - goodWindowUs` 之前一律不计分（现状用 ms，语义相同）。

### 1.4 版本
`time-conversion-v1`：上面三条规则 + PPQ 默认值 + count-in 以 µs 为准。任何变更 → `v2`，旧报告不重算。

---

## 2. G1 — 单声部（4/4 × 2，BPM 80）

### 2.1 输入

```xml
divisions=1; time 4/4; key 0; clef G2
m1: C4 q, D4 q, E4 q, F4 q
m2: G4 h, rest h
```

### 2.2 手工推导

| 事件 | 小节 | 小节内拍位 | 绝对拍位 | 时值（拍） | 小节起点 | 小节长度 |
|---|---|---|---|---|---|---|
| C4 | 1 | 0 | 0 | 1 | 0 | 4 |
| D4 | 1 | 1 | 1 | 1 | 0 | 4 |
| E4 | 1 | 2 | 2 | 1 | 0 | 4 |
| F4 | 1 | 3 | 3 | 1 | 0 | 4 |
| G4 | 2 | 0 | 4 | 2 | 4（=0+4） | 4 |
| rest | 2 | 2 | 6 | 2 | 4 | 4 |

- 小节长度 = `beats × 4 / beatType` = 4。
- `rangeStartBeat = 0`，`rangeDurationBeat = 8`。
- BPM 80 → 1 拍 = `60_000_000/80 = 750 000 µs`。

**PlanOffsetUs**（不含 count-in）：`0, 750000, 1500000, 2250000, 3000000`
**时值 µs**：`750000, 750000, 750000, 750000, 1500000`
**CountInUs = 3 000 000** → **TargetOnsetUs**：`3000000, 3750000, 4500000, 5250000, 6000000`
**Tick@960**：`0/960, 960/960, 1920/960, 2880/960, 3840/1920`（`起始/时值`）

### 2.3 期望输出（全部为真值）

```
importReport.status        = READY
strictAllowed              = true
counts                     = {partCount:1, measureCount:2, noteCount:5, restCount:1, chordNoteCount:0, tieSpanCount:0, graceCount:0, cueCount:0}
measures[0].startBeat      = 0/1 ; durationBeat = 4/1
measures[1].startBeat      = 4/1 ; durationBeat = 4/1
events (kind, spelling, onset, duration, measureOrdinal, staff, voice, dotted)
  note C4 0/1  1/1 m1 s1 v1
  note D4 1/1  1/1 m1 s1 v1
  note E4 2/1  1/1 m1 s1 v1
  note F4 3/1  1/1 m1 s1 v1
  note G4 4/1  2/1 m2 s1 v1
  rest --  6/1  2/1 m2 s1 v1
tieSpans                   = []
plan.occurrences.length    = 5
plan.groups.length         = 5
plan.occurrence[i].playbackBeat = 0/1, 1/1, 2/1, 3/1, 4/1
scoreEvents[i].targetOnsetMs = 3000, 3750, 4500, 5250, 6000
scoreEvents[i].targetDurationMs = 750, 750, 750, 750, 1500
atoms = [{0,960},{960,960},{1920,960},{2880,960},{3840,1920}]  // bar 1,1,1,1,2
atoms[i].beat (1-based, 小节内) = 1,2,3,4 → m1；1 → m2
```
**ID（对固定文件字节，fingerprint 稳定）**
```
fingerprint = 44a959429fe07921e744f87721b7442c4ec34dbfa3c2e3260bdc467090af4692
event id    = 44a959429fe07921:P1:m1:e{1..4}, 44a959429fe07921:P1:m2:e{1,2}
planId      = plan:44a959429fe07921:m1-2:once:playback-planner-1.0.0
occurrenceId= plan:44a959429fe07921:m1-2:once:playback-planner-1.0.0:p0:44a959429fe07921:P1:m1:e1  (等)
```

### 2.4 必须断言的"反例"

- 休止符**不是** occurrence，也不产生 scoreEvent。
- m2 的 G4 **不是** `playbackBeat 6/1`（那是休止符的位置），而是 `4/1`。
- `rangeDurationBeat` = 8，不是 6（小节长度驱动，不由最后音符决定）。

### 2.5 legacyReference 差分（TS 实测）

| 字段 | 真值 | legacyReference | 分类 |
|---|---|---|---|
| occurrence 数 | 5 | 5 | 一致 |
| group 数 | 5 | 5 | 一致 |
| playbackBeat | `0/1…4/1` | `0/1…4/1` | 一致 |
| targetOnsetMs | 3000/3750/4500/5250/6000 | 同 | 一致 |
| targetDurationMs | 750×4, 1500 | 同 | 一致 |
| 休止排除 | 是 | 是 | 一致 |

**结论：G1 无差异。**

---

## 3. G2 — 和弦 + 重复同音（4/4 × 1，BPM 100）

### 3.1 输入

```xml
divisions=1; 4/4
m1: C4 q ; <chord/>E4 q ; <chord/>G4 q ; C4 q ; rest h
```

### 3.2 手工推导

| 事件 | 小节内拍位 | 时值 | 说明 |
|---|---|---|---|
| C4(1) | 0 | 1 | 和弦锚（cursor 前进 1） |
| E4 | 0 | 1 | `<chord/>`，**不前进 cursor** |
| G4 | 0 | 1 | `<chord/>`，**不前进 cursor** |
| C4(2) | 1 | 1 | 重复同音，**新的起音** |
| rest | 2 | 2 | cursor 到 4 |

- 1 拍 = `60_000_000/100 = 600 000 µs`。
- **PlanOffsetUs**：`0, 0, 0, 600000`；时值：`600000 ×4`。
- **CountInUs = 2 400 000** → **TargetOnsetUs**：`2400000, 2400000, 2400000, 3000000`。
- **Tick@960**：`0/960, 0/960, 0/960, 960/960`。

### 3.3 期望输出

```
counts = {measureCount:1, noteCount:4, restCount:1, chordNoteCount:2}
events[0..2].onsetBeat = 0/1（三者相同）
events[0..2].chordGroupId = "chord:<eventId of C4(1)>"
events[3].onsetBeat = 1/1 ; chordGroupId = 无
plan.occurrences.length = 4
plan.groups.length = 2
groups[0]: playbackBeat 0/1, pitches [C4,E4,G4], occurrenceIds 3 个, durationBeat 1/1
groups[1]: playbackBeat 1/1, pitches [C4],           occurrenceIds 1 个, durationBeat 1/1
scoreEvents: 三个 targetOnsetMs=2400（pitch 60/64/67）+ 一个 3000（pitch 60）
atoms: [{0,960},{960,960}]          // 同 onset 的三个音合并成 1 个 atom
```
**ID**
```
fingerprint = 60ce9316750df57bbeed5305f3220024e118d3d26ea7795bebf3a7f25bbcd413
event id    = 60ce9316750df57b:P1:m1:e{1..4}
```

### 3.4 必须断言

1. 三个和弦音的 `playbackBeat` **完全相同**（0/1），**不是** 0/1、1/1、2/1 的旋律顺序。
2. group[0] 含 3 个 occurrence，`pitches` 顺序 = XML 顺序（C4,E4,G4）。
3. 重复 C4 是**独立 occurrence**、独立 scoreEvent、独立起音，`scoreEventId` 不同。
4. atoms 数 = 2（和弦合并），而 scoreEvents 数 = 4（逐音）。**两者不等是设计，不是 bug**——必须分别断言。
5. `buildEngineScoreEvents` 的排序：同 onset 时按 `scoreEventId` 字符串排序（确定），不得依赖数组下标。

### 3.5 legacyReference 差分

| 字段 | 真值 | legacyReference | 分类 |
|---|---|---|---|
| occurrences | 4 | 4 | 一致 |
| groups | 2 | 2 | 一致 |
| group[0].pitches | C4,E4,G4 | C4,E4,G4 | 一致 |
| targetOnsetMs | 2400×3, 3000 | 同 | 一致 |
| atoms | 2 | 2 | 一致 |

**额外（与 plan 无关的）实测**：OSMD 侧 `measure:staff:voice:pitch` 把两个 C4 合并为一个桶（见 anchor 报告）——这属于 anchor 层缺陷，**不影响** plan 真值，但会影响高亮正确性。

---

## 4. G3 — 跨小节 tie（2/4 × 2，BPM 120）

### 4.1 输入

```xml
divisions=1; 2/4
m1: C4 h  <tie type="start"/> <tied type="start"/>
m2: C4 h  <tie type="stop"/>  <tied type="stop"/>
```

### 4.2 手工推导

- 两个 notation note：`m1.e1`（tie start）、`m2.e1`（tie stop）。
- 声音语义：**1 次起音，时值 = 2 + 2 = 4 拍**（0 → 4）。
- TieSpan：`eventIds=[m1.e1, m2.e1]`, `startBeat=0`, `endBeat=4`。
- 1 拍 = 500 000 µs；**PlanOffsetUs = 0**，时值 = 2 000 000 µs。
- **CountInUs = 2 000 000** → **TargetOnsetUs = 2 000 000**，`targetDurationUs = 2 000 000`。
- **Tick@960**：`0/3840`。

### 4.3 期望输出

```
counts = {measureCount:2, noteCount:2, restCount:0, tieSpanCount:1}
measures: m1 start 0/1 dur 2/1 ; m2 start 2/1 dur 2/1
tieSpans[0] = { startBeat 0/1, endBeat 4/1, eventIds [m1e1, m2e1] }
plan.occurrences.length = 1
plan.occurrences[0].isTieOnset = true
plan.occurrences[0].durationBeat = 4/1
plan.occurrences[0].measureOrdinal = 1
plan.groups.length = 1
scoreEvents.length = 1 ; targetOnsetMs = 2000 ; targetDurationMs = 2000
atoms.length = 1 ; {startTick:0, durationTicks:3840, bar:1}
```
**ID**
```
fingerprint = 86b9560aac48c47e80934ae5a10763784a40487b663356e85bef16bfabb61c2f
```

### 4.4 必须断言

1. **起音数 = 1**（不是 2）。m2 的音**不生成 occurrence**。
2. 时值 = 4 拍（跨小节合并），**不是** 2 拍。
3. `measureOrdinal` 指向 tie 的**起点**小节。
4. 若把 `<tie>` 误读为两个独立音：`occurrences=2`、`duration=2`、`atoms=2` → 必须由测试抓住。
5. `<tied>`（记谱）与 `<tie>`（声音）分开存储；本 case 两者都存在，不应产生 warning。

### 4.5 legacyReference 差分

| 字段 | 真值 | legacyReference | 分类 |
|---|---|---|---|
| tieSpans | 1 | 1 | 一致 |
| occurrences | 1 | 1 | 一致 |
| durationBeat | 4/1 | 4/1 | 一致 |
| targetOnsetMs | 2000 | 2000 | 一致 |
| atoms | 1（3840 ticks） | 1（3840） | 一致 |

**anchor 侧**：两个 Note 都能识别（`NoteTie.StartNote`），但只有一个声音 occurrence → `scoreEventId → 2 个源 Note` 是**预期的一对多**，契约必须允许（不得要求 1:1）。

---

## 5. G4 — 三连音（4/4 × 1，BPM 60）

### 5.1 输入

```xml
divisions=3            (1 四分音符 = 3 units)
m1: C4(1) D4(1) E4(1) 三连音八分（<time-modification> 3:2）
    G4(3) 四分
    rest(6) 二分
```

### 5.2 手工推导

- `duration/divisions = 1/3` → 每个三连音音 = **1/3 拍**。
- 拍位：C4 `0/1`、D4 `1/3`、E4 `2/3`、G4 `3/3 = 1/1`、rest `2/1`。
- 总内容 = 1/3×3 + 1 + 2 = 4 拍 = 名义小节长度（无 over/underfull 告警）。
- 1 拍 = 1 000 000 µs。
  - `0/1` → 0
  - `1/3` → 333 333.33 → **333 333**
  - `2/3` → 666 666.67 → **666 667**
  - `1/1` → 1 000 000
- **CountInUs = 4 000 000** → **TargetOnsetUs**：`4000000, 4333333, 4666667, 5000000`
- 时值 µs：`333333, 333333, 333333, 1000000`
- **Tick@960**：`0/320, 320/320, 640/320, 960/960`（全部整除 ✅）

### 5.3 期望输出

```
counts = {measureCount:1, noteCount:4, restCount:1}
measures[0].durationBeat = 4/1
events[0].onsetBeat=0/1 dur=1/3 ; events[1]=1/3 dur=1/3 ; events[2]=2/3 dur=1/3
events[0..2].timeModification = {actualNotes:3, normalNotes:2}
events[3].onsetBeat=1/1 dur=1/1
plan.occurrences.length = 4 ; groups=4
scoreEvents.targetOnsetMs = 4000, 4333.333…, 4666.666…, 5000      // 显示值
scoreEvents.targetOnsetUs = 4000000, 4333333, 4666667, 5000000    // 契约真值
scoreEvents.targetDurationUs = 333333, 333333, 333333, 1000000
atoms = [{0,320},{320,320},{640,320},{960,960}]
```
**ID**
```
fingerprint = e084ca4e9e14e7f872b0b259e26c805273280137906a255e332ae53b2ed06ea9
```

### 5.4 必须断言

1. `1/3`、`2/3` **精确**；不得出现 `0.3333333333333333` 参与比较（只允许出现在显示字段）。
2. 三连音之间**没有累积误差**：`(2/3 - 1/3) == 1/3` 精确成立；`3 × 1/3 == 1` 精确成立。
3. tick 转换整除；若把 PPQ 改成 960 以外的值或改用 5 连音，必须走 `tick_grid_rounding` 阻断而不是取整。
4. `type=eighth` + time-modification 的时值由 `<duration>` 决定，**不是**由 `<type>` 重算（否则会得到 1/2 拍）。

### 5.5 legacyReference 差分

| 字段 | 真值 | legacyReference | 分类 |
|---|---|---|---|
| rational onset | 0, 1/3, 2/3, 1 | 同 | 一致 |
| duration | 1/3 | 同 | 一致 |
| targetOnsetUs | 4000000, 4333333, 4666667, 5000000 | `4000.000, 4333.333, 4666.667, 5000.000` ms | 一致（ms 显示四舍五入到 3 位） |
| atoms | 320 ticks | 同 | 一致 |
| **float 泄漏** | 真值不含 float | `beatPosition = 0.3333333333333333` | **serialization-only**：字段是显示/兼容用途，不得作为断言源 |

---

## 6. G5 — 3/4 两小节（BPM 90）

### 6.1 输入

```xml
divisions=1; 3/4
m1: C4 q, D4 q, E4 q
m2: F4 q, G4 q, A4 q
```

### 6.2 手工推导

- 小节长度 = `3 × 4 / 4 = 3` 拍（**不是 4**）。
- m1 start 0，m2 start **3**，总长 6。
- 拍位：0,1,2 | 3,4,5。
- 1 拍 = `60_000_000/90 = 666 666.67 µs`。
- 按 §1.2 的**单次舍入**规则，`TargetOnsetUs = round((4 + beat) × 60 000 000 / 90)`：
  `2 666 667, 3 333 333, 4 000 000, 4 666 667, 5 333 333, 6 000 000`。
- **Tick@960**：`0, 960, 1920, 2880, 3840, 4800`，每音 960。

> **勘误（2026-10-23，R1 收尾）**：本节初版把 `CountInUs = round(4 拍)` 与 `PlanOffsetUs = round(beat)` 分别舍入再相加，得到 `3 333 334` / `5 333 334`，并据此声称与实现存在 1 µs 差异。这违反了 §1.2"只舍入一次"，是文档自身的双重舍入错误。按单次舍入后，手推值与实现完全一致，**不存在 1 µs 差异**；差异分类机制保留（见下），但不应被用来为错误真值开脱。
>
> **裁决（2026-10-25，R2-2 复审）——时值权威 = R2-1 §3.5 冻结协议，§6.2 公式勘误**：
>
> 上一条勘误本身存在残留错误：它把 §6.2 的公式改为 `TargetOnsetUs = round((4 + beat) × 60 000 000 / 90)`——把 count-in 与拍位**合并成精确有理数后舍入总值**。这与本文自身的定义冲突：
> - §1.1 定义 `PlanOffsetUs = round(beat × 60e6/bpm)`、`TargetOnsetUs = CountInUs + PlanOffsetUs`；
> - §1.3 规定 **`CountInUs` 是整数 µs 输入**（产品规则；R2 的接口变更方向相同）。
> 在 90 BPM 下 4 拍不是整数 µs（2 666 666.67），`round((4+beat)×…)` 实际上假设 count-in 是"精确 4 拍"而非冻结的整数 µs 输入，等于把 count-in 的量化偷偷消除。
>
> R2-1 `TS_RUST_PARITY_GATE_V1 §3.5`（四轮复审冻结，RF-01 逐字对齐 `beatToMicroseconds()`）明确规定：**`CountInUs` 是冻结的整数时间起点，唯一的舍入发生在 `PlanOffsetUs` 的 roundHalfUp**。据此裁决：
>
> 1. **时值权威 = 冻结协议**：G5 的 `TargetOnsetUs = 2 666 667 + roundHalfUp(beat × 60e6/90)`，即 `2 666 667, 3 333 334, 4 000 000, 4 666 667, 5 333 334, 6 000 000`；时值仍 `666 667`/音。
> 2. **`g5.expected.json` 已按此修订**（scoreEvents beats 1/4：`3 333 333→3 333 334`、`5 333 333→5 333 334`；derivation 记录修订；全部五个 golden 增加 `countInUs` 字段）。
> 3. **legacyReference 差异显式分类**：旧 dump 在 beats 1/4 与新真值差 −1 µs，按 §7.1 分类为 `time-rounding`（legacy float ms 表示的既有精度），**不是**语义差异，也不再声称"无差异"。
> 4. 裁决依据：§1.1/§1.3 定义文本、R2-1 冻结规范（用户复审 RF-01 通过）、生产 count-in 的整数 µs 输入现实。本修订随 R2-2 复审提交，**最终批准权在复审人**；如否决，整体 revert 此提交并回退 G5-base case。
>
> 修订执行：R2-2 复审修复提交（见 `R2_2_PARITY_HARNESS_IMPLEMENTATION_REPORT.md` §复审修复）。

### 6.3 期望输出

```
measures[0].startBeat = 0/1 ; durationBeat = 3/1
measures[1].startBeat = 3/1 ; durationBeat = 3/1     ← 关键：不是 4/1
plan.rangeStartBeat = 0/1 ; rangeDurationBeat = 6/1
occurrences = 6；groups = 6
atoms: bar=1,beat=1,2,3 ; bar=2,beat=1,2,3
scoreEvents.targetOnsetUs = 2666667, 3333333, 4000000, 4666667, 5333333, 6000000
```
**ID**
```
fingerprint = 7cf95a8868824099d4454136f3d53104c4e714953532fb64da83d74e836c2ec7
```

### 6.4 必须断言

1. `measures[1].startBeat == 3/1`（硬编码 4/4 会给出 4/1）。
2. `atoms` 的 `bar` 从 1 变 2 的边界在**第 4 个音**（F4），不是第 5 个。
3. `atom.beat` 每小节重新从 1 开始。
4. 若实现按"每小节 4 拍"推进，m2 的 F4 会落到 `4/1` → 必须被抓住。

### 6.5 legacyReference 差分

按 §1.2 的单次舍入真值，G5 的六个 onset 与 `legacyReference` **逐项相等**（差 0），没有 1 µs 差异。

| index | 真值 `TargetOnsetUs` | legacyReference（ms→µs） | 差 | 分类 |
|---|---|---|---|---|
| 0 | 2666667 | 2666667 | 0 | exact |
| 1 | 3333333 | 3333333 | 0 | exact |
| 2 | 4000000 | 4000000 | 0 | exact |
| 3 | 4666667 | 4666667 | 0 | exact |
| 4 | 5333333 | 5333333 | 0 | exact |
| 5 | 6000000 | 6000000 | 0 | exact |

**差异分类纪律仍然保留**（`exact` / `time-rounding`（≤1 µs）/ `semantic`），并已由 `golden.fixtures.test.ts` 的单元断言覆盖。任何未来的 1 µs 差异必须被显式分类，但**不得用"分类"掩盖语义差异**，也不得为了制造差异而修改真值。

---

## 7. legacyReference 差分纪律

### 7.1 规则

1. 旧 TS 输出标记为 `legacyReference`，**永不**自动升级为 `expected`。
2. 每个差异必须归类到以下之一：
   - `semantic-defect`（音高/时值/tie/声部/小节/事件数）→ **默认失败**
   - `unsupported-behavior`（repeat/tempo change 等未承诺）
   - `identity-mapping`（occurrence/source ID 不一致）
   - `time-rounding`（≤1 µs 或显示精度）
   - `order-only`（同 onset 的排序差异，且集合相等）
   - `serialization-only`（float 显示字段、`beatPosition`）
3. 音高、rational onset/duration、tie 语义、声部、measure、事件计数的差异**默认为失败**，除非有人工批准的语义修订。
4. 不允许用"总分接近"替代逐字段比较。
5. 修改 golden 必须记录：原因、审核人、日期、schema/time 规则版本。

### 7.2 本次五个 golden 的差分汇总

| case | 差异 | 分类 | 处置 |
|---|---|---|---|
| G1 | 无 | — | — |
| G2 | 无 | — | — |
| G3 | 无 | — | — |
| G4 | `beatPosition` float | serialization-only | 真值用 rational/µs；float 只作显示 |
| G5 | 无（初版误报 2 × 1 µs，见 §6.2 勘误） | — | 真值与实现按单次舍入一致 |

> 注意：**"无差异"只说明旧实现与手推真值在这 5 个极简 case 上一致**，不能推断旧实现在复杂谱面上也正确。G5 初版的 1 µs 差异是文档双重舍入造成的假差异，已撤回；它提醒我们：**真值必须先按规则算清，再与实现比对**，否则会把文档错误当成实现缺陷。

---

## 8. 验收 / 负例 case 清单（独立于五个 golden）

这些不是"第五个 golden"的扩展，而是**各自独立**的 acceptance/negative 测试。每条给出输入、期望、以及"若实现错误会怎样暴露"。

### A1 — rests

- 输入：整小节休止（`<rest measure="yes"/>`）+ 普通休止。
- 期望：`restCount` 正确；休止**不进入** occurrences/scoreEvents/atoms；休止影响小节长度与后续 onset；`ranges` 不因休止而缩短。
- 暴露：若休止被当作音，`atoms.length` 会多 1、`buildSchedule` 会多一个 target。

### A2 — alter / accidental / 调号

- 输入：G8（`<alter>1</alter>`、无 alter、`<accidental>natural</accidental>`）+ `<alter>2</alter>`。
- 期望：
  - 有 `<alter>` → 以 alter 为准（F#4 = 66）；
  - 无 `<alter>` → alter=0（F4 = 65），**与 OSMD 一致**（本次实测）；
  - 双升 → `spelling="F##4"`, midi 67；
  - `alter` 非整数 → `unrepresentable_pitch` + `blocksStrict`。
- 负例：`<step>H</step>` / 缺 octave → `unrepresentable_pitch`。

### A3 — backup / forward

- 输入：`g6_unison_two_staves.musicxml`（staff1 whole + backup 4 + staff2 whole）。
- 期望：两音 onset 都是 `0/1`；`multi_staff` capability；两个 occurrence；1 个 group；1 个 atom（同 tick 合并）。
- 负例：backup 超过小节起点 → `invalid_measure_cursor` + `blocksStrict`，cursor 被钳到 0。
- 负例：backup 之前无 divisions → `missing_divisions`（fatal）。

### A4 — multi voice

- 输入：同小节两个 voice，onset 相同/不同各一。
- 期望：`voiceId` 分别为 "1"/"2"；同 onset 同 staff 不同 voice → **同一个 group**（group 键是 pass+beat），`voiceIds` 排序为 ["1","2"]；不同 onset → 不同 group。
- 暴露：若 group 键包含 voice，会把同时发声拆成两个目标。

### A5 — range / hand filtering

- 输入：G1 的 range = m2..m2；hand = right/left。
- 期望：
  - range：`rangeStartBeat = 4/1`，occurrence 的 `playbackBeat = 0/1`（相对 range 起点）；`rangeDurationBeat = 4/1`。
  - hand：过滤后只保留对应 occurrence；group 若混合两手，只保留选中手，`pitches/occurrenceIds/durationBeat` 同步缩减。
  - **无法确定手别** → `missingEventIds` 非空 → 阻断启动（现状正确）。
- 负例：range 越界（start<1、end<start、end>measureCount）→ `invalid_range`。

### A6 — count-in（产品 3 s 规则）

- 输入：BPM 70（3 s = 3.5 拍）、BPM 120（6 拍）。
- 期望：`CountInUs = 3_000_000` 恒定；`countInBeats` 显示为 3.5 / 6；首音 `TargetOnsetUs = 3_000_000 + PlanOffsetUs(0)`。
- 反向断言：count-in 期间的 note-on **不产生** Extra/scoreEvent（`scoringStartUs` 之前过滤）。
- 暴露：若把 3 s 当整数 4 拍，70 BPM 下首音会晚 428 ms。

### A7 — pause / resume

- 输入：目标 0/1、1/1；在 0.5 拍时暂停 4 s 再恢复。
- 期望：后续目标 `TargetOnsetUs` 增加 4 000 000；演奏事件时间**不平移**（本身已含暂停）；恢复后按同一 PlanOffset 继续；`pauseAdjusted=true`。
- 负例：暂停期间按键 → 必须 `duringPause=true` 且不计分（见 clock 契约 C3；当前 Node 路径未实现）。
- 暴露：若只平移目标不记录区间，"onset 误差"会包含 4 s。

### A8 — 不支持的语义（必须显式失败，不得静默）

| 输入 | 期望 `ImportIssue.code` | `blocksStrict` |
|---|---|---|
| `score-timewise` | `unsupported_score_timewise` | 是（REJECTED） |
| `.mxl` | `unsupported_compressed_musicxml` | 是 |
| 含 `<!ENTITY>` | `xml_external_entity_disabled` | 是 |
| 内部 DTD 子集 | `xml_internal_subset_disabled` | 是 |
| 无 `divisions` 但有 duration | `missing_divisions` | 是 |
| `<chord/>` 无锚 | `invalid_chord_anchor` | 是 |
| 小节内容超长 | `duration_out_of_measure` | 是 |
| repeat / ending | `unsupported_repeat_structure` | 是 |
| D.C./D.S./Coda/Fine | `unsupported_repeat_structure` | 是 |
| rit./accel./rubato 文字 | `unsupported_tempo_curve` | 是 |
| 非 G/F 谱号 | `unsupported_clef` | 是 |
| 非零 transpose | `unsupported_transpose` | 是 |
| grace | `unsupported_grace` | 是 |
| cue | `unsupported_cue` | 是 |
| 微音高 | `unrepresentable_pitch` | 是 |
| orphan tie start/stop | `orphan_tie_start` / `orphan_tie_stop` | 是 |
| 只有 `<tied>` 无 `<tie>` | `tied_notation_without_sound_tie` | 否（warning） |
| 小节不足 | `measure_underfull` | 否（warning） |
| 多 part | `multiple_parts` | 否（info） |

**断言方式**：`importReport.status` + `strictAllowed` + **具体 code**（不是错误文案）。
**当前实现已满足**（28 个测试覆盖大部分）；缺的是：重复 `note@id`、多 part 的手别语义、7 连音的 tick 阻断。

### A9 — 同 onset 不同时值（group 时长）

- 输入：C4 全音符 + 同 onset 的 E4 四分（用 backup 构造）。
- 期望：`group.durationBeat = 最长`（4 拍）；但参考播放的**每个 voice 保留自己的时值**（`ReferencePlaybackVoice.durationMs` 各自计算）。这是 P0 已修复的 bug（第 23 小节"降号听感不对"根因）。
- 暴露：若 group 时长被写回每个 voice，短音会被拉长。

### A10 — range-loop 多次 pass

- 输入：range 1..1，`repeatSelection={kind:'range-loop', count:2}`。
- 期望：`occurrences.length = 2 × 单遍数`；`passIndex` 0/1；第二遍 `playbackBeat` 偏移 `rangeDurationBeat`；`occurrenceId` 不同；`playbackIndex` 从 0 连续。
- 负例：count=0 或 > 32 → `invalid_repeat_count`。
- 注意：这是"练习循环"，**不是**乐谱反复记号；乐谱 repeat 仍被阻断。

### A11 — 重复 / 非法 `note@id`（新增，对应审计 F12）

- 输入：两个 `<note id="n1">`。
- 期望（待实现）：`ImportIssue{code:'duplicate_xml_id', blocksStrict:true}` 或明确的 `xmlIdStatus='REPAIRED'` 策略；**不得**静默让两者都通过。
- 当前：**未实现**，两者都会被记录为 `xmlId="n1"`。

### A12 — tie 两端音高不同

- 输入：`<tie type="start">` 在 C4，`<tie type="stop">` 在 D4。
- 期望：pitchKey 不匹配 → 一个 `orphan_tie_start`（C4）+ 一个 `orphan_tie_stop`（D4），`blocksStrict=true`。
- 暴露：若按顺序配对而不校验音高，会得到错误的 4 拍延音。

---

## 9. 测试实现要求（R2 前落地）

1. **断言源必须是 rational + 整数 µs + 整数 tick**：
   - `expect(doc.parts[0].measures[1].startBeat).toEqual({numerator:3, denominator:1})`
   - `expect(targetOnsetUs).toBe(3333333)`
   - `expect(atom.startTick).toBe(320)`
2. **不得**用 `toBeCloseTo` 断言时间真值（只在显示层允许）。
3. 每个 fixture 同时存：`*.musicxml` + `*.expected.json`（手推真值，含 `derivation` 备注字段）+ `*.legacyReference.json`（TS 输出，带 `generatedBy`/`gitSha`/`date`）。
4. `legacyReference` 文件必须由脚本生成并**只读**；CI 里做 diff 并输出分类报告。
5. 修改 expected 的 PR 必须包含：差异分类、审批记录、时间规则版本。
6. golden 与 negative 分开目录：`fixtures/golden/`（5 个）与 `fixtures/cases/`（A1–A12）。

---

## 10. 明确不属于 golden 的内容

- 对齐/评分（`scorePerformance`）——属于 R5 的 acceptance，不是 plan golden。
- OSMD 渲染/锚点——见 `SCORE_ANCHOR_SPIKE_REPORT.md`，需要独立 contract test。
- repeat/tempo change 展开——未承诺。
- 音频延迟——C2。
- 多 part 手别——语义未定义（P5 前置条件）。

---

## 11. 真值推导的第二独立检查（本次）

为避免"自己推自己验"：
1. 五个 case 的拍位/时值用两种方法分别算出：手算（本文表格）+ 独立小脚本按 `duration/divisions` 约分（`rational()` 实现之外的手算）。
2. µs/tick 由 `round(n×60e6/(bpm·d))` 与 `n×960/d` 手算，未读取实现输出。
3. 只有在真值写定**之后**才去比对 `importer-dump.json`（legacyReference）；比对结果见 §2.5/§3.5/§4.5/§5.5/§6.5。
4. G5 初版声称的 1 µs 差异在 R1 收尾落测试时被发现是**文档双重舍入造成的假差异**（实现按单次舍入，与正确真值一致）。这本身是"先写清规则、再比对实现"的反例，已按 §6.2 勘误修正；测试里保留了差异分类函数，确保未来的真实差异不会被静默放过。

**建议**：正式落地时再请一位人工复核 G2/G3/G5 的表格（或用一个独立的 Python/JS 脚本只做有理数算术，不 import 项目代码）。
