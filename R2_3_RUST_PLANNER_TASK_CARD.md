# R2-3 工程任务卡（v2——按首轮审查意见修订，提交于 `r2-3-rust-planner` 分支）

**状态：** SUBMITTED FOR REVIEW（v2；仅任务卡，零 Rust 代码实现）
**基线：** `main` @ `ba6d3c4`（R2-2 关闭决定提交；本分支自该点创建）
**上位约束：** R2-1 `TS_RUST_PARITY_GATE_V1.md`（Frozen @ 838cd9b）、R2-2 关闭报告（`R2_2_PARITY_HARNESS_IMPLEMENTATION_REPORT.md` §11）、路线决策 §5.1
**性质：** Rust planner 实施卡。验收规则与 TS 侧靶场已冻结/关闭，本卡是把 Rust 侧做出来并接上靶场。
**工作方式：** 全程在本分支提交；**不推送、不合入 main**，直至用户按阶段审查批准。

**v2 变更摘要**（相对 v1/ad3f60c）：
1. §2.0 新增「数据边界与契约定义」：五类对象的冻结定义处、Rust 输入/输出形态、`project`/`validate` 责任边界、路线 A 保持方式——Rust 只消费**已提交 Schema 定义的契约 JSON 实例**，不引入任何"原始 TS DTO JSON"协议（审修 2）。
2. §2.3（原 R2-3b）补全 `PlannerOutput`：Rust **自行计算**精确 `targetOnsetUs`/`targetDurationUs`，scoreEvents 进入 `ParityCandidate.scoreEvents` 参与三层差分；TS 不代算任何 Rust 字段（审修 1）。
3. §3 重写精确算术设计：撤回"i128 任意精度"的含糊表述，给出**输入域 → 中间积上界证明 → i128 充分性 → checked 兜底 → 错误码 → 边界测试**完整方案（审修 3）。
4. §1 依赖表完整化：`serde`（含 derive）+ `serde_json` + `sha2` + `unicode-normalization`；精确算术**零额外依赖**（自实现 gcd，i128）；JCS 实现限定 payload 值域并说明与 serde_json 序列化的关系（审修 4）。
5. §0.1 拆分「调查时快照」与「本卡提交时状态」，准确说明 untracked 文件（审修 5）。
6. §2.2 R2-3a 内部细分 a1/a2/a3 三个小验收点，N-FP-V1 六向量 byte-exact 为**第一小点**（审修 6）。
7. §4 硬约束全表保留（审修 7）。

---

## 0. 调查结论（以实际代码为据）

### 0.1 Git 状态——两个时点分别记录

**调查时快照（任务卡 v1 产出时）**：分支 `main`，HEAD = `ba6d3c4`（R2-2 关闭落档提交）。工作区无已提交修改；untracked 文件两枚：`R2_3_RUST_PLANNER_TASK_CARD.md`（当时尚未提交的任务卡草案）与 `audit-r1/spike/sync-r20-report.mjs`（R2-0 时期的历史遗留脚本，非本卡范围）。"工作区干净"的准确表述是：**无 staged/modified 的已跟踪文件；存在上述两枚 untracked 文件**。

**本卡提交时状态（v2 提交时）**：分支 `r2-3-rust-planner`（自 `main@ba6d3c4` 创建），任务卡 v1 已随 `ad3f60c` 提交，本 v2 修订为分支上第二个提交。untracked 仍剩 `audit-r1/spike/sync-r20-report.mjs`（保持不动）。**分支不推送、不合入 main**，直至用户按阶段审查批准。

远端核验：`origin/main == ba6d3c4`（本轮会话早前 ls-remote 核验；期间多次 443 间歇超时，均按既有经验重试通过）。

### 0.2 Rust workspace 真实结构（已核实）

