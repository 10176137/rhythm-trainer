# Rhythm Trainer 开发者架构（截至 1b48e8e）

> **同步说明**：本文取代基于 f9ab52fe 的旧版架构描述。旧版中"契约校验仍待完善、负例测试待补"的表述已过时——R2-0B（1b48e8e）已完成下述全部内容。本文描述的是当前 `main` 的真实状态。
>
> **迁移状态**：R2 Rust planner **尚未启动**。当前交付的是 R2-0 契约冻结 + R2-0A/R2-0B 验收修正；评分权威仍是 TS importer/planner + Rust `scoring_v1`（经 NAPI），没有发生生产评分权威切换。

## 1. 仓库布局

```
rhythm-trainer-frontend/     React + TS 前端 + 本地引擎服务（Node）+ 契约参考实现
  src/score-engine/            语义域（importer、planner、contract-v1、scope）
  src/features/                practice/playback/midi/score 功能层
  server/                      引擎服务（WebSocket + REST + Rust NAPI 宿主）
rhythm-trainer-core-v0.2/    Rust 核心（scoring_v1、midi、take、schedule）+ napi 绑定
audit-r1/                    R1 迁移审计交付物 + 契约 + 固定向量 + 证据
```

## 2. 乐谱语义链（生产路径）

```
MusicXML
  → importMusicXml()               importer（fail-closed：重复 xmlId、未知 capability、
  │                                 时值超界等全部拒绝；R2-0 后新增 duplicate_xml_id）
  → ScoreDocument（RationalBeat 精确拍）
  → buildPlaybackPlan()            occurrences + groups（occurrenceId 每 pass 唯一；
  │                                 R2-0B 起每个 occurrence 携带语义 locator
  │                                 sourcePartId/sourceMeasureOrdinal/sourceOrdinal）
  → scoreOccurrencesToEngineAtoms()  EngineAtom[]（实时目标，Rust buildSchedule 消费）
  → buildEngineScoreEvents()       EngineScoreEvent[]（最终评分目标）
  → 手别过滤                        filterPlaybackPlanByHand()（P1-4：必须显式
                                    HandMappingV1，谱号推断被拒绝）
```

## 3. 契约层（R2-0 冻结，audit-r1/contracts/）

| 交付物 | 位置 | 说明 |
|---|---|---|
| ScoreDocumentV1 Schema | `contracts/score-document-v1.schema.json` | 语言无关 DTO；RationalV1 必须约分、分母>0、零=0/1；capabilities 封闭枚举（15 值） |
| PlanFingerprintPayloadV1 Schema | `contracts/plan-fingerprint-payload-v1.schema.json` | 指纹输入的完整结构 |
| 参考实现 | `src/score-engine/contract-v1/plan-fingerprint.ts` | projectScoreDocumentV1 / validateScoreDocumentV1 / validatePlanFingerprintPayloadV1 / buildPlanFingerprintPayloadV1 / computePlanFingerprintV1 / planFingerprintV1 / beatToMicroseconds |
| 固定向量 | `contracts/test-vectors/plan-fingerprint-v1.json` | 5 组（single/rest-gap/chord/tie/hand），每组含 payload + canonical bytes + 期望 sha256 |
| 黄金生成器 | `src/score-engine/contract-v1/generate-golden.ts` | 仓库相对路径发现；双路径（独立 JCS+crypto vs 参考实现）交叉验证，分歧即中止 |

### 3.1 强制校验门（R2-0B）

`planFingerprintV1()` 是唯一受支持的端到端入口，依次执行：

1. `projectScoreDocumentV1`：投影 + fail-closed 不变量（重复 eventId/partId/xmlId、未知 capability、Document↔Report 指纹配对）；
2. `validateScoreDocumentV1`：AJV（Draft 2020-12，直接编译已提交 Schema）+ 语义闭合检查（约分有理数、连续 ordinal、tieSpan 双向引用、scoreRevisionId 公式、文档级 locator 唯一、note/rest 时值规则）；
3. `PLAN_DOCUMENT_MISMATCH`：plan.scoreFingerprint 必须等于 report.fingerprint；
4. `computePlanFingerprintV1`：payload 全量校验（`PAYLOAD_VALIDATION_FAILED`）后哈希。

不合法的 ScoreDocumentV1 无法通过该入口到达指纹——不存在"调用方自行决定是否校验"的旁路。

### 3.2 指纹 payload 的循环轮次语义（R2-0B）

