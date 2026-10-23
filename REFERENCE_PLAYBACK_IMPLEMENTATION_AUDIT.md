# Reference Playback v1.0 仓库审计

> 后续状态：2026-10-22 已按本审计实施 P0 核心；本文件保留为实施前基线，当前完成项/未完成项见 `REFERENCE_PLAYBACK_IMPLEMENTATION_REPORT.md`。

- 审计日期：2026-10-22
- 审计对象：`D:\123\rhythm-trainer-frontend`、`D:\123\rhythm-trainer-core-v0.2`
- 依据：`RHYTHM_TRAINER_REFERENCE_PLAYBACK_REQUIREMENTS_v1.0`、`PROMPT_FOR_ZCODE_REFERENCE_PLAYBACK_v1.0`
- 结论：**需要修改，且 P0 当前未达标。** 现有“系统伴弹”是可用的振荡器提示音，但不是需求中的 Reference Playback 模块；它没有播放运行实例、播放时钟、播放快照、采样钢琴、欠载诊断，也没有与评分共享一个显式的 target plan 契约。

本次只做审计，没有修改代码。下面所有结论都以当前代码为准，不以 README/旧文档为完成证明。

---

## 1. 总体判断

仓库基础比“从零实现”好：

- `PlaybackPlan`、`PlaybackOccurrence`、起音分组、tie 展开、A–B pass、`PlaybackPlan.planId` 已存在。
- 严格练习路径已经从同一 `PlaybackPlan` 生成 Rust Core 的 atoms，并把 `playbackPlanId` 传给引擎并持久化。
- 系统伴弹已经用 Web Audio 的绝对时间调度声音，不靠 `requestAnimationFrame` 发声。
- 输入隔离方向正确：参考音由振荡器直接进音频输出，不会进入 `PerformedEvent` / MIDI 输入。
- Node MIDI 时钟映射、Session/Take、Journal、Trace、输入健康已有基础。

但它与本需求之间不是“补几个 UI 开关”的差距：

1. 播放不是独立模块，而是 `App.tsx` 里依赖 React effect、引擎 target 和 `setTimeout` 标记的一段逻辑。
2. 播放声音是三角波振荡器，时长被强制夹在 120–1200 ms；不是钢琴音色，也不遵守目标时值。
3. 没有 `PlaybackSnapshot` / `PlaybackClock` / `playbackRunId`，UI 光标实际由“下一个未判定目标”或用户弹奏进度驱动，不是播放位置。
4. 反复段被导入器明确阻断；UI 从不使用 `range-loop`；左手/右手选择没有进入严格目标计划。
5. 音频启动失败、漏排、时钟退化都不会产生结构化诊断；Node 时钟质量也不参与评分可信度。
6. 跟手模式是独立的客户端 `FollowSession`，不是使用同一 Take 时间基准的引擎会话。

因此建议：**先修现有正确性缺陷，再抽 ReferencePlaybackController；不要直接在 `App.tsx` 上继续堆功能。**

---

## 2. 已存在（可复用）

