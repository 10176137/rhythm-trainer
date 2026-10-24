# R2-3 工程任务卡（v3——按二轮复审意见修订，提交于 `r2-3-rust-planner` 分支）

**状态：** v3 SUBMITTED；**批准范围 = 仅 R2-3a1**（Rust NFC/JCS/SHA-256 + 六固定向量 byte-exact 复现）。R2-3a2/a3 未放行——各有前置阻断项（见 §4）。
**基线：** `main` @ `ba6d3c4`；本分支自该点创建。
**上位约束：** R2-1 `TS_RUST_PARITY_GATE_V1.md`（Frozen @ 838cd9b）、R2-2 关闭报告 §11、路线决策 §5.1。
**工作方式：** 全程在本分支提交；**不推送、不合入 main**，直至用户按阶段审查批准。

**v3 变更摘要**（相对 v2/ecf0b06，全部来自二轮复审意见）：
1. **§3.2 时间公式修正**：v2 遗漏了 `bpm.denominator`（关键数学错误 C-8）——正确公式为 `N = beat.num × 60_000_000 × bpm.den`；以 175/2 BPM 为例 v2 公式会得到 342,857 而非 685,714（差一倍）。**time.rs 的实现被阻断至 a2 修复完成**。
2. **§3 溢出策略重写**：v2 的 i128 上界证明不成立（补上 bpm.den 后分子为三因子积，上界 ≈2^132 > i128 的 2^127；C-9）——改为 **`num-bigint` 任意精度中间值 + 结果 checked 到 safe-integer** 的方案。
3. **§1 sha2 版本更正**：v2 写"2.x"错误（C-10）——经 crates.io API 核验（2026-10-25，走代理）**`sha2 0.11.1`** 为最新稳定版；全部依赖列真实版本并锁定 Cargo.lock。
4. **§2.2/§2.3 `scoreFingerprint` 接口明确化**（C-11）：`PlannerOutput` 顶层新增 `scoreFingerprint` 字段，由 `build_plan_v1` 从输入 document 的 fingerprint 字段携带；门禁 `plan_fingerprint_v1_gate` 接收的 plan 即该 PlannerOutput，检查 `plan.scoreFingerprint == report.fingerprint`。
5. **§4 阶段状态**更新：a1 有条件批准（本卡即其边界）；a2 前置阻断 = 修正后的时间公式 + num-bigint 溢出策略 + config 输入边界；a3 前置阻断 = scoreFingerprint 接口（已在 v3 完成）+ a2 通过。

---

## 0. 调查结论（以实际代码为据）

### 0.1 Git 状态——两个时点分别记录

**调查时快照（任务卡 v1 产出时）**：分支 `main`，HEAD = `ba6d3c4`（R2-2 关闭落档提交）。工作区无已提交修改；untracked 文件两枚：`R2_3_RUST_PLANNER_TASK_CARD.md`（当时尚未提交的任务卡草案）与 `audit-r1/spike/sync-r20-report.mjs`（R2-0 时期历史遗留脚本，非本卡范围）。"工作区干净"的准确表述：**无 staged/modified 的已跟踪文件；存在上述两枚 untracked 文件**。

**本卡提交时状态（v3 提交时）**：分支 `r2-3-rust-planner`（自 `main@ba6d3c4` 创建），提交链 `ad3f60c`(v1) → `ecf0b06`(v2) → 本 v3。untracked 仍剩 `audit-r1/spike/sync-r20-report.mjs`（保持不动）。**按二轮复审指令：本阶段只提交、不推送**（分支曾在 v2 时经用户指令推送过一次至 `ecf0b06`，远端当前可见到 v2；v3 待用户指示后再推）。

远端：`origin/main == ba6d3c4`（ls-remote 多次核验）；`origin/r2-3-rust-planner == ecf0b06`（v2 时点推送，用户已在 GitHub 完成 v2 审查）。

### 0.2 Rust workspace 真实结构（已核实）

