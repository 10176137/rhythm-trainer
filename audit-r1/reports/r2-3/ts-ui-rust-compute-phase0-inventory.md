# TypeScript 界面化 / Rust 全计算化迁移 — Phase 0 盘点报告

**文档性质：** Phase 0 只读盘点与迁移门槛；**本轮未修改任何生产代码、契约、默认值或测试 oracle**。
**当前基线 SHA：** `dc18da6bb780374516702c4ba4f1bba8fbc02c64`（`dc18da6`，分支 `r2-3-rust-planner`）
**设计依据：** `rhythm-trainer-ts-ui-rust-compute-migration-v1.md`（V1.0）§13：Phase 0 经评审后才进入 Phase 1，不得一次性重写。
**现有测试基线（dc18da6）：** `tsc -b` 通过；Vitest **504 passed / 4 skipped**；Rust **173 passed / 0 failed**；selftest **251/251**。仓库无 CI，无实体 MIDI 自动化回归；浏览器验证均为本地 IAB。

## 0. Phase 0 结论摘要

当前系统不是“TS 全算 / Rust 全算”二选一，而是三层混合：

- **Rust 已经在生产负责 Timeline 的实时匹配、最终评分、时长/分析、Take runtime、StudentModel**；这部分不是待迁移，而是迁移后的目标形态已部分存在。
- **TS 仍负责 MusicXML 语义解析、ScoreDocument 投影、默认 rts Planner、Follow 运行时/匹配/报告、复练处方分析**；这些是本轮迁移的主要对象。
- **Node 仍负责部分业务校验与结果拼装**：plan timeline/follow 语义校验、`buildRetryComparison`、mode scoring config、duration measure 标注、capture diagnostics；持久化/API/设备 I/O 属于允许的基础设施。
- **Take 领域模型**目前只覆盖 Timeline：`takes/<takeId>.json`、score/config/evidence、plan context 已落地；Follow 仍不产生 Take，Free Play 不产生 Take；Profile 仍由 Node 调用 Rust StudentModel 在提交后更新，尚未从 Takes 全量重建。
- **生产默认仍是 `rts`**；Rust Planner 仍 opt-in。迁移不能以“已经实现”替代“生产切换评审”。

## 1. 前端 TS 中仍影响业务结果的计算及调用方

