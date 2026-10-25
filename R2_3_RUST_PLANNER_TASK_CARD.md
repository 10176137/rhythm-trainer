# R2-3 工程任务卡（v7——按 R2-3c 复审裁决同步状态；提交于 `r2-3-rust-planner` 分支）

**状态：** v7；**a1 PASS；a2 验收通过；a3 复审放行（2a93574）；R2-3b PASS（二轮复审，2d77cc6）；R2-3c 复审通过**（双跑集成与验收报告链路：60af861→2ffd195→af8adfc+8da3124，两轮修复）；**R2-3d（§8 七证据）未放行**。
**基线：** `main` @ `ba6d3c4`；本分支自该点创建。
**上位约束：** R2-1 `TS_RUST_PARITY_GATE_V1.md`（Frozen @ 838cd9b）、R2-2 关闭报告 §11、路线决策 §5.1。
**工作方式：** 全程在本分支提交。分支已推送远端供 GitHub 审查（用户确立的审查模式）；**main 不动、不合入**。

**v7 变更摘要**（仅阶段状态同步，不改任何冻结定义/范围）：
1. R2-3c 经两轮复审后**通过**：一轮四项修复（报告保留 diffs 全文且失败前写盘/双侧 gitSha+契约元数据/TS·Rust 各两次完整流程验稳定性/冻结 expectedOutcome 逐 case 双侧校验），报告于固定验证 SHA `af8adfc` 单独提交（8da3124）。批准范围 = 双跑集成与验收报告链路。
2. **R2-3c 通过 ≠ 生产权威切换许可**：`TS_RUST_PARITY_GATE_V1.md` §8 七项迁移证据（真实谱回归、A/B/C/V 验收、正式归档）仍是独立门槛；合并 main 仍不在批准范围。
3. 下一阶段：R2-3d（§8 七证据包）——未放行，待用户批准。

**v5 变更摘要**（相对 v4；四轮复审批准 a1、同步 a2 范围）：§4.2 重写为四项范围（time.rs 公式/num-bigint 全程精确/config 输入边界/§3.5 最终加法），**document.rs 完整校验移至 a3**；a3 定义相应更新。原 v4 摘要：**v4 变更摘要**（相对 v3/b6c2b9f，全部来自三轮复审意见）：
1. **§2.2/§2.3 `scoreFingerprint` 字段来源修正**（C-12，关键）：v3 写"从输入 document 的 fingerprint 字段携带"——**ScoreDocumentV1 顶层不存在 `fingerprint` 字段**（Schema `additionalProperties:false`）。正确规则（三轮复审 §二 五步）：源指纹在 **`document.source.sourceFingerprint`**（格式 `sha256:` + 64 位小写 hex）；`build_plan_v1` 读取它、**验证格式、去 `sha256:` 前缀**得 64hex，写入 `PlannerOutput.scoreFingerprint`；门禁比较 `plan.scoreFingerprint == report.fingerprint`（后者即裸 64hex，TS 投影 :178 同格式）；`project_score_document_v1` 的文档/报告绑定检查使用**同一规范化规则**（去前缀后比较），不比较不存在的 `document.fingerprint`。
2. **§3.5 新增 `TargetOnsetUs` 最终加法边界**（三轮复审 §三）：`CountInUs + PlanOffsetUs` 各自合法、和仍可能超 safe-integer——最终加法必须精确整数并做范围检查，超限返回越界错误码，禁止截断/回绕（a2 阻断项 +1）。
3. **§0.1 git 状态同步**：v3 实际已推送（`origin/r2-3-rust-planner == b6c2b9f`），v2→v3 diff 已由用户在 GitHub 完成审查——撤销 v3 文本中"未推送"的过时表述，避免本地/远端版本追溯混淆。
4. **§4 阶段状态**：a1 放行开工（不依赖时间换算/Planner/scoreFingerprint）；a2 阻断项 +1（TargetOnsetUs 加法）；a3 阻断项 = 本节 scoreFingerprint 规则（已写入）+ a2 通过。

---

## 0. 调查结论（以实际代码为据）

### 0.1 Git 状态——按时点分别记录（v3 的"未推送"表述已过时，此处为准）

