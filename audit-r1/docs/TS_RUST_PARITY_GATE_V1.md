# TS↔Rust Parity Gate V1（R2-1：Golden 语义差分与对照门槛——验收规则冻结）

**日期：** 2026-10-24
**基线：** `main` @ `9361f7c`
**性质：** **验收规则设计冻结**。本卡不实现 Rust planner、不改 TS 语义、不切生产权威（Rust planner 未启动）。
**上位文档：** 卡定义见 `R2_0_CONTRACT_FREEZE_REPORT.md` §11、前置条件状态见 `R2_R3_ROUTE_DECISION.md` §5.1、真值纪律见 `GOLDEN_FIXTURES.md`。

> **本卡要回答的四个问题**（完成标准）：任何开发者开始实现 Rust planner 前，能明确知道——
> ① 输入是什么（§2）；② 输出比较哪些字段、怎么比（§3–§4）；③ 哪些差异允许、哪些必须阻断（§5）；
> ④ 什么证据才能宣布迁移通过（§6 负例清单、§7 回归矩阵、§8 迁移证据）。

---

## 1. 迁移语义模型（比较什么）

R2 的迁移对象是**规划语义**（时间轴/顺序/目标），不是解析（R3）也不是评分（R5）。双侧对照的生产链：

```
TS legacyReference（现状，行为保持基准）              Rust planner（R2 待实现）
MusicXML → importMusicXml() → ScoreDocument    →    ScoreDocumentV1（同一契约 Schema）
  → buildPlaybackPlan()            playback-planner.ts:89       │
  → filterPlaybackPlanByHand()     reference-playback-plan.ts:103│ NAPI
  → scoreOccurrencesToEngineAtoms() playback-planner.ts:242      ▼
  → buildEngineScoreEvents()       score-events.ts:11         PlaybackPlanV1 + planFingerprintV1
```

**输入语义相同（同一 ScoreDocumentV1 + 同一练习配置），输出必须语义相同。**
比较分四层对象：occurrence（逐音）、group（起音组）、EngineAtom（调度目标）、EngineScoreEvent（评分目标）。

---

## 2. 冻结的差分输入（case bundle）

每个 parity case = **字节冻结的 MusicXML fixture + 以下冻结配置**。两侧必须消费同一份 bundle：

| 输入 | 类型/规则 | 依据 |
|---|---|---|
| MusicXML 文件字节 | 逐字节冻结；改动即新 case（sourceFingerprint/scoreRevisionId 必变） | R2-0 契约 §2.2 |
| `partId` | 单 part 谱内显式选择；多 part 仍被上游拒绝（P5 方案 A） | `HAND_AND_MULTIPART_CONTRACT.md` |
| `range` | start/end measure ordinal（1-based，end ≥ start，end ≤ measureCount） | playback-planner.ts:93 |
| `repeatSelection` | `none` 或 `range-loop count`（1–32，:37/:97）；**练习循环，非乐谱反复** | GOLDEN_FIXTURES A10 |
| `HandMappingV1` + `hand` | `source:'user'`；`clef-heuristic` 对 strict 拒绝 | practice-scope.ts:118 |
| `bpm` / `ticksPerQuarter` | 20–300 / 默认 960 | tempo-map.ts:11-12 |
| `CountInUs` | **整数 µs 输入**；`countInBeats = CountInUs × bpm / 60_000_000` 按精确有理推导（payload `tempo.countInBeats` 即此值，禁止 float 参与指纹） | GOLDEN_FIXTURES §1.3 |
| `unsupportedNotationPolicy` | `reject-strict` \| `allow-display-only` | types.ts:260 |
| **`plannerVersion`（差分公共值）** | payload 的**显式输入**（plan-fingerprint.ts:896、门禁 :1204），**双侧必须传同一冻结值**；各实现的生产 plannerVersion 字符串不参与差分比较 | R2-0 报告 §2.1 |
| 规则版本 | `time-conversion-v1`、`fingerprintSchemaVersion=1`、`normalizer-1`、`musicxml-v1.0` | 冻结契约 |

**禁止**：任何一侧从运行时状态（`Date.now()`、环境变量、UI 状态）引入输入。

---

## 3. 逐字段验收规则（映射与比较方法）

