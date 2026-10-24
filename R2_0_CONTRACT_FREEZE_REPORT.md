# R2-0 实施报告：ScoreDocumentV1 + planFingerprintV1 契约冻结

**日期：** 2026-10-24
**基线：** `main` @ `7198605`
**任务卡：** `R2_0_SCOREDOCUMENT_V1_PLAN_FINGERPRINT_V1_CONTRACT_FREEZE.md`
**边界遵守：** 未写 Rust planner、未切换生产评分权威、未改 `scoring_v1`、未改 importer/planner 语义、未改 UI 行为。

---

## 1. 交付物清单

| 文件 | 内容 |
|---|---|
| `audit-r1/contracts/score-document-v1.schema.json` | `ScoreDocumentV1` JSON Schema（draft 2020-12，自包含，封闭 capabilities 枚举） |
| `audit-r1/contracts/plan-fingerprint-payload-v1.schema.json` | `PlanFingerprintPayloadV1` JSON Schema |
| `audit-r1/docs/SCOREDOCUMENT_V1_CONTRACT.md` | 规范文本：身份三指纹、Rational 规则、结构、禁止项、版本策略 |
| `audit-r1/docs/PLAN_FINGERPRINT_V1.md` | 规范文本：payload、JCS+NFC+SHA-256 算法、必含/必排、时间量化、人工向量 |
| `rhythm-trainer-frontend/src/score-engine/contract-v1/plan-fingerprint.ts` | TS 参考实现（纯函数） |
| `rhythm-trainer-frontend/src/score-engine/contract-v1/contract-v1.test.ts` | 28 条契约测试 + 5 个手工向量 + 113 小节回归 |
| `rhythm-trainer-frontend/package.json` | devDependency `canonicalize`（RFC 8785 实现） |

## 2. 任务卡 §9 问题的回答

**1. 冻结的版本值**
- Schema：`schemaVersion: 1`；`normalizerVersion: "normalizer-1"`；`supportProfileVersion: "musicxml-v1.0"`；`plannerVersion`（参考实现用 `"planner-ref-1"`，Rust planner 落地时定值）；`fingerprintSchemaVersion: 1`。
- Schema 路径见 §1 表格。

**2. 三个身份的确切区别**
- `sourceFingerprint = sha256(UTF-8(原始 MusicXML 文本))`——来源文件逐字节身份；
- `scoreRevisionId = "score-revision-v1:sha256:" + sha256(JCS({sourceFingerprint, normalizerVersion}))`——语义 revision：同来源 + 同 normalizer 规则 ⇒ 同 revision；
- `planFingerprintV1 = "plan-v1:sha256:" + sha256(JCS(PlanFingerprintPayloadV1))`——revision + scope + tempo/repeat + 实际有序目标计划的计划身份。

**3. Rational 来源与失败策略**
- importer 内部 `RationalBeat {numerator,denominator}` → 直接 `rationalV1()` 约分拷贝（不经过 number）；
- TS `number`（BPM、`Pitch.alter`）→ `numberToRationalV1()`：非有限数抛 `NON_FINITE_NUMBER`；整数超安全范围抛 `RATIONAL_OUT_OF_RANGE`；非整数走规范十进制展开（`0.1` → `1/10`，不是二进制近似），分子/分母超界抛 `RATIONAL_OUT_OF_RANGE`；分母 ≤ 0 抛 `NON_POSITIVE_DENOMINATOR`。所有失败显式，无静默舍入。

**4. RFC 8785 实现**
- npm **`canonicalize`**（CJS default 导出为 canonicalize 函数；做了 ESM/CJS 互操作兼容）。
- NFC 由参考实现在 JCS **之前**深遍历强制（RFC 8785 不做文本归一化；任务卡要求 NFC，所以由我们执行）。
- 独立核验：测试内置第二个 oracle（手写 key 字典序递归 JCS + Node `crypto` sha256），与 `canonicalize`+模块路径交叉比对；5 个 golden 向量与 NFC/JCS/顺序基本测试都经由该 oracle。此外在 vitest 之外用独立脚本重算了 V-single = `plan-v1:sha256:3a6137fc22698cc52d47ff84cf3a41dbd50a091bf4a3a908dc9028e1adfd7939`，与测试一致。

