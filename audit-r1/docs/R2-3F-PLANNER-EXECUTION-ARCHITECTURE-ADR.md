# ADR R2-3F — Rust Planner 执行架构决策（GAP-2）

**状态：** Accepted（架构决策；**仅设计，不实现、不切换、不授权**）
**日期：** 2026-10-25
**基线：** `r2-3-rust-planner` @ `b387dd081dccb7c44a5867e08a90a40c9970fa90`（`b387dd0`，本地 == origin 已核验）
**输入：** `audit-r1/reports/r2-3/r2-3e-planner-switch-readiness-review.md`（R2-3e：BLOCKED，GAP-1..5）
**冻结规范：** `TS_RUST_PARITY_GATE_V1.md` @ blob `29d7e6ea7f858d76adc7f21a223cd791dc2b3d74`（零触碰）
**决策者：** 用户（本卡记录指挥决策并核实其可行性）

---

## 1. 决策（Decision）

**采用方案 A：Rust planner 通过现有本地 Node 引擎服务的 NAPI 通道执行。服务端生成唯一权威的 canonical plan / scoreEvents / atoms；浏览器接收权威计划后仅做呈现、跟随、高亮与参考播放，不再独立生成任何具有评分权威的计划。**

- `RHYTHM_PLANNER=rts|rust` 开关在方案 A 的**接入任务卡**中实现（本 ADR 只定义其语义：start 时读取、日志打印生效值、非法值 fail-closed 拒绝启动严格计划路径；默认 `rts`）。
- **不选** WASM（B）与 TS/Rust 混合双权威（C）——理由与可证伪条件见 §8。

## 2. 可行性核实（以真实代码为据，非函数名推断）

### 2.1 现有 Rust NAPI 能力 vs 生产需求——逐项对照

| 生产需求（App.tsx 现状） | 现状来源（代码） | `build_plan_v1` 输出覆盖？ | 差异与处理 |
|---|---|---|---|
| 语义计划 occurrences（playbackBeat/duration/beatInMeasure/bar/staff/voice/pitch/isTieOnset） | `playback-planner.ts:135-163` | **覆盖**：PlannerOutput.occurrences 同语义全集（含 occurrenceId/scoreEventId/locator/passIndex/playbackIndex） | Rational 表现为 `"n/d"` 文本（TS 内部为 `{numerator,denominator}`）→ 浏览器**解析层**（§6.2，纯呈现转换） |
| hand 过滤后的 scoped plan | `App.tsx:1032` `filterPlaybackPlanByHand` + `:979 handByScoreEventIdFromMapping` | **覆盖**：`config.hand` + `config.handMapping` 由服务端过滤（R2-3b 移植，playbackIndex 保留原值/空组丢弃/planId+:hand= 已对齐 TS） | 浏览器不再构造 handByScoreEventId 做规划过滤 |
| same-onset 分组 groups | `playback-planner.ts:173-206` | **覆盖**：PlannerOutput.groups（duration=最长成员、staffNumbers/voiceIds 排序去重） | `"n/d"` 解析同上 |
| EngineAtom[]（startTick/durationTicks/bar/beat） | `App.tsx:1104 scoreOccurrencesToEngineAtoms` + tick 不可整除阻断 | **覆盖**：PlannerOutput.atoms + `atomIssueCodes`（tick_grid_rounding 时 atoms 缺失并阻断） | atoms 由服务端 canonical plan 直接下发；浏览器**删除** `scoreOccurrencesToEngineAtoms` 调用 |
| EngineScoreEvent[]（wire ms） | `App.tsx:1100 buildEngineScoreEvents` | **覆盖（换算规则变更）**：PlannerOutput.scoreEvents 携带**整数 µs**（targetOnsetUs/targetDurationUs）+ 全部 wire 字段（scoreEventId/measure/beatPosition/pitch/partId/parseConfidence） | µs→ms 单次除法规则冻结（§7 GAP-5） |
| strict 阻断问题 | `App.tsx:1074-1080`（semantics.issues） | **覆盖**：`meta.planIssues`（score_not_strict_ready / unsupported_repeat_structure / no_playable_notes）+ `planStrictAllowed` | 服务端拒绝语义一致 |
| 指纹绑定 | `App.tsx:1163`（scoreFingerprint）+ 服务端 `:1369/:1395` | **加强**：`build_plan_v1` 内 C-12 绑定 + `require_valid_document` + payload gate（服务端不再信任浏览器 scoreEvents） | 见 §7 GAP-4 |
| 参考播放 / FollowSession / 高亮 | `App.tsx:1091-1100,1129-1140`（groups + tempo） | **覆盖**：groups 含全部所需字段 | 播放 ms 在浏览器由 playbackBeat+bpm 派生（§6.3 豁免） |
| 规划参数 | `App.tsx:1066-1072`（range/repeat/policy）、`config.tempo`（**整数 BPM**，`practiceSettings.ts:88` clamp 40-160）、count-in（`countdown.ts:14`：**固定 3000 ms 折算为拍**） | **覆盖**：config = `{partId, range, repeatSelection, hand, handMapping, bpm:{n,1}, countInUs, ticksPerQuarter, unsupportedNotationPolicy, plannerVersion}` | countInUs = **3,000,000**（现状"3 秒准备"的整数 µs 形式，冻结时间原点语义不变，见 §7） |