比较规则四级：**【精确】**值完全相等（有理数用 BigInt 交叉相乘比较，契约 `isCanonicalRationalV1` 同规则）；**【结构】**按生成规则比较、不逐字节；**【显示】**serialization-only，不得作语义断言源；**【真值协议】**见 §3.5。

### 3.1 occurrence 级（TS 来源 `types.ts:263-285`，填充 `playback-planner.ts:135-163`）

| PlaybackPlanV1 字段 | TS 来源 | 规则 |
|---|---|---|
| `sourceLocator {partId, measureOrdinal, sourceOrdinal}` | sourcePartId/sourceMeasureOrdinal/sourceOrdinal（:146-148，R2-0A 语义 locator） | **【精确】身份锚，比较主键** |
| `voiceId` | occurrence.voiceId | 【精确】 |
| `passIndex` | passIndex（pass 偏移 = rangeDurationBeat×pass，:136） | 【精确】 |
| `playbackBeat` | playbackBeat（range 相对 + pass 偏移，:139-141） | 【精确·有理】 |
| `durationBeat` | tie 起点 = `span.endBeat − onsetBeat`（:61-67）；续接事件不生成 occurrence（:138） | 【精确·有理】 |
| `measureOrdinal` / `bar` | :151/:154（tie 记**起点**小节） | 【精确】 |
| `beatInMeasure` | :153 | 【精确·有理】 |
| `staffNumber` | :155 | 【精确】 |
| `pitch {step, alter, octave, midiNote, spelling}` | types.ts:71-80；midiNote 非整数已被契约拒（`UNMAPPABLE_PITCH`） | 【精确】全字段 |
| `isTieOnset` | :160 | 【精确】 |
| 和弦等价类 | chordGroupId 同值分组（types.ts:118-119） | 【结构】比较"哪些成员同组"的**等价类划分**，不比较 ID 字符串（ID 内嵌 eventId） |
| `playbackIndex` | 排序后下标；排序键冻结为 playbackBeat→passIndex→bar→occurrenceId（:164-171） | 【精确】序列逐位相等 |
| `occurrenceId` | `planId:p{pass}:{scoreEventId}`（:144） | 【结构】planId 含 plannerVersion 字符串，字节必不同；比较生成规则与唯一性 |

### 3.2 group 级（`playback-planner.ts:173-206`）

| 字段 | 规则 |
|---|---|
| 分组键 `passIndex:playbackBeat`（:175） | 【精确】同拍跨 pass **不**合并为同组 |
| 成员表（occurrenceIds/scoreEventIds 顺序） | 【精确·经 locator 等价】顺序逐位相等 |
| `pitches` 顺序 = XML 顺序（GOLDEN_FIXTURES §3.4-2） | 【精确】 |
| `durationBeat` = 组内**最长**成员（:186-189） | 【精确·有理】（BigInt 比较，R2-0B） |
| `staffNumbers`/`voiceIds` 去重升序（:198-199） | 【精确】 |
| `bar` / `beatInMeasure`（:196-197，loop pass 不平移 bar） | 【精确】 |
| `groupId` | 【结构】 |

### 3.3 EngineAtom 级（每组 1 个 atom，`playback-planner.ts:242-270`）

| 字段 | 规则 |
|---|---|
| `startTick` = playbackBeat×PPQ | 【精确·整数】**必须整除**（:272-277），不整除 → `tick_grid_rounding` 阻断，禁止取整 |
| `durationTicks` = group.durationBeat×PPQ（`max(1,·)`，:264） | 【精确·整数】 |
| `bar` | 【精确】 |
| `beat` = beatInMeasure(num/den)+1（:266） | 【显示】浮点除法结果；比较按同一公式的有理等式判定，不作语义断言源 |
| 不含 pitch/音数 | 已知表达力边界（engine-server.mjs:1506-1507 注释）；差分**不**要求 atom 携带，逐音语义由 scoreEvent 层承担 |

### 3.4 EngineScoreEvent 级（每 occurrence 1 条，`score-events.ts:11-41`）

| 字段 | 规则 |
|---|---|
| `scoreEventId` = occurrenceId | 【结构】 |
| `measure` = bar（:31） | 【精确】 |
| `pitch`（int 0–127） | 【精确】 |
| `targetOnsetMs` / `targetDurationMs` | **【真值协议】**见 §3.5 |
| `beatPosition` | 【显示】（GOLDEN_FIXTURES §5.5 已分类 serialization-only） |
| `partId` = `staff-{staffNumber}:voice-{voiceId}`（:35） | 【结构·已知映射】确定性派生自 staffNumber+voiceId，**不是** sourcePartId；多 part 同 staff/voice 撞名被 P5 上游拒绝。Rust 侧输出真实 `sourcePartId`+staff+voice，差分按派生规则核对 wire 值 |
| `parseConfidence` = 1（设计债 D13） | 【精确】常量 |