| 文件 / 导出 | 现在计算什么 | 生产调用方 | 当前权威性 | 目标阶段 |
|---|---|---|---|---|
| `src/score-engine/import/musicxml-importer.ts` `importMusicXml` | MusicXML 读取、divisions/拍号/调号/谱号/声部/小节/音符/休止/和弦/tie/tuplet/能力/导入报告/指纹 | `musicXmlParser.parseMusicXml`、`scoreImport.importScoreText`、乐谱库载入、`practiceScore` 内置谱、dev/parity | **权威 TS parser** | Phase 2 |
| `src/features/score/musicXmlParser.ts`、`scoreImport.ts` | parser + `toLegacyScoreDocument` 包装 | `App` 导入/载入、`ScoreLibraryPage` | 权威解析入口 | Phase 2 |
| `src/score-engine/contract-v1/plan-fingerprint.ts` `projectScoreDocumentV1`、`computeScoreRevisionId` | 把 engine document 投影成 ScoreDocumentV1、score revision ID、指纹 payload/校验 | `App.startRustPractice` 的 plan-request；contract/parity/server 测试 | **权威 TS 投影/身份** | Phase 2/3 |
| `plan-fingerprint.ts` `planFingerprintV1`、`canonicalizeJcs` 等 | 冻结指纹参考实现 | 测试 oracle；浏览器生产不生成可信 plan fingerprint | 测试/参考实现 | 保持 oracle；生产权威在 Rust gate |
| `src/score-engine/playback/playback-planner.ts` `buildPlaybackPlan` | 范围/手别/和弦分组/target onset/时值/loop pass/plan ID | `App` 默认 rts timeline/follow；`reference-playback` 测试 | **权威 TS Planner（默认生产）** | Phase 3 |
| `src/score-engine/playback/score-events.ts` `buildEngineScoreEvents` | 最终评分用 EngineScoreEvent（onset/duration/pitch） | `App` rts timeline | 权威 TS 评分事件 | Phase 3/6 |
| `src/score-engine/playback/reference-playback-plan.ts` `buildReferencePlaybackPlan`、`filterPlaybackPlanByHand` | 参考播放计划、手别二次过滤 | `App` rts 与 rust 两条 accept | rts 路径含业务过滤；rust 路径以 `hand:'both'` 调用，仅参考播放 | Phase 3/6（保留纯展示/音频调度） |
| `src/features/score/practicePlan.ts` `buildPracticePlan` | 无 engine 时的 target 分组/atoms | `App` 无语义乐谱 fallback | 业务分组 | Phase 6 |
| `src/score-engine/scope/practice-scope.ts` `assessPracticeScope`、`handByScoreEventIdFromMapping`、`buildUserHandMapping`、`suggestClefHeuristicMapping` | 手别映射完整性、范围非空、event→hand 映射、初始建议 | `App` launch 门禁/参考播放/设置建议 | **业务门禁（TS）** | Phase 3/4；建议保留为 UI 建议，门禁交 Rust |
| `src/features/score/staffMapping.ts` `getUnsupportedNotes` | 显示/严格练习前的谱面支持检查（bar 超界、音高/符型等） | `App` launch、`ReaderPage`、`scoreLayout` | 显示+启动门禁 | Phase 3/6 |
| `src/score-engine/practice/follow-session.ts` `FollowSession` | Follow 光标推进、音高/顺序/和弦间距、IOI 容差、FollowReport | `App` follow 路径（rust 与 rts 均使用） | **权威 Follow runtime/matcher（TS）** | Phase 4 |
| `src/features/practice/teachingPrescription.ts` `buildTeachingPrescriptions`、`buildManualPrescription` | 基于报告/分析生成复练处方、BPM/范围/手别建议、manual fallback | `TargetedPracticePanel`（历史/报告） | 业务分析与学习建议（TS） | Phase 5 |
| `src/features/practice/usePracticeSession.ts` Free Play 分支 | 本地 `beginFreePlay`/`finishFreePlay`，记录事件、不建目标、不评分 | `App` free 模式 | 本地采集，无权威评分 | Phase 4/5（若 Free Play 也要 Take） |
| `src/features/practice/usePracticeSession.ts` 非 Free 分支 | 发送 start/pause/resume/finish、接收 judgments/report | `App` | 传输/状态镜像；计时权威在 Rust/Node | 保留（瘦身为 API 适配） |
| `src/services/engineBridge.ts` | WS 传输、requestId、超时、断连拒绝 | `usePracticeSession` | 基础设施 | 保留 |
| `src/score-engine/view/score-view-adapter.ts`、`ScoreViewer`、`OsmdScoreView`、`scoreLayout`、`scoreHints` | OSMD 映射、高亮/淡化、布局、滚动/跟随、音符提示 | UI | **展示** | 保留 |
| `src/components/HistoryView/ProfileView/ReportPanel/FollowReportPanel` | 报告/历史/画像展示 | UI | **展示** | 保留（Phase 5 适配 Take） |
| `src/features/practice/practiceSettings.ts` | 练习配置本地持久化 | UI | 配置 UI | 保留 |
| `src/score-engine/parity/*`、`src/score-engine/test/*`、`contract-v1` 测试 | 差分/oracle/golden | 测试 | 测试 oracle | 保留，不进入生产 bundle |

### 1.1 生产 bundle 中必须优先消除的业务计算

1. `importMusicXml`（权威 parser）
2. `buildPlaybackPlan`（默认 rts planner）
3. `buildEngineScoreEvents` / `scoreOccurrencesToEngineAtoms`（rts 路径的评分事件/atoms）
4. `FollowSession`（Follow runtime/matcher/report）
5. `buildTeachingPrescriptions`（学习建议）
6. `projectScoreDocumentV1`（若 Rust parser 直接产出 SD，则浏览器不再投影）
7. `assessPracticeScope`/`handByScoreEventIdFromMapping` 中的业务门禁（建议保留 UI 提示，权威判定交 Rust）

## 2. Parser / Planner / Matcher / Scoring 调用关系

### 2.1 导入链

```text
App 导入 / 乐谱库载入 / 内置谱
  → features/score/musicXmlParser.parseMusicXml 或 scoreImport.importScoreText
  → score-engine/import/musicxml-importer.importMusicXml (TS)
  → Legacy ScoreDocument (UI) + Engine ScoreDocument + ImportReport
  → App 设置 scoreDoc，后续 plan/runtime 使用 engine document
```