| 能力 | 代码证据 | 说明 |
|---|---|---|
| 语义 MusicXML 导入 / ScoreDomain | `rhythm-trainer-frontend/src/score-engine/import/musicxml-importer.ts`、`domain/types.ts` | 已有 `ScoreDocument`、`ScoreEvent`、`TieSpan`、`ImportReport`、`strictAllowed`。 |
| PlaybackPlanner | `src/score-engine/playback/playback-planner.ts:89` `buildPlaybackPlan` | 从语义文档生成 occurrence 和 onset group，不重新解析 XML。 |
| 反复/A–B pass 的 occurrence 身份 | `playback-planner.ts:96`、`:145-158` | `passIndex`、`occurrenceId`、`playbackIndex` 已存在，并有 `range-loop` 单测。 |
| 同起音和弦分组 | `playback-planner.ts:170-215` | 按 `passIndex + beat` 分组，`groupId` 稳定。 |
| tie 语义 | `playback-planner.ts:56-77` | tie continuation 不新建起音；onset 使用整条 tie 的时长。 |
| 目标计划 → Rust atoms | `playback-planner.ts:239` `scoreOccurrencesToEngineAtoms` | 960 tick 网格，无法精确表示时阻断 strict。 |
| 引擎 target 时间表 | `rhythm-trainer-core-v0.2/crates/rhythm-core/src/schedule.rs:70` | `buildSchedule` 生成 `at_ms`、`nominal_duration_ms`，同 onset 合并并取最长时长。 |
| 计划 ID / 乐谱指纹传递 | `App.tsx:747`、`:799-801`；`server/engine-server.mjs` 持久化 `playbackPlanId` | 评分记录可追溯 `scoreFingerprint` / `playbackPlanId`。 |
| Web Audio 绝对时间调度 | `src/features/practice/systemDuet.ts:34-57` | `ctx.currentTime + (atPerfMs - performance.now()) / 1000`，不是 rAF 发声。 |
| 同起音和弦同时发声 | `systemDuet.ts:46-57` | 每个音一个 oscillator，共享同一个 `when`。 |
| 重复同音不共享振荡器 | `systemDuet.ts:46-58` | 每个音独立 oscillator；听感上不会互相误关。 |
| 播放/输入隔离 | `App.tsx:473-495` 与 `handleRawPacket`/`ingestPacket` 分离 | 系统音不进入 MIDI 包，不进入用户 `PerformedEvent`。 |
| 暂停/停止清理基础 | `App.tsx:497-502`、`systemDuet.ts:65-70` | 暂停/完成/空闲时 `stopAll()`，停止所有已排程 oscillator。 |
| Node↔浏览器时钟映射 | `server/midi/clock-map.mjs`、`engine-server.mjs:600-606` | 四时间戳、RTT、quality、uncertainty 已有。 |
| Take / Journal / Trace | `server/engine-server.mjs`、`server/journal.mjs`、`server/midi/trace-recorder.mjs` | 已有 Take 生命周期、原始包 Trace、持久化。 |
| OSMD/Bravura 谱面 | `src/components/OsmdScoreView.tsx` | 1610/1610 事件映射、目标高亮、点击详情；但自身 cursor 被禁用。 |

---

## 3. 部分存在

### 3.1 共享目标计划：有链路，但没有显式播放契约

严格练习路径是：

```text
ScoreDocument
  → buildPlaybackPlan (groups)
  → scoreOccurrencesToEngineAtoms (atoms)
  → Rust buildSchedule (targets)
  → App 用 targets + planGroupsRef[target.index] 调度系统伴弹
```

这条链路没有二次解析 XML，方向正确；但：

- 系统伴弹不直接消费 `PlaybackPlan`，而是消费 `session.targets`，再用数组下标 `planGroupsRef.current[target.index]` 反查 pitch 和 scoreEventIds（`App.tsx:485-488`）。
- `PlaybackPlan` 的 `occurrenceIds`、`staffNumbers`、`voiceIds`、`chordGroupId` 没有进入播放器；只按 index 对齐，属于隐式契约。
- `playbackPlanId` 只是传给引擎存档，播放器没有用它校验“我播的确实是这份计划”。
- 无 `engine` 的旧 fixture 会退回 `buildPracticePlan`，把所有目标时长固定为 960 ticks（`src/features/score/practicePlan.ts:35-40`），这是第二套目标时间线。

**判断：部分存在。P0 的“同一个 targetPlanId”目前只是元数据，未形成播放器的输入契约。**

### 3.2 音符起止：有 start/stop，但时值被截断

`systemDuet.ts:45`：

```ts
const duration = Math.max(0.12, Math.min(1.2, durationMs / 1000));
```

