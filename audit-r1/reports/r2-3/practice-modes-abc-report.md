# 三种练习模式（A/B/C）交付报告 — 第一批：模式层级 + B 固定判定线 + C 生成器

- 分支：`feat/teaching-experience-v1`
- 交付代码：`47a2cab`
- 日期：2026-10-27
- 需求依据：`C:\Users\10178\Downloads\Rhythm_Trainer_BC_需求设计文档_V1.0.md`（钢琴训练器·三种练习模式 v1.0 + B/C 需求文档 V1.0）
- 默认 planner：仍为 `rts`；未合并 `main`；未改 Rust 评分、`build_schedule`、`PracticePlanBundleV1`、`ScoreDocumentV1` 与 plan-fingerprint 契约

## 1. 结论

本批交付三件事：

1. **导航层级**（用户截图指定）：侧栏「练习模式」成为父节点，下面是三个子节点——
   **A 正常曲目演奏**（原 `score` 模式，已实现，保持行为）、**B 固定判定线节奏练习**（新 `fixed-line`）、**C 节奏型与技巧训练**（新 `exercise`，生成节奏型/琶音后进入 B 视图）；**自由弹奏**保持独立入口。
2. **B：固定判定线单行谱面**。谱面**不再自绘**（按用户反馈“保持和第一个图一样别自创”），直接复用现有 OSMD/Bravura 专业制谱；判定线视口一次显示一个 system，整份 OSMD 排版随 session 时间平移，让当前目标音符的**真实刻谱锚点**在目标时刻对齐固定判定线（约 30% 视口宽）。
3. **C：确定性练习生成器**。节奏型（四分/八分/八分+休止/附点）与琶音（大/小三和弦、上行/下行/上下行、一个八度）按 `spec + seed + generatorVersion` 生成规范 MusicXML，经现有导入器进入同一 Planner/评分链路，并保存到曲谱库供 Take 引用。

## 2. 导航层级（父/子节点）

- `src/App.tsx` 侧栏：`mode-group` 父按钮（展开/收起）+ `mode-children` 子列表 + 分隔线 + 自由弹奏。
- `modeRegistry.ts`：`score` 改名「正常曲目演奏」，新增 `'fixed-line'` 与 `'exercise'` 定义；`PracticeModeId` 扩展两个新值。
- 服务端 `mode-config.mjs`：`MODE_IDS` 增加 `fixed-line`/`exercise`，各自有完整评分策略（standard profile、strict-keydown、pitchHint on），历史 Take 的 `modeId` 不受影响。
- 历史/报告模式名 `MODE_CN` 同步补齐。

## 3. B：固定判定线视图（OSMD 复用）

`src/components/FixedLineScoreView.tsx`：

- **同一份刻谱**：组件内部 `new OpenSheetMusicDisplay(...)` 用与 `OsmdScoreView` 完全相同的配置渲染当前曲谱（同一 XML、同一 Zoom、同一 adapter 映射），因此谱面外观与第一张截图一致（大谱表、调号、拍号、附点、`sf` 等记号全部保留）。
- **单 system**：OSMD 的 `g.staffline` 按 part 的 staves 数分组为 system；任意时刻只显示当前 system，其它隐藏。system 内音符、连音线、小节线随宿主一起移动。
- **时间对齐**：启动/计划变更时测量一次每个 target 的 notehead 锚点 x（用现有 `OsmdScoreViewAdapter.getGraphicalNotes`，与普通页高亮同一映射），运行时在相邻 target 锚点间**分段线性插值**，`x = judgeX − anchorX(now)`。不是把整份 SVG 按固定速度左移。
- **rAF 只做展示**：动画读取 `displayStartMs + performance.now()` 计算 x；评分时钟仍是引擎 session（暂停/恢复时 `displayAtMs` 由核心统一顺延，视图跟随）。CSS/动画帧不参与评分。
- **绿色当前目标**：用同一 adapter `highlightScoreEvent('current')`，判定线处的目标始终绿色；漏拍不改变时间参考。
- **倒数/暂停覆盖层**、页面外壳不滚动（`.fixed-line-page` 固定高度、内部布局重排）。
- 已知边界：若某 target 的映射锚点缺失（例如映射冲突），该 target 不参与插值但仍参与评分；视图回退到上一个有效锚点。

## 4. C：练习生成器

`src/features/exercises/exerciseGenerator.ts`：