```
rhythm-trainer-core-v0.2/
  Cargo.toml                  # workspace: members=[crates/rhythm-core]，exclude=[bindings/node]
  crates/rhythm-core/         # 核心 lib（version 0.5.0，**声明零运行时依赖**）
    src/
      lib.rs (48)             # 模块导出
      duration.rs (661)       # MIDI 音符时值评估——非有理数算术
      matcher.rs (244)        # HitMatcher（实时判定）
      schedule.rs (266)       # build_schedule(pattern,bpm f64,start_at_ms f64,profile)→Vec<TargetHit>
      scoring_v1.rs (969)     # 最终评分（R5 范围，不动）
      take.rs (1151) session.rs (320) midi.rs (921) teaching.rs (866) stats.rs (85) …
    tests/                    # 集成测试：end_to_end / property_tests / scoring_v1_acceptance / benchmark
  bindings/node/              # NAPI crate（rhythm-trainer-native 0.5.0，napi2/napi-derive2）
    src/lib.rs                # 57 个 #[napi] 导出；DTO 数值全 f64
    package.json              # scripts.build = "napi build --platform --release --js false"（@napi-rs/cli 2.18.4）
    rhythm_trainer_native.win32-x64-gnu.node   # 现役产物（frontend 经 @rhythm-trainer/native 包加载）
  rust-toolchain.toml         # 工具链锁定
```

- **依赖现状**：`crates/rhythm-core/Cargo.toml` 的 `[dependencies]` 为**空**（"no runtime dependencies"）。本卡新增依赖见 §1（待 a1 批准即生效）。
- **数值现状**：全链 `f64`。整数 µs、有理数、roundHalfUp 在 Rust 侧**零基础**。
- **测试现状**：workspace 内 92 个 `#[test]` + 4 个集成测试文件；`cargo test --target x86_64-pc-windows-gnu` 当前 110 个测试通过（w64devkit GNU 工具链）。

### 0.3 TS 侧资产位置与调用关系（已核实，R2-2 产物）

```
rhythm-trainer-frontend/src/score-engine/
  contract-v1/plan-fingerprint.ts        # TS 权威参考：projectScoreDocumentV1(:172) / validateScoreDocumentV1 /
                                         #   validatePlanFingerprintPayloadV1 / buildPlanFingerprintPayloadV1 /
                                         #   computePlanFingerprintV1 / planFingerprintV1(强制门禁 :1171) /
                                         #   beatToMicroseconds(:1229 — N 含 ×bpm.denominator，Rust 必须同式)
  contract-v1/contract-v1.test.ts        # 契约测试 + 6 固定向量断言
  playback/playback-planner.ts           # buildPlaybackPlan / scoreOccurrencesToEngineAtoms（迁移语义源）
  playback/reference-playback-plan.ts    # filterPlaybackPlanByHand（:103）
  playback/score-events.ts               # buildEngineScoreEvents（wire，不动）
  scope/practice-scope.ts                # assessPracticeScope / HandMappingV1
  parity/
    parity-diff.ts                       # diffCandidates(expected, candidate)——Rust 候选接入点（形状=ParityCandidate）
    parity-candidate.ts                  # buildTsCandidate / computeL3Invariants / fingerprintStable
    parity-runner.ts                     # full/case/fault 模式；FAULT_SPECS 六项注入；ParityDiffReportV1
    normative-codes.ts                   # C 类规范码 + 服务端消息锚点映射
    case-bundle.ts                       # 15 冻结 case 加载 + golden→expected 转换器
    acceptance-{a,b,c,v}.test.ts         # 四类验收（V 类: RUST_V_CLASS_STATUS='DEFERRED_TO_R2-3'，R2-3d 翻转）
    real-score-parity.test.ts            # 113 小节结构不变量（RHYTHM_REAL_SCORE_PATH 门禁）
audit-r1/contracts/test-vectors/plan-fingerprint-v1.json   # 6 向量（5 冻结 + V-rational-bpm）
audit-r1/contracts/score-document-v1.schema.json           # ScoreDocumentV1 契约 Schema
audit-r1/contracts/plan-fingerprint-payload-v1.schema.json # payload 契约 Schema
audit-r1/contracts/parity-case-bundle-v1.schema.json       # case bundle（含 planner config 形状）
```

### 0.4 Rust 已实现 / 尚缺（代码为据）