### 3.5 时间真值协议（冻结，`time-conversion-v1`）

- **真值**：`PlanOffsetUs = sign·floor(|n×60_000_000|/(bpm·d) + 1/2)`（half away from zero，BigInt 精确，等价 `beatToMicroseconds`）；`TargetOnsetUs = CountInUs + PlanOffsetUs`——**只舍入一次**（GOLDEN_FIXTURES §1.2；G5 勘误为鉴）。
- **Rust 侧**：输出整数 µs，**必须逐项 exact**，无任何舍入类容差。
- **TS legacyReference 侧**：现状为 float ms（float 乘法链 tempo-map.ts:36-41、countInMs score-events.ts:16）。比对 `ms×1000` 与真值：每处偏差 ≤ 1 µs → 逐项归因为 `time-rounding`（引用具体公式与操作数）；**> 1 µs → semantic-defect，FAIL**。
- **禁止**：`toBeCloseTo` 作时间断言；相邻 onset 相减推时值；float beat 参与比较（GOLDEN_FIXTURES §1.2/§9）。

---

## 4. 三层比较协议

| 层 | 内容 | 通过条件 |
|---|---|---|
| **L1 指纹层** | 双侧对同一 bundle 各自实现 `planFingerprintV1`（NFC + JCS(RFC 8785) + SHA-256，**Rust 独立实现，禁止 FFI 调 TS**），哈希相等 | 相等；且文档必须过强制门禁（R2-0B `planFingerprintV1` 入口） |
| **L2 结构层** | §3.1–§3.2 全字段 diff（覆盖指纹**不**见证的字段） | 零未分类差异 |
| **L3 派生层** | atoms（§3.3 tick 精确规则）+ scoreEvents（§3.5 真值协议）+ server P1-3 不变量离线复算（onset 组↔target 组一一、组时值=最长成员、小节覆盖；engine-server.mjs:1497-1557） | 全绿 |

**L1 见证范围**（payload 字段，`plan-fingerprint.ts:721-756`）：scope（partId/range/hand/handMapping）、repeat、tempo（bpm/PPQ/countInBeats）、group 序列（groupIndex/passIndex/bar/onsetBeat/durationBeat/beatInMeasure/staffNumbers/voiceIds）、成员（locator/pitch{midiNote,spelling}/durationBeat/isTieOnset）。

**L1 不见证**（必须由 L2/L3 补齐）：运行时 ID 字符串、playbackIndex 排序、chordGroupId 字符串（等价类经同拍分组间接见证）、atoms/scoreEvents 派生值、全部显示字段。

**case 通过判据**：L1 相等 ∧ L2 零未分类差异 ∧ L3 全绿。

---

## 5. 差异分类与容差（冻结；继承 GOLDEN_FIXTURES §7.1 并扩展跨语言项）

| 分类 | 判定 | 处置 |
|---|---|---|
| `exact` | 值相等 | 默认要求 |
| `identity-mapping` | 运行时 ID（planId/occurrenceId/groupId/scoreEventId）按 §3 结构规则匹配但字节不同 | 允许，diff 报告须逐项列出 |
| `serialization-only` | beatPosition、atom.beat、DisplayMs 等显示字段 | 允许，禁止作断言源 |
| `time-rounding` | **仅限 legacyReference（TS）ms 字段**，≤1 µs 且逐项归因 | 允许；**Rust 整数 µs 输出无此类，必须 exact** |
| `semantic-defect` | pitch/onset/duration 有理值/tie 语义/voice/staff/bar/pass/计数/顺序/hand 的任何差异 | **FAIL** |
| `unsupported-behavior` | 乐谱 repeat/ending 展开、tempo curve——不在承诺集 | 范围外（双方一致阻断） |

**禁止**：通用容差（"差不多"）；"总分接近"判定；仅比较集合大小；以 TS↔Rust 互相一致作为正确性证明（两实现可能共享同一语义错误——**权威永远是手工真值**）。

---

