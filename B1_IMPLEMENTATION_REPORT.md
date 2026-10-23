# B1 完整评分链与 P08 报告 — 实施报告

- 日期：2026-10-22
- 范围：B1 only；已完成完整评分链、P08 报告、历史持久化与测试。
- 停止点：**B1 完成后停止，未开始 B2/C。**
- 结论：Rust `scoring_v1` 仍是唯一评分权威。前端只把同一 `PlaybackPlan` 转成 per-note 目标，并把 Rust report 展示出来；没有 TypeScript 评分算法、没有伪造 0 分/综合分/置信度/小节/诊断。

---

## 1. 本次完成内容

1. **per-note 目标契约**：新增 `EngineScoreEvent` 和 `buildEngineScoreEvents`，从手别过滤后的 `PlaybackPlan.occurrences` 生成逐音音高、onset、逐 occurrence 时值、小节、拍位、part。
2. **NAPI 导出**：新增 `scorePerformance`，把 `ScoreEvent`/`PerformedNoteV1` 直接交给现有 `rhythm_core::score_performance`，返回完整 `scoring_v1` 报告。
3. **完成后评分链**：Take 结束后从 Rust key-lifecycle observations 构造 performed notes，使用 session time；过滤准备拍；平移暂停区间；调用 NAPI。start 时还会拒绝 onset 不在本次 targets 时间线上的 scoreEvents，避免评分目标与练习计划脱节。
4. **数据质量**：`AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID` 区分；低置信度=数据不足；零输入不显示 0 分；Overall 在降级/重归一化/不可用时隐藏。
5. **P08 报告**：新增 `FullScoreReport`，展示状态、event results、pitch/onset/rhythm/duration/continuity、measure、subscores、diagnostics、版本；接入实时报告和历史详情。
6. **和弦对齐修复**：同 onset 目标和弦按音高匹配，修复乱序和弦被误判的问题。
7. **测试与文档**：Rust 110 项、selftest 126 项、vitest 155 项、build 通过；浏览器合成 raw-MIDI 会话验证；更新 README/CHANGELOG/CORE_API。

---

## 2. 改动文件

### Rust Core

| 文件 | 改动 |
|---|---|
| `crates/rhythm-core/src/scoring_v1.rs` | `align_performances` 增加同 onset 和弦分组、按音高匹配、下一目标 onset 边界；未重写指标/诊断。 |
| `crates/rhythm-core/tests/scoring_v1_acceptance.rs` | 新增 p–u 共 6 项；`t_chord_spread_is_not_a_sequence_error` 曾真实失败，修复后通过。 |
| `bindings/node/src/lib.rs` | 新增 `JsScoreEventInput`、`JsPerformedNoteInput`、完整输出 DTO 和 `scorePerformance`；直接调用 core。 |
| `bindings/node/index.d.ts` | 构建生成 `scorePerformance` 类型声明。 |
| `bindings/node/rhythm_trainer_native*.node` | 用 GNU 工具链重建；实际加载平台文件已更新。 |
| `README.md` / `CORE_API.md` / `IMPLEMENTATION_STATUS.md` / `CHANGELOG.md` | 记录 post-finalize 评分边界、NAPI 契约、和弦修复、测试与环境限制。 |

### Frontend / engine service

