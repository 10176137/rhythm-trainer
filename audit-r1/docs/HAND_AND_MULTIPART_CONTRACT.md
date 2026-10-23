# HAND AND MULTIPART CONTRACT（R1 收尾）

**日期：** 2026-10-23
**状态：** 契约 + 测试计划（**本次未落实现代码**，见 §6）
**适用阶段：** R2 之前必须冻结；R4 接线时强制执行

---

## 0. 结论

手别（left/right）**不是**乐谱属性，而是**一次练习的作用域配置**。当前实现用谱号推断（F 谱号 → 左，其余 → 右），这只能作为显示层提示，**不能作为 strict 计时练习的隐含权威**；多 part 的 range 语义目前只取 `parts[0]`，同样不能作为默认行为。

本契约规定：**未显式映射的手别、未定义的多 part 范围，strict 路径必须拒绝**（fail-closed），不得静默当作右手或只练第一个 part。

---

## 1. 现状（源码事实）

| 行为 | 位置 | 问题 |
|---|---|---|
| 手别由谱号推断 | `src/score-engine/legacy-bridge.ts:57-72`（`clefFor()`，`hand: staff === 'bass' ? 'left' : 'right'`） | 双高音谱表、单手声部、跨手写法都会判错；且无法表达"同一谱表按段落换手" |
| 手别过滤依赖上述 map | `src/score-engine/playback/reference-playback-plan.ts:103` `filterPlaybackPlanByHand` | 只要 map 完整就永不报 `missingEventIds`，因此"无法确定手别"这条 fail-closed 永远不会触发 |
| 手别 map 来自 legacy 视图 | `src/App.tsx:924-940`（`handByScoreEventId = new Map(scoreDoc.notes.map(n => [n.id, n.hand]))`） | 映射来源是显示模型，不是计划或配置 |
| 多 part range 只看第一个 part | `src/score-engine/playback/playback-planner.ts:75-82` `rangeMeasures()`；`measureCount` 取各 part 最大值 | 第二个 part 的小节可能被"顺带"纳入或完全忽略；measure ordinal 在不同 part 间不保证同义 |
| 多 part 仅 info | `musicxml-importer.ts`（`multiple_parts`，`blocksStrict: false`） | 导入不阻断，但后续语义未定义 |

**结论：** 当前 strict 路径对手别与多 part 都是"看起来能用"，没有可测试的拒绝规则。

---

## 2. 规范规则（normative）

### R1 — 手别来源

手别只能来自以下之一，按优先级：

1. **用户显式选择**：`handMapping.source = 'user'`，逐 `partId + staffNumber` 指定 `left|right`；
2. **乐谱元数据**：`handMapping.source = 'score-metadata'`，来自可信的 part/staff 命名（例如 `P1`/`P2` 明确为左右手，且经用户确认）；
3. **谱号启发式**：`handMapping.source = 'clef-heuristic'`，**仅可用于显示/建议，不得用于 strict 计时练习**。

### R2 — 完整性

strict Take 要求：**被选范围内的每一个 note 目标**都能通过 `handMapping` 得到唯一手别。任一缺失 → 启动前拒绝，返回机器码 `hand_mapping_incomplete`，并列出缺失的 `partId/staffNumber` 与受影响事件数。

### R3 — 多 part

- `PracticeScopeV1.range` 必须绑定**单个 partId**；跨 part 的"第 1..N 小节"没有定义。
- 谱面含 `parts.length > 1` 且用户未选择 part → 拒绝，机器码 `multiple_parts_require_part_selection`。
- 允许未来增加"合并钢琴谱"模式（把多个 part 映射到同一 staff 索引空间），但必须作为显式模式，不能是默认。

### R4 — 不静默默认

禁止以下默认：`hand = 'right'`、`range = parts[0]`、`handMapping = clef 推断`（用于 strict）、`partId = 第一个 part`。任何默认都必须由用户显式确认，并在 Take 快照里记录来源。

### R5 — 记录来源

每个 strict Take 的快照必须包含：

```ts
interface HandMappingV1 {
  schemaVersion: 1;
  mappingVersion: string;           // 规则版本，例如 'hand-mapping-1'
  source: 'user' | 'score-metadata' | 'clef-heuristic';
  parts: Array<{
    partId: string;
    staves: Array<{ staffNumber: number; hand: 'left' | 'right' }>;
  }>;
}
```

报告里可见 `handMapping.source`；`clef-heuristic` 出现在 strict 报告中即视为数据质量降级（不应发生，因为 R2 会拒绝）。

### R6 — 显示 vs 练习

非目标手的音符仍然渲染（可淡化），但**不进入 occurrences / atoms / scoreEvents**。这一条当前由 `filterPlaybackPlanByHand` 满足；契约要求它继续以"显式 map"为输入。

---

## 3. 最小 DTO / API 建议