## 6. P8 负例验收清单（目标校验加固——逐条冻结，替代泛化的"非法计划必须拒绝"）

以下负例须在 **TS 与 Rust 两侧**分别落地并通过，错误码一致（Rust 侧映射到同一码表）。

### N-PITCH 音高
| ID | 操作 | 期望 |
|---|---|---|
| N-PITCH-1 | 某 member `midiNote` +1 | L1 哈希变化 + L2 semantic-diff 被捕获（FAIL） |
| N-PITCH-2 | `spelling` 改变、midiNote 不变（同音异名） | L1 哈希变化（payload 含 spelling，plan-fingerprint.ts:751） |
| N-PITCH-3 | scoreEvent pitch 越界（<0 或 >127）或非整数 | 双侧拒绝（server 同款检查 engine-server.mjs:1458-1460） |
| N-PITCH-4 | 非整数 alter / 不可表示音高进入 plan | `unrepresentable_pitch` 阻断（上游，双侧一致） |

### N-COUNT 目标数量
| ID | 操作 | 期望 |
|---|---|---|
| N-COUNT-1 | tie 续接事件被当作独立 occurrence 输出 | G3 真值失败（occurrences 2≠1、duration 2≠4，GOLDEN_FIXTURES §4.4） |
| N-COUNT-2 | rest 进入 occurrences/groups/atoms/scoreEvents | 计数与 atom 数与真值不符（A1） |
| N-COUNT-3 | grace/cue 进入目标 | 计数不符（collectEvents 过滤 :52-53 语义保持） |
| N-COUNT-4 | 任意 occurrence 被静默丢弃（含 hand 过滤误删） | occurrence/group/scoreEvent 三层计数同步暴露差异 |
| N-COUNT-5 | 同 onset 同 staff 异 voice 被拆成两组 | groups 计数不符（A4：group 键不含 voice） |

### N-ID ID 唯一性
| ID | 操作 | 期望 |
|---|---|---|
| N-ID-1 | scoreEventId 重复 | 双侧拒绝（server engine-server.mjs:1464-1469 同款） |
| N-ID-2 | 同一 score event 跨 pass 的 occurrenceId 相同 | 拒绝（occurrenceId 每 pass 唯一，A10/R2-0B） |
| N-ID-3 | 全部内部 ID 一致重命名、语义不动 | **指纹逐字节不变**（R2-0A 不变性正测反向复用） |
| N-ID-4 | 重复 partId / 文档级重复 source locator / 重复 xmlId | 文档校验 fail-closed（R2-0B：`DUPLICATE_PART_ID`/`duplicate_source_locator`/`duplicate_xml_id`） |

### N-COV 小节覆盖
| ID | 操作 | 期望 |
|---|---|---|
| N-COV-1 | scoreEvents 的 measure 集合 ≠ note atoms 的 bar 集合 | 双侧拒绝（engine-server.mjs:1553-1557 同款） |
| N-COV-2 | scoreEvents 超出处方 range | 拒绝（:1477-1480 同款） |
| N-COV-3 | Rust plan 丢失整小节目标 | L2 计数/覆盖差异 FAIL |
| N-COV-4 | range 边界：tie 起点在 range 外 | 冻结现有语义：range 内的续接事件不生成 occurrence、**不重定锚**（:138）——双侧一致即通过，写入 expected |

### N-FP 指纹一致性
| ID | 操作 | 期望 |
|---|---|---|
| N-FP-1 | Rust 重算 5 个固定向量 | 与 `test-vectors/plan-fingerprint-v1.json` 逐字节相等 |
| N-FP-2 | 9 项篡改（scope/hand/repeat/bpm/PPQ/count-in/plannerVersion/scoreRevisionId/normalizerVersion） | 每项哈希必变（R2-0 §4 篡改矩阵复用） |
| N-FP-3 | plan↔document、document↔report 指纹错配 | `PLAN_DOCUMENT_MISMATCH` / `DOCUMENT_REPORT_MISMATCH` 拒绝 |
| N-FP-4 | 未经校验的非法文档尝试进入指纹 | 强制门禁入口拒绝（`DOCUMENT_VALIDATION_FAILED`），无旁路 |
| N-FP-5 | handMapping 冲突（重复 part/同 staff 列两次/同 staff 双手） | `hand_mapping_conflict` 拒绝 |
| N-FP-6 | 空目标 / 非法 range / 非法 loop count（0、33） | `EMPTY_PLAN` / `invalid_range` / `invalid_repeat_count` 双侧同码拒绝 |

