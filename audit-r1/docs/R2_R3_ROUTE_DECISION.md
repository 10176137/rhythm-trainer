# R2 / R3 路线决策（R1 交付物 4/5）

**日期：** 2026-10-23
**决策问题：** 当前 TypeScript importer + `ScoreDocument` 是否足以成为长期、语言无关的契约，从而让 R2 先做 Rust planner（路线 A）？还是应当合并 R2/R3，先做 Rust 纵向切片（路线 B）？
**决策结论：** **选择路线 A**，但附**四项前置修复**与**明确的切换触发条件**（见 §6、§7）。
**依据：** 本次对 `musicxml-importer.ts`（962 行）逐段审计 + 10 个 fixture 的真实输出（`audit-r1/spike/out/importer-dump.json`）+ 28 个既有 importer 测试。

---

## 0. 一句话理由

> TS parser 的**语义模型**（精确有理数拍、part/staff/voice、rest/chord/tie、source id、ImportReport）已经具备成为 canonical schema 的结构；它的问题集中在**四个可枚举的具体缺陷**，而不是"模型选错了"。因此最有价值的一步是把这份语义冻结成语言无关契约、把**时间/顺序/过滤/指纹**的权威交给 Rust（R2），而不是现在花数周重写一个会立刻丢失既有 113 小节真实谱兼容性的 Rust 解析器（R3 前置）。

同时必须承认：**当前 parser 的正确性证据并不完整**（既有 `*.expected.json` 是从实现 dump 的，不是手推真值）。所以路线 A 的采纳是**有条件的**——前置修复与 golden 真值不完成，就不进入 R2 实现。

---

## 1. 当前 importer 覆盖矩阵（逐项，附证据）

