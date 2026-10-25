# ADR R2-3F (R1) — Rust Planner 执行架构决策：真实接口对齐修订

**状态：** Accepted（架构决策；**仅设计，不实现、不切换、不授权**）
**日期：** 2026-10-25
**基线：** `r2-3-rust-planner` @ `0a77f38aef8f00d1f338fc2181b6459c6901ded9`（`0a77f38`，本地 == origin 已核验）
**修订：** R1——按 R2-3f-R1 复审意见修正指纹门禁调用关系、补齐 PlannerOutput→前端结构逐字段映射、区分 `rts`/`rust` 生产模式与时间线/跟手两条消费路径。
**输入：** R2-3e 评审（BLOCKED，GAP-1..5）；R2-3f 任务卡（指挥决策=方案 A）。
**冻结规范：** `TS_RUST_PARITY_GATE_V1.md` @ blob `29d7e6ea7f858d76adc7f21a223cd791dc2b3d74`（零触碰）。

---

## 1. 决策（Decision，维持 R2-3f）

**方案 A：Rust planner 经本地 Node 引擎服务的 NAPI 通道执行；服务端生成唯一权威的 canonical plan / atoms / scoreEvents；浏览器仅消费下发计划做呈现、跟随、高亮与参考播放，禁止重新执行规划、手别过滤或 target 聚类。** 所有浏览器端转换只允许确定性投影、显示与播放派生。

逐字段映射（§5）未发现无法确定性投影的字段——**不触发**"重启 WASM 评审"或"引入混合双权威"的例外条件（R2-3f §4）。

## 2. 真实接口与调用关系（R1 修正）

### 2.1 现有 NAPI 入口的真实分工（修正此前"门禁在 build_plan_v1 内"的不准确表述）

| 入口（`bindings/node/src/lib.rs`） | 输入 | 输出 | 职责边界 |
|---|---|---|---|
| `buildPlanV1(document, report, config)` | ScoreDocumentV1 + ImportReportV1 + config（JSON 文本） | **PlannerOutput JSON**（occurrences/groups/atoms/scoreEvents/runtimeIds + planStrictAllowed/planIssues/scopeCodes/missingEventIds/atomIssueCodes） | 投影级 fail-closed（schema 门禁、C-12 绑定、UNKNOWN_CAPABILITY、DUPLICATE_*）+ **语义规划**。**它不计算 planFingerprint、不包含 plannerVersion/plannerAuthority 字段** |
| `planFingerprintV1Gate(document, report, plan, config)` | 同上三件 + **原样 PlannerOutput** | `plan-v1:sha256:…` 指纹 | **独立的**冻结指纹门禁（payload 全量校验 + NFC/JCS/SHA-256）；失败抛 `"<冻结码>: <message>"` |
| `buildParityCandidateV1 / validateCandidateScoreEventsJson / computePlanFingerprintV1Json / canonicalBytesJson` | — | — | 证据 harness 通道，生产规划不依赖 |

### 2.2 未来服务端规划路径（五步；接入任务卡实现，本 ADR 只定义）

1. `plan = build_plan_v1(document, report, config)` —— 失败（schema/绑定/规划违约）→ 返回冻结错误码响应，**不产出计划**；
2. `fingerprint = plan_fingerprint_v1_gate(document, report, plan, config)` —— 以**原样 PlannerOutput** 作为 gate 输入，document/report/config 三件与第 1 步**完全相同**（输入绑定）；
3. 门禁**恰好调用一次**；成功才允许组装成功响应；
4. 失败 → 错误响应携带冻结码（`PAYLOAD_VALIDATION_FAILED` / `PLAN_DOCUMENT_MISMATCH` / `INVALID_RANGE` / …），**不得提供任何可被前端当作有效计划的负载**；
5. **响应封装层**（服务端，非 Rust）附加：`plannerVersion`（请求回显）、`plannerAuthority: "rust"`、`planFingerprint: fingerprint`、契约版本元数据。PlannerOutput 本身不含这三个字段——由封装层补齐。

### 2.3 两条消费路径的模式定义（GAP-1 开关语义；本 ADR 只定义行为）

| 模式 | planner | 浏览器行为 | fail-closed |
|---|---|---|---|
| `RHYTHM_PLANNER=rts`（默认；未来兼容模式） | 现有 TS 管线（`App.tsx:1066/1016`） | 现状不变 | 现状（strict-blocked 拒绝） |
| `RHYTHM_PLANNER=rust` | **服务端**执行 §2.2 五步 | 仅消费下发的 canonical plan（解析层 + 纯呈现转换）；**禁止**再调用 TS planner 产生任何评分权威计划 | 请求失败/超时/服务端不可用/校验失败 ⇒ 严格练习（两种模式）**不开始**；无 TS 回退重算 |
| 非法值（非 `rts\|rust`） | 服务端启动时拒绝进入严格计划路径（打印生效值与错误）；行为必须显式可审计，**不得静默选边** | — | fail-closed |