**结论：方案 A 可行。** `build_plan_v1` 的输出是现状消费面的严格超集（含 atoms 与 scoreEvents 这两个此前必须在客户端生成的产物）；唯一的形状差异（`"n/d"` 文本 vs 对象）由浏览器解析层以纯呈现转换吸收（§6.2/6.3）。**未发现需要反例否定的不可行点。**

### 2.2 现有 NAPI 入口的复用与增量

- `buildPlanV1(documentJson, reportJson, configJson) -> PlannerOutput`（`bindings/node/src/lib.rs` R2-3c 段）：输入即生产所需全部参数；**可复用为服务端规划入口**。
- 增量（留给接入任务卡，不在本 ADR 实现）：
  1. 会话态封装（document/report 的会话内缓存 + 请求 ID 关联）；
  2. `plannerVersion` 生产值注入；
  3. scoreEvents 的 µs→ms 派生（或在响应中原样下发 µs，由接入层按 §7 规则派生——**推荐后者**，保持 Rust 输出零变换）。

---

## 3. 迁移前数据流（现状，代码行号）

```
浏览器                                    本地 Node 服务 (engine-server.mjs)
────────────────────────────              ──────────────────────────────────
importMusicXml (TS importer)
  → ScoreDocument(内部) + ImportReport
[用户配置 range/hand/tempo/loop]
buildPlaybackPlan (TS) …… App.tsx:1066
buildReferencePlaybackPlan …:1091
  (hand 过滤 + 参考播放 plan)
buildEngineScoreEvents ……...:1100   ── WS: session.begin{atoms,scoreEvents,
scoreOccurrencesToEngineAtoms :1104      scoreFingerprint,playbackPlanId}──▶
                                                                          │
                                       候选校验 :1442-1480（四码锚点）      │
                                       fingerprint 匹配 :1369/:1395        │
                                       addon.buildSchedule :1496 ── targets│
                                       matcher / scoring_v1（Rust 原语）◀───┘
参考播放/跟随/高亮：全部由浏览器内 TS plan 驱动（评分权威事实上在浏览器）
```

问题（R2-3e GAP-2/3/4）：评分权威在浏览器且不可替换；无 plannerVersion/plan 指纹；指纹门禁不在生产链。

## 4. 目标数据流（方案 A）

```
浏览器                                     本地 Node 服务
────────────────────────────              ──────────────────────────────────
importMusicXml（R3 前保留 TS 导入）
  → projectScoreDocumentV1
    → {dto(V1), report}                    [plan.request {requestId, config,
[plan.request] ── WS ──────────────────▶    dto, report}]
                                            build_plan_v1(dto, report, config)
                                              ① require_valid_document（schema 层）
                                              ② C-12 绑定（dto↔report）
                                              ③ 语义规划（Rust，唯一权威）
                                              ④ payload gate（指纹层）
[plan.response] ◀── WS ─────────────────  ⑤ PlannerOutput{canonical plan,
  校验 resp.fingerprint==request 绑定        occurrences/groups/atoms/
  （丢弃不匹配的迟到响应）                    scoreEvents(µs)/runtimeIds/meta
  解析层（纯呈现）：                          +plannerVersion/plannerAuthority/
   "n/d"→{n,d}；µs→ms（§7）                  planFingerprint/strictAllowed}
session.begin{atoms(Rust), scoreEvents(ms,由 µs 按 §7 派生),
  scoreFingerprint, playbackPlanId, plannerVersion, planFingerprint} ──▶
                                       同现状候选校验 :1442-1480（保留）
                                       buildSchedule/matcher/scoring 不变
参考播放/跟随/高亮：消费下发的 groups/occurrences（解析层），不重建目标
错误路径：plan.request 失败/超时/服务端不可用 ⇒ 严格练习不开始（fail-closed，
  无 TS 回退重算）；错误码原样呈现（INVALID_RANGE / EMPTY_PLAN /
  PAYLOAD_VALIDATION_FAILED / PLAN_DOCUMENT_MISMATCH / …）
```

