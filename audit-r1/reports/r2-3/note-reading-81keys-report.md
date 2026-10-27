# 81 键识谱训练交付报告 — 替换「节奏型与技巧训练」业务

- 分支：`feat/teaching-experience-v1`
- 基线：`94be316`
- 需求依据：`Rhythm_Trainer_BC_需求设计文档_V1.0.md`（81 键识谱训练：前端交互与实现任务书 v1.0）；用户指令「把节奏型训练的业务改成这个」
- 默认 planner：仍为 `rts`；未合并 `main`；未改 Rust 评分、`build_schedule`、`PracticePlanBundleV1`、`ScoreDocumentV1`

## 1. 结论

按任务书交付了完整的「81 键识谱训练」功能，替换原练习模式 C（节奏型与技巧训练 / exercise）：

1. **两种模式共用一套配置**：自由识谱（不限时、任意顺序、不评速度）与节奏识谱（拍号/速度/复杂度生成乐谱 → 固定判定线 → Rust 权威评分）。
2. **音域多选区间**：预设 + 自定义起止音（C4/C5 下拉等），并集去重构成目标池；选择器显示起止音名与池大小。
3. **每时间点 1–4 个目标音**：自由识谱=每题目标数；节奏识谱=每个节奏事件的和弦音数；池不足时禁用开始并解释。
4. **真实五线谱**：题目/生成的谱面全部由 OSMD/Bravura 渲染（同一份刻谱能力），无音名卡片、无伪五线谱。
5. **节奏识谱全链路复用**：生成的 MusicXML 走 `importScoreText` → 曲谱库保存 → 现有 Planner/Timeline/Rust 评分 → Take/ReportPanel/历史，不产生第二份目标数组。
6. **旧业务下线**：`exercise` 模式 ID 与生成器/配置面板删除；历史 Take 的 `modeId=exercise` 显示「生成练习（已下线）」。

## 2. 调查结论（任务书 §2）

- **81 键无权威定义**：现有键盘可视化是 C2–B5（48 键），练习页虚拟按键只有 8 键。按任务书要求，本方案提出并落地 **E1(MIDI 28)–C8(MIDI 108) = 恰好 81 键**，定义在 `src/features/reading/readingKeys.ts` 单一常量（`READING_KEY_LOW/HIGH`）；用户如需改音域只改这一处。此为提案值，待用户确认。
- **音名约定**：复用 `midiToPitchName`（C4=60），无第二套命名。
- **自由识谱无引擎评分路径**：`beginFreePlay` 纯本地、不落 Take（调查证实）。因此自由模式的命中匹配做成纯函数模块 `freeReadingSession.ts`（集合成员判定 + 去重 + 统计，12 项测试），不是第二套评分公式——自由模式没有可复制的 Rust 时间评分。
- **MIDI 输入**：`handleRawPacket` 是设备+模拟统一入口；`reading-free` 激活时 note-on 喂给识谱会话并提前返回，绝不进引擎计时链路。
- **节奏识谱**：与 A/B 完全同链路（P1-4 手别映射门槛也保留——开始前需在练习设置确认）。

## 3. 实现

新增：

- `src/features/reading/readingKeys.ts` — 81 键权威范围、区间合并/去重、预设音域（入门 C4–C5 / 低音谱表 C2–C4 / 大谱表 C2–C6 / 扩展 E1–C7 / 全部 81 键）、音名标签。
- `src/features/reading/readingGenerator.ts` — mulberry32 确定性生成：自由题组（每题 N 个不同音，单谱表和弦）+ 节奏谱（复杂度分三档的节奏单元库：基础=四分/二分与休止；进阶=加八分/附点；高级=加十六分与拍内切分；每小节按拍号容量分区，违反即拒绝），事件和弦全部落在单一谱表侧；输出 MusicXML（Part 名「节奏识谱练习」，不再是内部代号）。
- `src/features/reading/freeReadingSession.ts` — 自由识谱状态机：任意顺序命中、重复 note-on 去重、错音按被按键统计、一次弹对题数、暂停/提前结束保留真实记录。
- `src/components/NoteReadingSetup.tsx` — 配置页：模式卡片、音域多选（预设+自定义区间增删）、1–4 音、模式专属设置（自由=题数 10/20/40；节奏=拍号 2/4、3/4、4/4，BPM 40–180（四分音符为一拍，UI 标明），复杂度，2/4/8 小节，预备拍 1/2 小节）、seed、完整配置摘要、MIDI 状态与手别映射提示。
- `src/components/ReadingKeyboard.tsx` — 81 键键盘条（白键 48 + 黑键 33），只做输入反馈，绝不预高亮目标；设备连接时禁用模拟点击。
- `src/components/FreeReadingView.tsx` — 自由识谱练习页（顶栏题号/暂停/结束、OSMD 题目谱、命中 n/N 反馈、81 键键盘）+ 结果页（完成题数、一次弹对题数、错误输入次数、按被按键统计的薄弱音、音高准确率=按错误输入占比的明确定义；不显示速度分）。

