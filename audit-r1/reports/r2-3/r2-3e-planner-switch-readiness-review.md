# R2-3e — Rust Planner 生产切换独立评审（Switch Readiness Review）

**审查类型：** 只读上线准备审查（review only; no runtime/config/code change）
**审查执行：** ZCode（只读静态审查 + 证据引用）
**基线分支 / HEAD：** `r2-3-rust-planner` @ `50ae5f56c3c52a15105f111613602e4eba8194e5`（`50ae5f5`，本地 == origin，已核验）
**R2-3d 被测源码 SHA：** `d687a9edfd0b3e23fd2e0476923e12568e6ef70c`；**R2-3d 证据提交：** `50ae5f5`
**冻结 Gate blob：** `29d7e6ea7f858d76adc7f21a223cd791dc2b3d74`（`git hash-object` 核验一致）
**工作树状态：** 审查开始时存在两份归档报告的工作树漂移（R2-3d 阶段全量 vitest 重写 `generatedAt`/`gitSha` 的副作用），已 `git checkout --` 恢复为已提交的固定 SHA 版本（恢复≠修改历史；HEAD 未动）；此后全程只读。历史遗留 untracked `audit-r1/spike/sync-r20-report.mjs` 保持原样。
**独立验证边界：** Rust 173/0、Vitest 436/4、selftest 251/251 为提交者报告；本轮未运行测试，GitHub `50ae5f5` 无 CI runs/status checks——这些数字**不是** GitHub 独立验证结果。本轮结论全部来自远端可见源码与归档证据的静态审查。

---

## 1. 执行摘要与最终建议

**最终建议：`BLOCKED`（当前不可安全开展 Rust planner 切换；需先行完成 §6 列出的实现缺口并另立任务卡）。**

决定性理由（详见 §3/§6）：
1. `RHYTHM_PLANNER` 运行时开关在生产代码中**完全未实现**（全仓生产源码零读取点，仅存在于文档）；
2. 生产 planner 的消费方在**浏览器客户端**（`App.tsx` 打包进前端 bundle），而 Rust planner 目前只有 **Node NAPI 通道**——"切换 Rust 权威"不是设置一个环境变量，而是一次**执行架构决策**（planner 下沉服务端 / WASM 通道 / 其他），必须先有设计任务卡；
3. `plannerVersion` 与 plan 指纹未进入生产上传与持久化路径，切换后无法区分/复现一次运行使用的 planner（Gate §8.7 的 Trace/plan snapshot 复现要求无承载）。

同时明确：**R2-3d 七项证据（E1–E7 全 PASS）所证明的是 TS↔Rust 语义等价与指纹逐字节一致**——这部分证据是 GO 方向的（切换的最大风险"planner 语义漂移"已被冻结用例、真实谱与逐字段差分排除）；`BLOCKED` 针对的是**接入与运行架构缺口**，不是语义正确性。

**本报告不是生产切换批准。** 任何实际切换、灰度试用、启用 `RHYTHM_PLANNER=rust` 或合并 `main` 均须用户另行明确授权。

---

## 2. `RHYTHM_PLANNER` 运行时开关现状

**结论：`NOT IMPLEMENTED`。**

| 检查 | 结果 | 证据 |
|---|---|---|
| 生产源码读取点 | **零**：全仓 `grep -rn "RHYTHM_PLANNER"` 在 `*.ts/*.tsx/*.mjs/*.rs` 生产代码中无任何命中 | 命中仅 7 处，全部为文档/报告：`TS_RUST_PARITY_GATE_V1.md:292`、`R2_R3_ROUTE_DECISION.md:288,300`、`R2_3_RUST_PLANNER_TASK_CARD.md:238`、`R2_2_…REPORT.md:177`、`r2-3d-summary.md:5` |
| 默认值 | 不存在（无开关即无默认值分支）；现状 = TS 为唯一生产权威（见 §3） | `App.tsx:1066/1067`（唯一生产 planner 调用点，直接调 TS `buildPlaybackPlan`，无任何条件分支） |
| 合法值定义 | 文档定义 `rts\|rust`（`R2_R3_ROUTE_DECISION.md:288`）；未知值行为**未定义**（无实现即无处理逻辑） | 同上 |
| 分阶段设计依据 | R2-3 任务卡 §5.4 明确"`RHYTHM_PLANNER` 开关不实现于本卡"；Gate §8.7 将其列为切换后才存在物的运行时开关 | 见左 |

**审计含义**：不存在"误启 Rust"或"静默选 Rust"的风险面——当前**不可能**通过任何配置让生产走 Rust planner。这也意味着切换前置工作（开关实现、默认值、未知值 fail-closed 行为）必须由**新任务卡**交付，本评审不实现。

---

## 3. 生产权威唯一性与失败路径（静态追踪）

