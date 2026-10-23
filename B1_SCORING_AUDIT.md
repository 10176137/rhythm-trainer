# B1 完整评分链审计

- 日期：2026-10-22
- 范围：B1 only（P08 完整评分报告与真实评分链路）；未进入 B2/C。
- 结论：现有 `NativeSession`、Take/Trace、`scoring_v1` 和 mode→ScoringConfig 边界可复用。B1 前缺失的是 **per-note ScoreEvent 契约、NAPI `scorePerformance` 导出、完成后评分接线、数据质量状态和报告/历史展示**，不是另写一套评分算法。本轮已按现有 Rust 权威实现接通；评分仍由 `rhythm_core::score_performance` 产生，TypeScript 只构造输入和展示输出。

---

## 1. 审计方法与证据

本轮审计对照以下内容：

- `crates/rhythm-core/src/scoring_v1.rs`：`score_performance`、`align_performances`、指标、诊断、重归一化；
- `bindings/node/src/lib.rs`：现有 `NativeSession`、raw-MIDI decode、key lifecycle、duration、Take coordinator 导出；
- `server/engine-server.mjs`：start → raw MIDI/judgment → finish → report → persist；
- `src/features/practice/usePracticeSession.ts`、`src/services/engineBridge.ts`、`src/types/engine.ts`；
- `src/components/ReportPanel.tsx`、`HistoryView.tsx`、`src/services/practiceRepository.ts`；
- 现有 `scoring_v1_acceptance.rs`、`server/selftest.mjs`、vitest。

B1 实现时本机没有可用的实体 MIDI 输入设备；当时的输入链证据来自 synthetic raw MIDI 或固定 Trace。2026-10-22 后续已连接实体 `MEDELI SP-A500`：Node Adapter 收到 76 个真实事件、Note On/Off 和力度，设备页显示 `healthy`；但尚未完成一次实体键盘的完整 Take/评分验收。

---

## 2. B1 前的真实缺口

| 能力 | B1 前实际状态 | 影响 |
|---|---|---|
| `scoring_v1` | Rust 已有 `score_performance`，验收 A–O；能算 pitch/onset/rhythm/duration/continuity、overall、measures、diagnostics、practice ranges | 核心存在，但前端无法调用 |
| NAPI 评分导出 | 没有 `scorePerformance`；只有 timing/duration/raw-MIDI/Take 相关导出 | 浏览器无法拿到权威完整评分 |
| per-note target 契约 | 只有节奏 atoms/targets（按起音组）；没有逐 occurrence 的 pitch/onset/duration/part | 无法把和弦、逐声部时值、tie 继续音传给 `scoring_v1` |
| 完成后评分 | finish 只生成 rhythm report、durations、analysis、keyLifecycles | P08 的 pitch/measure/event/overall 全部缺失 |
| performed notes | `keyLifecycles` 只是诊断/时值输入，没有映射为 `PerformedNoteV1` | 无法做 note alignment |
| 暂停区间 | 旧 matcher 会平移目标；`scoring_v1` 目标和 performed 时间尚未对齐暂停 | 暂停后整段会被误判为漏音/额外音 |
| 准备拍输入 | 旧 matcher 在 `scoringStartMs` 前抑制；`scoring_v1` 尚未过滤 | 准备拍按键可能变成 Extra |
| 数据质量状态 | 没有 score status；只有 report.trustworthy 和 captureDiagnostics | 低置信度/无目标/降级容易与 0 分混淆 |
| 报告 UI | 只有节奏统计、时值、规则诊断；没有 scoreV1/event/measure/overall | P08 不存在 |
| 历史 | 会话 JSON 不保存 scoreV1/status/versions | 历史报告无法重放完整评分 |
| 和弦对齐 | 贪心 cursor 对同 onset、不同到达顺序的和弦会误判 | 真实和弦演奏会产生错误 pitch/miss/extra |

---

## 3. B1 后的实际调用链

