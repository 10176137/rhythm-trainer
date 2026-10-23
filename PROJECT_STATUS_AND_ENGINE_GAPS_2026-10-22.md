# 项目现状、伴弹差距与引擎核心缺口

- 日期：2026-10-22
- 对象：`D:\123\rhythm-trainer-core-v0.2`、`D:\123\rhythm-trainer-frontend`
- 目的：给下一步开发排期，并明确指出“看起来已完成、实际未接通”的引擎核心部分。
- 说明：本文件是现状评估，不是“全部完成”的证明。代码路径和符号名以当前仓库为准。
- **B1 更新（同日）**：下文“最终评分链”缺口已在 B1 接通——NAPI `scorePerformance`、per-note score events、Take 完成后 `scoring_v1`、数据质量状态、P08 报告与历史均已实现。现状与边界以 `B1_SCORING_AUDIT.md` / `B1_IMPLEMENTATION_REPORT.md` 为准；本文件保留为 B1 前的缺口分析。

---

## 1. 一句话结论

旧“系统伴弹”是一个 **65 行的 UI 内振荡器提示音播放器**；新实现是 **控制器 + 播放时钟 + 前瞻调度器 + 音频适配器 + 共享目标计划** 的参考播放 P0 核心，架构层级已经不同。按 Reference Playback 的 P0 验收，旧实现大约满足 3/12，新实现约 10/12；剩下的硬缺口是**反复段**和**跟手模式统一 Take 时钟**，P1 功能大多还没做。

但项目最大的引擎缺口不在播放器，而在**最终评分链**：

> `crates/rhythm-core/src/scoring_v1.rs` 已经实现了 pitch/onset/rhythm/duration/continuity/overall/confidence 的完整评分库，**却没有 NAPI 导出，也没有接进 Node 服务、Take 报告和前端报告**。当前用户看到的最终报告是 `NativeSession` 的 onset-only 统计（Perfect/Good/Miss/Extra + 时间偏差），加上一份独立的按键时长报告；没有音高准确率、没有 overall、没有逐音时值、没有把 `scoring_v1` 的诊断接进产品。

这是下一步最值得优先补的核心，而不是继续加播放 UI。

---

## 2. 旧伴弹 vs 新参考播放

### 2.1 详细对照

| 维度 | 旧系统伴弹（`src/features/practice/systemDuet.ts`，约 65 行） | 新参考播放（`src/features/playback/*` + `reference-playback-plan.ts`） |
|---|---|---|
| 架构 | App 的 React effect + 一个播放器类 | `ReferencePlaybackController` + `PlaybackClock` + `ReferencePlaybackScheduler` + `WebAudioEngineAdapter` |
| 目标来源 | 引擎 targets + `planGroupsRef[target.index]` 反查音高 | 手别过滤后的 `ReferencePlaybackPlan`，同一份 groups 生成 atoms、音频和 expected notes |
| 计划校验 | 无 | 启动时校验 target 数量、`atMs`、小节；不一致进入 `FAILED` |
| 时间轴 | 启动时按 `performance.now` 换算一次，整段一次性排入 Web Audio | 音频前瞻窗口（150ms）+ 25ms tick；控制器维护播放位置 |
| 目标时值 | 同 onset 全部音使用组最长时值，且被夹到 0.12–1.2s | 每个 occurrence/voice 使用自己的时值和 Note Off |
| 和弦 | 同 `when` 起音，但同组共用同一时值 | 同 onset 起音；每个 voice 独立时长/voiceId |
| 重复同音 | 每个音独立 oscillator，可听层面不误关 | 每个 occurrence 独立 voiceId，可独立 note-off；有测试覆盖 |
| 反复段 | 不支持 | 规划器有 range-loop occurrence；App 仍未启用；repeat/ending 仍阻断 |
| 暂停/继续 | `stopAll`，依赖 React effect 重新排程 | 暂停冻结位置 + all-notes-off；继续重新锚定 AudioContext 和 scheduler |
| 停止 | `stopAll` | `stop` 状态 + hard-stop + runId 失效；未来已排程音符不会发声 |
| 完成 | 依赖引擎 report / UI effect | 计划范围结束 + scheduler 全部调度；会话结束时控制器停止 |
| 快照 | 无 | `PlaybackSnapshot`：runId、状态、健康、位置、小节、occurrence、时钟质量、调度进度 |
| 诊断 | 基本静默：ensure 失败返回 null、晚到音符直接跳过 | `reference_playback.*` 结构化诊断；欠载、时钟挂起、音色失败、all-notes-off |
| 时钟 | 自己的 AudioContext；用 `performance.now` 现算 | 共享 AudioContext；start 时对齐引擎 origin；clockId/mappingVersion/quality |
| 音色 | 三角波 oscillator | 本地 4 分音加法合成钢琴；无采样、无远程依赖 |
| 红标 | `setTimeout` 按 target 时间标记 | 快照位置驱动，UI 帧只读 |
| 输入隔离 | 音频不进 MIDI/评分 | 保持；系统音不进入 `PerformedEvent` |
| 手别 | 全部手 | 目标 scope 按手过滤（右手练习 856 targets 实测）；音频只手静音未做 |
| 测试 | 无系统伴弹自动化测试 | 15 项新增：计划/手别/和弦/tie/控制器/欠载/挂起/合成器/节拍器 |

