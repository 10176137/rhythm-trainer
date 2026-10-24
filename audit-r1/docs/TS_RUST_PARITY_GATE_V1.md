# TS↔Rust Parity Gate V1（R2-1：Golden 语义差分与对照门槛——验收规则冻结）

**日期：** 2026-10-24（同日经三轮复审修订：RF-01–RF-04 全部通过；C 类规范错误码映射表补齐、固定向量一致性独立成类后**最终冻结**）
**复审基线：** `36974d7`
**性质：** **验收规则设计冻结——Design Frozen / Accepted（最终）**。本卡不实现 Rust planner、不改 TS 语义、不切生产权威（Rust planner 未启动）；这不代表迁移已通过，实施仍须满足 §8 全部证据门槛。
**上位文档：** 卡定义见 `R2_0_CONTRACT_FREEZE_REPORT.md` §11、前置条件状态见 `R2_R3_ROUTE_DECISION.md` §5.1、真值纪律见 `GOLDEN_FIXTURES.md`。

> **本卡要回答的四个问题**（完成标准）：任何开发者开始实现 Rust planner 前，能明确知道——
> ① 输入是什么（§2）；② 输出比较哪些字段、怎么比（§3–§4）；③ 哪些差异允许、哪些必须阻断（§5）；
> ④ 什么证据才能宣布迁移通过（§6 验收清单——敏感性/不变性、故障注入、拒绝型、固定向量一致性四类、§7 回归矩阵、§8 迁移证据）。

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
| `bpm` | **正的约分有理数** `BPM = bpmNumerator / bpmDenominator`（分子分母均 > 0；payload 校验正性 `invalid_tempo`，plan-fingerprint.ts:1051-1052；生产值域仍受 20–300 约束，tempo-map.ts:11-12）。差分向量必须至少覆盖**一个整数 BPM（分母 = 1）与一个非整数有理 BPM**（§7 向量行） | RFC-01；payload `tempo.bpm: RationalV1` |
| `ticksPerQuarter` | 默认 960，正整数 | tempo-map.ts:19 |
| `CountInUs` | **非负整数 µs 输入**（冻结的时间起点）。对应拍数 `CountInBeats = CountInUs × bpmNumerator / (60_000_000 × bpmDenominator)` **先化为约分有理数**再进入 payload（`tempo.countInBeats` 为显式有理入参，plan-fingerprint.ts:914/:1215）；全程禁止 JS `number`/浮点计算中间值 | RFC-01；GOLDEN_FIXTURES §1.3 |
| `unsupportedNotationPolicy` | `reject-strict` \| `allow-display-only` | types.ts:260 |
| **`plannerVersion`（差分公共值）** | payload 的**显式输入**（plan-fingerprint.ts:896、门禁 :1204），**双侧必须传同一冻结值**；各实现的生产 plannerVersion 字符串不参与差分比较 | R2-0 报告 §2.1 |
| 规则版本 | `time-conversion-v1`、`fingerprintSchemaVersion=1`、`normalizer-1`、`musicxml-v1.0` | 冻结契约 |

**禁止**：任何一侧从运行时状态（`Date.now()`、环境变量、UI 状态）引入输入。

---

## 3. 逐字段验收规则（映射与比较方法）

比较规则四级：**【精确】**值完全相等（有理数用 BigInt 交叉相乘比较，契约 `isCanonicalRationalV1` 同规则）；**【结构】**按生成规则比较、不逐字节；**【显示】**serialization-only，不得作语义断言源；**【真值协议】**见 §3.5。

### 3.0 ID 三层语义（唯一性范围冻结，RF-03）

| 字段 | 语义 | 唯一性规则 |
|---|---|---|
| `ScoreEvent.id` / `PlaybackOccurrence.scoreEventId` | **原曲记谱事件身份** | 在语义文档内按其契约唯一；**跨 pass 合法重复引用**（range-loop 中同一原曲音符出现多次是正常现象） |
| `PlaybackOccurrence.occurrenceId` | 某计划内的一次播放出现 | 每 pass、每目标唯一（`planId:p{pass}:{scoreEventId}`，playback-planner.ts:144） |
| `EngineScoreEvent.scoreEventId` | 评分目标 wire ID；现有 TS 实现等于该播放目标的 `occurrenceId`（score-events.ts:29） | **单份评分目标数组内必须唯一**；唯一性检查对象是它，**不是**原曲事件 ID（见 N-ID-C1） |