```text
MusicXML semantic score
  └─ buildPlaybackPlan(range/hand)
       ├─ scoreOccurrencesToEngineAtoms(scopedPlan) ──► NativeSession targets (rhythm)
       ├─ ReferencePlaybackPlan(scopedPlan) ──────────► audio/reference
       └─ buildEngineScoreEvents(scopedPlan) ─────────► per-note EngineScoreEvent[]
                                                         │
App.startPractice                                         │
  └─ usePracticeSession.begin({ atoms, scoreEvents, ... })│
       └─ EngineBridge.start ── WebSocket ──► server      │
            ├─ resolveModeScoringConfig (mode → judged config)
            ├─ buildSchedule(atoms) → NativeSession
            ├─ TakeCoordinator.beginTake + trace/journal
            └─ meta.scoreEvents + config snapshot

Raw MIDI / Node MIDI
  └─ ingestRawPacket
       ├─ NativeSession.pushHit (live rhythm judgment)
       ├─ Take trace/journal
       └─ ingests[] (raw bytes + sessionTimeMs + clock mapping)

finishSession
  ├─ native.finish() → rhythm report
  ├─ trackKeyLifecycles(ingests) → observations
  ├─ assessKeyPresses(...) → durations (existing)
  ├─ decodeMidiPackets(ingests) → mapped event times
  ├─ performed notes:
  │    observation.noteOnEventId → sessionTimeMs
  │    noteOffEventId → releaseMs (or null)
  │    status → complete/missing-release/ambiguous/invalid-time
  │    filter count-in (< meta.scoringStartMs)
  ├─ pause intervals → shift score-event targetOnsetMs
  ├─ addon.scorePerformance(scoreEvents, performedNotes)
  │    └─ Rust rhythm_core::score_performance (scoring_v1, default config)
  ├─ scoreStatus resolution
  ├─ persist session JSON (report + scoreV1 + versions + diagnostics)
  └─ send report WebSocket message

UI
  ├─ usePracticeSession.onReport stores score fields
  ├─ ReportPanel → FullScoreReport (live completed Take)
  └─ HistoryView → practiceRepository.getSession → ReportPanel
```

### 3.1 同一目标计划

`buildEngineScoreEvents` 遍历的是 `reference.scopedPlan.occurrences`，与 `scoreOccurrencesToEngineAtoms(scopedPlan)` 使用同一个 `scopedPlan`。因此：

- 手别过滤、range/loop 选择、occurrence 顺序一致；
- 每个 occurrence 的 `targetOnsetMs` 来自 `countInMs + beatToMsAtBpm(occurrence.playbackBeat)`；
- `targetDurationMs` 来自该 occurrence 自己的 `durationBeat`，不是和弦组最长时值；
- tie continuation 由 planner 的 occurrence 语义处理，不额外造 onset；
- 和弦的每个 pitch 是独立 score event，`scoreEventId = occurrenceId`。

前端测试覆盖 per-note/count-in/逐声部时值/tie/和弦三条；`PlaybackPlan` 仍是唯一语义来源。

### 3.2 NativeSession 与 Take

B1 没有重写 `NativeSession` 或 Take。`NativeSession` 继续消费 atoms 生成节奏 target，Take 继续管理 capture epoch、trace、journal、stop/finalize 和持久化。B1 只新增：

- start 请求的 `scoreEvents` 字段和基础校验；
- meta/record 中的 score event 快照；
- finish 后基于同一 Take 的 ingests/key lifecycles 构造评分输入。

因此“节奏实时判定”和“完整评分”共用一次 Take 的原始事件，不是第二套采集或第二套会话。

---

## 4. NAPI 契约

### 4.1 输入

`bindings/node/src/lib.rs` 新增：

```ts
scorePerformance(
  scoreEvents: JsScoreEventInput[],
  performed: JsPerformedNoteInput[],
): JsSessionScoreReport
```

`JsScoreEventInput`：

| 字段 | 含义 | 校验 |
|---|---|---|
| `scoreEventId` | occurrence 稳定 ID | 非空由 server 校验 |
| `measure` | 内部小节 ordinal | >= 1 |
| `beatPosition` | 从播放原点算的拍位 | 有限 |
| `pitch` | MIDI 0..127 | 0..=127 |
| `targetOnsetMs` | count-in 后的目标 onset | 有限且 >= 0 |
| `targetDurationMs` | occurrence 自身时值 | 有限且 > 0 |
| `partId` | staff/voice 来源 | 可选 |
| `parseConfidence` | 解析元数据 | 当前仅携带，不参与指标 |

`JsPerformedNoteInput`：

| 字段 | 含义 |
|---|---|
| `performedNoteId` | key lifecycle 的 pressId |
| `pitch` | Note On MIDI |
| `onsetMs` | 映射后的 session time |
| `releaseMs` | Note Off 的 session time；缺失为 null |
| `pairingStatus` | `complete` / `missing-release` / `ambiguous` / `invalid-time` |