关键不变量：**atoms、scoreEvents、参考播放、跟随高亮同源于一份 canonical plan**（§6.1）；浏览器对它的任何变换都是纯呈现（§6.3）且不回写。

---

## 5. 请求契约（设计；接入任务卡实现）

```jsonc
{
  "schemaVersion": 1,                          // 请求契约版本（本 ADR = 1）
  "requestId": "uuid",                         // 诊断关联；非可信计划标识
  "document": { …ScoreDocumentV1 实例… },       // 浏览器 TS 投影产物
  "report": { …ImportReportV1 实例… },          // 与 document 配对（C-12 绑定在服务端复验）
  "config": {                                  // 与冻结 parity config 同形（R2-3a2 冻结形状）
    "partId": "P1",                            // 必填，非空
    "range": { "startMeasureOrdinal": 1, "endMeasureOrdinal": 113 },  // 必填，1<=start<=end
    "repeatSelection": { "kind": "none" },     // 必填；range-loop 带 count 1..=32
    "hand": "both",                            // 必填，left|right|both
    "handMapping": { …HandMappingV1… },        // 必填；user|score-metadata（clef-heuristic 拒绝）
    "bpm": { "numerator": 90, "denominator": 1 },  // 必填，正约分有理数，值域 20–300（BigInt 比较）
    "countInUs": 3000000,                      // 必填，非负整数 µs（冻结时间原点；见 §7）
    "ticksPerQuarter": 960,                    // 必填，正整数
    "unsupportedNotationPolicy": "reject-strict",  // 必填，reject-strict|allow-display-only
    "plannerVersion": "rust-planner-1"         // 必填，非空；参与指纹（GAP-3）
  }
}
```

**参数映射与缺失字段清单**（不得隐式默认）：

| 生产参数 | 现状 | 请求字段 | 转换规则 | 状态 |
|---|---|---|---|---|
| partId / range / hand / handMapping / policy / ticksPerQuarter / repeatSelection | `App.tsx:1066-1072`、`:979`、`practiceSettings.ts:88` | config 同名字段 | 直传 | ✅ 现有数据充分 |
| BPM | `config.tempo`（**整数**，40–160） | `bpm:{n,1}` | 整数 n → `{n,1}`；未来若支持小数 BPM，按 TS `numberToRationalV1` 十进制语义有理化 | ✅ |
| count-in | `countdown.ts:14` 固定 3000 ms 折算拍 | `countInUs` | **直接携带 3,000,000**（ms×1000；现状的"拍"是派生值） | ✅ |
| ScoreDocumentV1 + report | `projectScoreDocumentV1`（浏览器 TS，R3 前不变） | `document`/`report` | 直传；服务端 `require_valid_document` + C-12 复验（不信任浏览器投影） | ✅ |
| **缺失字段** | — | — | 无：生产规划的全部语义输入均在上表。UI 的 `handByScoreEventId`/`filterPlaybackPlanByHand`/`scoreOccurrencesToEngineAtoms` 是**被替代的客户端规划步骤**，不是缺失输入 | — |

错误语义：任何 config/document/report 违约 → 响应 `{error: {code, message}}`（码 = 冻结契约码：`SCHEMA_VIOLATION`/`INVALID_RANGE`/`INVALID_BPM`/`HAND_MAPPING_*`/`DOCUMENT_VALIDATION_FAILED`/`DOCUMENT_REPORT_MISMATCH`/…），HTTP/WS 层不得改写。

## 6. 响应契约（设计）

```jsonc
{
  "schemaVersion": 1,
  "requestId": "…",                          // 回显，用于丢弃迟到响应
  "plannerVersion": "rust-planner-1",        // 参与指纹（GAP-3）
  "plannerAuthority": "rust",                // 枚举 rust|rts（GAP-3/4）
  "contract": { "fingerprintSchemaVersion": 1, "timeConversion": "time-conversion-v1" },
  "scoreFingerprint": "…64hex",              // 输入回显（= report.fingerprint）
  "planFingerprint": "plan-v1:sha256:…",     // canonical plan 指纹（门禁产出；GAP-3）
  "plan": { …PlannerOutput：occurrences/groups/atoms/scoreEvents(µs)/runtimeIds… },
  "strictAllowed": true,                     // false 时 plan 仍返回，但不得开始严格练习
  "blockingIssues": [ { "code": "no_playable_notes", "blocksStrict": true } ],
  "errors": []                               // 空 = 成功；非空 = {code,message}
}
```