- 所有目标音最短 120 ms、最长 1200 ms。
- 二分音符、全音符、跨小节 tie 的实际时长会被截短。
- 不是显式的 `scheduleNoteOn` / `scheduleNoteOff`；没有 voice/occurrence 级 note-off 契约。
- `allNotesOff` 只有 `stopAll()`，没有原因、没有诊断、没有按 runId 过滤。

**判断：P0 的“目标时值”不成立。**

### 3.3 播放控制：是练习会话控制，不是播放器控制

- `usePracticeSession` 控制 `countdown/running/paused/processing/completed`，不是需求中的 `IDLE/PREPARING/COUNT_IN/PLAYING/PAUSED/COMPLETED/STOPPED/DEGRADED/FAILED`。
- 暂停时停掉节拍器和系统音；继续时引擎把剩余 target 整体顺延，React effect 重新按 `session.targets` 排程（`App.tsx:473-495`）。
- 没有播放运行实例，没有 `playbackRunId`；只有一个共享的 `systemPlayerRef` 和一组 `duetTimersRef`。
- 停止/重置会 `stopAll()` + 清 timer，基本能静音，但没有“旧 run 的异步结果不得污染新 run”的显式隔离。

**判断：基本可听，P0 的播放器状态机和 run 隔离没有实现。**

### 3.4 光标：不是播放光标

- OSMD 明确 `disableCursor: true`、`followCursor: false`（`OsmdScoreView.tsx:83-84`）。
- 绿色当前目标来自 `session.nextUnmatchedIndex` 或 `FollowSession` 的当前组，不由播放位置决定（`App.tsx:430-444`）。
- 系统已播放的红色标记由 `setTimeout` 在目标时间到达时添加（`App.tsx:490-492`），不是由 `PlaybackSnapshot.positionBeat` 驱动。
- 绿色光标在固定时间模式下仍可能停在用户没弹的目标上，README 也明确写了这一点。

**判断：有视觉提示，但没有播放快照/播放光标。**

### 3.5 预备拍与节拍器：有声音，配置没有接对

- `launchPractice` 固定传 `countInBeats: 4`（`App.tsx:794`）。
- `buildBeatClicks` 固定按 4 拍强调小节头（`metronome.ts:79`），不读取拍号/强拍。
- `rescheduleMetronome` 用前两个 target 的间隔推四分音符时长（`usePracticeSession.ts:96-100`），不是 `request.bpm`；前两个目标若是二分/附点/休止，节拍器速度会错。
- `metronomeOn` 只存在于设置状态和 localStorage（`App.tsx:105`、`:1231`、`:1447`），**没有传给 `BeginRequest` 或 `usePracticeSession`**；关闭节拍器不会停止排程。这是一个现有缺陷，不只是 P1 缺口。
- 3 秒准备倒计时是 `setTimeout`（`App.tsx:806-832`），4 拍预备拍在引擎 target 时间中；两者没有统一的 `COUNT_IN` 播放状态。

### 3.6 时钟：有映射基础，没有播放时钟

- 浏览器路径把 `clockQuality: 'good'`、`clockUncertaintyMs: 0` 写死（`usePracticeSession.ts:317-323`）。对于同页 `performance.now` 是合理假设，但没有时钟对象、锚点、mappingVersion。
- Node 路径有四时间戳样本和 quality（`engine-server.mjs:724-741`），quality 进入 `captureDiagnostics.node`（`:1232-1241`），但 RUST `trustworthy` 只检查队列溢出、序号缺口、重复/回退、乱序、非法事件（`rhythm-core/src/session.rs:207-212`），**不检查 clockQuality**。
- `scoring_v1.rs:648` 的 `data_degraded` 从未被赋值为 true（`:814` 原样返回），所以“时钟/数据质量导致评分降级”没有真正接通。
- 播放器、节拍器各自创建 AudioContext（`systemDuet.ts:8`、`metronome.ts:13`），没有共享音频时钟和映射快照。