| MusicXML 语义 | 支持状态 | 实现方式 | 本次实测证据 | 既有测试 |
|---|---|---|---|---|
| `score-partwise` 根 | ✅ | 拒绝 timewise | `unsupported_score_timewise` | importer.test |
| `<part-list>` / part 名 | ✅ | Map partId→name | G1–G8 均解析 | importer.test |
| `divisions` | ✅ | 每 measure 可变更；变更必须早于事件（mid-measure → 阻断） | G4 divisions=3 正确 | importer.test |
| `time` 拍号 | ✅ | 变更生效；无效则保留旧值 + warning | G3 2/4、G5 3/4 测量正确 | importer.test |
| `key` 调号 | ✅ 采集 | fifths/mode 存储；**不参与音高计算**（正确） | G8：F4→65、F4 alter=1→66 | importer.test |
| `clef` | ✅ G/F | 多谱号按 staff 合并；其他谱号 → 阻断 | G6 G2/F4 双谱表 | importer.test |
| `staves` | ✅ | | G6 staves=2 | importer.test |
| `<transpose>` | ⚠️ 阻断 | 非零 → `unsupported_transpose` | 未构造 fixture | importer.test（部分）|
| `note`/`pitch`/`step`/`octave`/`alter` | ✅ | alter 缺失→0；`<accidental>` 仅作 alter 缺省 | G1、G8 | importer.test |
| `<accidental>` | ⚠️ 部分 | 只在 `<alter>` 缺失时映射 sharp/flat/double/natural；**不做小节内临时记号作用域** | 未构造 fixture | — |
| `rest` | ✅ | `kind:'rest'`，不进入 plan | G1/G2/G4/G7 的 restCount 正确 | importer.test |
| `chord` | ✅ | 同 staff+voice 的 anchor；无 anchor → 阻断 | G2：3 音同 onset，1 个 group | importer.test |
| `duration` | ✅ | `duration/divisions` → RationalBeat | G4 1/3 精确 | importer.test |
| `<type>` / `<dot>` | ✅ | notatedType + dots | G1 half | importer.test |
| `time-modification`（tuplet） | ✅ | 记录 actual/normal；**不重新计算时值**（依赖 `<duration>`） | G4：1/3 拍 | importer.test |
| `backup` / `forward` | ✅ | 单一 cursor + 负值阻断 | G6：backup 4 → staff2 回到 0 | importer.test（multi-voice fixture）|
| `voice` | ✅ | `source.voiceId`；默认 "1" | G1–G7 均为 1 | importer.test |
| `staff` | ✅ | `source.staffNumber`；默认 1 | G6 staff 1/2 | importer.test |
| `<tie>`（声音） | ✅ | 解算为 TieSpan（同 pitch+staff+voice） | G3：1 span、2 events | importer.test |
| `<tied>`（记谱） | ✅ 分开记录 | 只有 `<tied>` 无 `<tie>` → warning | 未构造 fixture | importer.test |
| 跨小节 tie | ✅ | 排序后线性扫描；orphan start/stop 阻断 | G3 跨 2 小节 | importer.test |
| `grace` | ⚠️ 阻断 | `isGrace`，duration 0，不进 plan | G7 grace 解析成功 | importer.test |
| `cue` | ⚠️ 阻断 | `isCue` | 未构造 fixture | importer.test |
| `lyric` | ✅ 采集 | 仅文本 | — | — |
| `articulations` | ✅ 采集 | 名称列表 | — | — |
| `barline` / `repeat` / `ending` | ⚠️ 检测 + 阻断 | 不展开播放顺序 | 未构造（既有 fixture）| importer.test（unsupported-repeat）|
| `direction` metronome / sound tempo | ✅ 采集 | `tempoMarks[]`（**plan 不消费**） | — | — |
| 速度文字（rit./accel./rubato） | ⚠️ 检测 + 阻断 | 正则匹配 | 既有 fixture | importer.test |
| D.C./D.S./Coda/Fine | ⚠️ 检测 + 阻断 | sound 属性 + 文字正则 | — | — |
| 弱起 `implicit="yes"` | ✅ | 有效时长 = 内容长度 | 既有 fixture | importer.test |
| 小节过满 / 不足 | ✅ | 过满→阻断并采用实际长度；不足→warning，按名义推进 | 既有 fixture ×2 | importer.test |
| 0 小节 / 0 音符 | ✅ | 阻断 | — | importer.test |
| `.mxl` | ❌ 明确拒绝 | 扩展名检查 | — | importer.test |
| XXE / DTD 内部子集 / XInclude | ✅ 拒绝 | 正则 + 结构检查 | — | importer.test |
| 文件大小上限 | ✅ 10 MiB | | — | importer.test |
| `note@id` | ⚠️ 采集，不校验 | `source.xmlId` | G1i/G2i/G3i/G7/G8 均正确读取 | **无** |
| 多 part | ⚠️ 部分 | 解析所有 part，但 range/hand 只用 parts[0] | 未构造 | **无** |
| 微音高 / 不可表示音高 | ⚠️ 阻断 | `unrepresentable_pitch` | 既有 fixture | importer.test |

**统计**：完整支持 20+ 项，明确阻断 8 项，部分支持 5 项。**没有"静默忽略"**——每个限制都有 `ImportIssue` 码与 `blocksStrict`。这是它质量高的核心证据。

---

## 2. `ScoreDocument` 字段完整性 vs 目标契约

| v1.0/v1.1 要求 | 现状 | 差距 |
|---|---|---|
| `scoreId` / `scoreRevisionId` | ❌ 只有 `fingerprint`（原始 XML 的 SHA-256） | 需要显式 `revisionId`（= fingerprint + normalizerVersion） |
| `scoreFingerprint` + 算法/版本 | ⚠️ 有值（sha256 hex），**算法没进文档/DTO** | 契约里固定 `sha256(utf8(xml))` |
| 时间单位/分辨率 | ✅ `RationalBeat`（四分音符拍）+ 960 PPQ 输出 | 需要在 schema 里声明，不靠约定 |
| Part / Staff / Voice | ✅ | 多 part 的 hand 语义缺 |
| Measure / Note / Rest / Chord | ✅ | — |
| 音高 / 时值 / onset / voice / hand / source id | ✅（hand 由谱号推导） | hand 应成为显式字段或由配置决定 |
| tie / tuplet / time / key / clef / accidental / backup-forward | ✅ | accidental 作用域部分；tuplet 只记录不重算 |
| ImportReport | ✅ 4 状态 + 机器码 + blocksStrict | 命名与 v1.0 不同（需映射表） |
| `sourceNoteId` 稳定 & 唯一 | ❌ 未校验唯一；`event.id` 随 fingerprint 变 | 需要 `normalizerVersion` + 唯一性校验 |
| `anchorId` | ❌ | 见 anchor 报告 |
| `planFingerprint` | ❌ 不存在 | R2 |
| `clockSnapshot` | ❌ | 见 clock 契约 |