- **调查时快照（v1 产出时）**：`main` @ `ba6d3c4`；任务卡为 untracked 草案；另有历史遗留 untracked `audit-r1/spike/sync-r20-report.mjs`（至今保持不动）。
- **v2 时点**：分支 `r2-3-rust-planner` 创建并推送至远端 `ecf0b06`（用户要求远程审查）。
- **v3 时点**：本地提交 `b6c2b9f`，随后**经用户指令推送**，`origin/r2-3-rust-planner == b6c2b9f`（v3 文本中"未推送"的表述已过时，以此处为准）。用户已在 GitHub 完成 v2→v3 diff 的三轮审查。
- **v4 时点（本卡）**：v4 修订提交在分支上并推送；a1 实现提交随后。`origin/main` 保持 `ba6d3c4` 不动、不合入。

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
  = TS `projectScoreDocumentV1`（:172）同款 fail-closed 层：反序列化 → 投影级不变量 → 规范化强类型 DTO。**文档/报告绑定检查使用规范化规则（C-12 修正）**：读取 `document.source.sourceFingerprint`（格式 `sha256:` + 64 位小写 hex），**去掉 `sha256:` 前缀**后与 `report.fingerprint`（裸 64hex）比较，不一致 → `DOCUMENT_REPORT_MISMATCH`；**不比较不存在的 `document.fingerprint`**（ScoreDocumentV1 顶层无此字段，Schema `additionalProperties:false`）。其余投影级不变量：`DUPLICATE_EVENT_ID`/`DUPLICATE_PART_ID`/`DUPLICATE_XML_ID`、`UNKNOWN_CAPABILITY`、`INVALID_SOURCE_FINGERPRINT`。不做完整语义校验。
- **`validate_score_document_v1(dto) -> Vec<Issue>`** = TS `validateScoreDocumentV1` 完整闭合清单（closed keys、约分有理数、ordinal 连续、tieSpan 双向、`scoreRevisionId` 公式、locator 唯一、时值规则等），每条独立负例。
- **门禁 `plan_fingerprint_v1_gate(document_json, report_json, plan_json, config_json) -> Result<String, ContractError>`**
  复刻 TS `planFingerprintV1`（:1171）无旁路：投影 → 全量校验（→`DOCUMENT_VALIDATION_FAILED`）→ **`plan.scoreFingerprint == report.fingerprint`**（裸 64hex 对裸 64hex；否则 `PLAN_DOCUMENT_MISMATCH`）→ payload 构造（取已校验 DTO 自己的 scoreRevisionId/normalizerVersion/supportProfileVersion）→ payload 全量校验 → 哈希。
  **plan_json 的形状 = §2.3 的 `PlannerOutput`**（含顶层 `scoreFingerprint`）——公开输出与门禁输入是同一结构，不存在"内部 Plan 另有一套"的第二协议。

### 2.3 `PlannerOutput`（Rust 输出契约；v3 增补 `scoreFingerprint`，审修 4）