TS parser 同时产出 UI 的 legacy notes（含谱号推断 hand）和 engine events；`toLegacyScoreDocument` 是显示桥，不改变 engine 语义。**这是 Phase 2 的最大单点迁移。**

### 2.2 Plan 链

**默认 rts（生产默认）：**

```text
App.launchPractice
  → buildPlaybackPlan (TS planner)
  → buildReferencePlaybackPlan / buildEngineScoreEvents / scoreOccurrencesToEngineAtoms
  → session.begin → Node start → Rust NativeSession/HitMatcher/scoring_v1
```

**Rust opt-in（RHYTHM_PLANNER=rust）：**

```text
App.startRustPractice
  → projectScoreDocumentV1 (TS 投影)
  → WS plan-request
  → Node planner-service.createPlannerService
  → Rust build_plan_v1 + timeline/follow 深层校验 + plan_fingerprint_v1_gate
  → WS plan-response
  → App toPlaybackPlan / toEngineAtoms / toEngineScoreEvents (确定性解析/转换)
  → session.begin → Rust NativeSession/HitMatcher/scoring_v1
```

Rust path 的 plan provenance 已由服务端 plan context 绑定（`planRequestId`），不再信任客户端自报；默认 rts path 不经过 Rust planner。

### 2.3 Runtime / Matcher / Scoring 链

- **Timeline / 非 Free**：Node 收到 MIDI（Node MIDI adapter）→ `NativeTakeCoordinator.routePacket`（epoch 隔离）→ `NativeSession.pushHit` → Rust `HitMatcher`（onset 窗口）→ judgments → finish → Rust `scorePerformance`（`scoring_v1`）→ `analyzeTiming`、`trackKeyLifecycles`/`assessKeyPresses`、`NativeStudentModel`。
- **Follow**：plan groups → `App` 的 TS `FollowSession`（音高集合、当前目标、IOI/和弦间距、FollowReport）；**不调用 `session.begin`，没有 Rust runtime/matcher，没有 Take 落盘**。
- **Free Play**：`usePracticeSession.beginFreePlay` 本地记录事件；无 targets、无 SSession、无评分、无 Take。
- **Replay**：Node `trace-replay.mjs` 读取 trace → 重建 atoms/schedule → `NativeSession` 重放 → 与原始 report 比较；Rust 执行，Node 编排。

### 2.4 Node 中仍存在的业务计算

| 位置 | 计算 | 评价 / 迁移目标 |
|---|---|---|
| `server/planner-service.mjs` `assertTimelineUsable`、`assertFollowUsable`、`verifyTimelineSemantics`、`verifyFollowCrossReferences` | plan 语义/交叉引用/守卫 | **JS 业务校验**；建议 Phase 1/3 收敛到 Rust planner service（或 Rust 返回已校验结果） |
| `server/engine-server.mjs` `buildRetryComparison` | 两份 Take 的指标比较、差异/限制 | **Node 业务分析**；Phase 5 迁 Rust |
| `server/engine-server.mjs` `attachDurationMeasures` | 把 durations 关联到 target/measure | 结果拼装为主，Phase 5 评估是否并入 Rust DTO |
| `server/engine-server.mjs` `resolveModeScoringConfig`（`mode-config.mjs`） | mode/profile/feedback/duration 配置解析 | 业务配置解析；Phase 1/4 评估 Rust 化 |
| `server/engine-server.mjs` finish 组装 | 汇总 report/analysis/durations/scoreV1、takeSnapshot、captureDiagnostics | 主要是 envelope/持久化；不得修改 Rust 分数；Phase 5 收 thin |
| `server/engine-server.mjs` Take 写入/API/历史 | ID、原子写、旧 JSON、查询 | **允许的基础设施**；保留 |
| `server/trace-replay.mjs` | 调 Rust 重放、比较 | 编排层；保留 |

## 3. Timeline / Follow / Free Play 状态路径与落库