| 文件 | 改动 |
|---|---|
| `src/types/engine.ts` | 新增 `EngineScoreEvent`、score report/status/event/measure/diagnostic DTO；`start`/`report`/`captureDiagnostics` 扩展。 |
| `src/score-engine/playback/score-events.ts` | 新增 `buildEngineScoreEvents`：per-note、count-in、逐 occurrence 时值、稳定 ID。 |
| `src/score-engine/playback/score-events.test.ts` | 3 项：逐音/时值、tie 不额外 onset、和弦独立 pitch。 |
| `src/App.tsx` | 在 `launchPractice` 用同一 `scopedPlan` 构建 scoreEvents；传入 `session.begin`；报告透传 score 字段。 |
| `src/features/practice/usePracticeSession.ts` | `BeginRequest.scoreEvents`；新增 scoreV1/status/versions/input counts/pauseAdjusted 状态、重置和 onReport。 |
| `src/services/engineBridge.ts` | `start` 请求带 `scoreEvents`。 |
| `server/engine-server.mjs` | start 校验/保存 scoreEvents；finish 构造 performed notes、count-in 过滤、暂停平移、调用 `addon.scorePerformance`；状态解析；record/report 持久化；Node unmapped/stale 时钟降级。 |
| `server/selftest.mjs` | 新增 score chain、pause scoring、insufficient/unavailable/degraded、scoreEvents/atoms 时间线校验断言；当前 126 项。 |
| `src/components/FullScoreReport.tsx` | P08 展示；不可用/降级/数据不足状态；Overall 门禁；事件/小节/诊断/版本。 |
| `src/components/FullScoreReport.test.tsx` | 4 项 SSR：不可用/降级/可用/重归一化不伪造 Overall。 |
| `src/components/ReportPanel.tsx` | 接入 `FullScoreReport`。 |
| `src/components/HistoryView.tsx` | 历史详情透传 scoreV1/status/config/versions/counts/pauseAdjusted。 |
| `src/services/practiceRepository.ts` | `SessionDetail` 扩展 score 字段。 |
| `src/styles.css` | 新增完整评分卡片/网格/状态/分项/表格样式；修复首版指标与表格无样式导致的文字粘连。 |
| `README.md` / `CHANGELOG.md` | B1 能力、测试数量、边界与硬件限制。 |

未新增 npm/cargo 依赖；未修改 mode-config、Reference Playback、TargetSchedule 或 Take 生命周期。

---

## 3. 评分契约

### 3.1 ScoreEvent

`buildEngineScoreEvents(plan, bpm, countInBeats)`：

- 遍历 `plan.occurrences`；
- `targetOnsetMs = countInMs + beatToMsAtBpm(occurrence.playbackBeat, bpm)`；
- `targetDurationMs = beatToMsAtBpm(occurrence.durationBeat, bpm)`，逐 occurrence，不使用和弦组最长时值；
- `scoreEventId = occurrence.occurrenceId`；
- `measure = occurrence.bar`，`beatPosition = playbackBeat`，`partId = staff/voice`；
- 排序后发送。

同一 `scopedPlan` 同时生成 atoms、参考播放和 scoreEvents。准备拍、手别、range/loop 由上游统一决定。

### 3.2 performed notes

- 使用 `keyLifecycles.observations`；
- `noteOnEventId`/`noteOffEventId` 通过 `decodeMidiPackets` 映射到 session time；
- 缺 Note Off：`pairingStatus='missing-release'`，`releaseMs=null`，无 duration verdict；
- ambiguous/invalid 保留对应状态；
- 无法映射的 observation 计入 `scoreUnmappedNoteCount`；
- onset 早于 `meta.scoringStartMs` 的准备拍输入过滤，不进入 score input，也不变成 Extra。

### 3.3 暂停

- `pauseIntervalsSourceMs` 转为 session 区间；
- `targetOnsetMs >= pause.startSession` 的目标按暂停段平移；
- performed notes 使用前端 session time；
- `pauseAdjusted` 存入 report/record；
- selftest 验证 4000 ms 暂停后 2/2 匹配，MAE 仍约 +8 ms。

---

## 4. 数据质量

### 4.1 状态

| 状态 | 例子 | UI |
|---|---|---|
| `AVAILABLE` | 8 个目标、8 个匹配、confidence high | 显示 Overall 和分项 |
| `INSUFFICIENT_DATA` | 有目标但零输入；或 confidence low/not-assessable | 显示“数据不足”，Overall 不可用 |
| `DEGRADED` | 输入 health disconnected/degraded；Node clock unscorable/unmapped；无法映射的 performed note；`dataDegraded` | 显示分项，Overall 不可用 |
| `UNAVAILABLE` | 没有 scoreEvents（free/旧记录） | 显示完整评分不可用，不显示 0 |
| `INVALID` | NAPI 输入/调用错误 | 显示错误，不显示分数 |