### 2.2 P0 覆盖度

| P0 验收 | 旧伴弹 | 新参考播放 |
|---|---|---|
| 共享 target plan | 部分（按下标反查） | 通过（显式校验） |
| 音符起音 + 目标时值 | 不通过（组最长 + 1.2s 夹断） | 通过（逐 voice） |
| 和弦同刻 | 通过 | 通过 |
| 暂停清理/恢复 | 部分 | 通过 |
| 立即停止/无残音 | 部分 | 通过（含未来 note hard-stop 测试） |
| 正常完成 | 不通过（依赖引擎 report） | 通过（计划范围 + 会话结束停止） |
| 重复同音不误关 | 可听层面通过 | 通过（occurrence voiceId） |
| 反复段 | 不通过 | **仍未完成** |
| UI 降帧不改变音频 | 部分 | 通过（音频时钟 + 前瞻） |
| 参考音不进入用户输入 | 通过 | 通过 |
| 异常可见 | 不通过 | 通过（诊断/FAILED/降级） |
| 跟弹同一 Take 时钟 | 不通过 | **仍未完成**（FollowSession 仍是独立客户端） |

结论：**旧实现约 3/12，新实现约 10/12。** 新实现已经不是“补丁”，但距离完整 v1.0 仍有反复段、跟手统一时钟、P1 体验和采样音色。

---

## 3. 项目已完成内容（按层）

### 3.1 Rust Core（约 5,700 行）

| 能力 | 代码证据 | 状态 |
|---|---|---|
| 节奏目标 schedule / profile / 相邻窗口收缩 | `schedule.rs` | 已实现并接线 |
| 确定性 Perfect/Good/Miss/Extra matcher | `matcher.rs` | 已实现并接线；**onset-only，忽略 `StrikeEvent.notes`** |
| Session 状态机、暂停平移、确定性 replay、诊断 | `session.rs`、`replay.rs`、`ring_buffer.rs` | 已实现并接线 |
| Take / capture epoch / quarantine / finalization | `take.rs`、Node `NativeTakeCoordinator` | 已实现并接线 |
| Note On/Off 配对、按键时长评估 | `duration.rs`、`midi.rs` | 已实现并接线；**按 onset target 映射，和弦内不同时值无法区分** |
| 教学诊断 / 练习建议 / 学生模型 | `teaching.rs` | 已实现并接线 |
| 完整评分 v1（pitch/onset/rhythm/duration/continuity/overall/confidence） | `scoring_v1.rs` | **库已实现、15 项测试通过，但没有 NAPI 导出、没有进最终报告** |
| 基准/性质测试 | `tests/benchmark.rs`、`property_tests.rs`、`scoring_v1_acceptance.rs` | 104 项测试通过 |

### 3.2 Node 引擎服务

| 能力 | 代码证据 | 状态 |
|---|---|---|
| WebSocket 协议、start/pause/resume/finish/tick、错误 | `server/engine-server.mjs` | 已实现 |
| Session 持久化、JSON 原子写 | `server/engine-server.mjs` | 已实现 |
| Journal / Trace / replay API | `journal.mjs`、`trace-recorder.mjs`、`trace-replay.mjs` | 已实现 |
| 乐谱库 CRUD | `score-library.mjs` | 已实现 |
| MIDI 适配器、连接代次、队列、热插拔、输入健康 | `server/midi/*` | 已实现，实机 Note On/Off 已验证 |
| Node↔浏览器四时间戳时钟映射 | `clock-map.mjs` | 已实现；quality 进入诊断，finish 时做信任门禁 |
| 模式→ScoringConfig | `mode-config.mjs` | 已实现 |
| 自测 | `selftest.mjs` | 通过 |

### 3.3 前端 / Score Engine