### 3.7 跟弹模式：独立客户端，不是同一 Take 基准

- `FollowSession` 是纯客户端、自定速、用户弹对才前进的模式（`src/score-engine/practice/follow-session.ts`）。
- 报告明确 `strictTiming: false`；不经过 Rust Core，不创建 Take，不使用 Node 时钟映射。
- 系统伴弹默认开启时会强制 `advanceMode = 'timeline'`（`App.tsx:466-471`），所以“跟手 + 系统参考音”实际上会被改成固定时间模式。

**判断：与需求 RP-FR-009 / P1“跟弹复用同一 Take 时间基准”冲突。**

---

## 4. 缺失（相对 v1.0）

### P0

- `ReferencePlaybackController` 及状态机；`IDLE/PREPARING/COUNT_IN/PLAYING/PAUSED/COMPLETED/STOPPED/DEGRADED/FAILED`。
- `playbackRunId` 与运行实例隔离；旧 run 的 Promise、timer、audio 回调不能影响新 run。
- `AudioEngineAdapter`：`loadInstrument`、`scheduleNoteOn(pitch, velocity, audioTime, voice/channel)`、`scheduleNoteOff`、`allNotesOff(reason)`、`setGain`、`dispose`。
- 本地可用的钢琴音色与许可证说明；当前 `package.json` 没有任何钢琴采样/SoundFont 依赖，也没有资源文件。
- `PlaybackClock`：AudioContext 时间 → session/Take 相对时间的锚点、clockId、mappingVersion、mappingQuality。
- `PlaybackSnapshot`：`playbackRunId`、状态、beat/tick、小节、occurrence、健康、映射质量、错误码。
- 前瞻窗口（look-ahead）调度器与 underrun 检测。当前是在启动时把整段 target 一次性排入 Web Audio，并在 UI 用 timer 标红；没有“下一批事件是否已超过音频时间”的判断。
- 播放事件诊断：`reference_playback.prepare_started/prepare_completed/started/paused/resumed/stopped/completed/instrument_load_failed/scheduler_underrun/clock_mapping_degraded/all_notes_off`。
- 资源/启动失败可见：`SystemDuetPlayer.ensure()` 失败返回 `null`（`systemDuet.ts:12-24`），`schedule()` 静默返回；`Metronome.ensure()` 抛错发生在 `begin` 的 try 之外（`usePracticeSession.ts:200-206`），调用方 `void session.begin(...)` 也没有处理 rejection。
- 反复段实际播放：导入器检出 repeat/ending 后直接 `blocksStrict: true`（`musicxml-importer.ts:536-543`）；`buildPlaybackPlan` 的 `range-loop` 在 App 中从未启用（`App.tsx:696`、`:738` 都是 `{ kind: 'none' }`）。
- 暂停/继续的播放位置快照；当前只依赖引擎 target 顺延和重新排程。
- 参考播放与评分共用的、可验证的 `targetPlanId` 契约；当前只有元数据透传。
- 播放层测试：和弦、重复音、tie、occurrence、暂停恢复、停止无残音、UI 降帧、资源错误、underrun、时钟降级。现有 121 个 vitest 中没有系统伴弹/音频调度测试。

### P1

- 单手套音（只影响音频，不改 target plan）。
- 左右手独立音量、钢琴/节拍器独立音量。
- 速度预设（50%/70%/100%）与运行中变速边界。
- 小节循环在 UI 中实际使用 `range-loop`，并在每次进入时生成新 occurrence。
- 试听示范（不创建 Take、不需要 MIDI、可独立播放一段乐谱）。
- 播放中定位到小节/拍并开始。
- 诊断包关联 `playbackRunId` / `targetPlanId` / clock mapping。

---

## 5. 与设计冲突