开关本身由接入任务卡实现；本表是 ADR 规定的接口行为。

---

## 3. 迁移前数据流（现状，代码行号）

### 3.1 时间线模式（strict/score；`App.tsx:1061-1170`）

```
浏览器
  importMusicXml → ScoreDocument + ImportReport
  buildPlaybackPlan ……………………………… App.tsx:1066（strict-blocked 拒绝 :1074-1080）
  buildReferencePlaybackPlan …………………… :1091（hand 过滤 + 参考播放）
  buildEngineScoreEvents ……………………… :1100（wire ms）
  scoreOccurrencesToEngineAtoms ………… :1104（tick 不可整除 → blocking 拒绝）
  session.begin{atoms, scoreEvents, scoreFingerprint,
    playbackPlanId} ……………………………………… :1152-1170 ──WS──▶
                                         engine-server.mjs
                                           候选校验四码 :1442-1480
                                           scoreFingerprint 匹配 :1369/:1395
                                           addon.buildSchedule :1496 → targets
                                           matcher / scoring_v1（Rust 原语）
```

### 3.2 跟手模式（`advanceMode==='follow'`；`App.tsx:1009-1059`）——**提前返回，不经 session.begin**

```
  buildPlaybackPlan（同参，range 同规则）…… App.tsx:1016-1023
  strict-blocked 拒绝 ……………………………………… :1024-1029
  filterPlaybackPlanByHand …………………………… :1032（missingEventIds 非空 → 拒绝 :1033-1037）
  new FollowSession(scoped.plan.groups, tempo,
    {timingToleranceMs, chordSpreadToleranceMs}) …… :1039-1042
  expectedNotes/groupNoteIds ← scoped.plan.groups … :1048-1049
  return true ……………………………………………………………… :1053（**无 atoms/scoreEvents/服务端会话**）
```

自由弹奏（`modeId==='free'`，`App.tsx:1005-1007`）独立：`beginFreePlay()`，不要求任何计划——方案 A 不改变它。

---

## 4. 目标数据流（方案 A，两模式分别绘制）

### 4.1 时间线模式（rust）

```
浏览器                                        服务端（Node + Rust NAPI）
  importMusicXml（R3 前 TS 导入保留）
  projectScoreDocumentV1 → {dto, report}
  plan.request{requestId, config, dto, report} ──WS──▶ ① build_plan_v1(dto,report,config)
                                                         ② plan_fingerprint_v1_gate(dto,report,plan,config)
                                                         ③ 封装层：+plannerVersion/Authority/planFingerprint
  plan.response ◀────────────────────────────────────────（失败 ⇒ {error:{code,message}}）
  校验 requestId/fingerprint 绑定；丢弃迟到/不匹配响应
  解析层（§5 纯呈现）：occurrences/groups/atoms/scoreEvents
  session.begin{atoms(Rust), scoreEvents(ms=µs/1000, §8),
    scoreFingerprint, playbackPlanId=runtimeIds.planId(+hand 后缀按现状),
    plannerVersion, planFingerprint} ──WS──▶ 候选校验 :1442-1480（保留）
                                             buildSchedule :1496 → targets
                                             matcher / scoring_v1（不变）
  参考播放/跟随/高亮 ← groups/occurrences（解析层），不重建目标
```

### 4.2 跟手模式（rust；对应现状 §3.2）

```
  同一 plan.request（config 同形；hand 过滤在服务端执行）
  plan.response ◀── 服务端
    meta.missingEventIds 非空 ⇒ 拒绝开始（对应现状 :1033-1037）
    meta.planStrictAllowed=false ⇒ 拒绝（对应现状 :1024-1029）
  解析层：groups → FollowSession（timing/chordSpread 容差不变）
  expectedNotes/groupNoteIds ← groups（映射见 §5.2）
  return true —— 依旧不经 session.begin、无 atoms/scoreEvents 上传
```

### 4.3 失败语义（两模式统一）

| 失败 | 行为 |
|---|---|
| WS 断连 / 服务端不可用 | 严格练习不开始；进行中会话沿用现有断连语义 |
| plan.request 超时（阈值由接入任务卡定） | 丢弃 + 用户可见错误；不重试到别的权威 |
| 响应 fingerprint ≠ 请求绑定 / requestId 不匹配 | 丢弃（防旧响应覆盖新谱） |
| gate/校验冻结错误码 | 原样呈现给 UI 文案层；禁止静默降级为仅节拍或 TS 重算 |