```ts
// 输入：一次练习的作用域（R2 由 Node/App 组装，Rust 校验）
export interface PracticeScopeV1 {
  schemaVersion: 1;
  partId: string;                                  // R3：单 part
  range: { startMeasureOrdinal: number; endMeasureOrdinal: number };
  hand: 'left' | 'right' | 'both';
  handMapping: HandMappingV1;                      // R1/R5
}

export type ScopeIssueCode =
  | 'hand_mapping_incomplete'
  | 'hand_mapping_missing'
  | 'hand_mapping_heuristic_not_allowed_for_strict'
  | 'multiple_parts_require_part_selection'
  | 'range_part_mismatch'
  | 'range_empty_after_hand_filter';

export interface ScopeAssessment {
  ok: boolean;
  codes: ScopeIssueCode[];
  missingStaffs: Array<{ partId: string; staffNumber: number; eventCount: number }>;
}

/** 纯函数；R2 在 Rust 侧实现相同语义，R1 收尾阶段只定义。 */
export function assessPracticeScope(score: ScoreDocument, scope: PracticeScopeV1): ScopeAssessment;
```

调用点（未来）：
- `App.launchPractice` 在 `buildPlaybackPlan` 之前调用 `assessPracticeScope`，`ok === false` 时不启动并显示第一条 code 对应的用户文案；
- `engine-server` 的 `start` 校验同一份 `PracticeScopeV1`（与 scoreFingerprint 一起绑定），避免前端被绕过。

---

## 4. 验收样例（实现时必须逐条通过）

### D1 — 双高音谱表（两种手别，同一谱号）

输入：单 part、2 staves、两个谱表都是 G2；staff1 为右手旋律，staff2 为左手伴奏。
`handMapping = { source:'user', parts:[{ partId:'P1', staves:[{1:'right'},{2:'left'}] }] }`，`hand='both'`。

期望：
- `assessPracticeScope().ok === true`；
- 若把 mapping 改成 `source:'clef-heuristic'` → `ok === false`，`codes` 含 `hand_mapping_heuristic_not_allowed_for_strict`；
- 若删掉 staff2 的映射 → `hand_mapping_incomplete`，`missingStaffs` 含 `{partId:'P1', staffNumber:2}`。
- **反例**：旧实现会把 staff2 也判成 `right`，strict 能启动且目标错位 —— 必须由该样例拦住。

### D2 — 标准钢琴双谱号（G2 + F4）

输入：单 part、2 staves、G2/F4；显式 mapping staff1→right、staff2→left。
期望：
- `ok === true`；
- 左右手目标数之和 = 全部 note 数（休止/grace/cue 除外）；
- `hand='left'` 时 occurrences 只含 staff2；`hand='right'` 时只含 staff1；`hand='both'` 时两者在同一 beat 合并为同一 group（若 onset 相同）。

### D3 — 多 part（例如 Piano + Voice）

输入：`parts.length === 2`，未指定 part。
期望：
- `ok === false`，`codes` 含 `multiple_parts_require_part_selection`；
- 指定 `partId='P1'` 后 `ok === true`，且 range 的小节序号只在 P1 内解释（P2 不参与目标）；
- 若 `partId` 不存在 → `range_part_mismatch`。

### D4 — 单手谱面（单 staff，G2）

输入：单 part、单 staff、用户选择 `hand='left'`。
期望：
- 无显式 mapping → 拒绝（`hand_mapping_missing`），不得把单谱表默认成右手；
- 提供显式 mapping `{1:'left'}` → `ok === true`。

### D5 — 过滤后为空

输入：范围只覆盖右手音符，用户选 `hand='left'`。
期望：`ok === false`，`range_empty_after_hand_filter`；不得启动一个 0 目标的 Take。

---

## 5. 与现有测试的关系

- `src/features/playback/reference-playback.test.ts` 已有"缺手别 map 抛错"的单元覆盖（`missing_hand`）；
- `importer.test.ts` 覆盖多 part 的导入（`multiple_parts` 为 info）；
- **缺**：上述 D1–D5 的场景测试，以及"strict 拒绝"的接线测试。

---

## 6. 本次是否落实现代码

**没有落实现。** 原因：
1. 手别来源需要 UI（用户选择 part/staff 映射），属于产品交互改动；本次任务明确"不改用户 UI 页面布局"。
2. 若只把 `clef-heuristic` 一律拒绝，会立刻让现有所有 strict 练习无法启动（当前没有任何显式 mapping 的入口），属于破坏性变更。
3. 多 part 拒绝需要在 `App.launchPractice` 与 `engine-server.start` 同时接线，并配套用户文案；属于下一子任务，不适合塞进 R1 收尾。

**列为 R1 下一子任务（R2 前置）：**

1. 加 `HandMappingV1` / `PracticeScopeV1` 类型与 `assessPracticeScope` 纯函数（含 D1–D5 测试）；
2. UI 增加"谱表→手别"映射控件（默认建议值可以来自谱号，但必须用户确认后才标为 `source:'user'`）；
3. `launchPractice` 与 `start` 同时校验，拒绝时给出明确文案；
4. Take 快照落盘 `handMapping`，报告展示 `source`；
5. 真实谱（113 小节单 part 双谱表）回归：显式映射后目标数应与当前一致。

在此之前，**strict 路径继续使用现有 clef 启发式，但必须在实施报告中标注为已知语义缺口**（本文件即为该标注）。

---

## 7. 非目标（本次）

- 不做"运行中换手"。
- 不做"同一谱表按段落分左右手"。
- 不做多 part 合并钢琴谱。
- 不修改 `filterPlaybackPlanByHand` 的现有行为。
- 不把谱号启发式从生产路径移除（要等显式映射可用）。
