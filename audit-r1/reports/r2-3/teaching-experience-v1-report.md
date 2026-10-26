# Teaching Experience V1 — 交付报告

- 分支：`feat/teaching-experience-v1`
- 基线：`6d00e03`（Teaching UI V1 报告提交）
- 交付代码：`4cc0755`（verifiedCodeSha）；后续文案修正 `e0c5a55` + `9ac1a42`（模式改名「练习模式」并同步副标题/说明，见 §9）
- 日期：2026-10-27
- 范围：课程内容、Node 教学决策闭环、单屏教学工作区、导航重排、测试与浏览器验收
- 默认 planner：仍为 `rts`；未合并 `main`；未改任何冻结契约

## 1. 结论

任务卡的 §4.1–§4.6、§7 A–E、§10 均有对应实现与本地验证。核心变化：

1. 8 节版本化课程内容（Node 侧，带 schema 校验），每节都有真实讲解、阶段教练话术、错误反馈与完成/复习策略。
2. 课程按用户确认的进阶设计执行：**讲解 → 单手（先左或先右，学习者选择）→ 另一只手 → 合手慢速 → 合手原速通过检查**。循环范围 = 学习者选择的 A–B 小节，每阶段练一遍；每次重复都是新的 Take。
3. Node 继续独占教学决策：证据门槛 → 讲解 → 只挑一个问题 → practiceRequest → 新 Take → 再判 → 通过/继续/收集证据；证据不足时绝不宣称“学会”。
4. `/teaching` 重做为单屏工作区：顶部课程/步骤/输入状态/退出，步骤轨迹，左侧乐谱（框内滚动），右侧老师讲解 + 反馈（做得好/一处要改/证据/下一步），底部唯一主操作。桌面端页面本身不滚动。
5. 导航简化为 **学习 / 自由练习 / 进度**；曲谱库从工作台入口进入，设备/历史/画像页面保留直达 URL。

## 2. 课程内容（§4.1 / §4.2）

新文件 `rhythm-trainer-frontend/server/teaching-content.mjs`：

- `LESSON_CATALOG_SCHEMA_VERSION = 1`
- `HANDS_PROGRESSION_TEMPLATE`：四个阶段，`tempoFactor` 0.75 / 0.75 / 0.85 / 1.0
- `validateLessonDefinition()`：导入时校验；缺字段直接抛 `TeachingContentError`，不会把空课程渲染给学习者
- `LESSON_CATALOG` / `getLessonCatalog()` / `getLessonById()` / `lessonViewForRun()` / `learnerMessageFor()`
- 内容与 UI 解耦：React 只渲染 DTO，不包含课程文案或教学规则

8 节课（`GET /api/teaching/lessons` 返回）：

| lessonId | 主题 | 难度 | 核心证据 |
|---|---|---|---|
| `steady-beat-hands` | 稳定拍点 | 入门 | onset-timing |
| `duration-rest-hands` | 音符时值与休止 | 入门 | duration-assessment |
| `subdivision-count-hands` | 细分拍与口数 | 基础 | onset-timing |
| `early-late-onset-hands` | 起音过早/过晚 | 基础 | onset-timing |
| `even-rhythm-hands` | 节奏均匀 | 基础 | onset-timing |
| `pitch-missed-hands` | 音高/漏音 | 基础 | pitch-events |
| `weak-section-fix-hands` | 困难片段修复 | 进阶 | pitch-events + onset-timing |
| `transfer-review` | 迁移与复习 | 进阶 | onset-timing |

每节课包含：`explainScript`（title/explanation/prompts/successCriteria）、四阶段 `coachingByPhase`、`practiceTemplate`、`feedbackRules`（诊断码 → 学习者话术 + 下一步）、`completionPolicy`、`reviewPolicy`。

`pass-check` 是“练习通过检查”，不是迁移认证。完成时 decision 会带：

```json
"transfer": { "status": "not-executed", "note": "迁移检查使用未练过的新片段；V1 未执行时会如实标注「迁移未执行」，不会自动计为通过。" },
"reviewSuggestion": { "trigger": "通过检查完成 1 天后", "suggestedIntervalDays": [1, 3, 7] }
```

## 3. Node 决策闭环（§4.3）

`server/teaching-orchestrator.mjs`：

- `normalizeCreateInput` 新增 `lessonId` / `firstHand` 校验：未知课程 → `INVALID_LESSON` 400，非法手别 → `INVALID_HAND` 400。
- `lessonSteps()` 按进阶模板生成步骤；`hand-1`/`hand-2` 的手别由学习者选择；慢速阶段 BPM 四舍五入到 5，`pass-check` 严格使用学习者目标 BPM（72 不会被降成 70）。
- `findRemediation()` 原有证据门槛保持不变：不可信/中断/不可评分 → `check_input`；报告不可用/低置信 → `collect_more_evidence`；然后按 MISSING（p0）→ WRONG_PITCH（p1）→ EXTRA/DURATION（p2）→ LOCAL_ONSET（p3）只选一个。
- `performanceHighlights()`（新增）：只从 Rust 报告的逐小节 `matched/missed/meanAbsOnsetErrorMs` 生成“做得好”，最多两条；证据不可用时返回空数组，UI 显示“老师不编造结论”。
- `buildDecision()` 增加 `highlights`；DTO 层增加 `learnerFeedback`（优先课程 `feedbackRules` 的话术，回退到策略 reason）、`lesson` 课程视图。
- `record-take` 仍然只接受**已持久化**的 Take；重复 takeId 幂等且不产生第二个决策；指纹不一致/`pending-retry` 均拒绝。
- 完成分支记录 `transfer: not-executed` + 课程复习策略，不自动宣称掌握。