```
rhythm-trainer-core-v0.2/
  Cargo.toml                  # workspace: members=[crates/rhythm-core]，exclude=[bindings/node]
  crates/rhythm-core/         # 核心 lib（version 0.5.0，**声明零运行时依赖**）
    src/
      lib.rs (48)             # 模块导出
      duration.rs (661)       # MIDI 音符时值评估（DurationPolicy/PerformedNote 配对）——非有理数算术
      matcher.rs (244)        # HitMatcher（实时判定）
      schedule.rs (266)       # build_schedule(pattern,bpm f64,start_at_ms f64,profile)→Vec<TargetHit>
      scoring_v1.rs (969)     # 最终评分（R5 范围，不动）
      take.rs (1151) session.rs (320) midi.rs (921) teaching.rs (866) stats.rs (85) …
    tests/                    # 集成测试：end_to_end / property_tests / scoring_v1_acceptance / benchmark
  bindings/node/              # NAPI crate（rhythm-trainer-native 0.5.0，napi2/napi-derive2）
    src/lib.rs                # 57 个 #[napi] 导出；JsRhythmAtom/JsRhythmPattern/JsTarget 等 DTO（f64 承载数值）
    package.json              # scripts.build = "napi build --platform --release --js false"（@napi-rs/cli 2.18.4）
    rhythm_trainer_native.win32-x64-gnu.node   # 现役产物（frontend 经 @rhythm-trainer/native 包加载）
  rust-toolchain.toml         # 工具链锁定
```

- **依赖现状（关键决策点）**：`crates/rhythm-core/Cargo.toml` 的 `[dependencies]` 为**空**——crate 刻意保持"no runtime dependencies"。无 sha2、无 unicode-normalization、无 serde/serde_json。NFC、RFC 8785 JCS、SHA-256、JSON 解析在 Rust 侧**目前零基础**。
- **数值现状**：全链 `f64`（build_schedule 的 bpm/ms、JsTarget.at_ms）。整数 µs、有理数、roundHalfUp 在 Rust 侧**目前零基础**。
- **测试现状**：workspace 内 92 个 `#[test]` + 4 个集成测试文件；`cargo test --target x86_64-pc-windows-gnu`（w64devkit GNU 工具链）当前 110 个测试通过。

### 0.3 TS 侧资产位置与调用关系（已核实，R2-2 产物）

```
rhythm-trainer-frontend/src/score-engine/
  contract-v1/plan-fingerprint.ts        # TS 权威参考：projectScoreDocumentV1 / validateScoreDocumentV1 /
                                         #   validatePlanFingerprintPayloadV1 / buildPlanFingerprintPayloadV1 /
                                         #   computePlanFingerprintV1 / planFingerprintV1(强制门禁 :1171) / beatToMicroseconds(:1229, BigInt)
  contract-v1/contract-v1.test.ts        # 契约测试 + 6 固定向量断言
  playback/playback-planner.ts           # buildPlaybackPlan / scoreOccurrencesToEngineAtoms（迁移语义源）
  playback/reference-playback-plan.ts    # filterPlaybackPlanByHand（:103）
  playback/score-events.ts               # buildEngineScoreEvents（wire，不动）
  scope/practice-scope.ts                # assessPracticeScope / handByScoreEventIdFromMapping / HandMappingV1
  parity/
    parity-diff.ts                       # diffCandidates(expected, candidate)——Rust 候选接入点（形状=ParityCandidate）
    parity-candidate.ts                  # buildTsCandidate（TS 侧候选）/ computeL3Invariants / fingerprintStable
    parity-runner.ts                     # full/case/fault 模式；FAULT_SPECS 六项注入；ParityDiffReportV1
    normative-codes.ts                   # C 类规范码 + 服务端消息锚点映射
    case-bundle.ts                       # 15 冻结 case 加载（fixture sha256 校验）+ golden→expected 转换器
    acceptance-{a,b,c,v}.test.ts         # 四类验收（V 类: RUST_V_CLASS_STATUS='DEFERRED_TO_R2-3'，R2-3d 翻转）
    real-score-parity.test.ts            # 113 小节结构不变量（RHYTHM_REAL_SCORE_PATH 门禁）
audit-r1/contracts/test-vectors/plan-fingerprint-v1.json   # 6 向量（5 冻结 + V-rational-bpm）
audit-r1/contracts/score-document-v1.schema.json           # ScoreDocumentV1 契约 Schema
audit-r1/contracts/plan-fingerprint-payload-v1.schema.json # payload 契约 Schema
audit-r1/contracts/parity-case-bundle-v1.schema.json       # case bundle（含 planner config 形状）
```

