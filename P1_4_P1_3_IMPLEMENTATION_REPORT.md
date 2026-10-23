# P1-4 + P1-3 实施报告

**日期：** 2026-10-24
**基线：** `main` @ `f7c88da`（G0 完成之后）
**范围：** P1-4 手别/多 Part 严格练习规则 + P1-3 服务端计划完整性校验。
**未做：** R2（未冻结 ScoreDocumentV1/planFingerprint，未写 Rust planner）；P09 待发射任务持久化（记为后续卡）。

---

## 0. 结论

- **P1-4**：新增 `practice-scope.ts`（契约实现），`launchPractice` 在生成计划前强制 `assessPracticeScope`；两条手别过滤路径（跟手、参考播放）改用显式映射；设置面板提供"谱表→手别"编辑与确认；**谱号推断在严格路径上被彻底移除**（只保留为设置面板的初始建议值，且被 assess 拒绝）。
- **P1-3**：服务端 `start` 增加五道计划完整性校验：ID 唯一性、时值为正、onset 覆盖数、同 onset 事件数 vs atoms 数、时值与 atoms 名义时值一致、小节覆盖一致。全部有负例测试。
- 测试：vitest **246**（+9）、selftest **241**（+5）、`tsc -b && vite build` 通过、Rust 110（零 Rust 改动）。
- **真实谱回归**：113 小节 / 1610 目标在显式映射（staff1=right、staff2=left）下 `assessmentOk=true`、plan 与 P1-4 之前完全一致（1579 occurrence / 1018 group）、1610/1610 目标被分类。

---

## 1. P1-4 实现

### 1.1 新模块 `src/score-engine/scope/practice-scope.ts`

契约类型照 `HAND_AND_MULTIPART_CONTRACT.md` 落地：

- `HandMappingV1 { schemaVersion:1, mappingVersion:'hand-mapping-1', source:'user'|'score-metadata'|'clef-heuristic', parts[] }`
- `PracticeScopeV1 { partId, range, hand, handMapping }`
- `ScopeIssueCode`：`hand_mapping_missing` / `hand_mapping_heuristic_not_allowed_for_strict` / `hand_mapping_incomplete` / `multiple_parts_require_part_selection` / `range_part_mismatch` / `range_empty_after_hand_filter`
- `assessPracticeScope(score, scope)`：单一权威。规则：
  - part 必须存在（`range_part_mismatch`）；
  - 映射来源必须是 `user`/`score-metadata`，`clef-heuristic` 直接拒绝；
  - 所选 part 的**每个**出现过的谱表都必须在映射里（`missingStaffs` 列出 partId/staffNumber/eventCount，映射缺失该 part 时同样列出有目标的谱表）；
  - 过滤后范围必须还有至少一个目标（`range_empty_after_hand_filter`）。
- `buildUserHandMapping(partId, staves)`：`source:'user'`。
- `suggestClefHeuristicMapping(score, partId)`：仅供 UI 初始建议，`source:'clef-heuristic'`，**必被 assess 拒绝**。
- `handByScoreEventIdFromMapping(score, scope)`：把映射转成 planner 过滤所需的 `scoreEventId → hand`，限所选 part/range。

### 1.2 `App.tsx` 接线

- **状态**：`handMappings`（按曲谱指纹存储的用户映射，随 `PersistedPracticeSettings.handMappings` 持久化）；设置面板的映射编辑草稿与确认（`confirmStaffMapping` → `buildUserHandMapping` → `rememberHandMapping`）。
- **Gate**（`launchPractice`，在 strictAllowed 检查之后、目标生成之前）：
  1. 无语义引擎数据 → 拒绝；
  2. 无该指纹的用户映射 → 拒绝（提示去设置确认；多 Part 额外提示选择 Part）；
  3. `assessPracticeScope` 不过 → 拒绝并显示 codes + `missingStaffs` 明细。
- **替换**：跟手路径与参考播放路径原先从 `scoreDoc.notes`（谱号推断）构造 `handByScoreEventId`，现改为从映射构造；旧推断 map 彻底删除。
- **UI**：设置面板新增"谱表 → 手别映射"区块，每谱表一个 左/右 下拉 + 「确认手别映射」按钮；说明文字明确"谱号推断仅用于初始建议，不参与严格计分"。

### 1.3 行为变化

| 场景 | 之前 | 现在 |
|---|---|---|
| 首次打开任何曲谱开始严格练习 | 直接开始（手别按谱号猜） | 拒绝，要求先在设置确认手别 |
| 双高音谱表 | 全部判成右手 | 用户逐谱表指定 |
| 多 Part | 静默按 parts[0] + 谱号猜 | 必须显式选 Part + 映射（当前 UI 选 parts[0]，选择器在后续卡扩展） |
| 已确认映射的曲谱 | — | 直接开始，映射持久化 |