### 3.1 当前生产调用链（100% TS）

客户端（浏览器，打包自 `rhythm-trainer-frontend/src`）：

| 步骤 | 位置 | 内容 |
|---|---|---|
| P1 | `App.tsx:1066-1073` | 严格模式 `buildPlaybackPlan(scoreDoc.engine, {range, repeatSelection:{kind:'none'}, unsupportedNotationPolicy:'reject-strict'})` |
| P2 | `App.tsx:1074-1080` | **strict-blocked 拒绝**：`!semantics.plan \|\| !semantics.strictAllowed` → 阻断开始（用户可见警告），无降级 |
| P3 | `App.tsx:1091-1100` | `buildReferencePlaybackPlan`（hand 过滤 + 参考播放；`!reference.plan \|\| !scopedPlan \|\| !strictAllowed` → 拒绝）；`playbackPlanId = reference.plan.planId` |
| P4 | `App.tsx:1100` | `buildEngineScoreEvents(scopedPlan, tempo, countInBeats)` → **EngineScoreEvent wire（ms 域）**（`score-events.ts:11-41`，7 字段：scoreEventId/measure/beatPosition/pitch/targetOnsetMs/targetDurationMs/partId/parseConfidence；`score-events.ts:28-37`） |
| P5 | `App.tsx:1163-1165` | 上传 `scoreFingerprint`（=`scoreDoc.engine.fingerprint`）与 `playbackPlanId`；**不含 plannerVersion、不含 planFingerprint** |
| P6 | `App.tsx:1104` / `:1111-1117` | `scoreOccurrencesToEngineAtoms` 产 atoms（tick 网格不可无损 → blocking issue 拒绝）；客户端二次指纹校验 `App.tsx:1185` |

服务端（`engine-server.mjs`，Node）：

| 步骤 | 位置 | 内容 |
|---|---|---|
| S1 | `engine-server.mjs:89-98` | 加载 **Rust addon**（`RHYTHM_CORE_ADDON_DIR` 或默认 bindings/node；加载失败 → 打印错误并 `process.exit(1)`，**无静默降级**）——但该 addon 在服务端仅用于**既有原语**（`:1496 addon.buildSchedule`、matcher、scoring），**不涉及 planner** |
| S2 | `engine-server.mjs:1340-1354` | 接收 `msg.scoreFingerprint`/`playbackPlanId`/`scoreEvents`；playbackPlanId 提供则必须配 scoreEvents（拒绝"声称语义计划却降级为仅节拍"） |
| S3 | `engine-server.mjs:1369-1370,1395-1396` | takeTemplate/source 记录的 `scoreFingerprint` 一致性匹配（不一致拒绝） |
| S4 | `engine-server.mjs:1442-1480` | **候选输出校验**（中文消息锚点 = Gate §6 C 类映射表四码）：结构/合法目标（:1455-1461）、`scoreEvents 目标 ID 重复`（:1465-1467）、正时值（:1471）、处方范围（:1477-1480） |
| S5 | `engine-server.mjs:1496` | `addon.buildSchedule(pattern, bpm, countInMs, profile)`——**输入 atoms 来自客户端**（P6），Rust build_schedule 只做 atoms→targets 调度（C-2 边界：planner 不进 build_schedule） |

### 3.2 Rust planner 的生产可达性

**零可达。** Rust planner 的全部入口（`buildPlanV1`/`buildParityCandidateV1`/`planFingerprintV1Gate`/`computePlanFingerprintV1Json`/`canonicalBytesJson`/`validateCandidateScoreEventsJson`，`bindings/node/src/lib.rs` R2-3c/d 追加段）当前**仅被测试与证据 harness 调用**（`rust-parity.test.ts`、`r2-3d-evidence.test.ts`）。生产链 P1–P6、S1–S5 没有任何一行调用它们。因此：
- **不存在**静默 fallback、按得分挑侧、双侧混合产 targets、或未记录回退 TS 的路径——因为**只存在一条路径**（TS）；
- **不存在**绕过冻结 fingerprint gate / candidate validation 的 **Rust** 路径；但注意 §5 GAP-4：TS 生产路径本身也不运行指纹门禁（见下）。

### 3.3 失败路径行为（当前实现）

| 场景 | 行为 | 证据 |
|---|---|---|
| Rust addon 加载失败（服务端） | `process.exit(1)`，服务拒绝启动——fail-closed，无降级 | `engine-server.mjs:93-97` |
| planner 抛错（TS，客户端） | 捕获 → 用户警告 → 会话不开始（fail-closed） | `App.tsx:1074-1080,1105-1109,1121-1126` |
| scoreEvents 非法/重复/越界/时值非正（服务端） | 抛错拒绝（四码锚点消息） | `engine-server.mjs:1455-1480` |
| scoreFingerprint 不匹配（take/source） | 拒绝 | `engine-server.mjs:245,1369-1370,1395-1396` |
| Rust plan fingerprint gate 失败 | **生产不可达**（Rust planner 未接入）；gate 本身已由 E4-C/V 等证据验证为 fail-closed（`PAYLOAD_VALIDATION_FAILED` 等） | R2-3d 证据 `e4.classC/classV` |