### 0.4 Rust 已实现 / 尚缺（代码为据，逐项）

| 能力 | 状态 | 依据 |
|---|---|---|
| atoms→targets 调度（buildSchedule） | ✅ 已实现（f64 ms 域） | schedule.rs:71；保持不动，planner 走新入口 |
| 实时判定/最终评分/teaching | ✅ 已实现 | matcher/scoring_v1/teaching（本卡不动） |
| NAPI 绑定骨架与 GNU 产物链 | ✅ 已实现 | bindings/node（57 导出；napi build 脚本现役） |
| 有理数类型与精确算术 | ❌ 缺 | 无任何 Rational 类型 |
| 整数 µs / roundHalfUp | ❌ 缺 | 全链 f64 |
| ScoreDocumentV1 投影+闭合校验 | ❌ 缺 | 无对应模块 |
| planner 语义（range/hand/tie/chord/loop/排序） | ❌ 缺 | 无对应模块 |
| NFC / JCS / SHA-256 | ❌ 缺 | 零依赖，无相关 crate |
| planFingerprintV1 端到端 | ❌ 缺 | — |
| parity 候选 JSON 输出 | ❌ 缺 | — |

**文档-实现冲突检查**：`CORE_API.md`/`IMPLEMENTATION_STATUS.md`/`README.md` 中无 planner/PlanFingerprint/ScoreDocumentV1/playback 声明——**文档未声称未实现的能力，无冲突**。两处边界记录（非冲突）：
1. 现有 `build_schedule` 是 f64 ms 域且被生产使用——planner **不改造它**，新增独立入口；两者并存至权威切换。
2. pattern id 的 `Date.now()` 问题（路线决策 D11）属生产切换后事项，本卡不动。

---

## 1. 依赖决策（完整清单；待用户批准后生效）

新增至 `crates/rhythm-core/Cargo.toml` 的全部依赖（打破"零运行时依赖"传统的完整代价，一次列清）：

| crate | 版本策略 | 用途 | 为什么不可手写/省略 |
|---|---|---|---|
| `unicode-normalization` | 最新稳定（lock 固定） | Unicode NFC（`.nfc()` 迭代器） | NFC 归一化表巨大（组合字符类、合成排除、序等价），手写不可行 |
| `sha2` | 2.x | SHA-256 | 算法可手写但属密码学原语，手写引入不必要的实现风险；sha2 为 RustCrypto 维护的标准实现 |
| `serde` + `serde/derive` | 1.x | 契约结构体反序列化/序列化（ScoreDocumentV1/ImportReportV1/config/payload/PlannerOutput） | 手写 JSON 解析器风险远高于依赖成本 |
| `serde_json` | 1.x | JSON 文本 ↔ 结构体；canonical 输出的底层字符串处理 | 同上 |
| **精确算术** | **零额外依赖** | `i128`/`u128` + 自实现欧几里得 gcd | 输入域受 safe-integer 契约限制（≤2^53），上界证明见 §3——**不需要 num/bigint-rs** |

要点：
- **冻结契约不变**：以上依赖只影响 Rust 实现方式，不触碰任何已提交 Schema/向量/规则。
- 版本一律进 `Cargo.lock`（分支提交），不使用 `^` 浮动语义之外的宽容。
- README 与 `CORE_API.md` 的"no runtime dependencies"声明在 R2-3a 合入时同步更新（如实描述）。