---

## 5. PlannerOutput → 前端消费结构：逐字段映射（R1 核心）

**总则**：浏览器解析层对 PlannerOutput 只做**确定性投影**（有理数解析、locator 关联、常量填充、µs→ms 单次除法）；不重新聚类、不过滤、不重算时间。以下每行标注处理类别：**[直传]** / **[确定性投影]** / **[常量]** / **[非必需-可扩展]** / **[服务端拒绝]**。

### 5.1 Occurrences → `PlaybackOccurrence`（`domain/types.ts:263-285`，17 字段）

| 前端字段 | Rust 来源 | 处理 |
|---|---|---|
| `occurrenceId` | occurrences[].occurrenceId | [直传] |
| `scoreEventId` | occurrences[].scoreEventId | [直传] |
| `sourcePartId` | occurrences[].locator.partId | [确定性投影] |
| `sourceMeasureOrdinal` | occurrences[].locator.measureOrdinal | [确定性投影] |
| `sourceOrdinal` | occurrences[].locator.sourceOrdinal | [确定性投影] |
| `voiceId` | occurrences[].locator.voiceId | [确定性投影]（可缺省，直传 undefined） |
| `passIndex` / `playbackIndex` / `measureOrdinal` / `bar` / `staffNumber` / `isTieOnset` | 同名 | [直传] |
| `playbackBeat` / `durationBeat` / `beatInMeasure` | `"n/d"` 文本 | [确定性投影] `parseBeat`：整数解析 + 约分断言（有理数精确还原，无误差） |
| `pitch` | occurrences[].pitch `{step, alter(number), octave, midiNote, spelling}` 或 `null` | [直传]（字段同名；`alter` 已是 number）。**空值语义**：`midiNote === null` ⇒ canonical `pitch = null` ⇒ 对应 wire scoreEvents 无法表达合法 pitch —— 服务端四码 `invalid_target_pitch` 拒绝（与 TS `buildEngineScoreEvents` 对 null pitch 抛错现状一致，fail-closed 对齐） |
| `chordGroupId` | **Rust 不输出** | **[非必需-可扩展]**：生产代码当前零消费（`buildScoreOccurrences` 在 `playback-planner.ts:279` 定义后无任何调用者；`chordGroupId` 仅被它读取）。若未来需要：由 document 按 `scoreEventId → event.chordGroupId` 确定性关联，或 PlannerOutput 增补可选字段——两者均为后续扩展，不阻断实现卡 |

### 5.2 Groups → `PlaybackGroup`（`domain/types.ts`）

| 前端字段 | Rust 来源 | 处理 |
|---|---|---|
| `groupId` | `runtimeIds.groupIds[i]` | [确定性投影] 与 `groups[i]` **按数组序一一对应**（两者由 planner 同序生成）；解析层断言数量相等且无重复 |
| `playbackBeat` / `durationBeat` / `beatInMeasure` | `"n/d"` 文本 | [确定性投影] `parseBeat`；`durationBeat` 语义 = 组内最长成员时值（服务端已保证，浏览器只读） |
| `members`（locator 数组） | groups[].members | [直传] |
| `occurrenceIds` / `scoreEventIds` | groups[].occurrenceIds / scoreEventIds | [直传]；约束：与 `members` **同序等长**（服务端生成序），解析层断言 |
| `pitches: Pitch[]` | groups[].pitches（**spelling 字符串数组**） | [确定性投影] **禁止按 pitch/时间重新聚类**：由 `members`(locator) 与 occurrences 按 locator 建立 O(1) 索引后取各自 `pitch` 对象——恢复 planner 原组的完整 Pitch 对象（含 midiNote），顺序=members 序 |
| `bar` / `staffNumbers` / `voiceIds` | 同名 | [直传]（已排序去重） |

### 5.3 Atoms → `EngineAtom`（`types/engine.ts:11-17`）

| wire 字段 | Rust 来源 | 处理 |
|---|---|---|
| `startTick` / `durationTicks` / `bar` | atoms[] 同名 | [直传] |
| `beat` | atoms[].beat（number 显示域） | [直传] |
| `kind` | **Rust 不输出** | **[常量]** `'note'`——planner 仅产 note atom（rest 不产 atom；rest 的缺位由 atoms 计数与时长语义体现，与 TS `buildSchedule` 输入现状一致）。禁止投影出 `'rest'` |

约束：`meta.atomIssueCodes` 非空（如 `tick_grid_rounding`）时 atoms 可能少于 groups——此时 strictAllowed 链路拒绝开始严格练习，atoms **不得**补齐或舍入。