| 能力 | 状态 | 依据 |
|---|---|---|
| atoms→targets 调度（buildSchedule） | ✅ 已实现（f64 ms 域） | schedule.rs:71；保持不动，planner 走新入口 |
| 实时判定/最终评分/teaching | ✅ 已实现 | matcher/scoring_v1/teaching（本卡不动） |
| NAPI 绑定骨架与 GNU 产物链 | ✅ 已实现 | bindings/node（57 导出） |
| 有理数类型与精确算术 | ❌ 缺 | 无任何 Rational 类型 |
| 整数 µs / roundHalfUp | ❌ 缺 | 全链 f64 |
| ScoreDocumentV1 投影+闭合校验 | ❌ 缺 | 无对应模块 |
| planner 语义（range/hand/tie/chord/loop/排序） | ❌ 缺 | 无对应模块 |
| NFC / JCS / SHA-256 | ❌ 缺 | 零依赖（a1 交付） |
| planFingerprintV1 端到端 | ❌ 缺 | — |
| parity 候选 JSON 输出 | ❌ 缺 | — |

**文档-实现冲突检查**：`CORE_API.md`/`IMPLEMENTATION_STATUS.md`/`README.md` 无 planner/指纹能力声明——无冲突。边界记录：现有 `build_schedule` 为 f64 ms 域且在生产使用——planner 不改造它、走独立入口；pattern id 的 `Date.now()`（D11）属切换后事项。

---

## 1. 依赖清单（版本经 crates.io API 核验 @ 2026-10-25，走代理；全部 lock 进 Cargo.lock）

| crate | 核验版本 | 用于 | 阶段 |
|---|---|---|---|
| `unicode-normalization` | **0.1.26** | NFC（`.nfc()`）——手写不可行（归一化表巨大） | **a1** |
| `sha2` | **0.11.1**（v2 误写"2.x"，已更正；crates.io max_stable 实测） | SHA-256（RustCrypto 标准实现，手写属不必要的密码学风险） | **a1** |
| `serde` | **1.0.229**（features = ["derive"]） | 契约结构体反序列化/序列化 | **a1**（payload 结构） |
| `serde_json` | **1.0.154** | 契约 JSON ↔ 结构体 | **a1**（payload 解析） |
| `num-bigint` | **0.5.1** | 任意精度中间值（§3 溢出策略；v2 的 i128 证明不成立后的替代） | **a2**（time.rs 解禁时引入；a1 不需要） |

要点：
- **冻结契约不变**：依赖只影响实现方式，不触碰已提交 Schema/向量/规则。
- 版本精确写入 `Cargo.toml` 并由 Cargo.lock 锁定；README/CORE_API 的"no runtime dependencies"声明在依赖首次合入时如实更新。
- a1 实际引入子集：`unicode-normalization` + `sha2` + `serde`/derive + `serde_json`（payload 结构需要）；`num-bigint` 属 a2。

## 2. 数据边界与契约定义

**总原则（保持路线 A）**：TS importer 保留为 ScoreDocumentV1 的生产者（差分期）；Rust 只消费**已提交契约 Schema 定义的 JSON 实例**，并产出**本卡定义的 PlannerOutput JSON**。两侧传递的每一个 JSON 对象，要么符合已提交 Schema，要么符合本节定义并随本卡冻结——**不引入任何对 TS 内部类型的随手套序列化协议**。R3 后 Rust importer 直接生产同一 ScoreDocumentV1，TS 退出生产路径、保留为差分 legacyReference——契约不变。

### 2.1 五类对象的输入/输出契约