## 2. 数据边界与契约定义（先于一切实现）

**总原则（保持路线 A）**：TS importer 保留为 ScoreDocumentV1 的生产者（差分期）；Rust 只消费**已提交契约 Schema 定义的 JSON 实例**，并产出**本卡定义的 PlannerOutput JSON**。两侧之间传递的每一个 JSON 对象，要么符合已提交 Schema，要么符合本节定义并随本卡冻结——**不引入任何对 TS 内部类型（`ScoreDocument`/`PlaybackPlan` TS struct）的随手套序列化协议**。R3 后 Rust importer 直接生产同一 ScoreDocumentV1，TS 退出生产路径、保留为差分 legacyReference——契约不变。

### 2.1 五类对象的输入/输出契约

| 对象 | 冻结定义处 | Rust 输入形态 | Rust 输出 |
|---|---|---|---|
| **ScoreDocumentV1** | `audit-r1/contracts/score-document-v1.schema.json`（已提交） | JSON 实例文本。差分期由 harness 调 TS `projectScoreDocumentV1` 产出 dto 并**经 Schema 校验后**落盘传入；Rust 反序列化为强类型 `ScoreDocumentV1` | 投影级校验结果 + 规范化强类型值 |
| **ImportReportV1** | **本卡新增冻结**：`audit-r1/contracts/import-report-v1.schema.json`（补 R2-0 遗留"ImportReport 完整 V1 schema"；最小字段集：`schemaVersion/parserVersion/supportProfileVersion/fingerprint/status/strictAllowed/capabilities`，`additionalProperties:false`——投影与门禁只消费这些字段） | JSON 实例文本（同上，与 document 配对产出） | 配对/能力校验结果 |
| **planner config** | `audit-r1/contracts/parity-case-bundle-v1.schema.json` 的 `config` 对象（已提交） | JSON 实例文本 | 强类型 `PlanRequestConfig` |
| **plan（内部→输出）** | **本卡定义 `PlannerOutput`**（§2.3；serde 结构 + JSON 形状冻结于本卡） | —（Rust 内部构造） | ① 候选 JSON（喂 `ParityCandidate`）；② 指纹 payload 的输入（occurrences/groups） |
| **指纹 payload** | `audit-r1/contracts/plan-fingerprint-payload-v1.schema.json`（已提交） | Rust 内部构造（非外部输入） | canonical bytes + `plan-v1:sha256:…` 指纹 |

### 2.2 `project` 与 `validate` 的责任边界（对齐 TS 同名函数）

- **`project_score_document_v1(document_json, report_json) -> Result<ProjectedDocument, ContractError>`**
  职责 = TS `projectScoreDocumentV1`（plan-fingerprint.ts:172）的同款 fail-closed 层：反序列化 → 投影级不变量（重复 `eventId`/`partId`/`xmlId` → `DUPLICATE_EVENT_ID`/`DUPLICATE_PART_ID`/`DUPLICATE_XML_ID`；未知 capability → `UNKNOWN_CAPABILITY`；`document.fingerprint ≠ report.fingerprint` → `DOCUMENT_REPORT_MISMATCH`；`report.fingerprint` 非 sha256 hex → `INVALID_SOURCE_FINGERPRINT`）→ 输出规范化强类型 DTO。**不做**完整语义校验（那是下一层）。
- **`validate_score_document_v1(dto) -> Vec<Issue>`**
  职责 = TS `validateScoreDocumentV1` 的完整闭合语义校验清单（closed keys、必填键、嵌套结构、约分有理数 `is_canonical`、ordinal 连续、tieSpan 双向引用与 ID 唯一、`scoreRevisionId` 冻结公式、文档级 source locator 唯一、note/rest 时值规则、`source_measure_mismatch` 等）——每条配独立负例测试。