> 若未来把 wire 字段改名为显式 `occurrenceId`，属协议变更，另开审查；本轮不改 `EngineScoreEvent` wire 格式（§3.5、§9）。

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
| `targetOnsetMs` / `targetDurationMs` | 【真值协议】差分经 §3.5 的 `CanonicalScoreEventV1`（整数 µs）进行；wire 毫秒字段本轮不改结构（§3.5 三种比较对象） |
| `beatPosition` | 【显示】（GOLDEN_FIXTURES §5.5 已分类 serialization-only） |
| `partId` = `staff-{staffNumber}:voice-{voiceId}`（:35） | 【结构·已知映射】确定性派生自 staffNumber+voiceId，**不是** sourcePartId；多 part 同 staff/voice 撞名被 P5 上游拒绝。Rust 侧输出真实 `sourcePartId`+staff+voice，差分按派生规则核对 wire 值 |
| `parseConfidence` = 1（设计债 D13） | 【精确】常量 |

### 3.5 时间真值协议（冻结；RFC-01/RFC-04，与 `beatToMicroseconds()` plan-fingerprint.ts:1229-1242 逐字一致）

**BPM 为正的约分有理数**：`BPM = bpmNumerator / bpmDenominator`，`bpmNumerator > 0`、`bpmDenominator > 0`。

**Count-in 拍数（精确有理）**：

```text
CountInBeats = CountInUs × bpmNumerator / (60_000_000 × bpmDenominator)
```

先化为约分有理数再进入 `PlanFingerprintPayloadV1.tempo.countInBeats`；禁止以 JS `number` 计算中间值。

**目标时间**（拍位 `beat = n/d`，`n ≥ 0`、`d > 0`；时值 `duration = dn/dd`）：

```text
PlanOffsetUs     = roundHalfUp( n  × 60_000_000 × bpmDenominator / (d  × bpmNumerator) )
TargetDurationUs = roundHalfUp( dn × 60_000_000 × bpmDenominator / (dd × bpmNumerator) )
TargetOnsetUs    = CountInUs + PlanOffsetUs        ← 相对拍位只舍入这一次
```

`roundHalfUp` = 最接近整数、恰半向上（`floor((num + den/2) / den)`，仅非负域）；全部中间乘法用 BigInt/等价精确整数运算，结果受安全整数域检查（`TIME_OUT_OF_RANGE`）。该公式与参考实现逐字一致：`beatToMicroseconds()` 以 **`bpm.denominator` 进分子**（plan-fingerprint.ts:1234-1235）——整数 BPM 与有理 BPM 走同一条公式，不得分叉实现（GOLDEN_FIXTURES §1.2；G5 勘误为鉴）。

**三种比较对象（RF-04，边界冻结）：**

| 对象 | 内容 | 用途 |
|---|---|---|
| 语义权威 | `PlaybackPlanV1` 的有理拍位/时值 + 冻结 CountIn/BPM 配置 | L1/L2 的比较源 |
| **差分规范化 `CanonicalScoreEventV1`**（仅离线验收；**不代表现有 wire 已有该字段**） | occurrence/source locator、pitch、measure/pass、整数 `targetOnsetUs`/`targetDurationUs`（按上式从精确语义导出） | 双侧语义比较：**逐项 exact，无容差** |
| 现有 wire `EngineScoreEvent` | `targetOnsetMs`/`targetDurationMs` 毫秒字段 | **本轮不改字段结构**；兼容核查 = wire 字段与语义不变，harness 不得借新对象偷改生产协议 |

**三路比较：**

1. **语义比较**：双侧 canonical 整数 µs 逐项 exact（Rust 无舍入类容差）。
2. **legacy TS 表示比较**：现有 `targetOnsetMs`/`targetDurationMs` 按冻结规则映射到 µs；`|ms×1000 − Us| ≤ 1` 逐项记录公式、输入值并归因 `time-rounding`（float 乘法链：tempo-map.ts:36-41、countInMs score-events.ts:16）；**> 1 µs = `semantic-defect` FAIL**。
3. **wire 兼容比较**：对外字段与语义同现状（§3.4 映射规则）；任何协议变更另开审查。