### 2.1 设计债清单

| # | 债 | 严重度 | 说明 |
|---|---|---|---|
| D1 | `event.id` 前缀是 `fingerprint[:16]` | 中 | 任何字节改动 → 全部 ID 变化。v1.1 允许 revision-local，但必须显式说明"跨 revision 不保证稳定"，且历史报告必须绑定 revision |
| D2 | `source.xmlId` 不校验唯一 | 中 | 若把 xmlId 当锚点主键，必须有冲突策略 |
| D3 | hand 由谱号推导 | 高 | 双高音谱表/单手声部会错；应来自配置/part 语义 |
| D4 | 多 part 的范围/手别语义未定义 | 中 | `rangeMeasures` 只看 parts[0] |
| D5 | accidental 只映射到 alter，无小节作用域 | 低 | MusicXML 语义上 `<pitch>` 已是发声音高，作用域主要影响显示；但作为 R3 的 warning 候选 |
| D6 | tempoMarks 采集但不用 | 中 | 固定 BPM 是产品决策，应在 ImportReport 里明示"tempo 变化被忽略"（当前只有 `fixed_bpm_overrides_score_tempo` 码，未见触发路径） |
| D7 | tie 解算靠 `pitch|staff|voice` 的 open map | 低 | 无时间邻近约束；正常记谱不会出错，但异常谱面可能错配 |
| D8 | `(part as ...).tieSpans` 动态挂载 | 低 | 结构化返回值即可消除 |
| D9 | `PlaybackPlan` 里 `playbackIndex: -1` 先占位后赋值 | 低 | 应构造时计算 |
| D10 | `PlaybackPlan` 无 planFingerprint | 高 | R2 核心 |
| D11 | `buildSchedule` 用 `Date.now()` 生成 pattern id | 高 | 目标 ID 不可重放（见审计 F4） |
| D12 | 浮点在 DTO 边界（`beatPosition`、atom `beat`） | 中 | 需要版本化舍入规则 |
| D13 | `parseConfidence` 硬编码 1 | 低 | 未被评分使用（Rust 侧也标注为 carried metadata） |

---

## 3. 路线 A 与路线 B 的成本对照

### 3.1 路线 A：稳定中间契约（`ScoreDocumentV1`）+ Rust planner

**工作拆解**
| 工作 | 估时（工程师日） | 风险 |
|---|---|---|
| A1 定义 `ScoreDocumentV1` schema（语言无关，JSON Schema/IDL，rational 用 `{n,d}`，tick 显式 PPQ） | 2–3 | 低 |
| A2 TS→V1 投影层（纯函数，不引入 TS class） | 2–3 | 低 |
| A3 前置修复 D1–D4 + xmlId 唯一性 + ImportReport 码表冻结 | 3–5 | 低 |
| A4 5 个 golden 真值 + 差分框架（见 `GOLDEN_FIXTURES.md`） | 3–4 | 中（要人推） |
| A5 Rust planner：tempo map（有理）、range/hand、tie 合并、chord 分组、ordering、`planFingerprint` | 8–12 | **中高**（真正的算法迁移） |
| A6 NAPI 契约（rational DTO、版本、错误） | 2–3 | 低 |
| A7 双跑差分（旧 TS plan vs Rust plan，逐字段） | 3–5 | 中 |
| **R2 合计** | **23–35 人日** | |
| A8 R3：Rust importer 逐 feature 替换（复用 V1 schema，不重设计） | 25–40 人日 | 中 |