关键实现：

- 零输入是 `INSUFFICIENT_DATA`，不是 0 分；
- 低置信度不再归为“设备降级”；
- Overall 仅在 `AVAILABLE` 且 `renormalized=false` 且 `score != null` 时显示；
- `DEGRADED`/`INSUFFICIENT_DATA` 分别有明确文案，不把缺失数据当 0；
- 旧记录没有 scoreV1 时显示不可用，不回填假数据。

### 4.2 和弦修复

旧失败场景：

```text
targets: C4/E4/G4 @ 1000ms
performed: G4 @ 990, C4 @ 1000, E4 @ 1010
expected: 3 correct, 0 extra, 0 missed
actual before fix: pitch.correct = 1
```

修复后：

- 同 onset 目标分组；
- 组内按音高一对一匹配；
- 未匹配目标用组内最近候选形成 `WRONG_PITCH`；
- 未使用候选 `EXTRA`；
- 候选窗口以下一不同 target onset 为界。

NAPI 直接验证得到 3 MATCH；Rust acceptance 21 项全过。

---

## 5. 报告与历史

`FullScoreReport` 包含：

- RUST SCORING_V1 标题、状态 badge；
- confidence、mode/judgment/duration policy、配置/算法版本、输入/未映射、暂停标记；
- Overall（门禁）、音高、匹配目标、起音、节奏、时值、连续性；
- 分项权重/sample count；
- 原始指标句；
- 小节表（最多 40）；
- 事件级结果（最多 40）；
- 评分诊断与建议练习区间。

历史：

- server 会话 JSON 保存 `scoreEvents`、`scoreV1`、`scoreStatus`、`scoreConfigVersion`、`scoreAlgorithmVersion`、`scoreInputNoteCount`、`scoreUnmappedNoteCount`、`pauseAdjusted`、`scoringConfig`、`coreAlgorithmVersion`；
- `HistoryView` 展开详情渲染同一个报告，不重算；
- 浏览器实测历史详情显示 8 MATCH + 1 EXTRA、小节表、事件表、Overall 和版本。

首版样式缺失导致：

- `Overall100.0`、`音高正确率100.0%精确率...` 等文字粘连；
- 分项 `pitch 100.0w30` 无间距；
- 表格无边框/间距。

已在 `src/styles.css` 增加完整评分样式，并截图复查通过。

---

## 6. 验证命令与结果

### Rust

```text
cd D:\123\rhythm-trainer-core-v0.2
PATH="$HOME/dev-tools/w64devkit/bin:$PATH" \
cargo test --workspace --target x86_64-pc-windows-gnu
```

结果：

```text
82 unit + 1 end_to_end + 5 property + 1 benchmark + 21 scoring acceptance = 110 passed
0 failed
```

其中 `scoring_v1_acceptance`：

```text
a ... o  原有 15 项
p extra_note_does_not_shift_following_targets
q missing_note_does_not_shift_following_targets
r wrong_pitch_is_distinct_from_extra
s repeated_pitch_does_not_cross_consume
t chord_spread_is_not_a_sequence_error
u missing_release_has_no_duration_verdict
21 passed
```

### NAPI 构建

```text
cd D:\123\rhythm-trainer-core-v0.2\bindings\node
PATH="$HOME/dev-tools/w64devkit/bin:$PATH" \
RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu \
CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$HOME/dev-tools/w64devkit/bin/gcc.exe" \
LIBNODE_PATH="$HOME/dev-tools/libnode" \
npm run build
```