**禁止**：`toBeCloseTo` 作时间断言；相邻 onset 相减推时值；`targetDurationUs` 从已舍入 onset 反推——必须来自对应目标**自身**的精确 duration 语义；float beat 参与比较（GOLDEN_FIXTURES §1.2/§9）。

---

## 4. 三层比较协议

| 层 | 内容 | 通过条件 |
|---|---|---|
| **L1 指纹层** | 双侧对同一 bundle 各自实现 `planFingerprintV1`（NFC + JCS(RFC 8785) + SHA-256，**Rust 独立实现，禁止 FFI 调 TS**），哈希相等 | 相等；且文档必须过强制门禁（R2-0B `planFingerprintV1` 入口） |
| **L2 结构层** | §3.1–§3.2 全字段 diff（覆盖指纹**不**见证的字段） | 零未分类差异 |
| **L3 派生层** | atoms（§3.3 tick 精确规则）+ scoreEvents canonical µs 三路比较（§3.5）+ server P1-3 不变量离线复算（onset 组↔target 组一一、组时值=最长成员、小节覆盖；engine-server.mjs:1497-1557） | 全绿 |

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

## 6. P8 验收测试清单（敏感性 / 不变性 / 故障注入 / 拒绝型 / 固定向量一致性，替代泛化的"非法计划必须拒绝"）

**每项测试只验证一种性质**，各类的输入变更范围与通过判据不同：

| 类 | 名称 | 输入变更范围 | 通过判据 |
|---|---|---|---|
| **A** | 指纹敏感性 / 不变性 | 合法基线 payload `P`，每次只改**一个指定字段**得合法 `P'`（或仅重编码 ID） | 敏感性：`F(P') ≠ F(P)`；不变性：`F(P') = F(P)`。**不要求抛错、无错误码**——只验证指纹字段覆盖性 |
| **B** | 候选输出故障注入 | **冻结 case bundle 与独立 golden，不得修改**；只篡改一侧候选输出的指定字段 | L2/L3 差分报告定位到正确**字段路径**并归类 `semantic-defect`，进程**非零退出**。被篡改输出不得回填为输入，不得同步修改 golden |
| **C** | 拒绝型（fail-closed） | 注入非法输入 / 非法计划 | 在**指明层级**（Schema / 文档门禁 / planner 输入校验 / 服务端与候选输出校验）被拒绝，断言**规范错误码**（见下方映射表）；**仅此类要求 TS/Rust 码表一致**。不得以返回空计划、静默丢弃问题事件或仅记 warning 代替拒绝 |
| **V** | 固定向量一致性 | **不改任何输入**：Rust 独立实现重算已提交的 test-vectors | 与提交的 canonical bytes + 期望哈希**逐字节相等**。非敏感性、非故障注入、非拒绝——验证的是跨语言契约复现本身（原 N-FP-S3，独立成类） |

**独立 golden 原则**：任意一侧单独引入错误（另一侧正确）时差分必须失败；"两侧共享同一错误且彼此一致"**不能**替代独立 golden 验证（权威层级见 §10）。

### A 类——指纹敏感性 / 不变性（无错误码）
| ID | 操作 | 期望 |
|---|---|---|
| N-PITCH-S1 | 基线 payload 某 member `midiNote` 改变 | `F(P') ≠ F(P)` |
| N-PITCH-S2 | `spelling` 改变、`midiNote` 不变（同音异名） | `F(P') ≠ F(P)`（spelling 参与身份：payload `pitch.spelling`，plan-fingerprint.ts:751） |
| N-FP-S1 | 9 项配置篡改（scope/hand/repeat/bpm/PPQ/count-in/plannerVersion/scoreRevisionId/normalizerVersion）各**单项** | 每项 `F(P') ≠ F(P)`（R2-0 §4 篡改矩阵复用） |
| N-FP-S2 | 全部内部 ID（occurrenceId/scoreEventId/groupId/planId）一致重命名、语义不动 | `F(P') = F(P)`（R2-0A 编码不变性正向复用） |