| 对象 | 冻结定义处 | Rust 输入形态 | Rust 输出 |
|---|---|---|---|
| **ScoreDocumentV1** | `audit-r1/contracts/score-document-v1.schema.json`（已提交） | JSON 实例文本（harness 由 TS `projectScoreDocumentV1` 产出 dto 并经 Schema 校验后传入） | 投影级校验结果 + 规范化强类型值 |
| **ImportReportV1** | **本卡新增冻结**：`audit-r1/contracts/import-report-v1.schema.json`（补 R2-0 遗留；最小字段集 `schemaVersion/parserVersion/supportProfileVersion/fingerprint/status/strictAllowed/capabilities`，`additionalProperties:false`） | JSON 实例文本（与 document 配对产出） | 配对/能力校验结果 |
| **planner config** | `audit-r1/contracts/parity-case-bundle-v1.schema.json` 的 `config` 对象（已提交） | JSON 实例文本 | 强类型 `PlanRequestConfig` |
| **plan（输出）** | **本卡定义 `PlannerOutput`**（§2.3） | —（Rust 内部构造） | ① 候选 JSON（喂 `ParityCandidate`）；② 门禁的 plan 输入（含 `scoreFingerprint`） |
| **指纹 payload** | `audit-r1/contracts/plan-fingerprint-payload-v1.schema.json`（已提交） | Rust 内部构造 | canonical bytes + `plan-v1:sha256:…` 指纹 |

### 2.2 `project`/`validate`/门禁的责任边界与接口

- **`project_score_document_v1(document_json, report_json) -> Result<ProjectedDocument, ContractError>`**
  = TS `projectScoreDocumentV1`（:172）同款 fail-closed 层：反序列化 → 投影级不变量（`DUPLICATE_EVENT_ID`/`DUPLICATE_PART_ID`/`DUPLICATE_XML_ID`、`UNKNOWN_CAPABILITY`、`DOCUMENT_REPORT_MISMATCH`、`INVALID_SOURCE_FINGERPRINT`）→ 规范化强类型 DTO。不做完整语义校验。
- **`validate_score_document_v1(dto) -> Vec<Issue>`** = TS `validateScoreDocumentV1` 完整闭合清单（closed keys、约分有理数、ordinal 连续、tieSpan 双向、`scoreRevisionId` 公式、locator 唯一、时值规则等），每条独立负例。
- **门禁 `plan_fingerprint_v1_gate(document_json, report_json, plan_json, config_json) -> Result<String, ContractError>`**
  复刻 TS `planFingerprintV1`（:1171）无旁路：投影 → 全量校验（→`DOCUMENT_VALIDATION_FAILED`）→ **`plan.scoreFingerprint == report.fingerprint`**（否则 `PLAN_DOCUMENT_MISMATCH`）→ payload 构造（取已校验 DTO 自己的 scoreRevisionId/normalizerVersion/supportProfileVersion）→ payload 全量校验 → 哈希。
  **plan_json 的形状 = §2.3 的 `PlannerOutput`**（含顶层 `scoreFingerprint`）——公开输出与门禁输入是同一结构，不存在"内部 Plan 另有一套"的第二协议。

### 2.3 `PlannerOutput`（Rust 输出契约；v3 增补 `scoreFingerprint`，审修 4）

```jsonc
{
  "scoreFingerprint": "ba6d3c4…64hex",     // ★ v3 新增：build_plan_v1 从输入 document.fingerprint 携带；
                                            //   门禁用它与 report.fingerprint 比对（PLAN_DOCUMENT_MISMATCH）
  "occurrences": [ { "locator": {…}, "passIndex": 0, "playbackBeat": "0/1", "durationBeat": "1/1",
                     "measureOrdinal": 1, "bar": 1, "beatInMeasure": "0/1", "staffNumber": 1, "voiceId": "1",
                     "pitch": {…}|null, "isTieOnset": false, "playbackIndex": 0 } ],
  "groups": [ /* passIndex/playbackBeat/members/pitches/bar/beatInMeasure/staffNumbers/voiceIds/durationBeat */ ],
  "atoms": [ { "startTick": 0, "durationTicks": 960, "bar": 1, "beat": 1.0 } ],
  "scoreEvents": [ { "locator": {…}, "passIndex": 0, "measure": 1, "pitch": 60,
                     "targetOnsetUs": 3000000,      // ★ Rust 自算：CountInUs + beat_to_microseconds(playbackBeat, bpm)
                     "targetDurationUs": 750000,    // ★ Rust 自算：beat_to_microseconds(durationBeat, bpm)
                     "partId": "staff-1:voice-1", "parseConfidence": 1, "runtimeOccurrenceId": "plan:…:p0:…" } ],
  "runtimeIds": { "planId": "plan:…", "occurrenceIds": ["…"], "groupIds": ["…"] }
}
```

