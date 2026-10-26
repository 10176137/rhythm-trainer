# Teaching UI V1 — 交付报告

- 报告日期：2026-10-26
- 基线分支：`r2-3-algorithm-upgrade-v1-1` @ `5e8d9de`（任务卡核验基线，未漂移）
- 目标分支：`r2-3-teaching-ui-v1`
- 基线起点 SHA：`5e8d9de09bb7a45583eaa2e5e80429d5ae8376da`
- 最终 HEAD SHA：见下方 git 记录（报告提交）；**代码提交 `b2241f09997db49bd7fdf121a0df1dd4fddbdd72`（verifiedCodeSha b2241f0）**
- 提交列表：
  1. `b2241f0`：`feat(teaching-ui): Teaching UI V1 — workspace, from-take flow, Node-only strategy`
  2. 报告提交（本文件，SHA 见 git log 尾条）
  - 过程说明：开发中的中间提交（4d94fb1→1f096cf→769e819→01179f2）曾在未推送/已推送状态间反复 amend，最终推送前重置为以上两个干净提交并 force-push 覆盖；内容与 01179f2 完全一致，仅历史重组。
- 验证性质：**本地验证，无 CI**。仓库无 CI workflow；本报告不把本地结果表述为 CI 通过。

## 1. 交付范围与用户路径

### 流程 A：从当前曲谱开始教学（已真实 UI 走通）

1. `/workbench` 新增「✎ 老师带练」入口；无语义曲谱时按钮禁用并显示解释，不用示例数据伪装。
2. `/teaching` 路由（导航「老师带练」）挂载 `TeachingWorkspace`：学习目标/范围/BPM/手别表单（默认取当前练习配置）。
3. 「创建课程并开始」→ `POST /api/teaching/runs`（只提交用户意图）→ 成功后自动发送 `begin`。
4. `study_score` 步骤显示读谱提示；用户点「继续」才发 `complete-step`。
5. `guided_practice` 步骤显示 Node 生成的 `practiceRequest`（范围/手别/BPM/一次范围说明）；「开始这一步的练习」把该配置固定到练习室（`applyTeachingStepConfig`），并导航回工作台。
6. 实际启动走既有 launch 链路（默认 rts：TS 投影 + 服务端四码候选校验；rust 权威时走 Rust plan + Bundle 门禁）。
7. 演奏结束、Take 持久化后（本验收 `take-41306133-…`，报告面板确认「报告已保存」），回 `/teaching` 恢复课程：workspace 的自动登记 effect 把该 Take 以 `record-take` 交给 Node（revision 守卫、单次登记、pending-retry 不提交）。
8. Node 返回决策并渲染：本次真实链路返回 `collect_more_evidence`（证据不足，不下结论、不出处方）——不把无匹配输入说成能力问题。
9. 「结束学习」→ `abandon`；完成全部必需步骤由 Node 判定 `completed`，UI 明示「完成 ≠ 掌握」。

### 流程 B：从已保存 Take 开始教学（已真实 UI 走通）

1. 历史/报告的「针对性复练」面板重写为纯交互组件：标题「基于这次结果开始教学」，明确说明诊断来自 Node。
2. 用户选范围/BPM/手别 → `POST /api/teaching/runs/from-take`（只带 `takeId` + 用户选择；指纹由服务端对已落盘 Take 校验，不一致 409）。
3. Node 复用 `findRemediation()` 策略；创建的 run 携带 `sourceTakeId`/`sourceSelection=user-selection`。
4. 创建成功后 `saveLastRunId()` 把恢复指针指向新课程；「打开老师带练」→ `/teaching` → 「恢复上次课程」打开的正是这堂课（验收中确认 `来源 Take take-41306133…` 显示于工作区）。

### 流程 C：恢复与异常（已真实 UI 走通 + 单测覆盖）

- localStorage 只存最近 `runId` 指针（`rhythm-trainer.teaching.last-run.v1`）；刷新后 setup 页显示「恢复上次课程」，点击后 GET 服务端为唯一状态依据。
- `commandId` 每次逻辑命令稳定生成；409 `STALE_TEACHING_REVISION` 时自动 GET 刷新并提示用户重新确认，不盲目重试。
- 服务端 404 →「上次的课程不存在或已被清理，请重新创建」；其余错误映射为可读中文，不显示通用 500。
- 离开保护沿用既有 `LeaveGuardDialog`/`practiceInProgress`，页面卸载不静默 abandon。

## 2. 架构与数据流（Rust → Node → TS）