浏览器只提交用户意图和 takeId；不上报报告、诊断或处方。

## 4. 单屏工作区（§4.4）

`src/components/TeachingWorkspace.tsx` + `TeachingStepPanel.tsx` + 新增 `TeachingStepTrack.tsx`：

- 顶部：课程标题、当前步骤、MIDI 输入状态、进度、退出。
- 步骤轨迹：服务端步骤的短标签 + 手别/BPM；插入的针对性练习也会出现在轨迹中。轨迹换行，不裁切。
- 左栏：本阶段乐谱速览（客观事实）+ OSMD 谱面；谱面只在框内滚动。
- 右栏：老师讲解（课程 `explainScript` / 阶段 coaching）+ 反馈四段式（做得好 / 一处要改 / 证据详情 / 下一步）+ 唯一主操作。
- 证据不足时“做得好”明确显示“这次没有足够可靠的证据做正面评价，老师不编造结论”。
- 课程选择页：8 节课卡片、A–B 循环范围、目标 BPM、先练哪只手；`GET /api/teaching/lessons` 载入失败有错误与重试。
- 布局：`.teaching-page` 固定为 `calc(100vh - 72px)` 且 `overflow:hidden`；桌面端 `document.scrollHeight === clientHeight`（浏览器实测 720/720）；侧栏改为自身滚动，避免把页面撑高。

导航与进度：

- `NAV_ROUTES` = 学习（`/teaching`）/ 自由练习（`/workbench`）/ 进度（`/progress`）。
- `/progress` 组合 `ProfileView` 与 `HistoryView`，保留“能力画像是暂定判断，不是能力认证”的措辞。
- 曲谱库入口移到工作台标题栏；`/scores`、`/history`、`/profile`、`/device` 仍保留直达 URL，但不再占据主导航。

## 5. 真实 Take 链路（§4.5）

已验证链路：

1. 课程页 `POST /api/teaching/runs`（lessonId + firstHand + A–B 范围 + BPM）→ `hands-progression-v1` 五步。
2. 主按钮把 Node 下发的 `practiceRequest` 固定到练习配置（tempo/hand/loopStart/loopEnd）并回到自由练习室；学习者点“开始练习”后走既有的计划校验并启动真实练习。
3. 练习结束后 Take 原子落盘；回到学习页时自动 `record-take`（同一次 Take 只登记一次，revision 保护，409 会刷新而不是盲重试）。
4. Node 读取 Take → 决策 → 反馈区；期间输入状态、待持久化状态、指纹不匹配均有明确提示。

浏览器验收（mock MIDI，非物理设备）：

- 创建课程：`lesson-4c7fea…`，范围 1–8 小节，先右手。
- 手别映射未确认时，主按钮区显示“暂时无法开始这一步：尚未确认「谱表→手别映射」…”而不是死按钮；确认后恢复。
- 真实练习产生 Take `take-e4dc98ec-2864-4576-99c0-1fb48f831102`（`INSUFFICIENT_DATA`）并成功持久化。
- 该 Take 登记后，UI 显示“证据不足，暂不下结论 / 老师不编造结论 / 重弹本阶段，收集完整证据”，没有分数或“学会”。
- 为验证“有证据的表扬 + 单一纠错”视觉，临时写入本地 Take 夹具 `take-ui-lesson-demo-1` 并登记，UI 显示第 1、4 小节“做得好”、“漏音 · 第 3 小节 · 建议 45 BPM · 证据置信 高”、下一步话术；夹具与相关本地 LessonRun 已删除，代码与测试不依赖该夹具。
- 验收数据已清理恢复指针；未清理的 `take-e4dc…` 是真实浏览器练习产生的本地记录。

## 6. 测试与验证

在本机提交 `4cc0755` 上执行（仓库无 CI，以下均为本地结果）：

| 命令 | 结果 |
|---|---|
| `npm run test:teaching` | 32 pass / 0 fail（orchestrator 27 + content 5） |
| `npx vitest run` | 565 pass / 4 skipped（59 文件，57 pass / 2 skipped） |
| `npx tsc -b` | 通过（无输出） |
| `npm run build` | 通过（仅有既有 chunk size 警告） |
| `npm run selftest` | 251 项全部通过 |
| `cargo test --locked`（core，GNU 工具链） | 179 pass / 0 fail |

新增/更新测试：