| 模式 | 运行时权威 | 结束路径 | 当前持久化 |
|---|---|---|---|
| Timeline（rts） | TS plan + Rust `NativeSession`/`HitMatcher`/`scoring_v1` | App finish → Node `finishSession` → Rust report/score/analysis → Take Finalizer | **`takes/<takeId>.json`（Phase A/B 已落地）**；旧 `sessions/*.json` 兼容 |
| Timeline（rust） | Rust plan + Rust runtime/scoring | 同上 | **`takes/<takeId>.json`**；plan context 绑定 provenance |
| Follow | plan（rts 或 rust）+ **TS `FollowSession`** | App `follow.finish()` → 页面内 `FollowReport` | **不落库**（无 session.begin；无 Take） |
| Free Play | 本地事件采集，无 targets/评分 | App/hook `finishFreePlay` | **不落库** |
| 历史/回放 | Node 读取 Take/legacy session；replay 调 Rust | REST/WS | Take + legacy 兼容；Follow/Free 缺记录 |

当前 Take 领域模型只覆盖 Timeline；阶段 C（新设计书）应把 Follow 的真实报告/证据接入同一 Finalizer，不伪装成 Timeline；Free Play 是否产生 Take 需要在 Phase 5 明确产品决策。

## 4. 冻结契约、黄金样例与变更门槛

| 资产 | 路径 | 当前处理 |
|---|---|---|
| ScoreDocumentV1 schema | `audit-r1/contracts/score-document-v1.schema.json` | **冻结**；Rust parser 必须符合，不夹带 schema 变更 |
| Plan fingerprint payload schema | `audit-r1/contracts/plan-fingerprint-payload-v1.schema.json` | **冻结** |
| 指纹固定向量 | `audit-r1/contracts/test-vectors/plan-fingerprint-v1.json` | **冻结**（V-single/V-rational-bpm 等） |
| Parity case index/fixtures/expected | `audit-r1/fixtures/parity-cases/index.json`、`expected/`、`rust-parity-input/` | **冻结**；fixture 字节变更需新 case + 评审 |
| Parity Gate 规范 | `audit-r1/docs/TS_RUST_PARITY_GATE_V1.md`（838cd9b） | **冻结** |
| Golden fixtures 规范 | `audit-r1/docs/GOLDEN_FIXTURES.md` | **冻结** |
| Hand/multipart 契约 | `audit-r1/docs/HAND_AND_MULTIPART_CONTRACT.md` | **冻结** |
| Clock 域契约 | `audit-r1/docs/CLOCK_DOMAIN_CONTRACT.md` | **冻结** |
| Scoring v1 / matcher / build_schedule | `rhythm-trainer-core-v0.2/crates/rhythm-core/src/{scoring_v1,matcher,schedule}.rs` | **行为基线**；迁移不得改语义 |
| EngineScoreEvent wire | `src/types/engine.ts`、`server/engine-server.mjs` start/scoreEvents 契约 | **冻结**；变更需独立提案 |
| TakeRecordV1 / takes/ | 新设计书 + 当前实现 | **未冻结**；可随阶段 C/D/E 演进，但需历史兼容 |
| Legacy sessions | `%APPDATA%/rhythm-trainer-frontend/sessions/*.json` | 只读兼容；不得为迁移一次性全量重写 |

任何 schema/wire/golden 变更必须单独提交变更理由、兼容性与审批；不得混入 parser/planner 迁移。

## 5. MusicXML 能力矩阵与 Rust parser 缺口

**Rust parser 当前不存在。** Rust `contract_v1` 只校验/规划已经生成的 ScoreDocumentV1；生产 MusicXML 解析完全在 TS `musicxml-importer.ts`。这是 Phase 2 的空白。