**优点**
- 立即解决**评分正确性最相关**的部分（时间轴/顺序/目标）；
- 保留已在 113 小节真实谱上跑通的解析器（本次实测：1610 音、301 chord、31 tie span、0 阻断 issue、117 ms），产品不中断；
- 契约是新的、语言无关的，**不是把 TS class 搬过去**（避免 v1.1 §4.2 警告的 throwaway）。

**缺点**
- 长期存在"语义在 TS、时间在 Rust"的双权威边界；
- V1 schema 若设计不好，R3 会想改 → 需要版本化。

### 3.2 路线 B：合并 R2/R3，Rust 纵向切片

**工作拆解**
| 工作 | 估时 | 风险 |
|---|---|---|
| B1 Rust XML 读取（quick-xml/roxmltree）+ 安全边界（大小/实体/DTD） | 2–3 | 低 |
| B2 最小切片：单 part、单 staff/voice、notes/rests、4/4、divisions、duration | 3–5 | 低 |
| B3 Rust ScoreDocument + ImportReport（对齐现有码表） | 3–4 | 中 |
| B4 Rust planner（同 A5，但输入是自己解析的 document） | 8–12 | 中高 |
| B5 NAPI + 端到端 | 2–3 | 低 |
| **首个切片合计** | **18–27 人日** | |
| B6 扩到 chord / multi-voice / tie / tuplet / backup-forward / clef / accidental / 多 part | 25–45 人日 | **高**（每一项都要与 TS 行为对齐） |
| B7 真实谱（113 小节 OMR）parity | 5–10 人日 | 高（OSMD 显示与 Rust 语义必须一致） |

**优点**
- 没有"过渡 DTO"的长期维护；
- 语义与时间从一开始就在同一语言里。

**缺点（本次证据支持的关键点）**
- **最小切片无法服务当前产品**：真实曲谱（`D:\123\score-latest.musicxml`，Audiveris OMR：**113 小节 / 1610 个音 / 301 个 `<chord />` / 31 个 tie span / 双谱表 / multi_voice / tuplets**）远超"单 part、单 staff/voice、无 chord、无 backup、无 tie"的最小切片；最小切片只能处理其中一部分 → 会长期双路径（TS 用于真实谱、Rust 用于 demo），而 v1.0 §2.2 明确不允许"长期双写两套计划"。
- **TS parser 已在真实谱上验证可用（本次实测）**：`importMusicXml` → `READY_WITH_WARNINGS`、`strictAllowed=true`、0 error、**1 条 warning**（第 36 小节 underfull）、耗时 **117 ms**；随后 `buildPlaybackPlan` → **1579 个 occurrence / 1018 个 group**、耗时 **16 ms**、`scoreEventId` 全部唯一（1579/1579）。覆盖面：`chords, multi_staff, multi_voice, ties, tuplets`。
  一个尚未在真实谱上证明的替换实现（Rust parser）必须先达到同等覆盖，才有资格成为唯一路径。
- **没有可信 oracle**：扩 feature 时唯一对照是 TS importer，而它的 expected 是 dump 出来的。等于用一个未证明的实现去证明另一个实现。
- **R2 的价值被推迟**：评分正确性瓶颈（目标校验、plan 指纹、双时间线）在 B 路线里要等 parser 完成才轮到。

### 3.3 对照结论

| 维度 | A | B |
|---|---|---|
| 首个可交付价值（权威 plan） | 快（A5 后） | 慢（要等 B2–B4，且只覆盖小切片） |
| 对现有产品的中断 | 低 | 高（双路径期长） |
| 语义回归风险 | 中（parser 不变） | 高（parser 重写 + 无真值） |
| 长期架构纯净度 | 中（双权威边界） | 高 |
| 可回滚性 | 高（Rust planner 可 feature flag 关掉） | 低（parser 一旦切换，回退成本大） |
| 与 v1.1 §4.2/§4.3 的匹配 | 满足（定义独立 schema） | 满足（但需先有最小切片） |
| 本次证据的支持度 | **高** | 中 |