**5. 运行时 ID 与指纹隔离**
- payload 完全不含 `event.id` / `occurrenceId` / `groupId` / `planId` / `Date.now()`。member 用语义 locator `{partId, measureOrdinal, sourceOrdinal, voiceId?}`（文档内唯一性由 V1 不变量保证）。测试断言 payload 的 key 列表无 `planId`、序列化文本无 `Date`，且同输入跨构造顺序指纹不变。

**6. capabilities 冻结枚举（15 值）**
`chords, cue, grace, microtone, multi_staff, multi_voice, multiple_parts, repeat, tempo_curve, ties, transpose, tuplets, unsupported_clef, unsupported_transpose, unrepresentable_pitch`
（inventory：importer 直接 add 14 个 + issue-code 派生 3 个 + measure 级 `chords/tuplets` 2 个，去重合并。）未知值在投影时降级为 `unknown_capability` issue 并**不进入** dto.capabilities（fail-closed：旧 validator 会拒绝未升级的枚举）。measure 级 capabilities 单独封闭为 `chords|tuplets`。

**7. 未完成的路线门（诚实清单）**
- **Rust planner 未实现、未验证**——本卡通过的是契约测试，不是 planner 验证；
- golden oracle 与 TS/Rust 差分框架是 R2 planner 的前置门，本卡只交付了 fingerprint 向量，不是 plan 语义差分；
- ImportReport V1 表达冻结为"职责边界"（§3 文档），完整 report schema 未在本卡展开；
- `Schema → ajv` 结构校验未引入（`validateScoreDocumentV1` 为手写闭合检查）；ajv 接线可在 R2 里加，不阻塞。

---

## 3. 关键实现决策

| 决策 | 理由 |
|---|---|
| `numberToRationalV1` 走十进制字符串展开 | 满足"不得把 IEEE-754 近似写进分子/分母"；`0.1→1/10` 有专门断言 |
| NFC 由我们做、JCS 不做 | RFC 8785 不归一化文本；任务卡要求 NFC；实测 `canonicalize` 不归一化，所以前置深遍历 |
| `buildUserHandMapping(partId, staves)` 签名（本卡内简化） | score 参数未使用；P1-4 的测试同步更新 |
| payload 含**实际生成的** targetGroups（不只有请求参数） | 任务卡 §4.1：目标顺序/成员语义必须进指纹，防"同参数不同计划"漏检 |
| member `pitch.midiNote` 非整数 → 抛 `UNMAPPABLE_PITCH` | 严格计划不允许不可映射音高进入指纹 |
| 空目标列表 → 拒绝（`EMPTY_PLAN`） | 与现有 no_playable_notes 阻断一致 |
| `beatToMicroseconds` = `floor(exact+0.5)`（仅非负） | time-conversion-v1 的"就近取整、.5 向上"；1/3 beat@60BPM → 333333，2/3 → 666667 |

## 4. 测试结果（全部实跑）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **35 files / 274 tests**（+28 契约测试） |
| `npm run build`（`tsc -b && vite build`） | 通过 4.02s |
| `npm run selftest` | 通过（251 条，引擎侧未变） |
| `cargo test --target x86_64-pc-windows-gnu` | 110（Rust 零改动，符合本卡边界） |

契约测试覆盖（对应任务卡 §5 清单）：
- 同 DTO 双投影一致（deep equal）；key 插入顺序不影响 canonical bytes/指纹；
- `2/4` 由 `rationalV1` 约分为 `1/2`；denominator 0 / 超界 / NaN / Infinity / 1e17 全部按码拒绝；
- whitespace 改动 → sourceFingerprint 与 scoreRevisionId 均变（revision 语义即如此）；
- scope（hand/range）、repeat、BPM、PPQ、count-in、plannerVersion、scoreRevisionId、normalizerVersion 任一变化 → 指纹变化（9 项 tamper 断言）；
- payload 不含 planId/Date；空 targetGroups 拒绝；
- 5 个手工向量（V-single / V-rest-gap / V-chord / V-tie / V-hand）与独立 oracle 一致且两两不同；V-chord 验证"成员异时值、组取最长"；
- 113 小节真实谱：投影成功、issues 为空、capabilities 恰为 5 个枚举值、指纹稳定（DTO 字节 >100KB 已记录）。

## 5. 尚未完成（不阻塞本卡，如实声明）