- **强制门禁 `plan_fingerprint_v1(document_json, report_json, plan, config) -> Result<String, ContractError>`**
  顺序复刻 TS `planFingerprintV1`（:1171，无旁路）：投影 → 全量校验（issues 非空 → `DOCUMENT_VALIDATION_FAILED`）→ `PLAN_DOCUMENT_MISMATCH`（plan.scoreFingerprint == report.fingerprint）→ payload 构造（取**已校验 DTO 自己**的 scoreRevisionId/normalizerVersion/supportProfileVersion）→ payload 全量校验 → 哈希。

### 2.3 `PlannerOutput`（本卡冻结的 Rust 输出契约；审修 1）

```jsonc
// PlannerOutput —— Rust 序列化输出的 JSON 形状（serde 结构同步定义；字段名与 TS ParityCandidate 子形状一致）
{
  "occurrences": [ {                       // 语义与 TS PlaybackOccurrence 等价（R2-1 §3.1）
    "locator": { "partId": "P1", "measureOrdinal": 1, "sourceOrdinal": 1, "voiceId": "1" },
    "passIndex": 0,
    "playbackBeat": "0/1",                 // 约分有理文本
    "durationBeat": "1/1",
    "measureOrdinal": 1, "bar": 1, "beatInMeasure": "0/1",
    "staffNumber": 1, "voiceId": "1",
    "pitch": { "step": "C", "alter": 0, "octave": 4, "midiNote": 60, "spelling": "C4" } | null,
    "isTieOnset": false,
    "playbackIndex": 0
  } ],
  "groups": [ /* §3.2 字段：passIndex/playbackBeat/members/pitches/bar/beatInMeasure/staffNumbers/voiceIds/durationBeat */ ],
  "atoms": [ { "startTick": 0, "durationTicks": 960, "bar": 1, "beat": 1.0 } ],
  "scoreEvents": [ {                        // ★ Rust 自算，TS 不得代算（审修 1）
    "locator": { "partId": "P1", "measureOrdinal": 1, "sourceOrdinal": 1, "voiceId": "1" },
    "passIndex": 0, "measure": 1, "pitch": 60,
    "targetOnsetUs": 3000000,               // = CountInUs + beat_to_microseconds(playbackBeat, bpm)  ← Rust 按 §3 冻结公式计算
    "targetDurationUs": 750000,             // = beat_to_microseconds(durationBeat, bpm)
    "partId": "staff-1:voice-1",            // 已冻结派生规则 staff-{n}:voice-{v}
    "parseConfidence": 1,
    "runtimeOccurrenceId": "plan:…:p0:…"    // Rust 同规则生成（:p{pass}: 段检查用）
  } ],
  "runtimeIds": { "planId": "plan:…", "occurrenceIds": ["…"], "groupIds": ["…"] }
}
```

**进入差分的方式**（三层各归其位）：
- **L2（结构）**：harness 将上述 JSON 反序列化为 `ParityCandidate`（`side: "rust-planner"`, `kind: "candidate"`；字段一一对应，无 TS-only 字段缺失——`wireMs` Rust 候选**不携带**，`wireCompatibility` 记 `not-applicable`）→ `diffCandidates(expected, rustCandidate)` 全字段比对，含 `runtimeIds` 结构规则与封闭键 fail-closed。
- **L3（派生）**：`scoreEvents.targetOnsetUs/targetDurationUs` 是 **Rust 用 R2-3a 的 `beat_to_microseconds` + config 的整数 `CountInUs` 自算的 canonical 值**，与 golden expected 的整数 µs **零容差**比对；TS 在 Rust 候选通道中**不参与任何数值计算**。`computeL3Invariants` 照常离线复算（onset 组↔atom 集合、组时值=最长成员、小节覆盖、tick 网格）。wireMs 毫秒通道是 TS legacyReference 专属，Rust 候选无此通道、无对应容差。
- **L1（指纹）**：harness 用**同一份** ScoreDocumentV1/Report/PlannerOutput JSON 分别喂 TS `planFingerprintV1` 与 Rust 门禁，两个指纹逐字节相等；另以 6 固定向量做 N-FP-V1（R2-3a）。