### 4.2 输出

NAPI 直接映射 Rust `SessionScoreReport`（snake_case → camelCase）：

- `alignmentPairs`, `missedScoreEventIds`, `extraPerformedIds`, `restWindowExtraIds`;
- `eventResults`: `MATCH` / `WRONG_PITCH` / `MISSING` / `EXTRA` / `AMBIGUOUS`，带 expected/actual pitch、onset error、pairing status、reason；
- `pitch`（targets/correct/wrongPitch/missed/extra/recall/precision）；
- `onset`（signed mean/median、MAE、P50/P90、超容差）；
- `rhythm`（interval samples、speed ratio、jitter、drift、补偿疑似）；
- `duration`（graded/meanRatio/tooShort/tooLong）；
- `continuity`（covered ratio、最长连续、小节覆盖）；
- `measures`（逐小节 matched/missed/MAE/speed ratio）；
- `overall`（score、subscores、renormalized）；
- `confidence`、`dataDegraded`、`diagnostics`、`practiceRanges`；
- `algorithmVersion`、`configVersion`。

`configVersion` 当前由 NAPI 组装为 `format!("{}:default", SCORING_ALGORITHM_VERSION)`；Rust 使用 `ScoringConfig::default()`。mode→ScoringConfig 的 rhythm 判定配置另行保存在 Take 快照中，B1 未把 mode 的判定档位映射成不同 scoring_v1 权重。

### 4.3 和弦对齐修复

`align_performances` 原来按 onset 排序后单调贪心。对于同一 target onset 的 C/E/G 和弦，演奏顺序 G(990)→C(1000)→E(1010)，贪心会先拿 G 对 C，随后无法全部配对。

B1 加入同 onset 分组：

- 同 target onset（1 ms 内）的目标先成组；
- 在该组的 performed 候选中按音高做一对一匹配；
- 未匹配目标用组内最近未用候选形成 `WRONG_PITCH`，仍无候选才是 `MISSING`；
- 候选窗口以下一不同 target onset 为界，避免把下一目标的音吞进和弦；
- 未使用候选成为 `EXTRA`。

这不是完整 DP/最优分配，但对常见 human chord spread 和乱序到达做了确定性修复。验收 `t_chord_spread_is_not_a_sequence_error` 从失败变为 3 correct、0 extra、0 missed、3 pairs。

---

## 5. 完成后评分的数据质量规则

### 5.1 performed notes

- 只使用 Rust key-lifecycle observations 的 `noteOnEventId`/`noteOffEventId`；
- onset/release 使用 `decodeMidiPackets` 返回的 session time，不用原始设备时钟；
- `missing-note-off` → `missing-release`，`releaseMs=null`，不生成 duration verdict；
- `ambiguous-pairing` → `ambiguous`；
- `invalid-time` → `invalid-time`；
- 无法映射到 session time 的 observation 计入 `scoreUnmappedNoteCount`，不猜测时间；
- onset 早于 `meta.scoringStartMs` 的 count-in 输入被过滤，不计入 score input，也不会变成 Extra。

### 5.2 暂停与恢复

- `pauseIntervalsSourceMs` 转为 session 区间（利用前端发来的 `sessionOrigin`）；
- 对每个 score event，若 `targetOnsetMs >= pause.startSession`，按该暂停区间长度平移；
- performed notes 使用前端 session time（包含实际暂停段），因此恢复后的演奏与平移后的目标对齐；
- `pauseAdjusted` 写入 report 和会话记录；
- selftest `scenarioPauseScoring` 验证 4000 ms 暂停后第二音仍匹配，MAE 仍约 +8 ms。

### 5.3 状态矩阵

server 在 `finishSession` 中按以下顺序决定 `scoreStatus`：

| 状态 | 条件 | UI 行为 |
|---|---|---|
| `UNAVAILABLE` | 没有 `scoreEvents`（free/旧客户端/旧记录） | 不显示 0 分；提示完整评分不可用 |
| `INSUFFICIENT_DATA` | 有目标但无 performed；或 confidence 为低/不可评估且没有降级原因 | 显示“数据不足”，隐藏 Overall |
| `DEGRADED` | 输入健康 disconnected/degraded；Node clock mapping unscorable/unmapped；无法映射 session time 的 performed note；`scoreV1.dataDegraded` | 显示分项但隐藏 Overall，并提示输入/时钟降级 |
| `INVALID` | NAPI 调用/输入抛错 | 显示错误，不显示分数 |
| `AVAILABLE` | 有 performed、confidence 足够且没有上述降级 | 可显示 Rust Overall（仅当未 renormalized） |

