# ScoreDocumentV1 契约（冻结）

**状态：** 冻结（R2-0）
**Schema：** [`audit-r1/contracts/score-document-v1.schema.json`](../contracts/score-document-v1.schema.json)（`schemaVersion: 1`）
**参考实现：** `rhythm-trainer-frontend/src/score-engine/contract-v1/`
**本文件是规范文本；Schema 负责结构校验。两者冲突时，以更严格的解释为准并在报告中记录。**

---

## 1. 身份与三个指纹的区别

| 名称 | 算法 | 输入 | 语义 |
|---|---|---|---|
| `source.sourceFingerprint` | `sha256(UTF-8(原始 MusicXML 文本))` | 原始字节 | **来源文件**的逐字节身份；任何空白改动都会变化 |
| `scoreRevisionId` | `"score-revision-v1:sha256:" + hex(sha256(JCS({sourceFingerprint, normalizerVersion})))` | 规范化输入 `{sourceFingerprint, normalizerVersion}`（JSON 对象，JCS 序列化） | **语义文档 revision**：同一来源 + 同一 normalizer 规则 ⇒ 同一 revision |
| `planFingerprintV1` | 见 [PLAN_FINGERPRINT_V1.md](PLAN_FINGERPRINT_V1.md) | `PlanFingerprintPayloadV1` | **某 revision 在给定 scope/tempo/repeat 与实际目标计划**下的计划 |

规则：
- hash 一律对 JCS 规范化后的 UTF-8 字节计算 SHA-256，hex 小写。
- `scoreRevisionId` 的输入对象只有两个键 `{sourceFingerprint, normalizerVersion}`；扩展输入 = 升级 revision 前缀版本号（`score-revision-v2:…`）。
- `normalizerVersion` 变化 → 同一来源得到不同 revision（语义解释规则变了）。当前值：`normalizer-1`（对应 importer `SCORE_ENGINE_VERSION = 1.0.0` 的语义行为）。

---

## 2. 有理数 RationalV1

```json
{"numerator": 1, "denominator": 3}
```

- 分子/分母为 JSON 安全整数（|n| ≤ 2^53−1）；分母 ≥ 1；
- **必须约分**：`gcd(|numerator|, denominator) = 1`；零唯一表示为 `0/1`；
- 禁止浮点、NaN/Infinity、负分母；
- 语义时间量（onset/duration/startBeat/tie 起止）与 `Pitch.alter`、`TempoMarkV1.bpm`、`tempo.bpm`、`tempo.countInBeats` 全部使用 RationalV1；
- 计数（`divisions`、`ordinal`、`staffNumber`、`sourceOrdinal`、`ticksPerQuarter`、拍号等）为整数。

**TS number → RationalV1 适配规则**（参考实现 `numberToRationalV1`）：
1. 非有限数 → 抛 `ContractError('NON_FINITE_NUMBER')`；
2. 整数 → `{n, 1}`；
3. 非整数：写十进制展开（`String(value)` 的规范十进制形式），作为精确十进制分数约分（例如 `0.3333333333333333` → `3333333333333333/10^16`）。**不允许**把 IEEE-754 二进制近似直接当作分子/分母，也不允许静默四舍五入到某个网格；
4. 分母超出安全整数或约分后仍非有限 → 抛错。

> 推论：`scoreEvents.ts` 的 `beatPosition: toNumber(...)` 这类浮点字段**不会**进入 V1；V1 只携带 Rational。投影器从 RationalBeat 直接取 `{n,d}`，不走 number。

---

## 3. 结构

冻结字段与 Schema 一致，要点：

- **数组顺序有语义**：parts 保留来源顺序；measures 按 ordinal；events 保留 measure 内 `<note>` 的 source order（含 rest/chord 成员，`sourceOrdinal` 不可重编）；tie span 的 `eventIds` 按连接顺序。对象 key 顺序**无**语义（JCS 处理）。
- **唯一性**：`partId` 文档内唯一；同一 part 的 measure ordinal 从 1 连续唯一；`eventId` 文档内唯一；`xmlId` 若存在必须全文唯一（重复由 importer 以 `duplicate_xml_id` 阻断，投影器二次校验）。
- `PitchV1.midiNote: integer | null`：`null` 明确表示不可映射（如微音高），**不得改写为 0**；`kind:"note"` 必须有 pitch，`kind:"rest"` 不得有 pitch（Schema allOf 强制）。
- grace 事件允许零时值（`0/1`）；普通 note/rest 时值必须为正。
- **Hand 不在 ScoreDocumentV1 里**。手别属于 plan request（`HandMappingV1`/`PracticeScopeV1`，P1-4 已实现）。`HandMappingV1.source` 的封闭枚举只有 `user|score-metadata`；`clef-heuristic` 不得进入指纹 payload。
- **ImportReport 与语义文档分离**：诊断、状态、文案、warning 数量不进入 V1 文档，也不进入 planFingerprint；strict 能否启动仍由导入 gate 判定。`capabilities` 是从 importer 盘点冻结的**封闭枚举**（15 个值，见 Schema），出现未知值 = 升级枚举版本，旧 validator fail-closed。

---

## 4. 禁止项

V1 文档与指纹 payload 中不得出现：TS class 实例、函数、Map/Set、`undefined`、BigInt、DOM/OSMD 节点、运行时缓存、`Date.now()`/随机数生成的 ID、UI 文案、设备状态、Take/成绩状态、文件路径。可选字段缺省就省略（JSON 里不写），`null` 只用于 Schema 显式标注的可空字段（当前仅 `midiNote`）。

## 5. 版本策略

| 字段 | 何时升级 | 未知值行为 |
|---|---|---|
| `schemaVersion` | wire shape 不兼容 | validator 拒绝 |
| `normalizerVersion` | 语义解释规则变化（即使 Schema 不变） | 不匹配预期值时由消费方决定；指纹永远包含它 |
| `supportProfileVersion` | MusicXML 子集/strict 阻断规则变化 | 同上 |
| `plannerVersion` | target 顺序/分组/tie/chord/量化/范围/手别过滤规则变化 | 进指纹，变化即换指纹 |
| `fingerprintSchemaVersion` | 指纹 payload 结构、canonicalization 或 hash 算法变化 | hash 拒绝 |

历史 Take/report 不重算；旧记录无 V1 字段时显示 `unavailable/legacy`。