1. **手别语义冲突（最需要先决定）**
   - 需求 RP-FR-013：左右手静音“只改变音频输出，不修改目标计划或评分真值”。
   - 当前产品 `hands` 模式的 `hand` 是练习范围：`visibleTargetNotes` 按手过滤（`App.tsx:418-423`），legacy `buildPracticePlan` 也按手过滤（`:770`）。
   - 但严格目标路径 `buildPlaybackPlan` 没有 hand 参数，生成的是双手 groups（`App.tsx:733-763`），所以：
     - UI 显示单手目标；
     - 引擎/系统伴弹仍要求双手；
     - `scopedTargetCount` 与真实 target 数量可能不一致；
     - “右手练习”实际上会被左手目标判 Miss。
   - 这不是简单的 P1：需要区分 `targetScope.hand`（改变目标）与 `mutePart`（只改变音频），并先把当前 hand bug 修掉。

2. **反复段范围冲突**
   - 需求把 RP-FR-007 放在 P0；
   - 导入器明确拒绝 repeat/ending 并阻断 strict；
   - 若 P0 必须包含反复，工作范围会扩展到 importer + repeat/ending 展开 + occurrence 测试，而不是播放器单模块。

3. **跟手模式冲突**
   - 需求要求跟弹使用同一 Take 时间基准；
   - 当前 `FollowSession` 故意是自定速、非 strict、客户端独立评分；
   - 系统伴弹开启时还会强制固定时间，跟手模式不可用。
   - 需要明确：v1.0 是否把“跟手”重新定义为与参考播放同步的 scored 模式，还是保留当前自定速模式并把它排除在 Reference Playback v1.0 之外。

4. **音色验收冲突**
   - 需求默认钢琴音色；
   - 当前是 `oscillator.type = 'triangle'`（`systemDuet.ts:50`），不是钢琴；
   - 没有资源、没有许可证、没有包体积预算。
   - 需要定义“钢琴音色”的最低验收：采样钢琴、合成钢琴、还是允许提示音作为 v1.0 临时方案。

5. **TempoMap 冲突**
   - 需求要求 TempoMap 处理速度变化；
   - 当前 `buildTempoMap` 只有单一 BPM（`tempo-map.ts:14-32`），且生产路径没有使用它；
   - 导入器保留 `tempoMarks`，但播放/评分都忽略；带中途 tempo 的谱面仍可能被当作单一 BPM 严格评分。
   - 若 v1.0 采用“用户选定 BPM 覆盖谱面速度”，需要在文档里写清，并对含 tempo 变化的谱面给出提示或阻断。

6. **独立试听 vs 练习会话**
   - 需求有“先听示范”流程，可以不评分；
   - 当前系统伴弹必须在练习会话中、必须有引擎 target、默认还被强制固定时间；
   - 没有一个独立的“只播放、不建 Take”的入口。

---

## 6. P0 验收对照

| # | 验收项 | 当前结果 | 证据/原因 |
|---|---|---|---|
| 1 | 共享 targetPlan / fingerprint / tempoMapVersion | **部分** | atoms 和 guide 来自同一 plan，但播放器按 index 反查；没有 targetPlanId 播放契约；hand 不一致；legacy fallback 另有一套。 |
| 2 | 单音起音 + 目标时值传给音频引擎 | **不通过** | `systemDuet.ts:45` 把时长夹到 0.12–1.2s；不是钢琴音色。 |
| 3 | 和弦同刻调度 | **通过** | 同 group 的每个音使用同一 `when`；Rust 也按同 tick 合并 target。 |
| 4 | 暂停清理 + 恢复不把暂停时长算入 | **部分** | 暂停 `stopAll`，引擎顺延 remaining targets；但没有播放位置快照/播放器状态机。 |
| 5 | 立即停止、无残音、旧回调不发声 | **部分** | `stopAll` + 清 timer 基本有效；没有 allNotesOff(reason)、runId 隔离和诊断。 |
| 6 | 仅计划正常结束时 COMPLETED | **不通过** | 完成状态来自引擎 report，不是播放计划结束；音频结束/提前结束没有独立状态。 |
| 7 | 重复同音 occurrence 不互相误关 | **部分/可听层面通过** | 每音独立 oscillator；但没有 occurrence/voice 级 note-off 契约，暂停/停止是全局清理。 |
| 8 | 反复段 occurrence | **不通过** | 导入器阻断 repeat；App 始终 `repeatSelection: none`。 |
| 9 | UI 降帧不改变声音调度 | **部分/未验证** | 声音用 Web Audio 绝对时间，不依赖 rAF；但一次性排程且晚到会静默跳过，没有 underrun 检测。 |
| 10 | 参考音不进入用户输入 | **通过** | 系统音只进音频输出；用户输入只走 raw MIDI 包/`PerformedEvent`。 |
| 11 | 资源错误、scheduler underrun 可见 | **不通过** | `ensure()` 失败返回 null；`schedule()` 静默丢弃；没有 underrun 诊断。 |
| 12 | 跟弹映射到同一 Take 时间基准，质量差可降级 | **不通过** | `FollowSession` 是独立客户端、非 strict；Node clockQuality 不参与 `trustworthy`。 |