1. **Rust planner 与 TS↔Rust 差分**：本卡的向量是跨语言一致性基准，但 Rust 侧消费尚未存在——"contract tests passed" ≠ "planner verified"。
2. **plan 语义 golden 差分**（GOLDEN_FIXTURES 的 plan 逐字段对照 Rust 输出）仍是 R2 planner 的前置门。
3. ajv 或等价 validator 对两份 Schema 的自动校验接线（当前为手写闭合检查 + Schema 文档）。
4. ImportReport 的完整 V1 schema（本卡只冻结了职责边界与 capabilities 枚举）。
5. P09 待发射任务持久化、多 Part Part 选择器（方案 B）、零输入 `trustworthy` 标记——前几张卡记录的后续项，均未动。

## 6. 声明

**R2 Rust planner 尚未开始。** 本卡只冻结契约与参考实现。路线决策 P6（ScoreDocumentV1 契约）与本卡对应的 planFingerprint 部分（P7 的指纹定义）已完成；P7 的差分测试门与 golden oracle 门仍未完成，是 R2 planner 的开工前置。


---

## 7. 审查修正：四个验收缺口 + 配对保护 + 测试可复现性

审查 43253fb 指出的问题逐项修复：

### 7.1 P1-01 完整校验（指纹前 + 文档级）

- `validateScoreDocumentV1` 从根对象检查升级为**全量闭合校验**：封闭 key 集（`unexpected_field`）、必填 key、嵌套结构（part/measure/event/source/pitch/barline/tieSpan/tempoMark）、**约分有理数**（`isCanonicalRationalV1`：安全整数、分母>0、gcd=1、零=0/1）、唯一性（partId/ordinal 连续/eventId/xmlId）、**跨引用**（tieSpan→eventId 悬挂引用 `dangling_reference`）、语义（note 必有 pitch、rest 不得有、非 grace 时值为正、event.source.partId 与所属 part 一致）。
- 新增 `validatePlanFingerprintPayloadV1`：payload 级同强度校验（含 handMapping 封闭枚举拒绝 `clef-heuristic`、repeat 联合、tempo 正性、group/member/locator/pitch 逐项、groupIndex 唯一）。
- **`computePlanFingerprintV1` 在哈希前强制调用完整校验**，任何 issue 都抛 `PAYLOAD_VALIDATION_FAILED`（含全部 code）。缺 scope、未约分有理数、未知字段现在都在入口被拒。

### 7.2 P1-02 固定哈希向量（提交文件 + 硬断言）

- 新 fixture：`audit-r1/contracts/test-vectors/plan-fingerprint-v1.json`，含 5 个向量的 `payload`、`expectedCanonical`（JCS 规范化字节）与 `expectedFingerprint`。
- 生成走双路径：独立脚本（raw `canonicalize` + Node `crypto`）与参考实现交叉比对，分歧即中止（`contract-v1/generate-golden.ts`，带 `ts-nocheck`，仅构建用）。
- 测试**直接断言等于提交的固定哈希**（非运行时 oracle），并验证：canonical 字节可 round-trip、sha256(提交字节)===提交哈希、参考实现===提交哈希、5 向量两两不同。
- 冻结值：
  - V-single `0d798c3151a62dcc2c2e7ee4cb4b6a48c7587cf4945a8c62c43a2d92d99dffde4`
  - V-rest-gap `6771e36b1c73d37d24d9e55024e158674439d2975e6bba9ca1523fd4e2b12981`
  - V-chord `c922c4213bb299180b1e1b40c425333dbfdcac39425fb0a5321c379fe2919fa9`
  - V-tie `75298b49aff5eecb2d169810de4f92bba28f6acf1575f02630c398362cf388ca`
  - V-hand `4eadaffdeb795da2bb1f567fac487e8081d5f8318fcaedb1b7d10f2d384a3142`

### 7.3 P1-03 语义 locator（不再解析内部 ID）

- `PlaybackOccurrence` 新增 `sourcePartId`、`sourceMeasureOrdinal`、`sourceOrdinal`（`domain/types.ts`），由 planner 从 `ref.event.source` 直接填充（`playback-planner.ts`）。
- `buildPlanFingerprintPayloadV1` 的 member locator 改从这三个语义字段取值，**删除了 `scoreEventId.split(':')` 反解析**；occurrence 缺 locator 时抛 `LOCATOR_UNAVAILABLE`。含 '`:`' 的 partId 不再可能被错误切分。
- 注：这组新字段目前没有 Rust 消费者，属于向前兼容的领域扩展；planner 语义与既有输出不变（golden/importer 测试全绿佐证）。