### 5.4 ScoreEvents → `EngineScoreEvent`（`types/engine.ts:19-30`；必填 8 字段，`parseConfidence` 可选）

| wire 字段 | Rust 来源 | 处理 |
|---|---|---|
| `scoreEventId` | scoreEvents[].**runtimeOccurrenceId** | [确定性投影]（唯一对应；即 occurrence.occurrenceId——跨 pass 唯一，§3.0 语义） |
| `measure` | scoreEvents[].measure | [直传] |
| `beatPosition` | 对应 occurrence 的 `playbackBeat` | [确定性投影] `parseBeat` 后 `numerator/denominator`（"playback origin 起的四分音符拍位"，与 occurrence 同源；scoreEvents 数组按 locator:index 关联 occurrence——两数组由 planner 同源同序生成） |
| `pitch` | scoreEvents[].pitch（整数） | [直传]；范围 0..=127 由服务端四码校验兜底 |
| `targetOnsetMs` / `targetDurationMs` | scoreEvents[].targetOnsetUs / targetDurationUs | [确定性投影] **§8 冻结规则**：`ms = us / 1000`（单次除法） |
| `partId` | scoreEvents[].partId（`staff-{n}:voice-{v}`） | [直传] |
| `parseConfidence` | scoreEvents[].parseConfidence | [直传]（wire **可选**字段；canonical 恒 1——可显式携带或省略，不得伪造其他值） |

一致性校验（服务端既有断言保留 + 解析层断言）：scoreEvents 数 == occurrences 数；scoreEvents 的 measure 集合 == atoms 的 bar 集合；每条 scoreEvent 的 `runtimeOccurrenceId` 必须能在 occurrences 中按 `passIndex+locator` 命中。

### 5.5 计划元数据与错误 → 响应/Take 字段

| PlannerOutput 字段 | 响应字段 | 说明 |
|---|---|---|
| `meta.planStrictAllowed` | `strictAllowed` | false ⇒ 不得开始严格练习（阻断原因见 planIssues） |
| `meta.planIssues` | `blockingIssues` | code/blocksStrict 直传；UI 文案按码映射（现状文案表复用） |
| `meta.scopeCodes` | `scopeCodes` | 直传 |
| `meta.missingEventIds` | `missingEventIds` | 跟手模式拒绝依据（现状 :1033-1037 同语义） |
| `meta.atomIssueCodes` | `atomIssueCodes` | 非空 ⇒ atoms 缺失 ⇒ 拒绝（§5.3） |
| `runtimeIds` | `runtimeIds` | `planId`（+hand 后缀语义）作 `playbackPlanId`；occurrenceIds/groupIds 供归档 |

**PlannerOutput 不携带、由响应封装层/请求回显提供的字段**（不伪造 Rust 输出）：

| 字段 | 提供方 |
|---|---|
| `plannerVersion` / `plannerAuthority` / `planFingerprint` | 封装层（§2.2 第 5 步） |
| `range` / `repeatSelection` | 请求 config 回显（浏览器本就持有自己的请求参数） |
| `rangeStartBeat` / `rangeDurationBeat` | 生产消费点仅 `reference-playback-plan.ts:270`（lastEndMs）；由浏览器持有 document 按 `config.range` 对 measures 的 `durationBeat` 求和**确定性重建**——[确定性投影，非 DTO 必需]；若未来需要在服务端出这两个值，属 PlannerOutput 可选扩展 |

**未解决问题清单：无。** 上表所有字段均可经确定性投影、显式非必需定性或请求回显覆盖——不因本节阻断实现任务卡。

---

## 6. `rts` / `rust` 生产模式与消费路径（§2.3 的实现视角）

- **`rts`（默认）**：现 TS 生产路径原样保留（`App.tsx:1066/1016` 调 `buildPlaybackPlan`），作为未来开关实现后的兼容模式；`plannerAuthority: "legacy-ts"`。
- **`rust`**：服务端执行 §2.2 五步；浏览器仅走 §5 解析层与 §4 两模式流程；**禁止**浏览器再调用 TS planner 产生评分权威计划（验收断言 bundle 不含该调用，见 R2-3f §9-R3）。
- **非法配置/服务端错误/校验失败**：一律 fail-closed（§4.3），禁止静默选边或降级为仅节拍。

---

## 7. 请求契约、响应契约、GAP-5 转换规则（R1 维持 R2-3f 内容，仅 §2.2/§5 相关表述修订）