- `server/teaching-content.node-test.mjs`：8 节唯一、先修闭环、讲解/阶段话术/反馈规则完整性、目录深拷贝隔离、课程视图键映射。
- `server/teaching-orchestrator.node-test.mjs`：hands-progression 步骤/BPM/范围、lesson 反馈话术映射、highlights 只来自可信证据、完成时 transfer/review、未知课程/手别拒绝、无课程运行兼容。
- `server/teaching-orchestrator.api.test.mjs`：`GET /api/teaching/lessons`、课程运行、未知课程/手别 400、lesson 反馈 DTO。
- `src/components/TeachingStepPanel.test.tsx`：讲解、唯一主操作、反馈四段、证据不足不表扬、指纹不符、pending-retry、完成不宣称掌握。
- `src/components/TeachingStepTrack.test.tsx`：短标签、手别/BPM、当前步骤、插入的针对性步骤、步骤数量不虚构。
- `src/app/routes.test.ts`：主导航三项及顺序、旧页面退出导航、`/progress` 注册。

一次完整 vitest 运行中 `server/plan-protocol.test.mjs` 的两个用例因并行启动超时（5000ms）失败；单独运行 11/11 通过，紧接着完整重跑 565 pass。该文件不属于本次改动，属于本地并行启动的已知抖动，报告中不把它算作通过，也不声称 CI 通过。

## 7. 未做/边界

- 未做物理 MIDI 验证；浏览器验收使用 `RHYTHM_MIDI_BACKEND=mock` 与模拟按键。
- `pass-check` 的迁移检查在 V1 不自动执行；完成只代表当前范围流程走完。课程自带复习策略，但没有自动排程。
- from-take（流程 B）仍创建通用步骤，不套用 8 节课程；它服务“从某次 Take 直接开始纠错”的场景。
- 浏览器验收中出现过一次后台标签渲染暂停（计时停在 7s），服务端仍完成并持久化 Take；换新标签后继续验收。该现象未定位为产品缺陷，但“切换标签/后台时的计时与渲染”本轮未验证。
- 未改 `scoring_v1`、`HitMatcher`、`build_schedule`、`PracticePlanBundleV1`、`ScoreDocumentV1`、plan-fingerprint 固定向量、golden/parity 资产或 `EngineScoreEvent` 线格式。
- 未改 `RHYTHM_PLANNER` 生产默认（仍为 `rts`），未合并 `main`。

## 8. 回滚

- 代码回滚：`git revert 4cc0755`（报告提交单独回滚）。
- 本地数据：课程目录为代码内置，无迁移；LessonRun 文件仍在 `%APPDATA%/rhythm-trainer-frontend/lesson-runs/`，回滚后旧 UI 仍可读取通用字段，未知 `lessonId` 会被旧编排器忽略/拒绝创建，不会破坏已有 Take。
- 导航回滚仅涉及 `src/app/routes.ts` 与 `src/App.tsx` 的入口映射。

## 9. 后续修正

- `e0c5a55`（2026-10-27，用户反馈“这都同一个 UI，把乐谱跟练换成练习模式”）：把 `score` 模式的用户可见名称从「乐谱跟练」统一改为「练习模式」（`modeRegistry.ts`、`practiceRepository.ts` 的 `MODE_CN`、`server/mode-config.mjs` 的 `modeLabel`、练习设置里的说明文案）。面包屑、练习卡片标题、侧栏模式项、历史/报告模式标签现在都显示「练习模式」。
- `9ac1a42`（同日，用户反馈“它的内容肯定也要变”）：同步该模式的副标题与说明，侧栏从「跟随乐谱演奏」改为「按设置练习」，卡片说明改为「按当前曲谱与练习设置演奏；开始后由本地引擎给出实时判定、逐小节证据与练习报告。」，不再保留“乐谱跟练”时代的专属文案。
- 改后重跑 `npx vitest run` 565 pass / 4 skipped、`tsc -b` clean，并在浏览器确认 `/workbench` 的面包屑、卡片标题/说明与侧栏模式项一致。

## 10. 文件清单

新增：

- `rhythm-trainer-frontend/server/teaching-content.mjs`
- `rhythm-trainer-frontend/server/teaching-content.node-test.mjs`
- `rhythm-trainer-frontend/src/components/TeachingStepTrack.tsx`
- `rhythm-trainer-frontend/src/components/TeachingStepTrack.test.tsx`

修改：

- `rhythm-trainer-frontend/package.json`
- `rhythm-trainer-frontend/server/engine-server.mjs`
- `rhythm-trainer-frontend/server/teaching-orchestrator.mjs`
- `rhythm-trainer-frontend/server/teaching-orchestrator.node-test.mjs`
- `rhythm-trainer-frontend/server/teaching-orchestrator.api.test.mjs`
- `rhythm-trainer-frontend/src/App.tsx`
- `rhythm-trainer-frontend/src/app/routes.ts`
- `rhythm-trainer-frontend/src/app/routes.test.ts`
- `rhythm-trainer-frontend/src/components/TeachingStepPanel.tsx`
- `rhythm-trainer-frontend/src/components/TeachingStepPanel.test.tsx`
- `rhythm-trainer-frontend/src/components/TeachingWorkspace.tsx`
- `rhythm-trainer-frontend/src/services/teachingRunRepository.ts`
- `rhythm-trainer-frontend/src/styles.css`