**进入差分**：L2 = JSON → `ParityCandidate`（`side:"rust-planner"`）→ `diffCandidates` 全字段（含 runtimeIds 结构规则与封闭键）；L3 = scoreEvents 的整数 µs 为 **Rust 自算**（TS 不代算），与 golden expected 零容差 + `computeL3Invariants` 复算；wireMs 通道 TS legacy 专属，Rust 记 `not-applicable`；L1 = 同一份 V1 输入双侧指纹逐字节相等 + 6 固定向量（a1）。

## 3. 精确算术设计（v3 全部重写；审修 1/2/3）

> **v2 的两处错误正式撤回**：§3.2 公式遗漏 `bpm.denominator`（C-8）；基于该残缺公式的 i128 上界证明随之无效（C-9）。**time.rs 在 a2 修复并复审前禁止实现。**

### 3.1 依赖选型（审修 2 建议采纳）

中间值使用 **`num-bigint 0.5.1`**（§1 已核验）——任意精度，从根上消除多因子中间积的溢出证明负担；结果域检查保留（safe-integer 契约）。

### 3.2 冻结公式（与 TS `beatToMicroseconds` :1234-1235 逐字一致；**含 bpm.denominator**）

```text
N = beat.num × 60_000_000 × bpm.denominator     ← v2 遗漏了 ×bpm.denominator（C-8，已修正）
D = beat.den  × bpm.numerator
µs = roundHalfUp(N / D) = floor((N + D/2) / D)   （N, D 为 BigInt；N ≥ 0, D > 0）
校验：N ≥ 0（NEGATIVE_TIME）；bpm.num > 0 且两者已约分（INVALID_RATIONAL / INVALID_BPM）；
      结果 > 2^53−1 → TIME_OUT_OF_RANGE
```

自检锚点：175/2 BPM 一拍 = round(1×6e7×2/175) = round(685,714.28…) = **685,714**（v2 公式会错出 342,857）。

### 3.3 其余精确运算（全部 BigInt 中间、结果收域）

- 有理数比较（组时值=最长成员）：BigInt 交叉乘。
- gcd：BigInt 欧几里得。
- `countInBeats`：`(CountInUs × bpm.num) / (60_000_000 × bpm.den)` BigInt 精确，约分后分子/分母超 safe-integer → `RATIONAL_OUT_OF_RANGE`（对齐 TS 构造层行为；C-7 记录 TS 自身 `countInBeatsRational` 的 float 乘法局限，15 冻结 case 远低于该边界）。
- payload 的所有整数进出 BigInt↔i64 转换处做域检查。

### 3.4 边界测试方案（a2 交付；time.rs 解禁后）

1. 极端合法输入：分子/分母 ≈2^53−1 的 µs 换算与比较（与 TS BigInt 实现逐例对拍）。
2. half-up 精确 .5（常规手推表 685714/1371429/2057143/2742857 + 2^53 邻域）。
3. 越界拒绝：结果 >2^53−1 → `TIME_OUT_OF_RANGE`；未约分 → `INVALID_RATIONAL`；countInBeats 超域 → `RATIONAL_OUT_OF_RANGE`。
4. 三因子上界回归：beat.num≈2^53、bpm.den≈2^53、60_000_000 常数并存（这正是 v2 i128 会爆、BigInt 必须存活的用例）。

## 4. 阶段状态与验收条件（v3：仅 a1 放行）

### 4.1 R2-3a1——**已获有条件批准，即将开工**

**范围（严格限定）**：`crates/rhythm-core/src/contract_v1/fingerprint.rs`（NFC/JCS/SHA-256 原语）+ payload serde 结构（`payload.rs`）+ `compute_plan_fingerprint_v1`；`tests/contract_v1_vectors.rs`。
**验收（第一小验收点）**：读 `test-vectors/plan-fingerprint-v1.json`，6 向量 canonical bytes 与指纹**逐字节**相等；含 JCS UTF-16 键序非 BMP 负例；既有 110 项 Rust 测试零回归。
**范围排除**：不实现 `time.rs`（a2 阻断）；不做 document 投影/校验（a2/a3）；不触碰 planner/NAPI。
**纪律**：sha2 版本已更正（0.11.1）并 lock；实跑测试记录命令/输出/commit SHA；不声称未跑的测试。