- **Rust（音乐事实，未改动）**：曲谱语义、Plan、MIDI 解释、匹配、计时、评分、`scoreV1`/measures/eventResults/durations 全部来自既有 Rust/NAPI 链路；本任务零改动。
- **Node（教学编排）**：
  - `TeachingOrchestrator` 新增 `createRunFromTake()`（flow B 入口，内部同一条 `findRemediation` 策略）。
  - `toPublicRun()` DTO 增补 `latestDecision`、`sourceTakeId`、`sourceSelection`；create/get/applyAction 三条路径一致。
  - **策略健壮性修复**：`safeMaxMeasure` 不再把 `eventResults[].measure` 计入合法小节上界——越界/恶意 measure 值不能扩大可诊断范围（新增保守性测试）。
- **TS（交互层）**：`teachingRunRepository.ts`（类型化 REST 客户端 + `TeachingApiError` + last-run 指针）、`TeachingWorkspace.tsx`（创建/恢复/登记协调）、`TeachingStepPanel.tsx`（纯展示，动作只来自 `availableActions`）、`TargetedPracticePanel.tsx`（重写为 flow-B 交互）。TS 不再计算任何教学结论。

**TS 规则迁移（任务卡 §6 强制项，已完成）**：

- 删除 `src/features/practice/teachingPrescription.ts` 及其测试（生产路径零引用后删除；`grep` 验证全仓无 `buildTeachingPrescriptions`/`buildManualPrescription` 残留）。
- `TargetedPracticePanel` 不再 import 任何 TS 规则；组件测试断言旧策略产物（`LOCAL_ONSET_V1`、`确认创建复练任务`、`系统处方`）不出现在渲染输出。
- `TeachingPrescription` 类型仅保留在 wire 协议字段（`start` 消息的 sourceReportId/sourceTakeId 来源链）与 retryComparison 类型中，不再有生产者生成处方对象；`LaunchSource` 精简为 fingerprint/reportId/takeId/barCount，launch 不再附带 prescription。
- 策略行为现由 Node 单测固定样本表锁定（见 §4）。

## 3. Node API 增改

| 端点 | 变更 |
|---|---|
| `POST /api/teaching/runs` | 不变（契约兼容） |
| `GET /api/teaching/runs/:runId` | 响应 DTO 增 `latestDecision`/`sourceTakeId`/`sourceSelection`（additive） |
| `POST /api/teaching/runs/:runId/actions` | 行为不变；`record-take` 的 pending-retry/指纹守卫沿用 |
| `POST /api/teaching/runs/from-take` | **新增**：仅接受 `takeId` + 用户配置；服务端读 Take、校验持久化状态（`TAKE_NOT_PERSISTED` 409）、存在性（`TAKE_NOT_FOUND` 404）、指纹（`SCORE_FINGERPRINT_MISMATCH` 409） |

## 4. 测试明细（全部本地执行）

| 命令 | 结果 |
|---|---|
| `npm run test:teaching`（node:test） | **21 pass / 0 fail**（原 8 项 + 11 项策略表 + from-take 拒绝路径 + 保守小节映射） |
| `npx vitest run` | **559 passed / 4 skipped**（56 files passed / 2 skipped）；新增 `TeachingStepPanel.test.tsx` 5 项、`scoreBriefing.test.ts` 3 项、重写 `TargetedPracticePanel.test.tsx` 6 项、`routes.test.ts` 增 teaching 路由断言 |
| `npx tsc -b` | 通过，无输出 |
| `npm run build` | 通过（仅既有 chunk >500kB 警告） |
| `npm run selftest` | **251 ok**，全部通过 |
| `cargo test --locked`（GNU target） | **179 passed / 0 failed**（102+1+23+11+1+7+7+1+5+21，逐 binary 汇总） |

策略表覆盖（同输入同 policyVersion 决策一致，含双 orchestrator 重放比对）：MISSING / WRONG_PITCH / EXTRA / DURATION（有效分级 ≥2）/ LOCAL_ONSET / 低置信度 / dataDegraded / 不可信输入 / interrupted / Follow-only（绝不当作 Timeline 分数）/ 干净报告 → advance；越界 measure 不产生处方。

R2-3c/R2-3d evidence JSON 在全量 Vitest 后已 `git checkout --` 恢复，未进入提交。

### 4.1 教学内容适配（用户反馈「编排没有对应的内容」后的补充）

初版教学页只有 Node 返回的步骤文案，用户看不到与当前曲谱对应的内容。补充（均为乐谱事实的**展示**，不引入第二套教学决策）：

- **曲谱速览卡**（`src/features/teaching/scoreBriefing.ts`，纯函数 + 3 项单测）：按当前步骤的小节范围陈述调号、拍号、音符/休止数、音域（写法拼写）、谱表 1/谱表 2 音符分布、音符最多的小节。数据来自已解析的语义曲谱（engine doc），不来自任何评分或策略计算。
- **真实制谱视图**：`TeachingWorkspace` 内嵌 `OsmdScoreView` 只读渲染原 MusicXML（range 外小节盖罩），读谱/带练/独立演奏每一步都能直接看到乐谱本身。
- **无法开始练习的原因内联显示**：App 计算 `teachingPracticeBlock`（缺语义引擎数据 / 多 Part / 未确认谱表→手别映射 / 有练习进行中），`TeachingStepPanel` 在教学页直接展示原因并隐藏开始按钮——不再跳回工作台后才失败。
- **布局适配**：教学卡片限宽 920px + 内边距，表单栅格换行，宽屏不再整行拉伸。