### B 类——候选输出故障注入（冻结 bundle + 独立 golden；断言字段路径 + 分类 + 非零退出）
| ID | 操作 | 期望 |
|---|---|---|
| N-PITCH-F1 | 只篡改一侧候选 occurrence 的 `midiNote` 为相邻音高 | 报告定位到该成员音高字段 + `semantic-defect` + 非零退出 |
| N-COUNT-F1 | tie 续接事件被当作独立 occurrence（GOLDEN_FIXTURES §4.4 反例） | occurrences/duration 差异被捕获（2≠1、2 拍≠4 拍）+ 非零退出 |
| N-COUNT-F2 | rest / grace / cue 进入目标（A1） | 计数与 atom 数差异被捕获 + 非零退出（过滤语义 playback-planner.ts:52-53） |
| N-COUNT-F3 | 任意 occurrence 被静默丢弃（含 hand 过滤误删） | occurrence/group/scoreEvent 三层计数同步差异被捕获 + 非零退出 |
| N-COUNT-F4 | 同 onset 同 staff 异 voice 被拆成两组（A4 反例） | groups 计数差异被捕获 + 非零退出（group 键不含 voice） |
| N-COV-F1 | 一侧候选丢失整小节目标 | L2 计数/覆盖差异 + 非零退出 |

### C 类——拒绝型（指明层级 + 规范错误码；仅此类要求 TS/Rust 码表一致）

**Parity Gate 规范错误码映射表**（复审补齐，2026-10-24）：现有 Node 服务端以普通 `Error` + 中文描述消息实现拒绝、无机器可读码（engine-server.mjs:1454-1480）——**本轮不改生产代码**。下表冻结语言无关的规范码，作为双侧断言的唯一权威：

| 规范码 | 测试 | 语义 | TS 检测位置（现状） | TS 过渡断言锚点 |
|---|---|---|---|---|
| `duplicate_target_id` | N-ID-C1 | 单份评分目标数组内 `EngineScoreEvent.scoreEventId` 重复 | engine-server.mjs:1464-1469 | 抛错且消息含 `scoreEvents 目标 ID 重复` |
| `invalid_target_pitch` | N-PITCH-C1 | 候选评分目标 pitch 非整数或越界 [0,127] | engine-server.mjs:1454-1461 | 抛错且消息含 `scoreEvents 含非法目标` |
| `measure_coverage_mismatch` | N-COV-C1 | scoreEvents 的 measure 集合 ≠ note atoms 的 bar 集合 | engine-server.mjs:1551-1557 | 抛错且消息含 `小节覆盖与 atoms 不一致` |
| `target_outside_prescription_range` | N-COV-C2 | scoreEvents 超出处方小节范围 | engine-server.mjs:1477-1480 | 抛错且消息含 `scoreEvents 超出处方小节范围` |

**码表边界（冻结）**：

- **Rust 侧从第一天起直接产生上述规范码**（候选输出校验/服务端同层）——C 类的 Rust 断言对象就是规范码本身；
- **TS 侧过渡断言 = 拒绝行为 + 消息锚点**（上表末列，消息文本同样冻结不得改写）；把 TS 消息锚点归一化为规范码是**差分 harness 的职责**——harness 内置该映射表，输入"抛错消息/行为"→ 输出规范码 → 报告统一呈现；**除此之外 harness 不得 reinterpret 任何错误**；
- 服务端这四类拒绝的**机器码化（结构化错误携带 code）是可选的生产改进，不属 R2-1**；若实施，必须采用上表规范码并另行审查（server 行为变更）；
- 已有契约层机器码的条目（N-ID-C2/C3、N-PITCH-C2、N-FP-C1..C4）**维持原码**，不引入新码、不重复命名。