---

## 4. 决策

**采用路线 A。**

但不是"把 TS 对象序列化给 Rust"，而是：

```
MusicXML ──► TS importer（保留，作为 R2 期间的语义权威）
                │
                ▼
        ScoreDocumentV1  ← 新的、语言无关的、版本化契约
        （rational {n,d}、整数 ticks + PPQ、显式 source id、
          ImportReport 码表冻结、无 TS class / 无方法）
                │  NAPI（版本化 DTO）
                ▼
        Rust Planner ──► PlaybackPlanV1 + planFingerprint
                │
      ┌─────────┼──────────────┐
      ▼         ▼              ▼
  TargetEvents  参考播放      Rust scoring
  （整数 tick + µs）  （AudioContext） （plan fingerprint 贯穿）
```

R3 之后，Rust importer 输出**同一个 `ScoreDocumentV1`**，TS importer 退出生产路径但**保留为差分测试的 legacyReference**，schema 本身长期有效（用于 fixture、调试导出、跨边界契约）——因此不是 throwaway。

### 4.1 为什么不是"纯 A 原教旨"（不做任何 parser 改动）

因为审计发现 4 个必须修的问题（D1–D4 + xmlId）。如果把这些留到 R3，V1 schema 会把缺陷一起冻结。

---

## 5. 前置条件（R2 开工前必须完成）

| # | 条件 | 验收 |
|---|---|---|
| P1 | 建立版本控制（两个仓库） | 能 `git log` 看到 R1 基线提交 |
| P2 | 5 个 golden 真值 + 差分框架落地（`GOLDEN_FIXTURES.md`） | 手推期望与实际逐字段比对；TS 输出标注为 `legacyReference` |
| P3 | 修复 `source.xmlId` 唯一性校验 + 冲突报告 | 重复 id fixture → `ImportIssue`，不静默 |
| P4 | 明确 hand 归属来源（配置/part 映射），不再用谱号推断 | 双高音谱表 fixture 能正确分左右手 |
| P5 | 明确多 part 的范围/手别语义（或明确拒答） | 多 part fixture 有确定行为 |
| P6 | `ScoreDocumentV1` schema 草案 + 版本策略 | 有 JSON Schema/IDL，且不含 TS 类型引用 |
| P7 | `planFingerprint` 定义（规范化内容 + 哈希算法 + plannerVersion） | 同输入同指纹；不同 range/hand/BPM 不同指纹 |
| P8 | 目标校验加固设计（pitch/数量/唯一性/measure 覆盖/fingerprint） | 有负例清单 |

P1–P5 属于 R1 收尾，P6–P8 属于 R2 设计。

### 5.1 前置条件状态（2026-10-24，d7d4472 复审后正式记录）

| # | 状态 | 依据 |
|---|---|---|
| P1 | CLOSED | 双仓 git 版本控制（R1 收尾） |
| P2 | CLOSED | G1–G5 手工推导 golden + 逐字段差分测试落地（e33f529，`GOLDEN_FIXTURES.md`）；TS 输出定位为 legacyReference |
| P3 | CLOSED | `source.xmlId` 唯一性校验 + `duplicate_xml_id` 阻断（R1 收尾） |
| P4 | CLOSED | hand 归属显式 `HandMappingV1`，谱号推断被拒绝（P1-4） |
| P5 | CLOSED | 多 part 范围/手别语义冻结（`HAND_AND_MULTIPART_CONTRACT.md`） |
| P6 | **CLOSED** | ScoreDocumentV1 语言无关 JSON Schema + 字段约束 + 版本策略（R2-0，`SCOREDOCUMENT_V1_CONTRACT.md`） |
| P7 | **Contract CLOSED / Parity Gate OPEN** | planFingerprintV1 定义（规范化内容、JCS + SHA-256、plannerVersion、指纹输入）+ 5 固定哈希向量 + AJV schema-first 校验已交付（f9ab52f→1b48e8e）；**"Rust 规划器输出 vs 独立 golden 真值"的差分门仍开放——契约验收不等于迁移验收** |
| P8 | OPEN（负例清单已冻结，双侧实现并通过后关闭） | 负例验收清单已在 R2-1 逐条冻结——音高/目标数量/ID 唯一性/小节覆盖/指纹一致性（[TS_RUST_PARITY_GATE_V1.md](TS_RUST_PARITY_GATE_V1.md) §6）；指纹/配对/文档校验部分已由 R2-0/R2-0B 强制门禁先行交付 |