关键点：

- 零输入不等于 0 分；有目标但无输入是 `INSUFFICIENT_DATA`，Rust report 仍可见但 UI 不把它当完整成绩。
- 低置信度不再被错误标成“设备降级”；`DEGRADED` 只用于输入/时钟/数据质量原因。
- Overall 在 `status !== AVAILABLE` 或 `overall.renormalized` 时显示“不可用”，不将重归一化分数冒充完整综合分。
- 旧记录/没有 scoreV1 的记录显示 `UNAVAILABLE`，不回填假分数。

---

## 6. 报告与历史

`FullScoreReport` 展示：

- 状态、confidence、mode/judgment/duration policy、score 配置/算法版本、输入/未映射计数、暂停平移标记；
- Overall（受上述门禁）、音高、匹配、起音、节奏、时值、连续性；
- 分项权重与 sample count；
- 原始 pitch/onset/rhythm/duration 指标；
- 小节级表（最多 40）；
- 事件级结果（最多 40，带 expected/actual、误差、pairing/reason）；
- 评分诊断与建议练习区间。

历史链路：

- server record 保存 `scoreV1`、`scoreStatus`、`scoreConfigVersion`、`scoreAlgorithmVersion`、`scoreInputNoteCount`、`scoreUnmappedNoteCount`、`pauseAdjusted`、`scoreEvents`、`scoringConfig`、`coreAlgorithmVersion`；
- `practiceRepository.SessionDetail` 类型和 `HistoryView` 透传；
- 历史详情渲染同一个 `FullScoreReport`，不重新计算评分。

冻结版本：

- rhythm/算法：`coreAlgorithmVersion`（core 常量）；
- 完整评分：`scoreV1.algorithmVersion`、`scoreV1.configVersion`；
- mode 配置：`scoringConfig`/`scoringConfigVersion`；
- 输入目标：`scoreEvents`；
- 输入演奏：report/keyLifecycles 与 trace/journal。

---

## 7. 验证证据

### 7.1 Rust

```text
PATH="$HOME/dev-tools/w64devkit/bin:$PATH" \
cargo test --workspace --target x86_64-pc-windows-gnu
# 110 passed: 82 unit + 1 e2e + 5 property + 1 benchmark + 21 scoring acceptance
```

`scoring_v1_acceptance` 目前 A–U 共 21 项，其中 B1 新增 p–u：

- p extra 不级联；
- q missing 不级联；
- r wrong pitch 与 extra 区分；
- s 重复音不交叉消费；
- t 和弦 spread 不被当成序列错误（旧实现失败，修复后通过）；
- u 缺 Note Off 不产生 duration verdict。

### 7.2 NAPI

- GNU addon 重建；
- Node 直接调用 `scorePerformance` 验证和弦乱序 3/3 MATCH；
- `index.js` 实际加载 `rhythm_trainer_native.win32-x64-gnu.node`；同步 generic 文件。

### 7.3 server selftest（126 assertions）

新增/覆盖：

- `scenarioScoreChain`：8 raw MIDI + 1 extra，scoreV1 8 MATCH/1 EXTRA、pitch 8 correct、duration 8 graded、measure 1、confidence high、versions、persisted history；count-in note 不计入；
- 无 scoreEvents → UNAVAILABLE + scoreV1 null；
- 有目标零输入 → INSUFFICIENT_DATA，pitch correct 0/missed 8；
- 降级输入（disconnect）→ DEGRADED；
- `scenarioPauseScoring`：4000 ms 暂停后 2/2 MATCH、MAE +8 ms、pauseAdjusted；
- start 拒绝 onset 不在 targets 时间线上的 scoreEvents；
- 原有 raw-MIDI/Take/Trace/Node MIDI/duration/mode config 场景继续通过。

### 7.4 frontend

```text
npm test
# 26 files, 155 tests passed
npm run build
# PASS（仅 OSMD chunk 1.44 MB 警告）
```