### C 类用例
| ID | 拒绝层级 | 操作 | 规范码 |
|---|---|---|---|
| N-ID-C1 | 服务端 / 候选输出目标校验 | **`EngineScoreEvent.scoreEventId` 在单份评分目标数组内重复**（§3.0：检查对象是评分目标 wire ID，不是原曲事件 ID；range-loop 中原曲 `scoreEventId` 跨 pass 合法重复，不得误拒） | `duplicate_target_id`（服务端现状为普通 Error，见映射表） |
| N-ID-C2 | 候选输出校验（指纹 payload 构建） | 候选 occurrenceId 跨 pass 重复 | `DUPLICATE_OCCURRENCE_ID`（契约层已有，R2-0B；occurrenceId 每 pass 唯一，A10） |
| N-ID-C3 | 文档门禁 | 重复 partId / 文档级重复 source locator / 重复 xmlId | `DUPLICATE_PART_ID` / `duplicate_source_locator` / `duplicate_xml_id`（R2-0B fail-closed） |
| N-PITCH-C1 | 服务端 / 候选输出目标校验 | 候选 `EngineScoreEvent.pitch` 越界（<0 / >127）或非整数 | `invalid_target_pitch`（服务端现状为普通 Error，见映射表） |
| N-PITCH-C2 | 上游 importer/planner | 非整数 alter / 不可表示音高 | `unrepresentable_pitch` + `blocksStrict`——报告必须写明拒绝在**上游层级**，不得笼统写成"差分失败" |
| N-COV-C1 | 服务端派生目标校验 | scoreEvents 的 measure 集合 ≠ note atoms 的 bar 集合 | `measure_coverage_mismatch`（服务端现状为普通 Error，见映射表） |
| N-COV-C2 | 服务端处方校验 | scoreEvents 超出处方 range | `target_outside_prescription_range`（服务端现状为普通 Error，见映射表） |
| N-FP-C1 | 强制门禁 | plan↔document、document↔report 指纹错配 | `PLAN_DOCUMENT_MISMATCH` / `DOCUMENT_REPORT_MISMATCH` |
| N-FP-C2 | 强制门禁 | 未经校验的非法文档尝试进入指纹 | `DOCUMENT_VALIDATION_FAILED`，无旁路 |
| N-FP-C3 | payload 校验 | handMapping 冲突（重复 part / 同 staff 列两次 / 同 staff 双手） | `hand_mapping_conflict` |
| N-FP-C4 | planner 输入校验 | 空目标 / 非法 range / 非法 loop count（0、33） | `EMPTY_PLAN` / `invalid_range` / `invalid_repeat_count` |

### V 类——固定向量一致性（byte-exact；非敏感性、非故障注入、非拒绝）
| ID | 操作 | 期望 |
|---|---|---|
| N-FP-V1 | Rust 独立实现重算 5 个固定向量（NFC/JCS/SHA-256 全自研，禁 FFI 调 TS），输入即提交的向量 payload | canonical bytes 与期望哈希同 `test-vectors/plan-fingerprint-v1.json` **逐字节相等**（原 N-FP-S3，按复审意见独立成类——它验证契约复现，不属于"改一个字段看哈希"的敏感性测试） |

> 原 N-COV-4（tie 起点在 range 外）是**冻结语义的正向 parity case**，不是负例——已移入 §7 回归矩阵。

---

## 7. 回归矩阵（冻结）