| 能力 | TS 当前行为 | strict 策略 | Rust parser 需要 |
|---|---|---|---|
| score-partwise | 支持 | — | 必须 |
| score-timewise / .mxl | 明确拒绝 | REJECTED | 明确拒绝，错误码对齐 |
| divisions / time / key | 支持 | 可用 | 必须逐字节/语义一致 |
| 谱号 G2 / F4 | 支持 | 可用 | 必须 |
| 其他谱号 | 检测为 `unsupported_clef` | 阻断 strict | 同码/同报告 |
| 单/多谱表、多 voice | 支持，多 voice/staff 记录能力 | 视范围/映射 | 必须 |
| 和弦（`<chord/>`） | 支持，同 onset 分组；无效锚点阻断 | 可用/阻断 | 必须 |
| 附点、tuplet/time-modification | 支持/记录 | 可用 | 必须 |
| tie（`<tie>` 音响 + `<tied>` 记谱） | 支持；orphan tie 阻断；tied-without-sound 警告 | 视情况 | 必须，且 tieSpan 语义一致 |
| 休止/backup/forward/cursor | 支持；非法 duration/cursor 阻断 | 视情况 | 必须 |
| pickup/implicit/underfull/overflow | 支持；underfull 警告、overflow 阻断 | 视情况 | 必须 |
| grace | 检测；不进 strict 目标 | 阻断 strict | 必须同能力/同 issue |
| cue | 检测；不进严格目标 | 阻断 strict | 必须 |
| microtone/unrepresentable pitch | 检测；MIDI 无表示 | 阻断 strict | 必须 |
| transpose（chromatic ≠ 0） | 检测为 unsupported_transpose | 阻断 strict | 必须 |
| repeat/ending/DC/DS/Coda/Fine | 检测为 unsupported_repeat_structure（不展开） | 阻断 strict | 必须 |
| tempo marks | 支持 metronome/sound tempo | 可用 | 必须 |
| tempo curve/文字速度 | 检测为 unsupported_tempo_curve | 阻断 strict | 必须 |
| 多 Part | 解析并标记 multiple_parts | 产品 UI 严格模式拒绝多 Part | 必须保留能力 + UI gate |
| duplicate note@id | 阻断 strict | 阻断 | 必须 |
| 文件指纹/scoreRevisionId/importReport | TS 生成 | 契约 | Rust 必须生成同形 report 或明确定义交接 |

现有 parser 测试/语料（迁移对照 oracle）：

- `src/score-engine/test/fixtures/`：`piano-two-staff-basic`、`c-major-practice`、`time-key-change`、`tie-across-measure`、`triad-chord`、`multi-voice-backup-forward`、`dotted-triplet`、`pickup-implicit`、`rests`、`single-melody-quarter-eighth`、`ledger-lines-demo`、`cross-system-layout`、`unsupported-repeat-tempo-curve`、`malformed`、`missing-divisions`、`duration-overflow`、`invalid-chord-anchor`；
- parity `audit-r1/fixtures/parity-cases/`（G1-base、A4-multivoice、A9-mixed-duration、G3-range、G6-A3 hand 变体、a3-gate-fixture）；
- 真实谱 `score-latest.musicxml`（gitignored）+ `RHYTHM_REAL_SCORE_PATH` 才运行的真实谱门禁；`audit-r1/fixtures/real-score` 无提交。

**Phase 2 的迁移门槛：** Rust parser 对固定语料生成与 TS oracle 一致的 ScoreDocument/ImportReport/能力/错误码；未支持特性 fail-closed；不修改 golden 来掩盖差异；不切换生产读取路径直到对照通过。复杂点（tie/tuplet/grace/chord/多 voice/clef 变更/underfull/duplicate id）逐项测试。

## 6. 分阶段文件范围、测试、风险、回滚

### Phase 1 — Rust API 与 DTO 定稿

- **范围：** `crates/rhythm-core/src/contract_v1/*`、`bindings/node/src/lib.rs`、`src/types/engine.ts`、`server/planner-service.mjs`、`server/plan-protocol` 测试。
- **交付：** parse/build_plan/create_runtime/command/push_midi/finish_take 的 DTO/错误码/版本；明确 Node 只映射不计算。
- **测试：** Rust contract/golden；TS contract-v1；N-API 边界；不改行为。
- **风险：** DTO 字段双解释；N-API 生命周期/序列化。**回滚：** DTO 只增不改，保留旧入口。

### Phase 2 — MusicXML parser 迁入 Rust

- **范围：** 新增 Rust parser 模块、NAPI export；Node import API；TS parser 降为测试 oracle；不改 schema/report 字段。
- **测试：** parser fixtures 对照、parity case 输入、malformed/unsupported、真实谱门禁；TS parser 仍可离线 oracle。
- **风险：** tie/tuplet/chord/多 voice/clef 语义静默差异；OSMD 显示与 SD 分离。**回滚：** 生产仍读 TS parser，仅切换到旧版本；不运行时回退。

### Phase 3 — Rust 唯一 Planner

- **范围：** `App.tsx` 删除 rts planner 生产分支；`playback-planner.ts`/`score-events.ts` 降 oracle；`planner-service` 校验收敛 Rust；Node 不再做 JS 语义验证。
- **测试：** 固定 SD+config → plan 字节/语义；parity A/B/C/V；原有 rts 行为差分；服务端 provenance。
- **风险：** 计划差异导致谱面/评分变化；旧 Take 兼容。**回滚：** 回退整个发布版本到 rts planner；不做单次练习内 fallback。