## 3. 精确算术设计（撤回 v1 的含糊表述；审修 3）

**i128 不是任意精度整数**——以下用**输入域上界证明**说明 i128 在本契约下充分，并配 checked 兜底。

### 3.1 输入域（契约保证）

所有参与乘法的量受已冻结契约限制：有理数分子/分母、`ticksPerQuarter`、`CountInUs` 均为 JSON 整数且 |v| ≤ 2^53−1（safe integer；`parity-case-bundle-v1.schema.json` 与 payload Schema 的整数域 + `is_canonical` 检查）。有理数**构造即约分**。

### 3.2 `beat_to_microseconds` 的上界证明（half-up，一次除法前不溢出 i128）

分**两步乘 + 先约分后 half-up**（避免三因子连乘 2^53×2^26×2^53≈2^132 越界）：

```text
step1: N = beat.num × 60_000_000        ≤ 2^53 × 2^26          <  2^79     ✓ i128
step1: D = beat.den × bpm.num           ≤ 2^53 × 2^53          <  2^106    ✓ i128
step2: g = gcd(N, D)（欧几里得，纯减法/取模安全）
       N' = N/g, D' = D/g               ≤ 各自原值              ✓
half-up: R = (N' + D'/2) / D'           分子 ≤ 2^79 + 2^105     <  2^106    ✓ i128
result: R ≤ 2^53−1（否则 TIME_OUT_OF_RANGE，对齐 TS）
```

每一步乘法用 `i128::checked_mul`（理论不溢出，checked 作防御性兜底，触发即 `ARITHMETIC_OVERFLOW`→ 归入 `TIME_OUT_OF_RANGE` 同族失败，绝不 silent wrap）。**结论：schema 允许的任何合法输入（含分子分母同取 2^53−1 的极端用例）都不会因中间溢出误判**；非法/越界输入在构造层即被拒绝（未约分 → `INVALID_RATIONAL`；结果超 safe integer → `TIME_OUT_OF_RANGE`；负拍 → `NEGATIVE_TIME`；非正 BPM → `INVALID_BPM`）——与 TS BigInt 版行为逐码对齐。

### 3.3 其余精确运算

- **有理数比较**（组时值=最长成员）：交叉乘 `a.num×b.den` vs `b.num×a.den` ≤ 2^106 ✓ i128。
- **gcd**：自实现欧几里得（u128 域），无依赖。
- **`countInBeats`**：`(CountInUs × bpm.num) / (60_000_000 × bpm.den)`——分子 ≤ 2^53×2^53 = 2^106 ✓；约分后若分子或分母超出 safe-integer 域 → `RATIONAL_OUT_OF_RANGE`（**对齐 TS 同名行为**：TS `rationalV1` 构造层同样拒绝；边界测试覆盖）。

### 3.4 边界测试方案（R2-3a 交付）

1. 极端合法输入：分子=分母=2^53−1 的有理数比较；beat.num=2^53−1 × bpm.den=2^53−1 的 µs 换算（与 TS `beatToMicroseconds` 逐例对拍，TS 侧已有 BigInt 测试同款）。
2. half-up 精确 .5：`den` 为偶数且余恰半的构造用例（`333333`/`333334` 手推表已覆盖常规，补 2^53 邻域用例）。
3. 越界拒绝：结果 > 2^53−1 → `TIME_OUT_OF_RANGE`；未约分输入 → `INVALID_RATIONAL`；countInBeats 约分后超域 → `RATIONAL_OUT_OF_RANGE`。
4. checked 兜底路径用例无法用合法输入触发（上界已证），以单元测试直接调用内部 checked 步骤喂越界值验证错误映射存在。