新增 `score-events` 3 项，`FullScoreReport` 4 项 SSR 渲染断言（不可用/降级/可用/重归一化）。

### 7.5 浏览器

用真实 engine service + 浏览器历史页验证合成会话（synthetic raw MIDI，不是实体键盘）：

- AVAILABLE：完整评分可用，Overall 100.0，8 MATCH + 1 EXTRA，小节/事件表存在；
- DEGRADED：显示数据降级、Overall 不可用；
- INSUFFICIENT_DATA：显示数据不足、Overall 不可用；
- UNAVAILABLE：显示完整评分不可用，不显示 0 分；
- 历史详情持久化并可展开；修复了报告 CSS 缺失导致的指标粘连和表格布局问题，并截图复查。

---

## 8. 已知缺口 / 风险

1. **实体 MIDI 只完成输入链路验证**：后续已连接 `MEDELI SP-A500`，Node Adapter 收到 76 个真实 Note On/Off 事件，`inputHealth=healthy`、`queueDropped=0`；设备页可显示按键。但尚未在实体键盘上完成一次完整 Take 及 `scoring_v1` 评分，真实设备延迟、跨暂停和断连仍需手工验证。
2. **完整评分是 post-Take**：不是实时 score；P08 只在结束后生成。实时只显示节奏/提示。
3. **对齐仍是贪心 + 和弦分组，不是全局最优 DP**：极端重叠同音、超大和弦 spread、复杂重复音仍可能产生歧义；`AMBIGUOUS`/低置信度状态不会被伪装成确定结果。
4. **`parseConfidence` 未参与指标**：前端目前把语义可解析目标标为 1；导入 warnings/限制在 ImportReport/status 中表达，不存在 per-note parser confidence。B1 未把它当作真实证据。
5. **server 只校验 scoreEvents 形状和时间线**：现在会拒绝 onset 不落在本次 targets 时间线上的 score event，但仍未校验 pitch/count、也不要求每个 target 都有 event（targets 本身不带 pitch）。前端由同一个 `scopedPlan` 生成；下一步可让服务端直接构建 score events，或增加完整覆盖校验。
6. **scoring_v1 使用默认配置**：mode 的判定档位/时值策略已用于 rhythm/duration；完整评分的权重和容差目前是 `ScoringConfig::default()`，没有 per-mode 权重。
7. **Node 时钟映射**：unmapped/stale 事件现在会使 `clockMapping.status=unscorable`，但浏览器 raw 路径的 `clockQuality` 固定为 `good`，没有独立的浏览器时钟质量降级来源。
8. **无 Overall 的旧记录**：B1 之前生成的会话没有 `scoreV1`，历史中显示不可用；不会回填/猜测。新会话才具备完整评分。
9. **历史 UI 不在列表行显示 scoreStatus**：状态在展开后的报告内；没有额外汇总徽章。
10. **报告最多显示 40 小节/40 事件**：完整数据在 JSON；这是展示上限，不是评分丢失。
11. **未校准音频延迟**：onset/duration 适合练习反馈，不是采样级物理时间；C2 才接入校准。
12. **B1 边界**：未实现 P09、独立试听、Snapshot 光标、`.mxl`、B2 教学动作或 C 系列；不把 free/旧记录伪造成完整评分。

---

## 9. B1 验收清单

- [x] Rust Core 仍是唯一评分权威，NAPI 直接调用 `score_performance`。
- [x] 同一 `PlaybackPlan` 生成 atoms、参考播放和 scoreEvents。
- [x] per-note pitch/onset/duration/part 契约。
- [x] Take 完成后 raw MIDI → key lifecycles → performed notes → scorePerformance。
- [x] 准备拍过滤、暂停目标平移、缺 Note Off 不猜测。
- [x] 事件级结果、小节级报告、pitch/overall/confidence/diagnostics 均来自 Rust。
- [x] `AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID` 区分。
- [x] 无 score/零输入/降级/重归一化不显示假 0 或占位 Overall。
- [x] 会话持久化配置/算法版本/评分输入与状态。
- [x] 历史详情展示同一报告。
- [x] Rust 21 项 scoring acceptance、110 项全量；selftest 126；vitest 155；build 通过。
- [x] 浏览器合成会话验证可用/不可用/降级/数据不足展示。
- [ ] 实体 MIDI 设备手工验收（环境无设备，明确未完成）。
- [ ] 音频延迟校准（C2）。
