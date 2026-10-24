# R2-3 工程任务卡（v1——提交于 `r2-3-rust-planner` 分支，待用户审查）

**状态：** SUBMITTED FOR REVIEW（调查与任务卡阶段产出；零代码实现）
**基线：** `main` @ `ba6d3c4`（R2-2 关闭决定提交；本分支自该点创建）
**上位约束：** R2-1 `TS_RUST_PARITY_GATE_V1.md`（Frozen @ 838cd9b）、R2-2 关闭报告（`R2_2_PARITY_HARNESS_IMPLEMENTATION_REPORT.md` §11）、路线决策 §5.1
**性质：** Rust planner 实施卡。验收规则与 TS 侧靶场已冻结/关闭，本卡是把 Rust 侧做出来并接上靶场。
**工作方式：** 全程在本分支提交；**不推送、不合入 main**，直至用户按阶段审查批准。

---

## 0. 调查结论（以实际代码为据，2026-10-25）

### 0.1 仓库与 git 状态（已核实）

- 分支 `main`，HEAD = `ba6d3c4`（R2-2 关闭落档提交），工作区干净（仅历史遗留 untracked `audit-r1/spike/sync-r20-report.mjs`）。
- 远端 `origin/main == ba6d3c4`（本轮会话早前 ls-remote 核验）。

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
      take.rs (1151) session.rs (320) midi.rs (921) teaching.rs (866) …
    tests/                    # 集成测试：end_to_end / property_tests / scoring_v1_acceptance / benchmark
  bindings/node/              # NAPI crate（rhythm-trainer-native 0.5.0，napi2/napi-derive2）
    src/lib.rs                # 57 个 #[napi] 导出；JsRhythmAtom/JsRhythmPattern/JsTarget 等 DTO（f64 承载数值）
    package.json              # scripts.build = "napi build --platform --release --js false"（@napi-rs/cli 2.18.4）
    rhythm_trainer_native.win32-x64-gnu.node   # 现役产物（frontend 经 @rhythm-trainer/native 包加载）
  rust-toolchain.toml         # 工具链锁定
```

- **依赖现状（关键决策点）**：`crates/rhythm-core/Cargo.toml` 的 `[dependencies]` 为**空**——crate 刻意保持"no runtime dependencies"（README/manifest 描述）。无 sha2、无 unicode-normalization、无 serde。NFC、RFC 8785 JCS、SHA-256 在 Rust 侧**目前零基础**。
- **数值现状**：全链 `f64`（build_schedule 的 bpm/ms、JsTarget.at_ms）。整数 µs、有理数、roundHalfUp 在 Rust 侧**目前零基础**。
- **测试现状**：workspace 内 92 个 `#[test]` + 4 个集成测试文件；`cargo test --target x86_64-pc-windows-gnu`（w64devkit GNU 工具链，见记忆配方）当前 110 个测试通过。

### 0.3 TS 侧资产位置与调用关系（已核实，R2-2 产物）

```
rhythm-trainer-frontend/src/score-engine/
  contract-v1/plan-fingerprint.ts        # TS 权威参考：projectScoreDocumentV1 / validateScoreDocumentV1 /
                                         #   validatePlanFingerprintPayloadV1 / buildPlanFingerprintPayloadV1 /
                                         #   computePlanFingerprintV1 / planFingerprintV1(强制门禁) / beatToMicroseconds(BigInt)
  contract-v1/contract-v1.test.ts        # 契约测试 + 6 固定向量断言（test-vectors/plan-fingerprint-v1.json）
  playback/playback-planner.ts           # buildPlaybackPlan / scoreOccurrencesToEngineAtoms（迁移语义源）
  playback/reference-playback-plan.ts    # filterPlaybackPlanByHand
  playback/score-events.ts               # buildEngineScoreEvents（wire，不动）
  scope/practice-scope.ts                # assessPracticeScope / handByScoreEventIdFromMapping / HandMappingV1
  parity/
    parity-diff.ts                       # diffCandidates(expected, candidate)——Rust 候选接入点（候选形状：ParityCandidate）
    parity-candidate.ts                  # buildTsCandidate（现行管线投影）/ computeL3Invariants / fingerprintStable
    parity-runner.ts                     # full/case/fault 模式；FAULT_SPECS 六项注入；ParityDiffReportV1
    normative-codes.ts                   # C 类规范码 + 服务端消息锚点映射
    case-bundle.ts                       # 15 冻结 case 加载（fixture sha256 校验）+ golden→expected 转换器
    acceptance-{a,b,c,v}.test.ts         # 四类验收（V 类: RUST_V_CLASS_STATUS='DEFERRED_TO_R2-3'，R2-3d 翻转）
    real-score-parity.test.ts            # 113 小节结构不变量（RHYTHM_REAL_SCORE_PATH 门禁）
audit-r1/contracts/test-vectors/plan-fingerprint-v1.json   # 6 向量（5 冻结 + V-rational-bpm）
```