R2-3f 的 §5（请求契约：config 十字段 + document/report；参数映射表与缺失字段清单）、§6（响应契约：由**封装层**附加 plannerVersion/plannerAuthority/planFingerprint——PlannerOutput 本身不含，见 §2.2）、§6.2/6.3（解析层与纯呈现转换豁免清单）、§8（µs→ms 单次除法规则、边界向量、wire/scoring_v1 不变）**全部维持有效**。修订点仅两处：
1. 响应中 `planFingerprint` 的来源改为"§2.2 第 2 步独立门禁的返回值"（原表述"门禁产出"未指明调用边界）；
2. 响应 `plan` 明确为**原样 PlannerOutput**（封装层不增删其字段；附加字段位于响应顶层与 meta）。

## 8. 方案对比与建议（维持 R2-3f：选方案 A）

A/B/C 三方案九维对比与可证伪条件维持 R2-3f §8 不变。R1 的逐字段映射（§5）进一步支持方案 A：**所有前端消费字段均可由 PlannerOutput 确定性投影，无需 WASM 或双权威。** 可证伪条件（p95/体积、离线硬需求、core 无法服务端稳定运行）维持。

## 9. 风险与验收设计（维持 R2-3f §9，追加三项）

| # | 追加项 | 验收设计 |
|---|---|---|
| R8 | 逐字段映射正确性 | 解析层单测：对 15 冻结 case 的 PlannerOutput 执行 §5 全部映射，断言投影结果与 TS 原生 plan 逐字段相等（现 R2-3c harness 数据可直接复用） |
| R9 | `kind`/`chordGroupId` 投影 | atoms `kind==='note'` 断言；chordGroupId 非必需定性在验收中复核（若未来启用 ScoreOccurrence 显示，需先落 DTO 扩展） |
| R10 | C/V 通道回归 | R2-3d 报告的 e4.classC/classV 在接入后仍由实时执行产出 |

---

## 10. 边界

本 ADR（R1 修订）仍是**设计决策文档**：不实现开关与五步服务端路径、不修改任何生产代码/NAPI/协议/Schema/Gate/golden/向量/历史证据、不授权切换/灰度/合并 main。未解决问题清单为空——架构方案可进入下一张接入实现任务卡（范围 = GAP-1 开关 + §2.2 五步服务端封装 + §5 解析层 + §9 验收），逐项复审后仍须独立切换评审与用户单独授权。

---

## 11. R2-3g 实现约束（随第一阶段实现补充的实际代码决策）

第一阶段实现（`server/planner-service.mjs` + `server/planner-service.test.mjs` + NAPI `beatToMicrosecondsJson`）落地了以下**实际代码约束**，作为本 ADR 的修订部分：

1. **多 Part 拒绝**：`document.parts.length > 1` → `MULTI_PART_PLANNER_UNSUPPORTED` 拒绝（Rust planner 的多 Part 严格场景未经验证，绝不返回可能混合 Part 的计划）。多 Part 支持需后续任务卡。
2. **plannerVersion 允许列表**：服务端信任值 `RUST_PLANNER_VERSION = 'rust-planner-1'`；请求携带不匹配值 → `INVALID_PLANNER_VERSION` 拒绝；缺失 → 注入信任值。生成、门禁、响应使用同一版本。
3. **开关语义**：authority 来自显式参数 → `RHYTHM_PLANNER` env → 默认 `'rts'`（rust 路径默认关闭）；非法值 `INVALID_PLANNER_AUTHORITY` fail-closed；`rts` 下调用 rust 链路 → `PLANNER_PATH_DISABLED`（无 TS 回退）。
4. **会话守卫**：`assertTimelineUsable`（strictAllowed ∧ scopeCodes 空 ∧ missingEventIds 空 ∧ atomIssueCodes 空 ∧ atoms 非空且数==groups ∧ scoreEvents 数/ID/measure 覆盖一致 ∧ planFingerprint 格式合法）与 `assertFollowUsable`（strictAllowed ∧ scopeCodes 空 ∧ missingEventIds 空 ∧ groups/occurrences 引用完整 ∧ planFingerprint）——follow **不**检查 atoms/scoreEvents（其不消费）。任一失败 → coded 拒绝，绝不补齐/取整/回退。
5. **时间一致性原语**：`beatToMicrosecondsJson`（NAPI，冻结 time-conversion-v1）供 scoreEvents onset/duration 与 groups playbackBeat 的逐事件精确校验。

验收：`server/planner-service.test.mjs` 10/10（真实 NAPI、无 plan mock；含真实谱端到端 1579/1018/1018/1579 + 指纹稳定 + timeline 守卫通过；真实谱 fixture 为本地 gitignored 文件，非 CI 可复跑——边界照旧标注）。