## 5. 真实 UI 验收（默认 rts + mock MIDI；无物理 MIDI）

环境：engine `PORT=8788 RHYTHM_MIDI_BACKEND=mock`，Vite `127.0.0.1:5174`。乐谱《晓之车》（113 小节，指纹 `2654f283…`）。

按任务卡 §9.4 逐步执行并观察：

1. 打开曲谱 → `/teaching` 表单显示曲名/小节/指纹。
2. 创建课程 → 自动 `begin`，状态「学习中」，读谱步骤 active。
3. 「继续」完成读谱 → 带练步骤显示 Node 的 practiceRequest（1–4 小节 · 双手 · 72 BPM · loop 只表示范围）。
4. 「开始这一步的练习」→ 练习室 toast「教学步骤已就绪」，页面 chips 确认 72 BPM/第 1–4 小节/固定时间。
5. 「开始练习」→ 走既有计划校验进入「练习中」；mock MIDI 注入 4 音 → 「结束」→ 报告生成且「报告已保存（take-41306133-4cb5-4a9c-9e0e-ade423858237）」。
6. 回 `/teaching` → 「恢复上次课程」→ 自动 `record-take` 成功，Node 决策「证据不足，暂不下结论」（0 证据条目，无处方，不出能力标签）——符合证据门槛。
7. 刷新页面 → setup + 「恢复上次课程」→ 恢复到 awaiting_evidence 与同一决策（服务端为真源）。
8. 历史 → 「基于这次结果开始教学」→ 选范围创建 → 新课程 `lesson-4ab44a…`，恢复后显示「来源 Take take-41306133…」；「打开老师带练」落点正确（指针修复后复验）。

限制：MIDI 输入为服务端 mock 注入（`midi-test-note`），非物理键盘；验收聚焦教学工作流串联，未宣称硬件层验收。

## 6. 文件清单

新增：

- `src/services/teachingRunRepository.ts`
- `src/components/TeachingWorkspace.tsx`
- `src/components/TeachingStepPanel.tsx`（+ `.test.tsx`）

重写/修改：

- `src/components/TargetedPracticePanel.tsx`（+ 测试重写）
- `src/components/ReportPanel.tsx`、`HistoryView.tsx`（props 换为 Node 决策回调）
- `src/App.tsx`（路由挂载、`applyTeachingStepConfig`、teachingTakeNotice、删除 TS 规则路径 `startTargetedPractice`/`pendingTargetedLaunch`）
- `src/app/routes.ts`（+`/teaching`）、`routes.test.ts`、`src/styles.css`
- `server/teaching-orchestrator.mjs`（from-take、DTO、safeMaxMeasure 修复）、`engine-server.mjs`（路由注册）
- `server/teaching-orchestrator.node-test.mjs`（策略表）、`server/teaching-orchestrator.api.test.mjs`（from-take 集成）

删除：

- `src/features/practice/teachingPrescription.ts`、`teachingPrescription.test.ts`

## 7. 遗留限制与非目标

- **环境限制**：无 CI；浏览器验收用 mock MIDI；无物理键盘（如实记录，不宣称硬件验收）。
- **代码限制**：
  - `TeachingWorkspace` 每次挂载（进入 `/teaching`）不自动恢复 last run，需要用户点一次「恢复上次课程」（按 §4.4 的恢复入口语义实现，避免静默打开旧课程）。
  - `demonstrate` 步骤：V1 未接参考播放绑定，创建时固定 `referenceAvailable=false`，该步骤不会出现——无假按钮。
  - 课程模板仍是固定 `guided-score-v1` 最小流程；无 AI/Transfer Test/Profile 写入。
  - `appliedCommands` 仅保留最近 128 条；`from-take` 未做去重（同一 Take 可开多堂课，属产品语义未定）。
- **非目标（未做，符合任务卡 §10）**：评分/对齐/PlanBundle/Rust 语义零改动；默认 `rts` 未动；`main` 未合并；未创建 PracticeSession 聚合；LessonRun 只存 takeRefs/decisions。

## 8. 回滚方式

功能分支未合并 `main`，直接弃用分支即可整体回滚。若需部分回退：删除 §6 新增文件并 revert 对应修改文件即可；`/api/teaching/runs/from-take` 为新增端点，下线路由不影响既有端点；DTO 新增字段均为 additive，旧前端忽略即可。