### 6.1 单一权威（指挥决策的硬性要求）

`plan` 内的 **occurrences/groups/atoms/scoreEvents 同源同发**：参考播放、UI 当前音符（group.scoreEventIds）、OSMD 高亮、`session.begin.atoms`、`session.begin.scoreEvents` 全部来自这一份 canonical plan。禁止浏览器重跑 `scoreOccurrencesToEngineAtoms`/`buildEngineScoreEvents`/`filterPlaybackPlanByHand` 生成新的评分目标。

### 6.2 浏览器解析层（新增，纯呈现）

- `parseBeat("n/d") → {numerator, denominator}`（整数解析；可断言已约分）；
- `occurrence/group` 字段名映射到 TS 内部形状（FollowSession/reference UI 所需）；
- 解析是**双射**且不触碰时间与评分语义（有理数精确还原）。

### 6.3 纯呈现转换豁免清单（逐项证明不改语义）

| 转换 | 证明 |
|---|---|
| `playbackBeat("n/d") → ms`（参考播放 atMs / UI 拍显示） | `atMs = countInMs + n/d × 60000/bpm`——只用于**播放与显示**；评分目标（atoms/scoreEvents）不经此路径；有理数精确还原无累积误差 |
| `targetOnsetUs → targetOnsetMs`（若 UI 需要 ms 显示） | §7 冻结的单次除法 |
| `occurrences → "当前音符"`游标 | 按 group.playbackBeat 与播放时钟比较，纯读取 |
| OSMD anchor 映射 | 按 group.scoreEventIds 关联（现状同字段），不重规划 |

---

## 7. GAP-5：µs→ms 唯一转换规则（冻结）

1. **转换层**：浏览器解析层（呈现用途）与接入层（组装 `session.begin.scoreEvents`）都只允许**一次**除法：`ms = canonicalTargetUs / 1000`（IEEE-754 double；µs 整数 ≤ 2^53−1，商精确到 1 µs 步进的 double 表示）。
2. **rounding/truncation**：**禁止**在派生 ms 上再取整/再换算；需要更高精度时必须回到 canonical µs。禁止 `beat → float → ms` 的 legacy 公式与 µs 派生混用（双轨时间戳即缺陷）。
3. **无积累误差**：canonical µs 是唯一时间真值；ms 是一次性投影。参考播放/跟随的内部时钟不参与评分（现状不变），因此不产生跨路径漂移。
4. **边界向量**（接入任务卡的验收用例，全部可由现有冻结资产派生）：
   - 非整数 BPM：175/2（V-rational-bpm 手工表 685714/1371429/2057143/2742857 µs → 685.714/1371.429/2057.143/2742.857 ms）；
   - count-in：3,000,000 µs → 3000 ms；0 µs → 0 ms；
   - range 重定基（G1-A5：m2 起点 4/1 拍）与 loop pass 偏移（G1-A10 ×2/×3）；
   - tie 拉伸（G3：4 拍 = 3,000,000 µs @60…按 case config）与 mixed duration（A9）。
5. **wire 契约不变**：`EngineScoreEvent` 仍为 7 字段 ms 结构（`score-events.ts:28-37`）；`scoring_v1`/matcher 定义不变。若未来需要把 canonical µs 本身带上 wire，那属于**冻结 wire 语义变更**，必须单独批准——本 ADR 不做该决定。

---

## 8. 方案对比