## 4. 阶段拆分与验收条件

### 4.0 R2-3a 内部细分（审修 6：小步验收，N-FP-V1 最先）

| 小步 | 内容 | 独立验收点 |
|---|---|---|
| **a1（第一小验收点）** | `fingerprint.rs` 原语（NFC/JCS/SHA-256）+ payload serde 结构 + `compute_plan_fingerprint_v1` | **N-FP-V1：`tests/contract_v1_vectors.rs` 读 `test-vectors/plan-fingerprint-v1.json`，6 向量 canonical bytes 与指纹逐字节相等**；含 JCS UTF-16 键序非 BMP 负例（C-3）；既有 110 项 Rust 测试零回归 |
| a2 | `document.rs` 反序列化 + `validate_score_document_v1` 全清单 + `rational.rs`/`time.rs` + §3 边界测试 | TS 负例矩阵逐条映射（≥20 项，一一对应注释）；§3.4 边界全绿 |
| a3 | `project_score_document_v1` + payload 全量校验 + 强制门禁 `plan_fingerprint_v1` | 门禁顺序与 TS :1171 一致；投影/门禁负例（双 mismatch、无旁路）全绿；TS `acceptance-v` V 类翻转后绿 |

### 4.1 R2-3b：Planner 核心（语义迁移；输出契约 = §2.3）

**新增**：`crates/rhythm-core/src/planner/`（`mod.rs`/`range.rs`/`hand.rs`/`groups.rs`/`passes.rs`）。
- 输入：`ScoreDocumentV1`（R2-3a 强类型）+ `PlanRequestConfig`（§2.1）。
- 语义逐条对齐 `playback-planner.ts`（file:line 注释）：过滤（:52-53）、tie 合并与续接不生成（:61-73/:138）、重定基+pass 偏移（:139-141）、排序键（:164-170）、playbackIndex（:171）、group 键与最长成员（:186-189）、去重升序（:198-199）、loop 1–32、`invalid_range`/`invalid_repeat_count`/`no_playable_notes`。
- hand 过滤对齐 `reference-playback-plan.ts:103`（组缩减、playbackIndex 不重编号、`:hand=` 后缀）。
- **scoreEvents 由 Rust 生成**：`targetOnsetUs = count_in_us + beat_to_microseconds(playbackBeat, bpm)`、`targetDurationUs = beat_to_microseconds(durationBeat, bpm)`（§2.3）。
- 输出：`PlannerOutput`（§2.3 JSON 形状，serde 序列化）。

