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