修改：

- `OsmdScoreView.tsx` 新增 `zoom` prop（识谱题目谱放大渲染），并加 `osmdStage` 诊断标记。
- `FixedLineScoreView.tsx` 修复隐蔽布局下的锚点测量：`display:none` 期间量到全 0 的几何不再被采用——零尺寸时逐帧重试（上限 ~2s）+ ResizeObserver 触发重测 + 动画 tick 遇零几何保持原帧并请求重测。此前一次浏览器验收中曾因该问题把谱面移出视野。
- `App.tsx` — 识谱接线（setup/自由会话/节奏生成），`reading-rhythm` 计入固定判定线布局与 `engineModeFor`；预备拍按配置的 1/2 小节换算 `countInBeats/countInUs`；练习结束（`page-done`）释放固定高度外壳让报告可达。
- `mode-config.mjs` — `reading-free`（无引擎会话语义：`scoringStartPolicy: none`、时值不评）与 `reading-rhythm`（同 B 的严格策略）两个模式 ID；`exercise` 移除。
- `practiceRepository.ts` — 历史模式名（`exercise` → 生成练习（已下线））。
- 删除 `ExerciseSetupPanel.tsx`、`features/exercises/*`。

## 4. 验证（本地，无 CI）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **577 pass / 4 skipped**（含新增 12 项识谱测试：81 键区间去重、生成确定性、三种拍号合法性、1–4 音和弦尺寸、单谱表侧、池不足拒绝、题目 XML 可解析；自由会话：任意顺序/去重/错音统计/首对题/暂停忽略/提前结束） |
| `npx tsc -b` / `npm run build` | 通过 |
| `npm run selftest` | 251 项全部通过 |
| `npm run test:teaching` | 32/0（回归） |

浏览器验收（mock MIDI，E 项证据）：

- 配置页：模式卡片、音域多选（预设高亮/自定义区间添加移除/池计数）、1–4 音、节奏设置齐全、摘要与 MIDI 状态。
- 自由识谱：题目真实谱面渲染（放大 2.4×）；按错键显示「✗ D4 不是当前目标音」，弹对目标「✓ G♯4 命中」自动进入第 2 题；81 键键盘 E1–C8 完整；「结束并查看结果」出结果页（真实统计）。
- 节奏识谱：生成「4/4 · 4 小节 · 每事件 2 音 · 12 事件」→ 自动存曲谱库（「识谱训练 · 节奏 · 4/4 · 4 小节」）→ 固定判定线视图；未确认手别映射时按 P1-4 门槛拒绝开始，确认后启动；绿色双音目标在判定线处对齐；结束生成 Take `take-e1b52fbe…`（modeId `reading-rhythm`、60 BPM、`persistenceStatus=persisted`）。

## 5. 未做/边界（对照任务书）

- **81 键范围是提案值**（E1–C8），任务书要求不猜测、需确认；实现为单常量，确认后一处修改。
- **自由识谱结果不落 Take**（v1）：结果在本页与 React 状态中，来自真实 MIDI 事件；任务书 §9 的演奏记录契约在节奏识谱由 Take 完整满足，自由识谱标记为已知限制。
- **结果页「复习薄弱音」**以薄弱被按键为中心生成 10 题复习集（简化实现）。
- 节奏识谱结果页复用现有 ReportPanel（音高/起音/时值指标以引擎当前支持为准）；未新增按事件定位的问题列表 UI。
- 高级复杂度含拍内切分（十六-八-十六，不需要连音线）；跨拍连音切分与三连音未启用（与早前 B/C 文档的验收前置一致）。
- 无物理 MIDI 验证；浏览器用 mock MIDI + 虚拟键盘。
- 已知一次性问题：vite 依赖重优化可使 OSMD 懒加载挂起一次，刷新即恢复（本地开发现象，非代码缺陷）。

## 6. 回滚

`git revert` 本批提交即可；`exercise` 业务删除是分支内行为（未合 main），回滚后旧 UI 恢复；历史 Take 不受影响（MODE_CN 保留旧标签）。