| 维度 | **A. 服务端 Node + Rust NAPI（选定）** | B. 浏览器 Rust/WASM | C. TS 运行时权威 + Rust 影子验证（阶段性） |
|---|---|---|---|
| 单一计划权威 | ✅ 服务端一次生成 | ✅（浏览器内） | ❌ 双实现并存，权威在 TS；"已切换"不成立 |
| 交互延迟 | 本地 WS 一跳；真实谱 Rust 规划毫秒级 + JSON 传输（未压缩 ≈1 MB 量级，本地回环可接受；gzip 为接入优化项） | 零跳；wasm 载入与内存边界开销 | 零新增延迟 |
| 数据传输 | plan DTO 过 WS（可 gzip/分层下发优化） | 无网络传输 | scoreEvents 照旧 |
| Rust 复用 | **100%**（现有 NAPI 直用） | 需 wasm32 target + 依赖审计（unicode-normalization 等的 no-std/可用性未验证） | 0（Rust 仅验证） |
| 安装/构建复杂度 | **最低**（addon 已存在并在服务端加载） | 新 target、新分发、双环境验收 | 最低但无切换意义 |
| 版本追踪 | ✅ 响应内 plannerVersion/planFingerprint，随 Take 归档 | 同左（需前端通道） | 影子报告独立归档，与生产记录分离 |
| Fail-closed | ✅ 服务不可用/planner 错 ⇒ 拒绝开始（无 TS 回退） | 同左 | ❌ 结构上必然"TS 出活、Rust 只报警"，不构成切换 |
| 测试覆盖 | 复用 R2-3c/d 全部 harness + E5 真实谱 | 需重建整套跨语言验收（wasm 语义与 NAPI 逐字节等价另证） | 复用 harness |
| 回滚 | 关开关 → 重启 → TS（§5 R2-3e 方案） | 关开关 | 无需回滚（但无进展） |

**建议：方案 A。** 可证伪条件（任一成立即重开决策，需新证据）：
1. 真实谱 `plan.request→plan.response` p95 超过 500 ms 或 gzip 后传输体积 > 2 MB（本地回环实测）；
2. 出现"无本地引擎服务的独立浏览器会话"的产品硬需求（WASM 成为唯一通道）；
3. `rhythm-core` 无法在服务端环境稳定加载/执行（当前 selftest 251/251 与多次重建证据相反）。

---

## 9. 风险与验收设计（接入任务卡的验收输入）

| # | 风险 | 验收设计 |
|---|---|---|
| R1 | plan 请求/响应耗时与体积 | 真实谱（113/1579/1018）计时 + 体积记录；阈值见 §8 可证伪条件 |
| R2 | 服务端断连/超时/重复请求/迟到响应 | requestId + fingerprint 绑定；迟到/不匹配响应丢弃并计事件；断连 ⇒ 严格练习不开始 |
| R3 | 静默 TS 回退 | 接入后删除/停用客户端规划代码路径（验收断言 bundle 不含 buildPlaybackPlan 的评分调用）；plannerAuthority 必须出现在每 Take |
| R4 | 指纹稳定性 | 同 document/config 重复请求 planFingerprint 逐字节相等（真实谱含 1579 occurrences） |
| R5 | 语义回归 | 15 冻结 case 的 NAPI 双跑与 E1/E4 复跑全部保持 PASS；多 part/手别/和弦/重复段/绑音/三连音/非 4-4/range 边界由 case 矩阵覆盖 |
| R6 | 真实谱回归接入 | E5 流程改为经 WS 服务端通道执行；**本地第三方 fixture（sha256 已归档）不提交**，本地结果不得表述为 CI 可复跑——证据标注边界照旧 |
| R7 | 端到端验收/灰度/回滚 | 独立后续阶段；本 ADR 不启动 |

---

## 10. GAP-3/4/5 设计决定汇总

- **GAP-3（可追溯性）**：`plannerVersion`（请求+响应+Take 持久化）、`plannerAuthority`（rust|rts）、`planFingerprint`（响应+Take）为每 Take 必带字段；旧记录缺字段读取时标注 `plannerAuthority: "legacy-ts"`，**不重写**任何历史 Take/分数。生产 `plannerVersion = "rust-planner-1"`（与 harness 的 `parity-harness-1` 区分；plannerVersion 是指纹输入，不同版本指纹不可互比——这是定义而非缺陷）。
- **GAP-4（门禁对称）**：服务端是权威校验者——schema/文档校验、C-12 绑定、payload 指纹门禁在 `build_plan_v1` 内强制（无旁路）；浏览器投影不被信任（服务端复验）；`session.begin` 的 scoreEvents 继续过服务端四码候选校验（:1442-1480 保留）；缺版本/指纹/校验失败的请求一律拒绝开始严格练习。"Rust 测试已过"不等于生产门禁已执行——门禁在生产请求路径上运行。
- **GAP-5（µs→ms）**：§7 冻结规则（单次除法、禁止双轨、边界向量清单）；wire 与 `scoring_v1` 定义不变。

---

## 11. 边界

本 ADR 是**设计决策文档**：不实现开关、不执行 Rust planner 生产调用、不改任何代码/协议/Schema/Gate/golden/向量/历史证据、不授权切换/灰度/合并 main。实现进入下一张接入任务卡（其范围 = GAP-1 开关 + 本 ADR 接口的服务端封装 + 浏览器解析层 + §9 验收），逐项复审后再经独立切换评审与用户授权。