**R2-1 Golden Semantic Differential & TS↔Rust Planner Parity Gate**：验收规则已冻结于 [TS_RUST_PARITY_GATE_V1.md](TS_RUST_PARITY_GATE_V1.md)（2026-10-24）——对照对象与 case bundle（含双侧同一冻结 `plannerVersion` 输入）、逐字段映射（occurrence/group/atom/scoreEvent）、三层比较协议（指纹/结构/派生）、差异分类（**Rust 整数 µs 必须 exact，容差仅限 TS legacyReference ms 且逐项归因**）、P8 负例清单、回归矩阵与迁移证据门槛。**下一卡：R2 planner 实施**——须按该门槛交付全部证据后才允许 `RHYTHM_PLANNER=rust` 切换生产权威。

---

## 6. 迁移边界（哪些动、哪些不动）

### 迁移到 Rust（R2/R3）
- 时间映射：`tempo-map.ts`（→ 有理数/整数 µs）
- 演奏顺序与过滤：`playback-planner.ts` 的 `buildPlaybackPlan`、`filterPlaybackPlanByHand`
- 目标生成：`score-events.ts`（`buildEngineScoreEvents`）
- 目标校验：server 端 `scoreEvents` 校验逻辑
- 指纹：`planFingerprint`、`targetScheduleFingerprint`
- （R3）`musicxml-importer.ts`

### 留在 TypeScript/前端
- OSMD 渲染与 anchor 映射（浏览器 DOM 专属）
- AudioContext 调度（`reference-playback-*`、`synthPiano`、`metronome`）
- UI 状态机、路由、页面
- 设备选择与 MIDI 采集（Web MIDI 一側）

### 留在 Node
- 设备 I/O（`server/midi/*`）、Session/Take 编排、Trace/Journal、持久化、REST
- 时钟采样与 segment 维护（按 clock 契约，但**segment 的数据结构由契约固定**）

### 明确不动（本轮与 R2）
- `scoring_v1` 的对齐算法（R5 才按证据改）
- OSMD 版本（除非 anchor 方案 1 需要 patch → 另立项）
- 账号/云同步、MXL、音频延迟校准（C/D 阶段）

---

## 7. 会被弃用的过渡代码（明确清单）

| 代码 | 何时弃用 | 替代 |
|---|---|---|
| `src/score-engine/playback/tempo-map.ts` | R2 完成 | Rust `TempoMap` |
| `src/score-engine/playback/playback-planner.ts` | R2 完成 | Rust `PlaybackPlanner` |
| `src/score-engine/playback/score-events.ts` | R2 完成 | Rust `TargetSchedule` → DTO |
| `src/score-engine/playback/reference-playback-plan.ts` 的 plan/时间部分 | R2 完成 | Rust plan 的只读投影（仅保留参考播放所需的 `voices/atMs` 投影）|
| `App.tsx:1033` 的 `buildPracticePlan` 分支（**当前不可达**，见审计 F9） | R4 | 删除；若保留则显式降级为"仅节拍练习" |
| `buildScoreOccurrences` | R4 | 若仍无消费者则删除 |
| `server` 端 `scoreEvents` onset-only 校验 | R2 | 完整 plan 校验 |
| `pattern.id = ...Date.now()` | R2 | `planFingerprint` + 稳定 pattern id |
| `(part as ...).tieSpans` | R3 | `parsePart` 返回值 |