### Phase 4 — Runtime/Matcher/Scoring 全模式收敛 Rust

- **范围：** Follow 落到 Rust runtime/matcher；Free Play 采集/分析规则进 Rust（如产品要求）；`FollowSession.ts` 降 oracle；Timeline 保持既有 `NativeSession`/`scoring_v1`。
- **测试：** 固定计划+固定事件序列；pause/resume/finish 竞态；迟到/重复/epoch；Follow 目标推进与错音；Free Play 事件。
- **风险：** Follow 语义与 Timeline strict 混淆；时钟/暂停边界；客户端重连。**回滚：** 整版回退；旧 Follow 报告不可伪造。

### Phase 5 — Take Finalization/分析/Profile 收敛

- **范围：** Rust Take finalizer/analysis/profile 计算；Node 只分配 ID/存 envelope/API；Follow/Free 统一 Take；Profile 从 Takes 重建；`buildRetryComparison`/处方分析迁 Rust。
- **测试：** 一次完成一条 Take、重复完成幂等、断连/失败、旧历史兼容、Profile 重建、Follow 报告不伪装 Timeline、`/api/takes`/旧 `/api/sessions` 无重复。
- **风险：** 旧记录缺 provenance/报告；Profile 双重计数；Follow 证据不足。**回滚：** 保留旧 sessions 读取与旧发布版本；不删旧历史。

### Phase 6 — 前端瘦身

- **范围：** 清理生产 bundle 中 parser/planner/matcher/scoring/learner 计算；旧模块移测试 oracle；依赖扫描。
- **测试：** `tsc`、Vitest（oracle 仍跑）、production build dependency scan、UI 集成。
- **风险：** 未发现的 UI 依赖/隐式计算；显示回归。**回滚：** 整版回退；不恢复运行时双权威。

### Phase 7 — 端到端验收与切换

- **范围：** 真实 MusicXML + 真实 MIDI 键盘、延迟/断连/长曲/复杂谱；独立报告；生产默认切换单独审批。
- **测试：** 真实设备 note-on/off、时钟、暂停、断连、回放、历史、Profile 重建；记录精确 SHA/命令/环境/跳过项。
- **风险：** 模拟/真机证据混淆；无 CI；回滚路径未演练。**回滚：** 整版回退，含服务端/原生模块/前端；不保留部分旧算法在生产中并行。

## 7. 当前基线与未决问题

- 当前 `HEAD=dc18da6`，默认 `rts`，`origin/main=ba6d3c4`；Take 领域模型 Phase A/B Timeline 已落地，但其 Follow/Profile 部分仍未完成。
- Rust 已在生产负责 Timeline 评分/匹配；迁移不是“把评分搬到 Rust”，而是补齐 **parser、planner、Follow runtime、analysis/prescription、Profile 计算** 的权威归属，并清理 Node/TS 的业务副本。
- 需要在 Phase 1 前确认的决策：
  1. Rust parser 的导入报告/错误码/能力清单是否与 TS 完全同形，还是新版本化 DTO？
  2. Follow 的 Rust runtime 与 Timeline 的 `NativeSession` 哪些状态可共享，哪些必须分开？
  3. Free Play 是否产生 Take；若产生，采用何种 assessment（不伪造 strict 分数）。
  4. Node 的 plan 语义校验/retry comparison/mode config 哪些移 Rust、哪些保留为纯格式适配？
  5. Profile 重建的纳入策略（interrupted/degraded/low-confidence）与版本 watermark。
  6. 旧 `sessions/*.json` 的读取/回放/复练引用在 Phase 5 前的兼容期限。

## 8. Phase 0 验收

- [x] 前端 TS 业务计算函数及生产调用方已列出。
- [x] TS parser/planner、Rust planner、Matcher、`scoring_v1` 的生产/测试关系已列出。
- [x] Timeline/Follow/Free Play 状态与当前落库路径已列出。
- [x] 冻结契约/黄金样例位置与变更门槛已列出。
- [x] MusicXML 能力矩阵与 Rust parser 空白已列出。
- [x] 每阶段文件范围、测试、风险、回滚方式已列出。

**门槛：** 本报告需先评审；评审通过后才进入 Phase 1。本轮没有修改生产代码、默认值、冻结契约或测试 oracle。