- 输入 `ExerciseSpec`：`kind(rhythm|arpeggio) + seed + bpm + hand + timeSignature[2/3/4]+4 + bars(2|4|8) + rhythmPattern(quarter|eighth|eighth-rest|dotted)`；琶音另有 `root/quality/direction/octaves=1`。
- 输出：规范 MusicXML（`score-partwise`，divisions=480，单 Part 双谱表，音在练习手一侧的谱表上）+ `exerciseId/spec/seed/generatorVersion/contentFingerprint/summary`。
- **确定性**：`mulberry32(seed)`；同 spec+seed+version 输出逐字节相同（测试断言）。改 seed → 不同内容；改 spec → 新 exerciseId。
- **合法性**：每小节时值总和必须等于拍号容量（违例抛 `INVALID_MEASURE_CAPACITY`，不产出非法谱）；附点节奏仅 4/4；`bpm 20–300`；琶音第一版仅一个八度。
- **接入现有链路**：生成的 XML 走 `importScoreText`（现有 MusicXML 导入器，canonical ScoreDocument + importReport）；`strictAllowed` 为假则拒绝开始；保存到曲谱库（`createScoreLibraryEntry`），Take 通过 scoreId/指纹引用不可变曲谱快照（已在真实 Take 中验证 `scoreId: score-mvqxf96s-…`）。
- **UI**：`ExerciseSetupPanel`——类型切换（节奏型/琶音）、拍号、小节、BPM、手别、节奏型、琶音参数、seed（可随机）；生成后直接进入 B 视图，练习行保留「生成设置」按钮可返回配置并重生成。
- 改 BPM 只改目标时间（复练入口既有语义）；改规则/seed 需重新生成新内容。

## 5. 验证（本地，无 CI）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **571 pass / 4 skipped**（60 文件，58 pass / 2 skip；含新增 6 项生成器测试 + 更新的 5 项 mode-config 测试） |
| `npx tsc -b` | 通过 |
| `npm run build` | 通过（仅既有 chunk 警告） |
| `npm run selftest` | 251 项全部通过 |
| `npm run test:teaching` | 32 pass / 0 fail |
| `cargo test --locked`（上一批口径） | 179 pass / 0 fail（本批未改 Rust） |

新增测试：`exerciseGenerator.test.ts` 6 项（确定性、拍号容量与导入、休止/附点、琶音音序 [60,64,67,72]/下行/小三和弦、左手 staff 2、非法 spec 拒绝）；`mode-config.test.mjs` 更新为 7 个模式 ID 全覆盖。

浏览器验收（mock MIDI）：

1. 侧栏父节点「练习模式」展开/收起，A/B/C 三个子项切换；自由弹奏独立。
2. A 正常曲目演奏按原行为启动（回归）。
3. B：晓之车（双手）启动固定判定线视图——真实 OSMD 谱面单 system 显示，绿色当前目标在判定线处；暂停覆盖层正常；漏拍后视图继续按时间推进。
4. C：seed 20261027 生成「节奏型 · 四分音符 · 4/4 · 16 音」→ 自动保存曲谱库「生成练习 · 节奏型 · 四分音符 · 4/4」→ 进入 B 视图（C4 固定音高四分音符）→ 确认手别映射后启动 → Rust 评分产出 Take `take-7fff3740-…`（modeId `exercise`、80 BPM、`INSUFFICIENT_DATA`（模拟按键漏拍所致）、16 目标逐小节 4+4+4+4、persistenceStatus `persisted`、scoreFingerprint `a5f56438…` 与生成曲谱一致）。
5. 未确认手别映射时启动被拒（“需要先指定手别映射”），确认后可启动——沿用 P1-4 门槛。

## 6. 未做/边界（对照需求文档）

- **B 的“预读区 1–2 小节”与水平缩放**：当前缩放通过 OSMD `Zoom`（固定 1.0）实现，未做视口级 px/ms 缩放滑杆；预读宽度由判定线位置（30%）与锚点间距决定，暂不可调。
- **C 的“切分节奏”**：需求要求模板/记谱/评分验收后才启用，本批未实现切分模板。
- **C 的 exerciseSpecSnapshot/seed/generatorVersion 写入 Take JSON**：Take 目前引用曲谱快照（scoreId/指纹）与 modeId，生成元数据尚存在前端状态与曲谱库名称里，未持久化进 Take——下一批补。
- **B 与默认 rust planner**：B 走既有启动链（rts 默认；rust 授权时同链路），未新增 plan 权威分支。
- 无物理 MIDI 验证；全部浏览器验收用 mock MIDI/模拟按键。
- 回归：A 启动/配置/报告/历史无改动（本批未触碰 `usePracticeSession`/引擎协议），旧 modeId 未被重解释。

## 7. 回滚

`git revert 47a2cab`；生成的练习曲谱库条目与本地 Take 不受回滚影响（旧 UI 读取旧字段）。

## 8. 文件清单

新增：

- `rhythm-trainer-frontend/src/components/FixedLineScoreView.tsx`
- `rhythm-trainer-frontend/src/components/ExerciseSetupPanel.tsx`
- `rhythm-trainer-frontend/src/features/exercises/exerciseGenerator.ts`
- `rhythm-trainer-frontend/src/features/exercises/exerciseGenerator.test.ts`

修改：

- `rhythm-trainer-frontend/src/App.tsx`
- `rhythm-trainer-frontend/src/config/modeRegistry.ts`
- `rhythm-trainer-frontend/src/types/practice.ts`
- `rhythm-trainer-frontend/src/features/score/practicePlan.ts`
- `rhythm-trainer-frontend/src/services/practiceRepository.ts`
- `rhythm-trainer-frontend/server/mode-config.mjs`
- `rhythm-trainer-frontend/server/mode-config.test.mjs`
- `rhythm-trainer-frontend/src/styles.css`