成员与 passIndex **只经 `group.occurrenceIds`**（pass 内唯一）解析；scoreEventId 非
唯一、永不用于查找。fail-closed 错误码：`OCCURRENCE_REUSED`、
`OCCURRENCE_NOT_IN_PLAN`、`DUPLICATE_OCCURRENCE_ID`、`GROUP_ID_MISMATCH`
（occurrence↔scoreEventId 配对交叉校验）、`GROUP_PASS_MISMATCH`（单组混 pass）。

### 3.3 指纹不变量的实现位置（file:line，1b48e8e）

| 不变量 | 位置 |
|---|---|
| occurrenceId 唯一 / OCCURRENCE_REUSED / 配对交叉校验 | plan-fingerprint.ts:806-850 |
| 组时值 === 组内最长 member（BigInt 比较） | plan-fingerprint.ts:1126-1132（`rationalGreaterThan` :773） |
| 组 groupIndex === 数组下标 | payload validator（`group_index_out_of_sequence`） |
| 文档级 source locator 唯一 | validateEvent（`duplicate_source_locator`） |
| event.source.measureOrdinal === 父 measure.ordinal | validateScoreDocumentV1（`source_measure_mismatch`） |
| tieSpan 双向引用 + ID 唯一 | validateScoreDocumentV1（`duplicate_tie_span_id` / `dangling_reference` / `tie_reference_mismatch`） |
| scoreRevisionId === sha256(JCS({sourceFingerprint, normalizerVersion})) | validateScoreDocumentV1（`revision_id_mismatch`） |
| playbackPlanId 缺 scoreEvents 拒绝 | engine-server.mjs start 入口门 |
| HandMapping 冲突（重复 part/staff/双手） | payload validator（`hand_mapping_conflict`） |

## 4. 评分与输入链（未因 R2-0 变化）

- 实时判定：浏览器 raw packets → Node → Rust `HitMatcher`；P1-2/P1-2B 的
  admission ledger 在 Node 入口拦截暂停/乱序/重复/时钟不可用输入
  （`suppressionReason: paused | clock | count-in | duplicate | out-of-order`）。
- 最终评分：Take 结束后 `scorePerformance`（Rust `scoring_v1`）。
- 时钟：四时间戳 + P1-2 入口准入账本（`admission-1`）。

## 5. 测试矩阵（当前基线）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 37 files / 305 passed / 1 skipped（跳过 = 未设 RHYTHM_REAL_SCORE_PATH 的可选真实谱回归） |
| `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/contract-v1` | 60/60（含 113 小节真实谱） |
| `npm run build` | 通过 |
| `npm run selftest` | 251 断言 |
| `cargo test --target x86_64-pc-windows-gnu` | 110 |

## 6. 迁移状态与未完成项

- **已完成**：G0 真机四项、P1-2/P1-2B、P1-3、P1-4、R2-0（契约冻结 + A/B 修正）。前置条件正式状态（d7d4472 复审，2026-10-24）：**P6 CLOSED；P7 Contract CLOSED；TS↔Rust Golden 语义差分 / Parity Gate OPEN**（见 `R2_R3_ROUTE_DECISION.md` §5.1）。
- **未启动**：R2 Rust planner，以及"**Rust 规划器输出 vs 独立 golden 真值**"的逐字段语义差分。注意：G1–G5 手工推导 golden 及针对 **TypeScript** 实现的差分测试已存在并通过（`GOLDEN_FIXTURES.md`）——尚未开始的只是 Rust 侧输出与这些真值的对照，不是整个项目都没有 golden 测试。
- **已知后续卡**：R2-2 parity harness 与固定用例落地（先）→ R2-3 Rust planner 实施（后）——验收规则已由 R2-1 四轮复审 **Accepted/Frozen**（[TS_RUST_PARITY_GATE_V1.md](TS_RUST_PARITY_GATE_V1.md) @ 838cd9b：逐字段映射、三层比较协议、四类验收测试、迁移证据门槛）；P09 待发射任务持久化、多 Part Part 选择器（方案 B）、零输入
  `trustworthy` 标记。关于"AJV 独立 CI 校验"：不再单列后续卡——AJV 已在参考实现内直接编译两份已提交 Schema（schema-first，`schema_violation` 负例保证实现与 Schema 一致）；独立于参考实现的第二套 Schema 校验将由 R2 Rust planner 消费同一 Schema 时自然形成，其验收已并入 Parity Gate（N-FP-1 等）。
- 历史细节：`R2_0_CONTRACT_FREEZE_REPORT.md`（§6–§11 含每轮审查的修复与证据、复审结论）。