```jsonc
{
  "scoreFingerprint": "…64hex",            // ★ C-12 修正：build_plan_v1 从 document.source.sourceFingerprint
                                            //   （"sha256:"+64hex）验证格式并去前缀后携带（裸 64hex）；
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

### 3.5 `TargetOnsetUs` 最终加法边界（v4 新增，三轮复审 §三；a2 阻断项）

`TargetOnsetUs = CountInUs + PlanOffsetUs`——两项**各自**在 safe-integer 域内，其和仍可能超出（如 CountInUs ≈ 2^53、PlanOffsetUs ≈ 2^53）。规则：
- 最终加法用 BigInt 精确执行（不得落回 f64/i128 截断）；
- 加法结果做范围检查：> 2^53−1 → 返回越界错误码（`TIME_OUT_OF_RANGE`），**禁止截断、回绕或输出失真数字**；
- 边界测试：CountInUs 与 PlanOffsetUs 各取 ≈2^53/2 的合法组合，断言和越界时按错误码拒绝、和未越界时精确。

## 4. 阶段状态与验收条件（v3：仅 a1 放行）

### 4.1 R2-3a1——**已获有条件批准，即将开工**

**范围（严格限定）**：`crates/rhythm-core/src/contract_v1/fingerprint.rs`（NFC/JCS/SHA-256 原语）+ payload serde 结构（`payload.rs`）+ `compute_plan_fingerprint_v1`；`tests/contract_v1_vectors.rs`。
**验收（第一小验收点）**：读 `test-vectors/plan-fingerprint-v1.json`，6 向量 canonical bytes 与指纹**逐字节**相等；含 JCS UTF-16 键序非 BMP 负例；既有 110 项 Rust 测试零回归。
**范围排除**：不实现 `time.rs`（a2 阻断）；不做 document 投影/校验（a2/a3）；不触碰 planner/NAPI。
**纪律**：sha2 版本已更正（0.11.1）并 lock；实跑测试记录命令/输出/commit SHA；不声称未跑的测试。

### 4.2 R2-3a2——**已放行**（四轮复审批准；范围按四轮意见同步，v5 卡为准）

**范围（四项，严格按四轮复审清单；document.rs 完整文档校验不在本阶段——移至 a3）**：
1. **`time.rs` 正确时间公式**：非负拍位 `n/d`、BPM `bpmNum/bpmDen`，`N = n × 60_000_000 × bpmDen`、`D = d × bpmNum`、`µs = roundHalfUp(N/D)`——**必须含 bpm.denominator**；锚点 175/2 BPM 一拍 = 685714 µs。
2. **num-bigint 全程精确**：有理数交叉乘、GCD、µs 换算、count-in 转换、最终加法——**运算完成后**才做 safe-integer 域检查。
3. **planner config 输入边界**：JSON → 强类型 `PlanRequestConfig`（serde `deny_unknown_fields`）+ 冻结契约校验：非法 range、非法 loop 次数、非法 BPM、未约分/非法有理数、未知字段、负 countInUs、clef-heuristic 来源一律**拒绝**，绝不返回看似成功的计划。
4. **§3.5 最终加法越界**：`TargetOnsetUs = CountInUs + PlanOffsetUs` 精确整数相加，超 safe-integer → `TIME_OUT_OF_RANGE`，禁止截断/回绕。

**验收覆盖（四轮清单）**：正确公式、有理 BPM、精确半入舍、最大安全整数附近、超大中间乘积、非法 config 全负例、两合法分项相加后越界。冻结向量与 golden 原样。

**新增文件**：`contract_v1/rational.rs`（RationalV1 + BigInt 精确运算）、`contract_v1/time.rs`、`contract_v1/config.rs`；对应测试 `tests/contract_v1_time.rs` 或并入现有测试文件。既有 6 向量/117 项测试零回归。**依赖新增：`num-bigint 0.5.1`**（§1 已列）。

### 4.3 R2-3a3——**复审放行**（2026-10-25，七轮修复后；见提交链 d8369f0→518ed41→d7c3a7c→0f9a449→2a93574）

内容：**`document.rs` 完整 ScoreDocumentV1 校验清单**（自 a2 范围移入）+ `project_score_document_v1`（含 C-12 规范化绑定检查）+ payload 全量校验 + 门禁 `plan_fingerprint_v1_gate`。

### 4.4 R2-3b/c/d——状态

- **R2-3b（PASS，二轮复审）**：`contract_v1/planner.rs` `build_plan_v1` 完整 planner 语义（range/loop/tie/chord/排序/hand 过滤/atoms/逐音 scoreEvents/PlannerOutput §2.3）+ 冻结语料对拍（`rust-parity-input/` 15 case）+ **a3 gate isTieOnset 缺陷修复**（corpus 对拍抓获）；首轮阻断项（range-loop×1 planId）已修复（2d77cc6）。复审确认：corpus 通过不能替代规范边界值独立检查。
- **R2-3c（复审通过，2026-10-25）**：NAPI 三导出（buildPlanV1/buildParityCandidateV1/planFingerprintV1Gate，错误码跨 Node 边界可识别）+ ParityCandidate 适配层（lib 单点实现）+ 三方双跑（`loadExpected` 独立真值为锚，TS 与 Rust **分别**对照，冻结判据 reportPasses）+ 机器可读报告（`r2-3c-dual-run-report-v1`：逐 case L1 跨语言指纹+双侧完整重复跑稳定性、L2 diffs 全文、L3 computeL3Invariants、冻结 expectedOutcome 双侧校验、契约元数据与双侧 gitSha；先写盘后断言，失败非零退出）。报告于固定验证 SHA `af8adfc` 生成并单独提交（8da3124）。**批准范围 = 双跑集成与验收报告链路；不构成生产权威切换许可。**
- **R2-3d（未放行）**：§8 七证据（真实谱回归、A/B/C/V 验收、正式归档）——生产切换前提。

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
| **C-11** | **scoreFingerprint 的持有/生成/门禁输入歧义** | v3 的修正方向正确但字段来源错误（C-12）；v4 按 §2.2/§2.3 五步规则定稿 |
| **C-12** | **v3 写"从 document.fingerprint 携带"——ScoreDocumentV1 顶层无此字段（additionalProperties:false）；源指纹在 source.sourceFingerprint（sha256: 前缀）**（三轮复审抓获） | §2.2/§2.3 定稿五步规则：读 source.sourceFingerprint → 验格式去前缀 → 写 scoreFingerprint → 门禁与 report.fingerprint 比较；绑定检查同规则 |
| **C-13** | TargetOnsetUs = CountInUs + PlanOffsetUs 的**和**可越界（分项各自合法） | §3.5 新增：BigInt 精确加法 + 结果范围检查（a2 阻断项） |

## 7. 实施顺序（v4）

a1（已放行，本卡随附实现提交）→ 复审 → a2（阻断项：时间公式实现 + BigInt 策略 + config 边界 + **§3.5 加法边界**）→ a2 复审 → a3（scoreFingerprint 规则已在 §2.2/§2.3 定稿）→ a3 复审 → R2-3b → c → d。
**第一小验收点不变 = a1 的 N-FP-V1**：`cargo test --target x86_64-pc-windows-gnu contract_v1_vectors` 中"6 committed vectors are byte-exact"通过 + 非 BMP 键负例 + 既有 110 项零回归。