**P0 结论：2 项通过、5 项部分、5 项不通过。**

---

## 7. 建议的修改顺序

### Step 0：先修现有正确性缺陷（在抽模块之前）

1. **手别进入目标计划**
   - 给 `PlaybackPlanRequest` 增加显式 target scope（或增加 `filterPlaybackPlanByHand`），同时过滤 groups、pitches、atoms、expectedNotes、`visibleTargetNotes`、unsupported 检查。
   - 对跨谱表和弦明确规则：只手选择时，是否保留整组还是只保留该手音高；不能只删 group。
   - 增加测试：右手计划不含左手 pitch；target 数与 UI 一致。
2. **修复节拍器**
   - `BeginRequest` 增加 `metronomeEnabled`、`beatsPerBar`、`countInBeats`。
   - `rescheduleMetronome` 用 `request.bpm` 计算 quarterMs，不用前两个 target 间距。
   - `buildBeatClicks` 接收拍号，强调每小节第一拍。
   - 把 `metronomeOn` 真正接入；关闭时不排程。
   - 在用户手势内创建/恢复 AudioContext，`resume()` rejection 要可见。
3. **系统伴弹先变成“正确的临时参考音”**
   - 去掉 1.2s 时长上限；按 `nominalDurationMs` 排程，并给每个 note 独立 stop。
   - 记录 `playbackRunId`，每次 start/stop 使旧 run 失效。
   - `schedule()` 遇到 `when < currentTime` 时记录“漏排/underrun”而不是静默 return。
   - `ensure()` 失败返回结构化错误，UI 显示可恢复动作。
4. **统一音频上下文**
   - 至少让节拍器和参考音共享同一个 `AudioContext`；更彻底的做法是建立 `AudioEngineAdapter` 后由它统一持有。

### Step 1：P0 播放器闭环

- 新增 `ReferencePlaybackController`：状态机、runId、命令、快照订阅。
- 新增 `AudioEngineAdapter`：本地钢琴音色、Note On/Off、allNotesOff(reason)、gain、dispose。
- 新增 `PlaybackClock`：AudioContext 锚点、session 相对时间、clockId/mappingVersion/quality。
- 新增 look-ahead 调度器：只排即将到来的窗口；检测 underrun；暂停/停止取消未来事件。
- 播放器直接消费 `PlaybackPlan`，不再用 `planGroupsRef[index]` 反查 pitch。
- 保留 Rust Core 的评分权威；播放器只发声音、进度和健康状态。

### Step 2：光标与跟弹

- OSMD 当前 occurrence 高亮改为消费 `PlaybackSnapshot`，不再用 `nextUnmatchedIndex` 当播放位置。
- 用户判定/系统播放/绿色目标三种颜色保持分离。
- 跟弹模式若要进入 v1.0，接入同一 Take / 同一时钟；否则在文档中明确排除。