- 生成/更新平台 addon；
- `scorePerformance` 和 `decodeMidiPackets` 均为 function；
- 和弦乱序 Node 调用：

```text
pitch.correct = 3
eventResults = [MATCH, MATCH, MATCH]
```

### Engine selftest

```text
cd D:\123\rhythm-trainer-frontend
npm run selftest
# 126 assertions, 全部自测通过
```

新增关键断言：

- scoreV1 生成，status AVAILABLE；
- 8 MATCH + 1 EXTRA；
- pitch 8 correct + 1 extra；
- duration graded 8；
- measure matched 8；
- confidence high；
- versions；
- input 9 / unmapped 0 / pauseAdjusted false；
- 历史详情持久化；
- 无 scoreEvents → UNAVAILABLE；
- 有目标零输入 → INSUFFICIENT_DATA；
- degraded input → DEGRADED；
- 4000 ms 暂停 → 2/2 MATCH、MAE +8 ms；
- 准备拍按键不成为 Extra。

### Frontend tests/build

```text
cd D:\123\rhythm-trainer-frontend
npm test
# 26 files, 155 tests passed

npm run build
# tsc -b + vite build passed
# 仅 OSMD 1.44 MB chunk 警告
```

新增：

- `score-events.test.ts` 3 项；
- `FullScoreReport.test.tsx` 4 项（不可用/降级/可用/重归一化）。

### 浏览器验收

环境：真实 engine service + Vite，本机无 MIDI 设备。

用 synthetic raw MIDI（不是实体键盘）创建临时会话，验证：

1. AVAILABLE：状态“完整评分可用”、Overall 100.0、8 MATCH + 1 EXTRA、小节/事件表、版本；
2. DEGRADED：状态“数据降级”、Overall 不可用；
3. INSUFFICIENT_DATA：状态“数据不足”、Overall 不可用；
4. UNAVAILABLE：状态“完整评分不可用”、无 0 分；
5. 历史详情能重新加载并展示同一 scoreV1；
6. 截图检查布局；修复 CSS 后复查。

临时测试会话、trace、journal 已删除，不污染用户真实历史。

---

## 7. 硬件与环境限制

B1 实现时没有实体 MIDI 设备，端到端证据是 synthetic raw MIDI/固定 Trace。

后续补充（2026-10-22）：已连接实体 `MEDELI SP-A500`，Node Adapter 收到 76 个真实事件（Note On/Off、力度），设备页显示 `healthy`、`queueDropped=0`。这验证了实体键盘到 Node Adapter/设备页的输入链路；**还没有在实体键盘上完成一次完整 Take 和 `scoring_v1` 报告**，因此仍不能声称真机评分验收完成。音频输出延迟仍未校准。

---

## 8. 已知限制

详见 `B1_SCORING_AUDIT.md` 第 8 节。重点：

- 完整评分是 post-Take，不是实时评分；
- 对齐是贪心 + 和弦分组，不是全局 DP；极端重叠/大 spread/重复音仍可能 ambiguous；
- `parseConfidence` 不参与指标；
- server 会拒绝 onset 不在 targets 时间线上的 scoreEvents，但未校验 pitch/count 或每个 target 覆盖；当前由前端同一 `scopedPlan` 保证；
- scoring_v1 使用默认配置，mode-specific 完整评分权重未实现；
- 历史列表行不单独显示 scoreStatus，展开报告内显示；
- 报告最多显示 40 小节/40 事件，完整数据在 JSON；
- 旧记录无 scoreV1 时显示不可用，不回填；
- 未实现 P09、独立试听、Snapshot 光标、`.mxl`、B2/C。

---

## 9. 停止确认

B1 已完成并在此停止：

- 未实现 B2 教学动作/处方执行；
- 未实现 C2 音频延迟校准；
- 未实现 C3 独立试听/光标/MXL；
- 未修改 Reference Playback、Take 生命周期或 mode-config 的既有语义。

等待下一步指令。