**测试/验收**：15 冻结 case 的 Rust 侧结构断言（occurrence/group/atom/**scoreEvents µs** 逐字段 = 手工真值，**不改 golden**）；错误码负例；occurrence 每 pass 唯一；同音符跨 pass 合法重复。命令同 R2-3a。**依赖：R2-3a（a1–a3 全部）。**

### 4.2 R2-3c：NAPI DTO + parity 双跑接入

**修改**：`bindings/node/src/lib.rs` 新增导出（既有 57 个导出与 DTO 不动）：
- `plan_fingerprint_v1_gate(documentJson, reportJson, planJson, configJson) -> String`；
- `build_plan_v1(documentJson, configJson) -> String`（`PlannerOutput` JSON；整数以 JSON 整数承载——Node 侧经 `JSON.parse` 后直接进 harness，**不经 f64 中转**）；
- `index.d.ts` 同步。
**修改**：`parity-runner.ts` 增加 `--side=rust` 候选源（§2.3 映射）；fault 注入对 Rust 候选重跑；`normative-codes` C 类对 Rust 候选校验落地；`acceptance-b` 增加 Rust 候选变体。
**验收条件**：15/15 case **双侧** PASS（L1 相等 ∧ L2 零未分类 ∧ L3 全绿）；6/6 fault 对 Rust 候选全部捕获且路径/分类正确；unknown faultId 行为一致；`--mode=fault --side=rust` 未知 faultId 仍 exit 1。
**依赖**：R2-3a + R2-3b；bindings `npm run build` 重建 + harness esbuild 重打包。

### 4.3 R2-3d：迁移证据包 + 文档收尾

- §7 回归矩阵全量（双侧）+ §8 七条证据逐条落档 `audit-r1/reports/r2-3/`；真实谱 113 小节双侧：结构计数 1579/1018 + capabilities 5 值 + 双侧指纹稳定。
- `acceptance-v.test.ts` V 类常态化（不再是 DEFERRED）；`CORE_API.md`/`IMPLEMENTATION_STATUS.md`/README 如实更新（含依赖声明变更）。
- 实施报告 `R2_3_RUST_PLANNER_IMPLEMENTATION_REPORT.md`（逐 case 结果、gitSha、版本、命令输出摘要）。
**验收条件**：§8 七条全绿。**生产权威仍不切换**——切换是独立决策卡。

## 5. 硬性约束（全程有效）

1. 不修改冻结 golden（`g*.expected.json`、`test-vectors/plan-fingerprint-v1.json`、parity case index、两份契约 Schema）；预期不符 = 实现缺陷，按差异分类报告。
2. Rust 指纹自持：禁 FFI/子进程调 TS；NFC/JCS/SHA-256 全 Rust。
3. 不改 `EngineScoreEvent` wire 协议；不改 `build_schedule`/scoring_v1/matcher 生产行为。
4. 不切生产权威；`RHYTHM_PLANNER` 开关不实现于本卡。
5. 提交全部在 `r2-3-rust-planner` 分支；**不推送、不合入 main**，直至用户按阶段批准。
6. 不声称未运行的测试；所有命令实跑并留输出摘要。

## 6. 冲突/决策记录（v2 增补 C-6/C-7）

| # | 发现 | 处置 |
|---|---|---|
| C-1 | 零依赖传统 vs NFC/SHA-256 必需 | §1 依赖清单，**待批准** |
| C-2 | `build_schedule` f64 域 vs 冻结整数 µs | planner 独立入口，build_schedule 不动，两域并存至切换 |
| C-3 | JCS 键排序须 UTF-16 code-unit 序 | a1 实现要求 + 非 BMP 键负例 |
| C-4 | bindings 既有 DTO 全 f64 | 新接口走 JSON 字符串协议，整数原样承载；既有 DTO 不动 |
| C-5 | 文档无 planner 声明 | 无冲突；R2-3d 如实更新 |
| C-6 | **`ImportReportV1` 无独立 Schema（R2-0 遗留）** | R2-3a 交付 `import-report-v1.schema.json`（最小字段集冻结，§2.1），补齐遗留 |
| C-7 | TS `countInBeatsRational` 的 JS number 乘法在极端输入（CountInUs×bpmNum>2^53）下不精确 | Rust 侧按 §3.3 用 i128 精确计算并 `RATIONAL_OUT_OF_RANGE` 拒绝越界——Rust 比 TS 更严格且行为对齐 TS 的构造层拒绝； harness 现有 15 case 的 config 均远低于该边界，不受影响。已记录，不改 TS |

## 7. 实施顺序与第一个可独立验收切片

**顺序**：本卡批准 + §1 依赖拍板 → **a1（N-FP-V1）** → a2 → a3 → R2-3b → R2-3c → R2-3d。
**第一个可独立验收切片 = a1**：
> `cargo test --target x86_64-pc-windows-gnu contract_v1_vectors` 中"6 committed vectors are byte-exact"通过——Rust 在零 FFI 前提下对提交的 6 个向量（含 V-rational-bpm）复现 canonical bytes 与 SHA-256 指纹逐字节相等，含 UTF-16 键序非 BMP 负例，既有 110 项 Rust 测试零回归。