### 7.4 P1-04 精确微秒 + 科学计数法

- `beatToMicroseconds` 改为 **BigInt 精确运算**：`floor((num*60_000_000*den + den/2)/den')`，中间乘积不再经过 IEEE-754；结果超安全整数抛 `TIME_OUT_OF_RANGE`；未约分有理数直接拒绝（`INVALID_RATIONAL`）。新增超 2^53 中间积测试（444,444,447 拍 @60BPM = 444,444,447,000,000 µs 精确）。
- `numberToRationalV1` 支持**科学计数法**十进制精确转换（`1e-7`→`1/10^7`、`-1.5e-3`→`-3/2000`、`2.5e3`→`2500/1`），按数字移位实现，不经过二进制近似。

### 7.5 Document/Report 配对保护

`projectScoreDocumentV1` 现在要求 `document.fingerprint === report.fingerprint`，不一致抛 `DOCUMENT_REPORT_MISMATCH`（防止用 B 的报告身份装 A 的音符）。有专门负例测试。

### 7.6 113 小节回归：干净环境可复现

真实谱测试改用 `it.skipIf(!existsSync(path))`：文件缺失时**跳过而非失败**，`npm test` 在无该本地文件的环境（CI/新克隆）可完整通过；本地有文件时照常执行完整回归（投影 + 全量校验零 issue + 指纹稳定）。

### 7.7 测试（修正后）

vitest **35 files / 280 tests**（契约测试 28→34：+科学计数法、+BigInt 边界、+配对拒绝、+文档悬挂引用/深树未约分/重复 ID、+payload 校验负例、+5 固定哈希断言）、`tsc -b && vite build`、selftest 251 通过；Rust 零改动。

### 7.8 文档同步

- `PLAN_FINGERPRINT_V1.md` §6 改为指向提交的 fixture 与 5 个完整冻结哈希；§3 时间量化改写为 BigInt 精确公式。
- `SCOREDOCUMENT_V1_CONTRACT.md` §2 补科学计数法规则。


---

## 8. R2-0A 验收修正：Schema 自动化校验、向量规范化路径、顺序语义与可复现性

依据任务卡 R2-0A 对 9e3b2ab 的增量要求逐项落实。§7 已完成的项（BigInt 微秒、科学计数法、Document/Report 配对、语义 locator、fail-closed 入口）不重复；本节只列新增改动与全部验收证据。

### 8.1 A：AJV Schema 自动化校验（schema-first）

- `plan-fingerprint.ts` 现在直接 import 两份**已提交的 Schema**（`audit-r1/contracts/*.schema.json`），用 **AJV（ajv/dist/2020，JSON Schema Draft 2020-12）** 编译；`validateScoreDocumentV1` 与 `validatePlanFingerprintPayloadV1` 先跑 Schema（违规映射为 `schema_violation` + instancePath），再叠加 Schema 表达不了的语义检查。**Schema 是权威，实现与 Schema 的一致性由此自动化，不再只是声明。**
- 新增语义检查：`groupIndex` 必须等于数组下标（`group_index_out_of_sequence`）、组时值 === 组内最长 member 时值（`group_duration_mismatch`）、同组内 member locator 不得重复（`duplicate_member_locator`）。
- 投影 fail-closed 收紧：重复 `partId`、未知 capability 从"记 issue 继续"改为**直接抛错**（`DUPLICATE_PART_ID` / `UNKNOWN_CAPABILITY`）——闭合枚举下的未知值是契约破裂，不是可丢弃的警告。
- 依赖：`ajv` 加入 devDependencies（仅 contract 参考实现引用；引擎服务与生产 UI 不依赖它）。

### 8.2 B：向量文件规范化路径