| 能力 | 代码证据 | 状态 |
|---|---|---|
| React 工作台、设置草稿保存、历史/画像、乐谱库 | `App.tsx`、`HistoryView`、`ProfileView`、`practiceSettings`、`scoreLibrary` | 已实现 |
| MusicXML 语义导入、RationalBeat、fingerprint、ImportReport | `score-engine/import`、`domain` | 已实现；有限 MusicXML 子集 |
| PlaybackPlan / occurrence / onset group / tie / range-loop | `playback-planner.ts` | 已实现；App 未启用 range-loop |
| 手别过滤 + 参考播放计划 | `reference-playback-plan.ts` | 已实现 |
| OSMD 2.2.1/Bravura 谱面、事件映射 | `OsmdScoreView`、`score-view-adapter` | 已实现 |
| 固定时间 strict / 跟手等待 | `usePracticeSession`、`FollowSession` | 已实现；跟手独立客户端、非 strict |
| 参考播放 P0 核心 | `features/playback/*` | 已实现（见第 2 节） |
| 节拍器 origin/BPM/拍号/开关 | `metronome.ts` | 已修复并测试 |
| 测试 | vitest | 22 文件、136 项通过 |

---

## 4. 引擎核心缺口（按优先级）

### P0：评分核心没有真正接通

#### 4.1 `scoring_v1` 未导出、未接线（最高优先级）

- `scoring_v1.rs` 已实现 `SessionScoreReport`：pitch accuracy、onset、rhythm、duration、continuity、overall、confidence、measures、practice ranges、diagnostics。
- `bindings/node/src/lib.rs` 没有 `scorePerformance` 的 `#[napi(js_name = ...)]` 导出；`server/engine-server.mjs` 最终只调用 `NativeSession.finish()`（onset matcher）。
- `EngineReport` / `ReportPanel` 只有目标数、Perfect/Good/Miss/Extra、命中率、平均偏差、标准差，外加一份独立 duration 报告；没有 pitch、overall、每小节综合分、confidence。
- 影响：产品对外展示的“最终成绩”不是完整评分；`scoring_v1` 的 15 项测试只证明库本身，不证明产品链路。

**下一步**：新增 `scorePerformance` NAPI；把 ScorePlan 转成 `ScoreEvent[]`（pitch、onset、duration、part/voice、occurrence），把 key lifecycle 转成 `PerformedNoteV1[]`；在 finish 时调用；把 `SessionScoreReport` 写入 Take report/前端报告；保留 raw 诊断。

#### 4.2 Target 契约缺少 pitch/voice/逐音时值

- `RhythmAtom` / `TargetHit` 只有 `start_tick`、`duration_ticks`、`bar`、`beat`；没有 pitch、voice、staff、occurrence、chord group。
- `buildSchedule` 把同 tick 的 atoms 合并成一个 rhythm target；`TargetHit.nominal_duration_ms` 取最长时值。
- `HitMatcher.ingest` 完全不看 `StrikeEvent.notes`；任何一次起音都能命中下一个 target。
- 结果：一个三音和弦只算一个 target；只弹其中一个音也可以 Perfect；错音在正确时间不会影响实时判定。
- 前端 README 也明确写了：错音在正确时间仍会命中节奏 target，音高只是 UI 提示（`README.md:174`）。

**下一步**：定义“评分 target”是 onset group 还是 per-note。建议增加 target payload：`pitches[]`、`chord_group_id`、`part/voice/staff`、per-note duration；实时 matcher 至少要校验 chord pitch set，最终评分用 per-note alignment。否则 `scoring_v1` 无法正确工作。

#### 4.3 和弦内逐音时值评分仍然错误

- `duration.rs` 通过 onset 判定把 Note On 映射到 target；`nominal_duration_ms` 是 onset group 的最长时值。
- 第 23 小节类型：G/B♭/G 长和弦 + E♭3 短低音会共享 2 拍目标时值；参考音频已改为逐 voice，但按键时长评分仍会把正确的 0.5 拍低音判成“偏短”。
- 影响：听感问题已修，**成绩/时值诊断仍可能错**。

**下一步**：把每个 ScoreEvent 的逐音 duration 传入 `scoring_v1`；实时 duration 评估需要 occurrence/voice 级映射，不能只靠 onset target。

#### 4.4 实时与最终评分是两套语义

- 实时：`NativeSession`/`HitMatcher` 只看 onset，pitch 仅前端 hint。
- 最终：`scoring_v1` 有 pitch/duration/overall，但没有接线。
- 结果：实时说“命中”，最终可能说“错音”；两者没有统一 contract。

