# planFingerprintV1 契约（冻结）

**状态：** 冻结（R2-0）
**Payload Schema：** [`audit-r1/contracts/plan-fingerprint-payload-v1.schema.json`](../contracts/plan-fingerprint-payload-v1.schema.json)（`fingerprintSchemaVersion: 1`）
**参考实现：** `rhythm-trainer-frontend/src/score-engine/contract-v1/plan-fingerprint.ts`
**输出格式：** `plan-v1:sha256:<64 lowercase hex>`

---

## 1. 它标识什么（以及不是什么）

`planFingerprintV1` 标识：**某个 score revision 在给定 planner 规则、练习范围/手别映射、repeat、tempo 约定与实际生成的有序目标计划下的计划**。

它不是：
- `planId`（当前 `plan:…:m1-2:once:playback-planner-1.0.0` 字符串，含构造时间语义，仅供日志/调试）；
- `source.sourceFingerprint`（来源文件逐字节身份）；
- `scoreRevisionId`（来源 + normalizer 的语义 revision）。

## 2. 哈希算法（规范步骤）

1. 构造 `PlanFingerprintPayloadV1` 并通过 Schema 校验（结构、封闭枚举、Rational 约分）。
2. 所有字符串值做 Unicode **NFC** 归一化（深遍历；RFC 8785 本身不归一化文本，NFC 由本契约在 JCS 之前强制执行）。
3. 使用 **RFC 8785 JCS**（实现：npm `canonicalize`）生成唯一 JSON 字节序列。禁止依赖 `JSON.stringify` 的 key 插入顺序。
4. 对 JCS 输出的 UTF-8 字节计算 SHA-256。
5. 输出 `plan-v1:sha256:<64 lowercase hex>`。

## 3. Payload 内容（必含 / 必排）

**必含**（任何一项变化 ⇒ 指纹变化，均有测试断言）：
`fingerprintSchemaVersion`、`plannerVersion`、`scoreRevisionId`、`normalizerVersion`、`supportProfileVersion`、scope（partId、range、hand、**用户确认的** HandMappingV1，`clef-heuristic` 不得进入）、repeatSelection、tempo（Rational BPM、PPQ、Rational count-in、timeOrigin）、**实际生成的有序 target groups**（顺序 index、pass、bar、相对 onset、组时值、beat-in-measure、staff/voice、以及每个 member 的语义 locator + pitch + 单音时值 + tie 标志）。

**必排**：当前时间、随机数、设备/MIDI 输入、演奏表现与成绩、文件路径/文件名、UI 状态、OSMD anchor、诊断文案、key 插入顺序、临时 `planId`/`occurrenceId`/`groupId` 字符串（用语义 locator 替代）、墙上时钟、**HandMappingV1.parts 与 staves 的数组输入顺序**（映射是集合语义：入口按 partId/staffNumber 确定性排序，交换等价映射不改变指纹）。

**时间量化**：TargetSchedule 需要整数时间时用**整数微秒**，`µs = floor((beat.num × 60_000_000 × bpm.den + bpm.num × beat.den / 2) / (beat.den × bpm.num))`（非负 round-half-up），**中间乘积用 BigInt 精确运算**，不依赖 IEEE-754（乘积超过 2^53 时浮点会偏离精确半数规则；参考实现与测试都有超界用例）。规则版本化（`time-conversion-v1`），TS 参考实现与未来 Rust 实现共用同一批测试向量。不可精确落到 PPQ tick 网格的目标沿用现有 `tick_grid_rounding` 阻断，不得悄悄改节奏。

## 4. 临时 ID 的隔离

当前实现的 `event.id`（含 fingerprint 前缀）、`occurrenceId`、`groupId`（含 `planId`、`Date.now()` 生成的 pattern id）是**运行时字符串**，不进入指纹 payload。member 用语义 locator：

```
sourceLocator = { partId, measureOrdinal, sourceOrdinal, voiceId? }
```

该三元组在文档内唯一（由 ScoreDocumentV1 的唯一性不变量保证），跨语言、跨时间稳定。同一输入在任何机器、任何时间生成相同 payload 字节 → 相同指纹。

## 5. 版本策略

见 `SCOREDOCUMENT_V1_CONTRACT.md` §5。要点：payload 结构、JCS、hash 算法或时间量化规则任一变化 → `fingerprintSchemaVersion` 升级 + golden vectors 更新；历史报告不重算。

## 6. 人工核对向量（跨语言基准）

5 组固定向量提交于 [`contracts/test-vectors/plan-fingerprint-v1.json`](../contracts/test-vectors/plan-fingerprint-v1.json)，每个向量含 payload、规范化 JSON 字节（`expectedCanonical`）与期望 SHA-256（`expectedFingerprint`）。期望值由独立生成脚本（raw `canonicalize` + Node `crypto`）产出并与参考实现交叉比对，分歧即中止；测试直接断言等于**提交的固定哈希**，不是运行时 oracle：

| 向量 | 内容 | 期望指纹 |
|---|---|---|
| V-single | 单音 1 组 | `plan-v1:sha256:0d798c3151a62dcc2c2e7e4cb4b6a48c7587cf4945a8c62c43a2d92d99dffde4` |
| V-rest-gap | 两个 onset（含休止隔开的时距） | `plan-v1:sha256:6771e36b1c73d37d24d9e55024e158674439d2975e6bba9ca1523fd4e2b12981` |
| V-chord | 同 onset 两 member、异时值（组取最长） | `plan-v1:sha256:c922c4213bb299180b1e1b40c425333dbfdcac39425fb0a5321c379fe2919fa9` |
| V-tie | tie onset（1 组，`isTieOnset=true`，合并时值） | `plan-v1:sha256:75298b49aff5eecb2d169810de4f92bba28f6acf1575f02630c398362cf388ca` |
| V-hand | 与 V-single 仅 hand/mapping 不同 | `plan-v1:sha256:4eadaffdeb795da2bb1f567fac487e8081d5f8318fcaedb1b7d10f2d384a3142` |

防回归语义：任何对 payload 结构、JCS、NFC、SHA-256 或时间量化的改动，若改变了这些向量的哈希，测试立即失败；升级 `fingerprintSchemaVersion` 并重新生成/人工复核向量是唯一合法路径。