**调用关系（R2-3 的接入设计）**：Rust planner 输出 JSON 候选（形状 = `ParityCandidate`）→ parity harness 的 `diffCandidates(goldenExpected, rustCandidate)` 双跑 → `ParityDiffReportV1`；L1 用同一份 `plan-fingerprint-v1.json` 向量做 N-FP-V1；fault 模式对 Rust 候选重跑六项注入。

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

**文档-实现冲突检查**：`CORE_API.md`/`IMPLEMENTATION_STATUS.md`/`README.md` 中 grep 无 planner/PlanFingerprint/ScoreDocumentV1/playback 声明——**文档未声称未实现的能力，无冲突**。需注意的两处边界（非冲突，记录在案）：
1. 现有 `build_schedule` 是 f64 ms 域且被生产使用——planner **不改造它**，新增独立入口；两者在 R2-3 期间并存（差分用 planner 通道）。
2. pattern id 的 `Date.now()` 问题（路线决策 D11）属生产切换后事项，本卡不动。

---

## 1. 依赖决策点（动工前需用户拍板，二选一）

**D-DEP：NFC + SHA-256 的实现方式。**

| 选项 | 内容 | 代价 | 风险 |
|---|---|---|---|
| A. 加依赖（推荐） | `sha2` + `unicode-normalization` + `serde_json`（保留方式）加入 `crates/rhythm-core` | 打破"零运行时依赖"传统；三 crate 均为生态标准、可审计 | 低；需在 CORE_API/README 更新依赖声明 |
| B. 手写 | SHA-256 手写（算法短、有 NIST 测试向量可自证）；JCS 数字/字符串序列化手写（需严格对 RFC 8785 §3.2.2.2 数字序列化 + JSON 转义）；**NFC 手写不可行**（Unicode 归一化表巨大，等价于重造 unicode-normalization） | 零依赖传统保持 | NFC 手写不现实 → B 实际不可行，除非 payload 保证 NFC 已在输入端完成——但契约规定投影前 NFC 是指纹流水线的一部分，Rust 必须自持 |

**推荐 A**：`unicode-normalization` 是 ICU 上游维护的标准 crate；零依赖传统让位于正确性。cargo 依赖变更随 R2-3a 提交并在 README 声明。**待用户批准。**

---

## 2. 阶段拆分与验收条件

### R2-3a：Rust 契约层（有理数 + µs + 投影/校验 + 指纹原语）

**新增文件**（`crates/rhythm-core/src/contract_v1/`，模块 `pub mod contract_v1;`）：
- `rational.rs`：`RationalV1 { numerator: i64, denominator: u64 }`，构造即约分（gcd）、分母>0、零=0/1、safe-integer 域检查；`add/sub/mul/cmp`（BigInt 等价：i128 交叉乘）；`is_canonical`。
- `time.rs`：`beat_to_microseconds(beat, bpm) -> Result<i64>`——`(n*60_000_000*bpm_den + den/2)/(den*bpm_num)` half-up，i128 中间积，超 2^53-1 → `TimeOutOfRange`；负拍/非正 BPM/未约分 → 显式错误（错误码对齐 TS：`INVALID_RATIONAL`/`NEGATIVE_TIME`/`INVALID_BPM`/`TIME_OUT_OF_RANGE`）。
- `document.rs`：`ScoreDocumentV1`/`ImportReportV1` 结构（serde 反序列化自 JSON）+ `project_score_document_v1` + `validate_score_document_v1`——**逐条移植** TS 校验（closed keys、约分有理数、ordinal 连续、tieSpan 双向、scoreRevisionId 公式、source locator 唯一、note/rest 时值规则、`DUPLICATE_PART_ID`/`DUPLICATE_XML_ID`/`DUPLICATE_EVENT_ID` 投影抛错、AJV 可表达的约束以代码等价实现并各配负例）。TS 侧负例矩阵（contract-v1.test.ts）逐条映射为 Rust 测试。
- `fingerprint.rs`：`nfc(input) -> String`（unicode-normalization `nfkc`? **否——必须 `nfc`**，与 TS `String.normalize('NFC')` 严格对应）；`jcs(value) -> String`（RFC 8785：键字典序（UTF-16 code-unit 序——注意与 Rust String 字节序差异，需按 UTF-16 排序键）、数字 ECMAScript Number::toString 等价序列化、字符串转义规则）；`sha256_hex`（sha2）；`compute_plan_fingerprint_v1(payload) -> Result<String>`；payload 结构 + `validate_plan_fingerprint_payload_v1`（closed keys、groupIndex 序列、组时值=最长成员、重复 locator、hand_mapping_conflict、empty_plan 等，错误码对齐）。
- `mod.rs`：门禁 `plan_fingerprint_v1(input)`——投影→文档校验→PLAN_DOCUMENT_MISMATCH→payload→哈希（顺序与 TS `plan-fingerprint.ts:1171` 一致，无旁路）。