---

## 7. 回归矩阵（冻结）

| 层 | case | 比较对象 | 权威 |
|---|---|---|---|
| 手工真值 | G1–G5（GOLDEN_FIXTURES §2–§6） | report 计数、measures、occurrences/groups、scoreEvents、atoms 全字段 | **手工推导真值**（已存在，TS 侧测试已绿） |
| 扩展 parity | G1+A5：range m2、hand right/left/both | range 相对 beat 重定基、hand 过滤后 group 成员/时值缩减 | A5 手工期望 + 本文件 §3 |
| 扩展 parity | G1+A10：range-loop ×2、×3 | passIndex、第二遍 playbackBeat 偏移、occurrenceId 每 pass 唯一、bar 不平移 | A10 手工期望 |
| 扩展 parity | G2 和弦 × hand 混合组 | 组缩减规则（reference-playback-plan.ts:137-153） | §3.2 + A5 |
| 扩展 parity | G3 tie × range 边界 | N-COV-4 冻结语义 | 本文件 §6 |
| 扩展 parity | G5 非 4/4、A3 backup 双谱表、A4 多 voice、A9 同 onset 异时值 | 各 A-case 期望 | GOLDEN_FIXTURES §8 |
| 负例 | A8 全表 + §6 N-* 清单 | ImportIssue/错误码 + 拒绝行为 | 双侧一致 |
| 真实谱 | 113 小节 OMR | 结构计数（1579 occurrence/1018 group，路线决策 §3.2 实测值）、capabilities 恰 5 枚举、指纹跨运行稳定、TS↔Rust 分类后零未解释差异 | 结构不变量；**互相一致 ≠ 正确** |

---

## 8. 迁移证据与失败门槛（宣布"迁移通过"的全部条件）

1. G1–G5：Rust 输出 vs 手工真值逐字段 `exact`（Rust µs 无 time-rounding 项）。
2. §7 扩展矩阵每个 case：L1 相等 ∧ L2 零未分类 ∧ L3 全绿。
3. 5 个固定指纹向量在 **Rust 独立实现**下逐字节复现（NFC/JCS/SHA-256 全自研，禁止绑定 TS）。
4. §6 P8 负例清单双侧通过、错误码一致。
5. 真实谱回归：结构计数匹配、指纹稳定、零未分类差异。
6. **证据落档并提交仓库**：逐 case diff 报告（JSON：字段×分类×归因）、双侧 gitSha/plannerVersion/schemaVersion/time-conversion 版本。
7. 以上全部满足后，方允许按路线决策 §8 的 `RHYTHM_PLANNER=rts|rust` 运行时开关切换生产权威；回滚 = 关开关，不重写数据。

**任何一条不满足 → 不切换；存在未解释差异 → 阻断，不允许"先切再修"。**

---

## 9. 范围边界

- 本卡只冻结验收规则；Rust planner 实现、count-in 接口变更（`countInBeats` float 输入 → `CountInUs` 整数 µs，GOLDEN_FIXTURES §1.3）、`pattern.id=Date.now()` 由 planFingerprint 取代（D11）——均属 **R2 planner 实施卡**。
- `scoring_v1` 对齐算法不动（R5）；OSMD/anchor 不动；`EngineScoreEvent` wire 格式不动（改格式属路线决策 §8"不可回滚决策"，需先审）。
- 差分 harness 形态（供实施卡落地）：离线 CLI，输入 case bundle → 双跑 → 输出 JSON 分类报告 → 任何未分类/semantic 差异非零退出；TS 侧 legacyReference 由脚本生成、只读、带 `generatedBy`/`gitSha`/`date`（GOLDEN_FIXTURES §9.3-9.4）。

## 10. 真值纪律（引用强化）

- legacyReference **永不**自动升级为 expected；修改真值必须记录原因、审批、schema/time 规则版本（GOLDEN_FIXTURES §7.1-5、§9.5）。
- 行为保持层级：① G1–G5/A-case 手工真值 → ② 本文件冻结的映射规则与冻结语义（如 N-COV-4）→ ③ 其余字段以 TS 现行为 legacyReference 基准；任何故意偏离 ③ 的 Rust 行为 = 语义修订，必须走真值修订审批，不得静默。