- 文件移至任务卡指定路径：`audit-r1/contracts/test-vectors/plan-fingerprint-v1.json`（原 `contracts/fixtures/plan-fingerprint.golden.json`，git mv 保留历史）。
- 重新生成验证：加入 handMapping 确定性排序后重跑生成器，**5 个哈希逐字节不变**（V-single `0d798c31…`、V-rest-gap `6771e36b…`、V-chord `c922c421…`、V-tie `75298b49a…`、V-hand `4eadaffd…`）——现有向量本就是排序后的形态，排序规则是行为澄清而非哈希变更，**无需升级 fingerprintSchemaVersion**。
- 文档全部改指新路径（PLAN_FINGERPRINT_V1.md §6、本报告 §7.2 的历史记录保留原文并已在 §8 更正引用）。

### 8.3 C：顺序语义与 ID 编码不变性

- `buildPlanFingerprintPayloadV1` 对 `HandMappingV1` 做**确定性排序**（parts 按 partId、staves 按 staffNumber）并在契约文档声明"映射是集合语义"。
- 新测试：
  - **交换等价映射**（staves 逆序输入）→ 指纹不变；
  - **内部 ID 编码不变性**：一致重命名所有 `occurrenceId`/`scoreEventId`/`groupId`/`planId`（不同前缀/格式）且语义来源不动 → 指纹逐字节相同；
  - **真实语义变化**（member 音高 +1）→ 指纹变化。

### 8.4 F：真实谱回归改环境变量

- 测试路径改为 `process.env.RHYTHM_REAL_SCORE_PATH`；未设置或文件不存在 → `it.skipIf` **跳过**（不是失败也不是通过）。
- 本机验证两种模式都跑过（见 §8.6 执行记录）。

### 8.5 修改文件与位置

| 文件 | 改动 |
|---|---|
| `contract-v1/plan-fingerprint.ts` | AJV 编译两份 Schema 并接入两个 validator；groupIndex 序列/组时值/重复 locator 语义检查；`canonicalHandMapping` 确定性排序；投影对重复 partId/未知 capability 抛错 |
| `contract-v1/contract-v1.test.ts` | +7 测试（Schema violation ×2、投影抛错、payload 语义负例、ID 编码不变性、音高篡改、映射顺序不变性）；真实谱改环境变量；向量路径更新 |
| `contract-v1/generate-golden.ts` | 输出路径改 test-vectors |
| `audit-r1/contracts/test-vectors/plan-fingerprint-v1.json` | 由 fixtures 路径 git mv 而来，内容未变 |
| `audit-r1/docs/PLAN_FINGERPRINT_V1.md` | 向量路径、映射顺序语义、（§3 时间量化与 §6 哈希表已在上轮更新） |
| `package.json` / lock | devDependency `ajv` |

### 8.6 执行记录（全部实跑，区分通过/跳过）

| 命令 | 环境 | 结果 |
|---|---|---|
| `npx vitest run`（全量） | **未设置** RHYTHM_REAL_SCORE_PATH（模拟干净克隆） | **36 files / 286 passed / 1 skipped**（契约文件 40 passed + 1 skipped） |
| `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/contract-v1` | 设置真实谱 | **41 passed / 0 skipped**（113 小节回归实际执行：投影 + validateScoreDocumentV1 零 issue + capabilities 5 枚举 + 指纹稳定） |
| `npm run build`（tsc -b && vite build） | — | 通过 4.60s |
| `npm run selftest` | — | 通过，251 条断言 |
| `cargo test --target x86_64-p64-windows-gnu` | — | **110**（6 个 test binary 全 ok；本卡零 Rust 改动） |

**跳过项**：仅"113 小节真实谱回归"在未设置环境变量时跳过；这是设计行为，**不计为通过**。

### 8.7 DoD 对照

- [x] 两份 Schema 与参考实现的一致性自动化验证（AJV 直接编译已提交 Schema + schema_violation 负例）
- [x] fingerprint 入口完整校验、非法 payload fail-closed（含新增 groupIndex/组时值/重复 locator）
- [x] 五个 golden vectors 固定 canonical JSON + 固定哈希断言（重生成后哈希不变）
- [x] 来源定位符独立于内部 ID 编码（重命名全部内部 ID → 指纹不变，测试证明）
- [x] Rational/微秒精度边界（BigInt + 科学计数法，§7.4 已交付，本轮无回归）
- [x] Document/Report 指纹错配拒绝（§7.5 已交付）
- [x] 干净环境可运行常规测试（286 passed / 1 skipped，唯一 skipped 是可选真实谱回归）
- [x] 实施报告与代码、测试数字一致
- [x] **Rust planner 仍未启动**