**测试**（`crates/rhythm-core/src/contract_v1/` 内 `#[cfg(test)]` + `tests/contract_v1_vectors.rs`）：
- **N-FP-V1（本阶段核心验收）**：读 `audit-r1/contracts/test-vectors/plan-fingerprint-v1.json`，6 向量逐字节：`compute_plan_fingerprint_v1(payload) == expectedFingerprint` 且 canonical bytes 相等。**TS 侧翻转**：`acceptance-v.test.ts` 的 `RUST_V_CLASS_STATUS` 从 `DEFERRED_TO_R2-3` 改为 Rust 实测结果（本阶段唯一允许的 TS 文件改动）。
- 时间：G1–G5/rational-BPM 手推表复刻（685714/1371429/2057143/2742857 等）+ 边界（2^53、half-up .5、未约分拒绝）。
- 校验负例：TS 负例矩阵映射（≥20 项，与 TS 一一对应列表入测试注释）。

**命令**：`cargo test --manifest-path rhythm-trainer-core-v0.2/Cargo.toml --target x86_64-pc-windows-gnu`（全部绿，含既有 110 项无回归）+ `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/parity/acceptance-v`（TS 侧 V 类翻转后仍绿）。
**验收条件**：6 向量逐字节；负例矩阵映射完整；既有 Rust 测试零回归；无 FFI。
**依赖**：D-DEP 决策；固定向量文件只读。

### R2-3b：Planner 核心（语义迁移）

**新增**：`crates/rhythm-core/src/planner/`（`mod.rs`、`range.rs`、`hand.rs`、`groups.rs`、`passes.rs`）：
- 输入：`ScoreDocumentV1`（R2-3a 已可反序列化）+ `PlanRequest { partId, range, repeat_selection, hand, hand_mapping, bpm: RationalV1, ticks_per_quarter, count_in_us, unsupported_notation_policy }`。
- 语义逐条对齐 `playback-planner.ts`（file:line 引用写入注释）：事件收集过滤（rest/grace/cue 不进目标 :52-53）、tie 合并（续接不生成 occurrence、起点时值=endBeat−onset :61-73/:138）、playbackBeat 重定基+pass 偏移（:139-141）、排序键 playbackBeat→passIndex→bar→occurrenceId（:164-170）、playbackIndex 赋值（:171）、group 键 pass+beat、组时值=最长成员（:186-189）、staffNumbers/voiceIds 去重升序（:198-199）、loop 1–32（:96-99）、invalid_range/invalid_repeat_count/no_playable_notes 错误码。
- hand 过滤对齐 `reference-playback-plan.ts:103`（混合组缩减、**playbackIndex 不重编号**、`:hand=` planId 后缀而成员 ID 不变——R2-2 已冻结为基准语义）。
- 输出：`PlannerOutput { occurrences, groups, atoms }`（Rust 结构，可序列化为 harness 候选 JSON）。

**测试**：G1–G5/G1+A5/G1+A10×2×3/G3×range/G6×3/A4/A9/有理 BPM——15 冻结 case 的 Rust 侧结构断言（复用 GOLDEN_FIXTURES 推导值，**不改 golden**）；错误码负例（invalid_range×3、invalid_repeat_count×2、EMPTY_PLAN）。
**命令**：同 R2-3a。
**验收条件**：15 case 结构（occurrence/group/atom 计数与逐字段值）与手工真值一致；错误码一致。
**依赖**：R2-3a。

### R2-3c：NAPI DTO + parity 双跑接入