---

## 4. 数据与 wire 兼容

| 检查 | 结论 | 证据 |
|---|---|---|
| EngineScoreEvent wire | wire 由 TS `buildEngineScoreEvents` 生成（`score-events.ts:28-37`），7 字段 ms 结构；R2-3c/d 的 canonical candidate（µs 域）**不进 wire**。切换若把 scoreEvents 源换为 Rust plan 的 scoreEvents（整数 µs→ms 的换算策略）**未定义** → 记 GAP | GAP-5（§6） |
| scoring_v1 / matcher / build_schedule 被绕过？ | **否**。三者消费 atoms/targets（P6/S5），与 planner 选择解耦（C-2）；静态追踪无 planner→scoring 直连 | `engine-server.mjs:1496`；任务卡 C-2 |
| 旧 Take/历史报告重算？ | **不会**。take/score 记录一次性写入（`DATA_DIR` 下 atomic tmp+rename，`engine-server.mjs:100-107`）；无任何按新 planner 重算旧记录的代码路径；`engine-server.mjs:245` 仅做重试同谱指纹匹配（读比较，不写） | `engine-server.mjs:100-107,245` |
| 新记录写 plannerVersion/planFingerprint | **未实现**：`session.begin` 上传字段（`App.tsx:1152-1170`）与 server 校验/持久化（:1340-1400）均无 plannerVersion；planFingerprint 完全不在生产链上 | GAP-3（§6） |
| 未知 schema 版本 / 指纹不匹配 / 无效 hand mapping / strict-blocked 拒绝 | 双侧实现均有且行为一致（Rust：`unknown_schema_version` 早退、`PLAN_DOCUMENT_MISMATCH`/`DOCUMENT_REPORT_MISMATCH`、`HAND_MAPPING_*` config 码、blocked plan 上传即被服务端候选校验+客户端 P2 拒绝；TS：同语义）——由 R2-3a/b/c/d 证据与 E4-C 覆盖 | R2-3d 报告 `e4.classC`（7 例全过） |

---

## 5. 切换风险、观察与回滚方案（方案，不执行）

### 5.1 若未来实现开关，回滚步骤应为（设计要求，供新任务卡采纳）

1. 关闭开关（`RHYTHM_PLANNER` 移除或设回 `rts`）→ 重启服务进程（开关必须在 start 时读取并打印生效值到日志，`engine-server.mjs` 现有 addon 加载日志模式可复用）；
2. 确认回到 TS 权威：启动日志打印 `planner=rts` + 后续每条 scoreEvents 的 `playbackPlanId` 前缀回到 TS planId 格式；
3. **保留故障证据**：故障期间的 Trace/plan snapshot/版本字段必须已随 Take 持久化（依赖 GAP-3 先行实现——否则回滚后无法复现）；
4. 回滚**不得**重写历史 Take/评分（现状架构天然满足：记录一次性写入，无重算路径）。

### 5.2 触发立即回滚的条件（建议冻结进开关任务卡）

- 任何 `PAYLOAD_VALIDATION_FAILED` / `PLAN_DOCUMENT_MISMATCH` / `DOCUMENT_REPORT_MISMATCH` 出现在生产 plan 生成路径；
- scoreEvents 与 atoms 数量/覆盖不一致（服务端 `:1531-1533` 的同名断言在 Rust 侧输出上必须同强度执行）；
- 真实谱冒烟（切换后首跑 113/1579/1018 计数）不命中；
- 同输入双跑指纹不一致。

### 5.3 有限试用期的持续观察信号

- 每 Take 的 plannerVersion/planFingerprint 记录率 = 100%（GAP-3 实现后）；
- 服务端四码校验拒绝率突增；
- 客户端 strict-blocked 拒绝率 vs 切换前基线；
- 参考播放与目标命中的时序投诉（ms↔µs 换算边界）。

### 5.4 需另行授权的验证动作

- 启用 `RHYTHM_PLANNER=rust` 的任何生产/半生产实例；
- 真实用户 Take 的双权威影子比对；
- 上述全部属于切换评审**之后**的灰度方案，本报告仅立项不执行。

---

## 6. Go / No-Go / Blocked 清单

### ① 已由已审计证据证明（GO 方向）