**下一步**：决定产品语义：
- 方案 A（较稳）：实时只做 onset 节奏反馈；最终报告做 pitch/duration/overall。UI 明确区分“节奏命中”和“音高/综合成绩”。
- 方案 B（更大）：实时 matcher 也做 pitch/chord，实时和最终共用同一 target contract。
不要继续让两个语义各自演化。

### P0/P1：时间与同步

#### 4.5 输出延迟校准缺失

Core README 明确列出 `Audio output-latency calibration` 未实现。参考播放现在按 AudioContext 调度，但用户听到声音有设备/蓝牙/系统缓冲延迟；输入时间与参考音频的物理对齐没有校准。同步跟弹时会出现系统性偏差。

**下一步**：加入可配置输出延迟/用户校准；记录调度时间与实际输出时间；在评分报告中区分“输入偏差”和“输出延迟”。

#### 4.6 音频时钟与输入时钟还没有统一对象

- 参考播放用 AudioContext → session 时间；Node MIDI 用四时间戳映射 → session 时间。
- 两者都对齐到 engine origin，但没有共享 `ClockMapping` 对象；播放时钟质量/输入时钟质量分开报告。
- 时钟质量门禁目前只在 finish 时做；播放中没有实时提示。

**下一步**：建立 Take 级 `ClockMappingSnapshot`（audio/input/origin/quality/uncertainty），播放快照和输入诊断引用同一 mapping id；质量差时实时降级 UI。

#### 4.7 反复段/速度语义

- 导入器对 repeat/ending、D.C./D.S./Coda/Fine 直接 `blocksStrict`；App 始终 `repeatSelection: none`。
- `tempoMarks` 保留但播放/评分不用；TempoMap 仍是单 BPM。
- 这是产品范围问题：要么实现，要么明确标为不支持。Reference Playback P0 的 RP-FR-007 目前未完成。

### P1：评分/乐谱深度

#### 4.8 对齐算法是贪心 + 4 音 lookahead

`align_performances` 是单调贪心；复杂重复音、装饰音、跨手交错、长和弦可能选错配对。代码注释也写了 full DP 是 future upgrade。

**下一步**：对高价值场景引入 DP/匈牙利/带 voice 约束的对齐；保留当前算法作为快速路径，并用 trace 回归验证。

#### 4.9 声部/手别/踏板/力度没有进入评分

- `ScoreEvent` 有 `part_id`，但没有 staff/voice/hand；alignment 不用 part。
- `TargetHit` 没有 voice；实时/最终都无法判断左手/右手或声部交叉。
- 踏板 CC64 只有“不延长 held duration”的测试，没有踏板语义。
- velocity 被采集到 `PerformedNote`，但没有力度/动态评分。
- `DurationEvaluationPolicy` 只有 `strict-keydown` / `disabled`；需求文档中的 `articulation-aware` 未实现。

**下一步**：先补 staff/voice/hand + chord group；再决定 pedal/dynamics 是否进入 v1.1。

#### 4.10 乐谱语义仍有限

- 不支持完整 repeat/ending、D.C./Coda、复杂 tuplets、移调乐器、微分音、`.mxl`、歌词/力度。
- grace/cue 被排除 strict；没有装饰音评分。
- OSMD 渲染与领域音高已对齐，但谱面/播放/评分还没有统一的 articulation 语义。

### P1：播放与可观测性

#### 4.11 Reference Playback 剩余项

- 反复段、运行中变速、独立试听、音频只手静音、采样钢琴、播放光标、跟手统一 Take 时钟。
- 红标仍按计划位置推进；underrun 跳音时红标可能仍前进。
- 主音量/钢琴与节拍器独立音量未做。

#### 4.12 Take/诊断持久化

- `playbackRunId` 未写入会话记录；`reference_playback.*` 诊断只在内存/反馈，不进入 Journal/Trace。
- DiagnosticBundle、日志轮转、崩溃恢复扫描仍未实现（旧审计已有记录）。
- 这会影响后续定位“为什么某次播放/评分异常”。

### P2：测试与验证

- `scoring_v1` 的 15 项测试是库测试，不是产品链路测试；需要 NAPI → server → report → UI 的端到端测试。
- 没有真实音频听测；没有输出延迟/设备切换/后台标签页自动化。
- 没有 repeat/tempo 谱面回归；没有和弦逐音时值评分回归。
- 真实硬件只验证过 Note On/Off、力度、重复音、最小 Take；显式三音和弦、热插拔、macOS 仍 NOT RUN。