| 层 | case | 比较对象 | 权威 |
|---|---|---|---|
| 手工真值 | G1–G5（GOLDEN_FIXTURES §2–§6） | report 计数、measures、occurrences/groups、scoreEvents、atoms 全字段 | **手工推导真值**（已存在，TS 侧测试已绿） |
| 扩展 parity | G1+A5：range m2、hand right/left/both | range 相对 beat 重定基、hand 过滤后 group 成员/时值缩减 | A5 手工期望 + 本文件 §3 |
| 扩展 parity | G1+A10：range-loop ×2、×3 | passIndex、第二遍 playbackBeat 偏移、occurrenceId 每 pass 唯一、bar 不平移 | A10 手工期望 |
| 扩展 parity | G2 和弦 × hand 混合组 | 组缩减规则（reference-playback-plan.ts:137-153） | §3.2 + A5 |
| 扩展 parity | G3 tie × range 边界（tie 起点在 range 外：续接事件不生成 occurrence、**不重定锚**，playback-planner.ts:138） | §3.1 冻结语义（原 N-COV-4，正向 case） | §3.1 |
| 扩展 parity | G5 非 4/4、A3 backup 双谱表、A4 多 voice、A9 同 onset 异时值 | 各 A-case 期望 | GOLDEN_FIXTURES §8 |
| 负例 | A8 全表 + §6 验收清单（A/B/C/V 各按其判据；C 类断言规范码） | A：指纹变化；B：字段路径 + `semantic-defect` + 非零退出；C：层级 + 规范码；V：逐字节 | §6 |
| 向量 | 5 个固定指纹向量（整数 BPM）；实施卡须补**至少一个非整数有理 BPM 向量**（若产品决定只支持整数 BPM，则在输入校验层拒绝分母 ≠ 1 并同步 Schema/文档，不留模糊空间） | RFC-01 验收条件 | 契约向量 |
| 真实谱 | 113 小节 OMR | 结构计数（1579 occurrence/1018 group，路线决策 §3.2 实测值）、capabilities 恰 5 枚举、指纹跨运行稳定、TS↔Rust 分类后零未解释差异 | 结构不变量；**互相一致 ≠ 正确** |

---

## 8. 迁移证据与失败门槛（宣布"迁移通过"的全部条件）

1. G1–G5：Rust 输出 vs 手工真值逐字段 `exact`（Rust µs 无 time-rounding 项）。
2. §7 扩展矩阵每个 case：L1 相等 ∧ L2 零未分类 ∧ L3 全绿。
3. 5 个固定指纹向量在 **Rust 独立实现**下逐字节复现（NFC/JCS/SHA-256 全自研，禁止绑定 TS）。
4. §6 P8 验收清单全部通过：A 类（敏感性/不变性）与 B 类（故障捕获）按各自判据；C 类（拒绝型）双侧规范码一致（TS 侧经 harness 消息锚点映射过渡，§6 码表边界）；V 类逐字节一致。
5. 真实谱回归：结构计数匹配、指纹稳定、零未分类差异。
6. **证据落档并提交仓库**：逐 case diff 报告（JSON：字段×分类×归因）、双侧 gitSha/plannerVersion/schemaVersion/time-conversion 版本。
7. 以上全部满足后，方允许按路线决策 §8 的 `RHYTHM_PLANNER=rts|rust` 运行时开关切换生产权威；回滚 = 关开关，不重写数据。

**任何一条不满足 → 不切换；存在未解释差异 → 阻断，不允许"先切再修"。**

---

## 9. 范围边界

- 本卡只冻结验收规则；Rust planner 实现、count-in 接口变更（`countInBeats` float 输入 → `CountInUs` 整数 µs，GOLDEN_FIXTURES §1.3）、`pattern.id=Date.now()` 由 planFingerprint 取代（D11）——均属 **R2 planner 实施卡**。
- `scoring_v1` 对齐算法不动（R5）；OSMD/anchor 不动；`EngineScoreEvent` wire 格式不动（改格式属路线决策 §8"不可回滚决策"，需先审）。
- 差分 harness 形态（供实施卡落地）：离线 CLI，输入 case bundle → 双跑 → 输出 JSON 分类报告 → 任何未分类/semantic 差异非零退出；TS 侧 legacyReference 由脚本生成、只读、带 `generatedBy`/`gitSha`/`date`（GOLDEN_FIXTURES §9.3-9.4）。harness 的差分对象是 §3.5 的 `CanonicalScoreEventV1`（离线验收专用）；对外生产 wire（`EngineScoreEvent` 毫秒字段）保持不变，wire 兼容核查纳入 §8 证据。

## 10. 真值纪律（引用强化）

- legacyReference **永不**自动升级为 expected；修改真值必须记录原因、审批、schema/time 规则版本（GOLDEN_FIXTURES §7.1-5、§9.5）。
- 行为保持层级：① G1–G5/A-case 手工真值 → ② 本文件冻结的映射规则与冻结语义（如 §3.1/§7 的 tie-range 语义）→ ③ 其余字段以 TS 现行为 legacyReference 基准；任何故意偏离 ③ 的 Rust 行为 = 语义修订，必须走真值修订审批，不得静默。