**注意**：这是一个**故意的破坏性行为变化**——已保存设置的老用户首次开始时会被要求确认一次手别。这是契约 R4（不静默默认）的直接结果。

### 1.4 测试（`practice-scope.test.ts`，8 条）

D1 双高音谱表（接受显式映射 / 拒绝 clef-heuristic）、D2 标准钢琴（staff1=right staff2=left 全覆盖 / 缺 staff2 时 missingStaffs 精确到 eventCount）、D3 多 Part（未知 part 拒绝、显式选择通过、映射必须覆盖所选 part）、D4 缺映射不默认右手、D5 过滤后为空拒绝、`range_part_mismatch`。

---

## 2. P1-3 实现（`server/engine-server.mjs`）

`start` 处理器新增校验（scoreEvents 存在时）：

| # | 校验 | 错误信息 |
|---|---|---|
| 1 | `scoreEventId` 唯一 | `scoreEvents 目标 ID 重复: <id>` |
| 2 | `targetDurationMs > 0` | `… 的时值必须为正` |
| 3 | onset 覆盖数 === Rust targets 数 | `scoreEvents 与目标时间线不一致：覆盖 X 个 onset，目标 Y 个` |
| 4 | 每个 onset 组的 scoreEvents 数 === 同 onset note atoms 数 | `scoreEvents 与 atoms 在 onset …ms 处数量不一致（A vs B）` |
| 5 | 每个 scoreEvent 时值 === 该组 atoms 的名义时值（单 atom 直接比；多 atom 取最长，±1ms） | `… 的时值 …ms 与计划 …ms 不一致` |
| 6 | scoreEvents 的小节集合 === note atoms 的小节集合 | `scoreEvents 的小节覆盖与 atoms 不一致（…）` |

保留原有：字段合法性、处方范围、onset ∈ targets ±0.5ms。
**未做**（诚实边界）：pitch 与 atoms 的一致性**目前无法校验**——`EngineAtom` 不携带 pitch，服务端拿不到每个 atom 的期望音高。真正的 pitch 校验需要把 pitch 加入 atom 契约（R2 的 `ScoreDocumentV1`/`TargetSchedule` 会带），已记录为 R2 设计输入。

---

## 3. 测试结果（全部实跑）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **34 files / 246 tests**（+1 文件 / +9：scope 8 条 + 其余） |
| `npm run selftest` | **241** 条断言（+5：P1-3 五个负例） |
| `npm run build` | 通过 3.53s |
| `cargo test --target x86_64-pc-windows-gnu` | 110（Rust 零改动） |
| 真实谱 scope 回归 | `assessmentOk=true`，1579/1018 与 P1-4 前一致，1610/1610 分类 |

P1-3 负例（selftest 新增断言）：重复 ID / 非法时值 / 缺失事件 / 伪造同 onset 事件 / 小节覆盖不一致，全部按名称拒绝，且同一连接可继续开始。

---

## 4. 改动文件

| 文件 | 改动 |
|---|---|
| `src/score-engine/scope/practice-scope.ts` | 新增（契约实现） |
| `src/score-engine/scope/practice-scope.test.ts` | 新增（8 条） |
| `src/App.tsx` | gate、映射编辑 UI、handMappings 状态与持久化、两处过滤改用映射 |
| `src/features/practice/practiceSettings.ts` | `handMappings` 持久化字段 |
| `server/engine-server.mjs` | P1-3 六道校验 |
| `server/selftest.mjs` | P1-3 五个负例 |

未改：Rust、`scoring_v1`、`musicxml-importer`、`playback-planner` 的语义（planner 仍按 part/range 生成；本任务只加了入口 gate）。

---

## 5. 未完成与后续卡

1. **P09 待发射任务持久化**（你指出的发现）：确认后的复练任务只存页面内存，刷新/导航/中间开轮会丢。应迁移到可持久化的 pending 队列并定义生命周期。**单独任务卡，不阻塞本轮。**
2. **多 Part 的 UI Part 选择器**：gate 已拒绝未显式选择的语义（映射必须覆盖所选 part），但设置面板目前总是编辑 parts[0]；多 Part 曲谱的 Part 下拉是下一小步。
3. **pitch 进 atom 契约**：P1-3 的 pitch 校验需要 R2 的 `TargetSchedule` 携带 pitch。
4. **R2**：未开始。P1-4 的 `HandMappingV1`/`PracticeScopeV1` 是 `ScoreDocumentV1`/`PracticePlanConfig` 设计的直接输入；下一步按既定顺序冻结这两份契约。
5. `trustworthy=true` 对零输入轮的空洞标记（G0 期间发现）仍未处理。