---

## 5. 建议的下一步开发顺序

### 阶段 1：把“最终成绩”做成真的（最高价值）

1. 新增 `scorePerformance` NAPI，导出 `SessionScoreReport` 的 TS 类型。
2. 定义并传递 `ScoreEvent[]`：
   - `scoreEventId`、`occurrenceId`、pitch、onsetMs、durationMs、part/staff/voice、chordGroupId。
3. 把 `trackKeyLifecycles` 的 observations 转成 `PerformedNoteV1[]`。
4. finish 时调用 `scorePerformance`，把结果写入：
   - Take report（新增 `scoreV1` 字段）；
   - 前端 ReportPanel（pitch/overall/duration/confidence/measures）；
   - 会话 JSON；
   - `analysis`/mastery 的输入。
5. 增加端到端测试：正确音/错音/和弦/漏音/多音/不同时值和弦/时钟降级。

### 阶段 2：修 target 语义

6. 给 target 增加 pitch set / voice / chord group / per-note duration。
7. 决定实时 matcher 是否 pitch-aware：
   - 若短期不做，明确 UI 区分“节奏命中”和“最终音高成绩”；
   - 若做，扩展 `HitMatcher` 接受 chord pitch set，并处理部分和弦/错音。
8. 修 `duration.rs` 的 onset-group 映射，改成 occurrence/voice 级。

### 阶段 3：同步与延迟

9. 输出延迟校准（设备/蓝牙/系统缓冲）。
10. Take 级统一 ClockMapping；播放/输入引用同一 mapping；实时显示 quality。

### 阶段 4：乐谱/播放范围

11. repeat/ending 展开或明确移出 P0；tempo map；独立试听。
12. 采样钢琴、音频只手静音、播放光标、跟手统一时钟。

### 阶段 5：可观测性与硬件

13. playbackRunId / playback diagnostics 持久化；DiagnosticBundle。
14. 真实 Windows MIDI、和弦、热插拔、macOS、Safari/iPad 手工测试。

---

## 6. 用于验收“引擎核心”的最小测试矩阵

| 场景 | 期望 |
|---|---|
| 正确音高 + 正确时间 | pitch/onset/overall 均通过 |
| 正确时间 + 错音 | 实时节奏可命中；最终 pitch 扣分；两者明确区分 |
| 三音和弦只弹一个音 | 实时不能算完整和弦（若做 pitch-aware）；最终 chord completeness 扣分 |
| 同一 onset 长和弦 + 短低音 | 参考音频逐音时值；duration 评分逐音，不把短低音判长 |
| 重复同音 | Note Off 与 occurrence 正确关联；不互相误关 |
| 反复段 | occurrence 身份和光标顺序正确；评分按实际演奏顺序 |
| 时钟 unstable | 报告不可信/降级，不允许假精确 |
| 输出延迟 100ms | 校准后 onset 偏差不被误判为演奏问题 |
| 无 Note Off | duration unknown，不强行判错 |
| 装饰音/弱起/休止 | 不被静默计入 strict target；有明确支持/阻断 |

---

## 7. 证据索引

- 完整评分库未接线：`crates/rhythm-core/src/scoring_v1.rs`（`score_performance` / `SessionScoreReport`）、`bindings/node/src/lib.rs`（无 `scorePerformance` NAPI）、`server/engine-server.mjs`（使用 `NativeSession`）、`src/types/engine.ts`（`EngineReport` 无 pitch/overall）、`src/components/ReportPanel.tsx`（仅 onset + duration）。
- 实时 matcher 忽略音符：`crates/rhythm-core/src/matcher.rs` 的 `ingest`；`crates/rhythm-core/src/events.rs` 的 `StrikeEvent.notes` 未被 matcher 读取。
- Target 无 pitch/voice：`crates/rhythm-core/src/schedule.rs` 的 `RhythmAtom` / `TargetHit` / `build_schedule` 同 tick 合并。
- 和弦时长问题：`TargetHit.nominal_duration_ms` 取最长；`duration.rs` 通过 onset target 映射；前端第 23 小节实测已确认。
- 参考播放实现：`src/features/playback/*`、`src/score-engine/playback/reference-playback-plan.ts`。
- 旧伴弹：`src/features/practice/systemDuet.ts`。
- 旧审计中的未完成项：`rhythm-trainer-core-v0.2/README.md` "What is deliberately not implemented yet"；`rhythm-trainer-frontend/docs/implementation-audit.md`（`scorePerformance` NAPI 导出未实现）。