| 项 | 证据 |
|---|---|
| TS↔Rust planner 语义等价（15 冻结 case 双管线零 diff + expectedOutcome 双侧满足） | R2-3d 报告 `e2.cases[]`（E2 PASS） |
| G1–G5 手工真值逐字段 exact（913 项） | `e1`（E1 PASS，913/913） |
| 6 固定向量 Rust 独立 byte-exact | `e3`/`e4.classV`（E3 PASS） |
| A/B/C/V 四类验收全部实际执行并通过（C 7 例、B 6 故障、V 6 向量） | `e4.classA/classB/classC/classV`（E4 PASS，判定=A∧B∧C∧V 计算值） |
| 真实谱等价（113/1579/1018/1018/1579 + 五枚举 + 指纹稳定 + 双侧相等 + L2 零 diff + L3 全绿） | `e5`（E5 PASS，含 fixture sha256 与不可独立复跑声明） |
| 证据包完整性/可追溯（verifiedCodeSha=d687a9e、先写盘后断言、diffs 全文） | `e6/e7`（E6/E7 PASS → READY_FOR_SEPARATE_SWITCH_REVIEW） |

### ② 由本轮静态代码检查确认（非测试声明）

| 项 | 结论 | 证据 |
|---|---|---|
| `RHYTHM_PLANNER` 开关 | **NOT IMPLEMENTED** | §2（全仓 grep 零生产命中） |
| 生产权威当前唯一 = TS；Rust planner 生产零调用 | 确认 | §3.1/3.2（App.tsx:1066-1100；bindings 导出仅测试消费） |
| 无 fallback/混选/绕过路径 | 确认（单路径架构下不成立） | §3.2 |
| 服务端 addon 加载 fail-closed（exit 1） | 确认 | `engine-server.mjs:93-97` |
| wire/历史数据/冻结引擎不被切换间接改写 | wire 结构由 TS 唯一生成器决定（现状）；历史记录无重算路径 | §4 |
| 指纹门禁不在 TS 生产链上运行 | 确认（P1–P6 无 planFingerprintV1 调用） | GAP-4 |

### ③ 仅由提交者本地声明支持（未独立重跑）

- Rust 173/0、Vitest 436/4、selftest 251/251 及各历史日志（日志按 `*.log` 约定不入库）。

### ④ 必须另行批准后试运行验证

- 开关行为、真实谱冒烟、双权威影子比对、回滚演练（§5 全部为方案）。

### ⑤ 当前阻断项（切换前置缺口——只列缺口，不在本任务修复）

| # | 缺口 | 所需新任务卡方向 |
|---|---|---|
| GAP-1 | `RHYTHM_PLANNER` 运行时开关不存在（读取点/默认值/`rts\|rust` 合法值/未知值 fail-closed 行为） | 开关实现任务卡（含启动日志打印生效值） |
| GAP-2 | **执行架构决策缺失**：生产 planner 消费方在浏览器（`App.tsx`，前端 bundle），Rust planner 仅有 Node NAPI 通道——浏览器无法加载 `.node`。需决策：planner 下沉服务端（server 以 NAPI 产 plan/scoreEvents 下发客户端）或引入 WASM 通道，或混合方案；这决定 scoreEvents 的生成位置与信任边界 | 架构决策 + 接入任务卡 |
| GAP-3 | `plannerVersion`/plan 指纹未进入 session 上传与持久化——无法满足 Gate §8.7 "Trace/plan snapshot 复现与区分所用 planner" | 可追溯性字段任务卡 |
| GAP-4 | TS 生产路径不运行冻结指纹门禁（现状，非切换引入）；Rust 侧 gate 已 fail-closed。切换评审需明确"门禁在哪一层强制"的对称策略 | 并入 GAP-2 架构任务卡 |
| GAP-5 | Rust plan 的 scoreEvents（整数 µs）到 EngineScoreEvent wire（float ms）的换算策略未定义（rounding 归因必须逐项可审计，Gate §3.5 legacy 轨道语义） | 并入 GAP-2 架构任务卡 |

---

## 7. 结论

1. **语义等价**：已由 R2-3d 七证据包证明（E1–E7 全 PASS，独立真值 + 逐字段 + 真实谱 + 四类验收）。
2. **切换条件**：**不具备**。`RHYTHM_PLANNER` 未实现（GAP-1）、planner 消费方在浏览器而 Rust 只有 Node 通道（GAP-2，架构决策缺失）、可追溯性字段缺失（GAP-3）——三者任一都足以阻断；合计判定 **`BLOCKED`**。
3. **本报告不是切换批准**，不构成启用 `RHYTHM_PLANNER=rust` 的授权，不授权灰度试用，不授权合并 `main`。
4. 后续路径建议：GAP-2 架构决策（用户）→ GAP-1/3/5 实现任务卡（复审后）→ 独立切换评审（引用本报告 + 新证据）→ 用户单独授权切换/灰度。