**改造而非弃用**：`systemDuet.ts` 仍是跟手模式的引导音实现（生产使用），但它的音符来自 legacy `scoreDoc.notes` 而非 `PlaybackPlan`（审计 F9b）。R4 应把它改为消费 plan，或明确标注其非权威地位。

**不会弃用**：`ScoreDocumentV1` schema、`ImportIssue` 码表、`RationalBeat` 的概念（即使实现改到 Rust）、`legacy-bridge`（在 OSMD 视图迁移前）、历史报告里的旧字段。

---

## 8. 回滚策略

**前提：P1（版本控制）必须先完成。** 当前没有 git，任何"回滚"都是空话。

分三层：

1. **运行时开关（首选）**
   - `RHYTHM_PLANNER=rts|rust`：server 在 start 时选择用 Rust plan 还是 TS plan 生成 targets/scoreEvents。
   - 两个实现同时存在但**只有一个是生产权威**；另一个只能用于差分（不允许"按分数挑一个"）。
   - 回滚 = 改环境变量 + 重启 server，不重写数据。

2. **数据兼容**
   - 新 Take 记录写入 `plannerVersion: 'rust-1'` + `planFingerprint`；旧记录保持 `plannerVersion: null`。
   - 历史报告**永不重算**（v1.0 §5.7）。UI 对缺字段显示 `unavailable`。
   - `ScoreDocumentV1` 有 `schemaVersion`；读取端遇到未知版本 → 明确拒绝并提示，不静默降级。

3. **代码回退**
   - 每个 R2 子项一个独立提交/分支（依赖 P1）；
   - 差分测试不通过 → 不合入；
   - 若生产出现无法解释的差异 → 关闭 `RHYTHM_PLANNER=rust`，保留 Trace/plan 快照用于复现，**不修改历史数据**。

**不可回滚的决策**（必须提前审）：
- 修改 `EngineScoreEvent` 的 wire 格式（加 rational 字段）→ 需要协议版本 2，server/前端必须同时升级；
- 删除 TS importer 的生产路径（R4）→ 只能在 Rust parser 通过全部 golden + 真实谱 parity 后做。

---

## 9. 切换到路线 B 的触发条件（诚实退出条款）

若在 **P1–P6 期间**出现以下任一情况，应停止路线 A，改为路线 B：

1. `ScoreDocumentV1` 草案在 2 轮评审后仍无法摆脱 TS 内部结构（例如必须序列化 `RationalBeat` 的 `Object.freeze`/helper 语义、或 schema 里出现 `capabilities` 之类开放字符串集合而无法版本化）。
2. 前置修复 P3–P5 暴露出 parser 的**结构性缺陷**（不是补一个校验，而是要重构 cursor/anchor/tie 模型）。
3. golden 真值测试显示 importer 在已承诺子集上有 ≥2 处语义错误，且修复会改变现有产品行为。
4. 真实谱（113 小节）在 V1 投影后出现无法解释的差异，且差分无法归因。

触发后：不删除已完成工作；`ScoreDocumentV1` 草案仍可作为 Rust 切片的目标 schema（这样 B 也不是从零开始）。

---

## 10. 明确不做的事（本轮与 R2）

- 不一次性迁移全部 MusicXML 语义到 Rust。
- 不把 TS class / 方法 / `Object.freeze` 对象直接序列化为契约。
- 不在 G0 完成前切换生产权威。
- 不在没有 golden 真值的情况下以"总分接近"判定 parity。
- 不为了"用了 Rust"而重写 `scoring_v1` 的对齐算法（R5 按证据触发）。
- 不引入第二套实时评分。

---

## 11. 决策记录（供后续审计引用）

| 项 | 值 |
|---|---|
| 决策 | 路线 A |
| 决策人 | ZCode（审计方），待用户批准 |
| 依据 | importer 覆盖矩阵（§1）、字段完整性（§2）、成本对照（§3）、前置条件（§5） |
| 已否决 | 路线 B（理由见 §3.2）；"纯 A 原教旨"（不做前置修复） |
| 生效条件 | P1–P5 完成 + 用户明确指定 R2 |
| 复查条件 | §9 的四条触发条件 |