### 4.2 R2-3a2——**未放行**（前置阻断）

阻断项：① 修正后的时间公式实现（§3.2，已写明）；② num-bigint 溢出策略落地（§3）；③ config 输入边界（§2.1 config JSON → `PlanRequestConfig` 强类型 + Schema 校验）。内容：`time.rs` + `rational.rs` + `document.rs`（validate 全清单）+ §3.4 边界测试。完成后复审放行。

### 4.3 R2-3a3——**未放行**（前置阻断）

阻断项：scoreFingerprint 接口（v3 已在 §2.2/§2.3 完成——复审确认后即解除）+ a2 通过。内容：`project_score_document_v1` + payload 全量校验 + 门禁 `plan_fingerprint_v1_gate`。

### 4.4 R2-3b/c/d——维持 v2 定义（§2.3 PlannerOutput / 差分接入 / 证据包），受 a2/a3 门控。

## 5. 硬性约束（全程有效）

1. 不修改冻结 golden/向量/契约 Schema/case index；预期不符 = 实现缺陷。
2. Rust 指纹自持：禁 FFI/子进程调 TS。
3. 不改 `EngineScoreEvent` wire；不改 `build_schedule`/scoring_v1/matcher 生产行为。
4. 不切生产权威；`RHYTHM_PLANNER` 开关不实现于本卡。
5. 提交全部在 `r2-3-rust-planner` 分支；**不推送、不合入 main**，直至用户按阶段批准。
6. 不声称未运行的测试；实跑留命令/输出/SHA。

## 6. 冲突/决策记录

| # | 发现 | 处置 |
|---|---|---|
| C-1 | 零依赖传统 vs NFC/SHA-256 必需 | §1 清单；v2 批准时已含此方向 |
| C-2 | `build_schedule` f64 域 vs 整数 µs | planner 独立入口，build_schedule 不动 |
| C-3 | JCS 键排序须 UTF-16 code-unit 序 | a1 实现要求 + 非 BMP 负例 |
| C-4 | bindings 既有 DTO 全 f64 | 新接口 JSON 整数原样承载；既有 DTO 不动 |
| C-5 | 文档无 planner 声明 | 无冲突；R2-3d 如实更新 |
| C-6 | ImportReportV1 无独立 Schema（R2-0 遗留） | R2-3a 交付 `import-report-v1.schema.json`（a3 配套） |
| C-7 | TS `countInBeatsRational` float 乘法极限 | Rust BigInt 精确 + `RATIONAL_OUT_OF_RANGE`；15 case 不受影响 |
| **C-8** | **v2 §3.2 公式遗漏 bpm.denominator（二轮复审抓获；175/2 反例差一倍）** | §3.2 已修正；time.rs 阻断至 a2 |
| **C-9** | **v2 i128 上界证明不成立（三因子 ≈2^132 > 2^127）** | §3 改 num-bigint 任意精度（0.5.1） |
| **C-10** | **v2 sha2 版本误写"2.x"** | 更正 0.11.1（crates.io API 核验） |
| **C-11** | **scoreFingerprint 的持有/生成/门禁输入歧义** | §2.2/§2.3 明确：PlannerOutput 顶层字段，build_plan_v1 从 document.fingerprint 携带，门禁输入即该结构 |

## 7. 实施顺序（v3）

a1（已批准，开工中边界见 §4.1）→ 复审 → a2 阻断解除（时间公式+BigInt+config 边界）→ a2 复审 → a3（scoreFingerprint 已定义）→ a3 复审 → R2-3b → c → d。
**第一小验收点不变 = a1 的 N-FP-V1**：`cargo test --target x86_64-pc-windows-gnu contract_v1_vectors` 中"6 committed vectors are byte-exact"通过 + 非 BMP 键负例 + 既有 110 项零回归。