### Step 3：P1

- 单手套音、独立音量、速度预设、A–B 循环、预备拍、诊断包关联。
- 反复段是否进入 v1.0 需先做范围决定；不要在不展开 repeat 的情况下声称 RP-FR-007 完成。

---

## 8. 需求文档本身建议修订的点

如果这份文档要作为 v1.0 实施基线，建议先改以下 6 处，否则实现和验收会有歧义：

1. **P0 范围**：反复段（RP-FR-007）与当前导入器的 `DISPLAY_ONLY` 策略冲突。要么把 repeat 展开列为独立的前置工作，要么把它移到 P1/已知限制。
2. **手别语义**：明确区分“练习手别（改变 target）”与“参考播放静音（只改变音频）”。当前产品把两者都叫 hand，直接按 RP-FR-013 实现会与现有分手练习语义冲突。
3. **跟手模式**：明确 v1.0 是否要求跟手与参考播放同步；当前 `FollowSession` 是自定速、非 strict 的独立模式。
4. **钢琴音色验收**：定义最低标准（采样/合成）、资源大小、许可证与离线要求；当前没有音色资源。
5. **TempoMap 边界**：明确“用户选定 BPM 覆盖谱面 tempo”还是“按谱面 tempo map 播放”；若选前者，含中途 tempo 变化的谱面应提示或阻断严格评分。
6. **独立试听**：明确“先听示范”是否必须不创建 Take；当前系统伴弹必须依附练习会话和引擎 target。

---

## 9. 实际测试与未运行项

### 已运行

```text
cd D:\123\rhythm-trainer-frontend
npx vitest run
# 19 test files, 121 tests passed

npm run build
# tsc -b && vite build 通过
# 警告：opensheetmusicdisplay chunk 1,436.11 kB (gzip 382.93 kB)
```

```text
cd D:\123\rhythm-trainer-core-v0.2
PATH="/c/Users/10178/dev-tools/w64devkit/bin:$PATH" \
  cargo test -p rhythm-core --target x86_64-pc-windows-gnu
# 82 + 1 + 1 + 5 + 15 = 104 tests passed, 0 failed
```

说明：第一次直接运行 cargo test 时，`x86_64-w64-mingw32-gcc` 不在 PATH，链接失败；把 w64devkit 的 `bin` 加入 PATH 后通过。这个环境前提应写入构建说明。

### 未运行 / 未验证

- 没有运行真实浏览器音频手工测试（暂停残音、后台标签页、设备切换、自动播放策略）。
- 没有在 Windows 上听测钢琴音色/音量/延迟（当前也没有钢琴采样资源）。
- 没有系统伴弹或 Reference Playback 的自动化测试；现有 121 个测试不覆盖 `SystemDuetPlayer` / `Metronome`。
- 没有验证 1610 音符长谱一次性排程的实际音频负载、内存和标签页节流行为。
- 没有验证 Node clockQuality 为 `estimated` / `unstable` 时的评分行为（当前代码不会因此降级）。

---

## 10. 最小可交付建议

如果目标是尽快得到“可验收的 P0”，建议按以下边界做，而不是一次性实现整份文档：

1. 先做 Step 0 的手别、节拍器、时值、runId、错误可见五项；这些是现有功能的正确性问题。
2. 只做“练习内的参考播放”作为 P0 第一版，不先做独立试听入口；但播放器 API 必须与 Take 解耦。
3. 钢琴音色先选一个**本地、许可证明确、体积可控**的方案；如果只能先用合成音，必须在报告里明确它不是采样钢琴。
4. 反复段和跟手同步不要混入第一版 P0，除非先修改需求范围；这两项会显著扩大导入器、计划器和 Take 契约的工作量。
5. 每个 P0 验收项都要有可执行测试（建议用可注入的 fake AudioClock，而不是依赖真实音频设备）。