**修改**：`bindings/node/src/lib.rs` 新增导出（不改既有 57 个导出与 JsXxx DTO）：
- `plan_fingerprint_v1_gate(documentJson, reportJson, planJson, config) -> String`（门禁入口，错误 → napi Error 携带契约码）；
- `build_plan_v1(documentJson, configJson) -> String`（**返回 JSON 字符串**——harness 候选形状，避免新增大量 Js DTO；整数以字符串承载避免 f64 精度问题，harness 侧解析）；
- `index.d.ts` 同步类型。
**修改**：`parity-runner.ts` 增加 `--side=rust` 候选源（`build_plan_v1` 输出 → 反序列化为 `ParityCandidate` → `diffCandidates`）；fault 注入对 Rust 候选重跑；`acceptance-b` 增加 Rust 候选故障注入变体；`normative-codes` 的 C 类对 Rust 候选校验落地。
**命令**：`npm run build`（bindings）→ CLI full/fault 双侧模式；`npx vitest run src/score-engine/parity`。
**验收条件**：L1 相等（同一 bundle 双侧指纹逐字节）∧ L2 零未分类 ∧ L3 全绿——15/15 case 双侧 PASS；6/6 fault 对 Rust 候选全部捕获；unknown faultId 行为一致。
**依赖**：R2-3a + R2-3b；Node 侧 bundle 重建（esbuild）。
**边界**：不改 `build_schedule`、不改 `EngineScoreEvent` wire、不切 `RHYTHM_PLANNER`（开关设计留 R2-3d 后的实施尾卡或随切换卡）。

### R2-3d：迁移证据包 + 文档收尾

- §7 回归矩阵全量（双侧）+ §8 七条证据逐条落档 `audit-r1/reports/r2-3/`（JSON diff 报告 ×15 case + fault + 真实谱 113 小节：结构计数 1579/1018 + capabilities 5 值 + 双侧指纹稳定）；
- `acceptance-v.test.ts` V 类 Rust 断言常态化（不再是 DEFERRED）；
- `CORE_API.md`/`IMPLEMENTATION_STATUS.md` 更新（新增 planner/契约模块的如实描述）；
- 实施报告 `R2_3_RUST_PLANNER_IMPLEMENTATION_REPORT.md`（逐 case PASS/FAIL/SKIP、gitSha、版本）。
**验收条件**：§8 七条全绿；**生产权威仍不切换**（切换是独立决策卡，需另行审查）。
**依赖**：R2-3c。

---

## 3. 硬性约束（重申，全程有效）

1. 不修改冻结 golden（`g*.expected.json`、`test-vectors/plan-fingerprint-v1.json`、parity case index）迁就实现；发现预期不符 = 实现缺陷，按差异分类报告。
2. Rust 指纹自持：禁 FFI/子进程调 TS；NFC/JCS/SHA-256 全 Rust 实现。
3. 不改 `EngineScoreEvent` wire 协议；不改现有 `build_schedule`/scoring_v1/matcher 生产行为。
4. 不切生产权威；`RHYTHM_PLANNER` 开关不实现于本卡。
5. 提交走独立分支/提交序列，**不直接推送 main**（每阶段一组提交，待审查后合入——合入方式由用户指定）。
6. 不声称未运行的测试；所有命令实跑并留输出摘要。

## 4. 文档与实现的冲突/决策记录

| # | 发现 | 处置建议 |
|---|---|---|
| C-1 | rhythm-core 刻意零运行时依赖 vs NFC/SHA-256 必需 | §1 D-DEP，推荐加 `sha2`+`unicode-normalization`+`serde_json`，README 声明；**待拍板** |
| C-2 | 现有 `build_schedule` 为 f64 ms 域，冻结协议为整数 µs | 非冲突：planner 走独立入口，build_schedule 保持不动；两域并存至权威切换 |
| C-3 | JCS 键排序要求 UTF-16 code-unit 序 | Rust 实现须按 UTF-16 排序而非字节序（否则非 BMP 键会排错）——写入 R2-3a 实现要求与测试（含非 BMP 键负例） |
| C-4 | bindings DTO 全 f64 承载整数 | R2-3c 对指纹/planner 接口用 JSON 字符串承载整数，避开 f64 精度；既有 DTO 不动 |
| C-5 | 文档无 planner 能力声明 | 无冲突；R2-3d 完成后如实更新 CORE_API/IMPLEMENTATION_STATUS |

## 5. 实施顺序与第一个可独立验收切片

**顺序**：D-DEP 拍板 → **R2-3a（向量复现）** → R2-3b（planner 语义）→ R2-3c（双跑）→ R2-3d（证据）。
**依赖链**：a 独立可验收；b 依赖 a；c 依赖 a+b；d 依赖 c。

**第一个可独立验收切片 = R2-3a 的 N-FP-V1**：
> `cargo test --target x86_64-pc-windows-gnu contract_v1` 中 `committed_vectors_are_byte_exact` 测试通过——Rust 在零 FFI 前提下，对提交的 6 个向量（含非整数有理 BPM 的 V-rational-bpm）算出的 canonical bytes 与 SHA-256 指纹逐字节等于 `test-vectors/plan-fingerprint-v1.json` 的期望值，且既有 110 项 Rust 测试零回归、TS 侧 `acceptance-v` V 类翻转后绿。

该切片自含（不依赖 planner 语义），是全卡风险最高点（NFC/JCS/SHA 自持实现）的最早证伪点。
