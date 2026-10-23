# Rhythm Trainer 用户视角功能页面需求 v1.1（修订稿）

- 版本：v1.1（待审核，不进入代码实现）
- 日期：2026-10-22
- 取代：`RHYTHM_TRAINER_USER_FACING_PAGES_v1.0`
- 依据：当前仓库审计、`REFERENCE_PLAYBACK_IMPLEMENTATION_REPORT.md`、`PROJECT_STATUS_AND_ENGINE_GAPS_2026-10-22.md`
- 约束：本文件只修订需求与实施计划；不修改业务代码。

> 本修订稿的核心变化：把 v1.0 的“9 个 P0 页面”重新基线为 **Track A 最小可用用户闭环**、**Track B 完整评分与针对性复练**、**Track C 历史/进度/诊断/扩展**。P08 完整报告、P09 复练、独立试听、PlaybackSnapshot 光标、MXL 导入不再被当作 Track A 已具备能力。

---

## 1. 目标与真相层级

### 1.1 产品闭环

```text
打开首页
 → 曲谱库 / 导入
 → 曲谱阅读
 → 连接键盘（需要评分时）
 → 练习设置
 → 示范/跟弹
 → 本轮结果
 → 差距报告
 → 针对性复练
 → 历史与学习进度
```

### 1.2 能力真相层级

1. **Rust Core / TargetSchedule 是评分与目标时间的唯一权威。**
2. **Reference Playback 只负责声音、播放位置和播放健康。**
3. **React 只呈现与交互，不重新计算目标时间、评分或音高匹配。**
4. **页面上不存在的指标必须显示 unavailable / 暂不可用。**

### 1.3 v1.1 的 P0 重新定义

v1.1 中 **P0 = Track A**（最小可用用户页面与练琴流程）。Track B 是完整评分与复练的关键后续，不阻塞 Track A 的页面骨架，但 P08 完整报告/P09 不得在 B0/B1/B2 前宣称可用。Track C 是历史、进度、诊断和扩展能力。

### 1.4 不允许的非声明

以下能力在 v1.1 中**不得**被标为已实现或 MVP 可用：

- Pitch / Overall / Confidence 完整评分；
- 每小节与事件级诊断；
- 从报告创建针对性复练任务；
- 独立试听、不创建 Take 的预览链路；
- PlaybackSnapshot 驱动的播放光标；
- `.mxl` 导入。

它们分别放在 Track B/C，或保持 blocked。

---

## 2. Track 与批次

### 2.1 Track A：最小可用用户页面与练琴流程

目标：让用户能真实完成一次“打开 → 选谱/导入 → 看谱 → 连接设备 → 配置 → 练习 → 看到当前可用的节奏/时长结果”。

- 不依赖 `scoring_v1` 的 pitch/overall/confidence。
- 不要求独立试听、PlaybackSnapshot 光标、P09 复练、MXL。
- 报告只展示已有真实计算的数据；不可用指标明确标记。

批次：

| 批次 | 交付物 | 关键阻塞 |
|---|---|---|
| A0 | AppShell、导航、路由/视图骨架、离开确认 | 现有 `App.tsx` 是单页 `view` 状态，无 router |
| A1 | P01 首页、P02 曲谱库、P03 导入、P04 阅读页 | 曲谱库缺状态字段；`.mxl` 不支持 |
| A2 | P05 设备、P06 设置、P07 练习室、现有节奏/时长报告摘要 | 参考播放已有，独立试听/光标未做；报告字段有限 |

### 2.2 Track B：完整评分链路和针对性复练

目标：把库级 `scoring_v1` 接成产品级最终评分，并让 P08/P09 有真实数据。

批次：

| 批次 | 交付物 | 关键阻塞 |
|---|---|---|
| B0 | `scorePerformance` NAPI、ScoreEvent/PerformedNote 契约、pitch/overall/duration/confidence 接线、TargetSchedule/clock/real-time-vs-final 专项 | 当前 `scoring_v1` 未导出；`TargetHit` 无 pitch/voice/逐音时值 |
| B1 | P08 完整报告：pitch/overall/每小节/事件级可用字段/confidence/unavailable 状态 | B0 |
| B2 | P09 针对性复练：从报告小节/手别/BPM 预填新 Take | B1 的每小节诊断与报告数据 |

### 2.3 Track C：历史、学习进度、诊断导出和扩展能力

- C1：P10 练习记录详情、P11 学习进度、同范围对比。
- C2：P12 设置/诊断导出、音频输出/延迟校准、存储管理、版本信息、`playbackRunId`/播放诊断持久化。
- C3：扩展能力：独立试听、PlaybackSnapshot 光标、`.mxl`、repeat/ending、tempo map、采样钢琴、音频只手静音等。

C 不阻塞 Track A；C1/C2 可在 B1 之后并行；C3 按产品优先级单项排期。

---

## 3. 能力状态矩阵

状态定义：

- **已实现**：产品链路可运行，有代码和验证证据。
- **部分实现**：有代码或局部能力，但未达到本文件验收条件。
- **未实现**：产品链路没有该能力。
- **未验证**：代码存在但缺少可复现证据；本文件不把它当作通过。

说明：“批次”列即实施安排。审核通过后的**第一批代码实施是 Track A（A0-A2）**；B/C 为后续批次，其中 B0 可并行设计但不在本批交付。**本轮只做文档修订，不实施任何业务能力。**

### 3.1 页面/基础设施

| 能力/页面 | 状态 | 现有代码依据 | 依赖/接口 | 批次 | 验收条件 |
|---|---|---|---|---|---|
| AppShell / 导航 / 路由 | 未实现 | `src/App.tsx:108` 使用 `view: 'workbench' \| 'history' \| 'profile'`；`1479-1481` 侧栏按钮；无 router | React、现有页面组件 | A0 | 12 个页面有稳定入口/URL；刷新保持；练习中离开有确认 |
| P01 首页 | 未实现 | 当前首屏直接是工作台，无 home | AppShell、sessions/score API | A1 | 空状态可导入；最近曲谱/报告真实；无调试指标；Continue 只在可恢复时出现 |
| P02 曲谱库 | 部分实现 | `score-library.mjs` CRUD；`scoreLibrary.ts`；设置面板内列表；meta 无 import status | `/api/scores`、ImportReport | A1 | 独立页面；列表/搜索/筛选；状态真实；打开/重命名/删除有确认；不把可打开等同可评分 |
| P03 导入与解析结果 | 部分实现 | `musicXmlParser` / `musicxml-importer`；App 导入 feedback；无分阶段 UI；`.mxl` 不支持 | ImportReport、打分能力 | A1 | 分阶段显示；成功/警告/受限/失败；失败可重试；不产生半初始化曲目 |
| P04 曲谱详情/阅读 | 部分实现 | `OsmdScoreView`；固定 1510px；`Zoom=1.0`；无页码/适合宽度 | OSMD/ScoreViewAdapter | A1 | 清晰谱面；缩放/适合宽度/小节导航；警告可查阅；不错误高亮 |
| P05 设备连接向导 | 部分实现 | Node MIDI adapter；状态/监视器；无向导式 Note On/Off 测试 | MIDI adapter、`/api/midi/*` | A2 | 刷新/连接/断开；按键测试显示 Note On/Off；缺 Note Off 明确提示；不显示评分 |
| P06 练习设置 | 部分实现 | 设置弹窗：模式/BPM/手别/判定/推进/循环/节拍器；无独立播放方式/预备拍/音量 | PracticeConfig、Reference Playback | A2 | 模式和播放方式分离；参数校验；开始前列出限制；不把不可用项藏起来 |
| P07 练习室 | 部分实现 | 单页工作台；参考播放已接；暂停/继续/停止；无页面路由/离开确认/独立试听/光标 | Session/Take、Reference Playback | A2 | 主区域以谱面为主；传输控制完整；本轮结果可查看；离开有保护 |
| P08 练习报告 | 部分实现 | `ReportPanel`：onset stats + duration + analysis；无 pitch/overall/每小节/事件级 | EngineReport、durations、captureDiagnostics | A2 仅在 P07 内显示摘要；P08 页面在 B1 | A2 只显示真实字段；B1 才显示 pitch/overall/每小节/confidence |
| P09 针对性复练 | 未实现 | 无报告→复练入口；`practice_ranges`/measure report 未接线 | B1、Session/Take | B2 | 从报告预填范围/手别/BPM/循环；创建新 Take；不覆盖旧报告 |
| P10 练习记录详情 | 部分实现 | `HistoryView` 列表+展开报告；`SessionDetail` 只声明部分字段；服务端 detail 返回完整 record | `/api/sessions`、Take record | C1 | 列表筛选；详情显示冻结配置/fingerprint/算法版本/状态；中断与完成区分 |
| P11 学习进度 | 部分实现 | `ProfileView` 模式级技能 + MAE 趋势；无曲目级/pitch/时值趋势 | `/api/profile`、历史报告 | C1 | 曲目/模式维度；样本不足显示空；阈值可配置；不混不同条件 |
| P12 设置与诊断导出 | 部分实现 | 设置弹窗；导出 Trace；无音频设备/延迟/存储/诊断包 | 本地数据、Trace、Journal | C2 | 音频/设备/存储设置；诊断包预览选择；版本信息；无 secrets |

### 3.2 播放、评分与引擎能力

| 能力 | 状态 | 现有代码依据 | 依赖/接口 | 批次 | 验收条件 |
|---|---|---|---|---|---|
| 练习内 Reference Playback | 已实现（P0 核心） | `features/playback/*`、`reference-playback-plan.ts`；浏览器实测通过 | PlaybackPlan、AudioContext、engine origin | A2 复用 | 共享 plan；逐 voice 时值；暂停/停止无残音；诊断可见；不进入用户输入 |
| 独立试听（不创建 Take） | 未实现 | 控制器只在 `onStarted` 启动；无 preview 路由 | ReferencePlaybackController、standalone clock | C3 | 无 MIDI/无 Take 可播放；不显示用户分数；有播放控制 |
| PlaybackSnapshot 驱动光标 | 部分实现 | Snapshot 已存在；红标由 snapshot 位置推进；绿色仍由 FollowSession/未判定目标驱动 | PlaybackSnapshot、ScoreViewAdapter | C3 | 光标位置来自 snapshot；UI 降帧不改声音；映射不可靠退化为小节高亮 |
| Pitch / Overall / Confidence 完整评分 | 未实现（产品链路）；Rust 库已实现但未接通 | `scoring_v1.rs` 有 `score_performance`；无 NAPI 导出；`EngineReport` 无 pitch/overall | NAPI、ScoreEvent、PerformedNoteV1、server、ReportPanel | B0/B1 | 最终报告有 pitch/overall/confidence；缺失显示 unavailable；无默认 0/100 |
| 每小节与事件级诊断 | 未实现 | `scoring_v1` 有 MeasureReport/practice_ranges，但未接线；ReportPanel 无小节视图 | B0 report | B1 | 每小节可用指标/证据；点击回乐谱；数据不足显示不可判断 |
| 针对性复练 | 未实现 | 无入口/无新 Take 预填 | B1、Session/Take | B2 | 预填范围/手别/BPM；新 Take；旧报告不变；可对比同范围 |
| TargetSchedule 一致性 | 已实现（参考播放范围）/部分（页面/报告） | `validateReferencePlanAgainstTargets`；App start 校验 | PlaybackPlan、engine targets、planId/fingerprint | A2/B0 | 播放/评分/光标同一 plan；不一致阻止；快照可复现 |
| 音频/MIDI 时钟映射 | 部分实现 | `clock-map.mjs`；`captureDiagnostics.clockMapping`；无统一 Take mapping/output latency | AudioContext、Node monotonic、Take | B0/C2 | 同一 Take 的 mapping id；质量可见；不稳定→unscorable；输出延迟校准 |
| 实时匹配 vs 最终对齐 | 部分实现 | 实时 `HitMatcher` onset-only；最终 `scoring_v1` 未接线；`align_performances` 贪心+4 音 lookahead | matcher、scoring_v1、trace replay | B0 | 实时暂定、最终权威；extra/missing 不级联；错音/和弦语义明确 |
| Repeat/ending、tempo map | 未实现 | importer `blocksStrict`；App `repeatSelection: none`；TempoMap 单 BPM | Score importer/planner | C3 | 实际演奏顺序/occurrence/评分一致；否则明确阻断 |
| `.mxl` 导入 | 未实现 | importer 只接受 `.musicxml` 文本；无容器解压 | 文件容器/安全限制 | C3 | 支持后验证容器/压缩/安全；不支持时明确拒绝 |
| 采样钢琴 | 未实现 | 当前 `synthPiano.ts` 为本地合成 | 本地资源/许可证 | C3 | 本地离线、许可证明确、体积可控；无 CDN |
| 音频输出延迟校准 | 未实现 | Core README 明确未实现；播放/输入仅对齐 session origin | Audio output、calibration UI | C2 | 可配置/校准；报告区分输出延迟与演奏偏差 |
| `playbackRunId`/播放诊断持久化 | 未实现 | 会话记录有 planId/config/fingerprint/trace；无 playbackRunId；播放诊断只在内存/反馈 | Take record、Journal/Trace | C2 | 会话记录可查 playbackRunId/播放诊断；可关联失败 run |
| 曲谱库导入状态持久化 | 未实现 | `score-library.mjs` meta 只有 name/fileName/size/时间 | 保存 ImportReport 摘要 | A1 | 列表直接显示可练习/受限/警告/失败；不是只凭扩展名 |
| Continue 可恢复练习 | 未实现 | 无未完成 Take 的恢复接口；仅恢复 active score | Session/Take snapshot | A1 | 只有真实可恢复快照才显示 Continue；否则新建 attempt |
| Take 配置快照详情 | 部分实现 | 服务端 record 有 scoringConfig/版本/fingerprint/planId/trace；`SessionDetail` 类型/UI 未展示 | session detail API | C1 | 历史详情展示冻结配置/版本/fingerprint；不显示当前设置冒充历史 |
| `free` 模式不生成假分数 | 已实现 | `beginFreePlay`/`finishFreePlay` 无 engine report；ReportPanel 不显示 | App/hook | A2 | 自由练习只显示输入活动/记录；无标准分/0 分 |
| 参考播放输入隔离 | 已实现 | WebAudio 音频路径与 raw MIDI/PerformedEvent 分离 | Playback/AudioEngine | A2 | 参考音不进入用户事件/成绩；测试/手工验证 |

---

## 4. 页面需求（按 Track）

> 页面细节沿用 v1.0 的用户目标，本版只补充**范围收缩、依赖、状态和验收**。未列出的视觉细节不作为本版阻塞条件。

### 4.1 P01 首页（Track A / A1）

- 主行动：导入曲谱、打开曲谱库、继续练习。
- 继续练习语义：**只有存在可恢复的 Take 快照时才显示**；当前没有恢复接口，因此 A1 的 Continue 只允许“用上次曲谱/配置新开一轮”，并在文案中写清楚，不得称为恢复旧 Take。
- 最近曲谱/报告来自真实 API；空状态给导入入口。
- 验收：无数据时不出现假卡片；点击最近曲谱进入 P04；点击报告进入 P08/P10 可用入口。

### 4.2 P02 曲谱库（A1）

- 独立页面；列表/搜索/筛选；打开、重命名、删除。
- 状态必须来自持久化的 ImportReport 摘要（A1 需补 meta 字段），不是只凭扩展名：
  - 可练习 / 可阅读但评分受限 / 有警告 / 导入失败。
- 验收：导入一个有 repeat/tempo 的谱显示“可阅读但评分受限”；删除前确认；列表与 P04 打开状态一致。

### 4.3 P03 导入与解析结果（A1）

- A1 范围：`.musicxml` 文本导入；`.mxl` 明确“不支持”，不进入 MVP；PDF 只能作为阅读材料，不做音符级评分承诺。
- 流程：选择文件 → 读取 → 结构/语义/评分能力检查 → 结果 → 进入 P04 或重试。
- 验收：损坏文件不产生半初始化曲目；严格不可用时有具体原因；`.mxl` 显示明确不支持。

### 4.4 P04 曲谱详情/阅读（A1）

- 使用现有 OSMD/Bravura，不自绘谱面。
- 必须补：缩放、适合宽度、页码/小节导航、警告可查阅。
- “试听示范”入口：A1 只有在独立预览能力可用时才能启用；否则显示“暂不可用（需要 Track C）”，不能偷偷创建 Take。
- 验收：谱面清晰；缩放/导航可用；警告不打断阅读；不错误高亮。

### 4.5 P05 设备中心（A2）

- 真实 MIDI 设备列表、连接/断开、状态、最近事件。
- 按键测试：显示 Note On/Off、音名、速度；缺 Note Off 显示时值可能无法评分。
- 验收：设备断开/被占用/无权限显示真实原因；试听不需要设备；评分练习才要求设备。

### 4.6 P06 练习设置（A2）

- 设置项：模式、播放方式、BPM、手别、预备拍、节拍器、参考音量、小节范围、反馈显示、设备。
- 当前限制必须显式：
  - 预备拍当前固定 4 拍，若 A2 不实现配置则禁用/说明；
  - 无独立参考/节拍器音量则只提供现有开关；
  - 运行中变速不承诺，沿用 Session 契约。
- 播放方式与模式分离；试听不创建 Take。
- 验收：开始前一次性校验；不可用项有原因；不静默忽略设置。

### 4.7 P07 练习室（A2）

- 页面骨架：顶部状态、谱面主区、反馈侧栏、传输控制。
- 复用现有 Reference Playback、Session/Take、OSMD；不另写评分。
- A2 实时反馈只使用现有 onset/duration 能力；Pitch/Overall 未接通前不显示“综合分”。
- 离开有未完成 Take 时确认：继续/结束并分析/放弃。
- 验收：开始→预备→播放→暂停/继续→结束；参考音与评分同一 plan；无残音；降级可见。

### 4.8 P08 练习报告（B1 页面；A2 仅在 P07 内显示摘要）

P08 独立页面属于 Track B/B1。A2 不新建 P08 页面，只在 P07 练习室内显示“节奏/时长摘要”：

A2 只允许“节奏/时长报告摘要”：

- 可用：目标数、Perfect/Good/Miss/Extra、命中率、平均偏差/绝对偏差/标准差、按键时长评估、输入健康、时钟映射、诊断/处方、可信状态。
- 不可用：Pitch、Overall、Confidence、每小节、事件级 WrongPitch/Ambiguous、针对性复练。
- 不可用项显示 `unavailable` 或“暂不可用”，不得补 0、不得拼综合分。
- B1 在 B0 完成后增加完整字段；P09 仍必须等 B2。

### 4.9 P09 针对性复练（B2）

- 依赖 B1 的每小节诊断/证据。
- 从报告预填：曲目、范围、手别、BPM、示范开关、辅助显示、完成条件。
- 新 Take，不覆盖原报告；循环边界不计算跨轮 IOI。
- 验收：报告问题小节可一键进入；新 Take 配置快照正确；可与原范围对比。

### 4.10 P10 练习记录详情（C1）

- 列表按曲目/模式/状态筛选；详情展示冻结配置、fingerprint、算法版本、输入/时钟健康、take 状态。
- 中断/取消/降级/完成分开标签。
- 验收：历史详情不显示当前设置冒充历史；`Aborted/Incomplete` 不显示 `Completed`。

### 4.11 P11 学习进度（C1）

- 曲目级/模式级趋势；只显示系统能测的指标；样本不足显示空。
- 不混不同 BPM/难度/模式成单一排名。
- 验收：数据不足不画趋势；pitch/duration 指标在 B0 前不展示。

### 4.12 P12 设置与诊断导出（C2）

- 音频输出设备/音量、延迟校准、默认 BPM/预备拍、自动滚谱、音名提示。
- 数据管理、存储占用、诊断包预览选择、版本信息。
- 验收：诊断包默认不含 secrets/未选原始资源；清理前说明影响；版本来自实际接口。

---

## 5. 报告 MVP 边界（A2）

### 5.1 允许展示的真实字段

| 区域 | 数据来源 | A2 状态 |
|---|---|---|
| 结果状态（完成/降级/不可评分/中止） | Session/Take + `report.trustworthy` + captureDiagnostics | 部分（中止/不可评分 UI 需补） |
| 目标数、Perfect/Good/Miss/Extra、命中率 | `EngineReport.stats` | 可用 |
| 平均偏差/绝对偏差/标准差 | `EngineReport.stats` | 可用 |
| 按键时长逐项/汇总 | `durations` | 可用（strict-keydown 时） |
| 输入健康/时钟质量 | `captureDiagnostics.inputHealth` / `clockMapping` | 数据可用，UI 需补 |
| 诊断/建议 | `analysis` | 可用（规则诊断） |
| 音高准确率 / Overall / Confidence | 无 | **unavailable** |
| 每小节/事件级 pitch 状态 | 无 | **unavailable** |
| 针对性复练 | 无 | **disabled，等待 B2** |

### 5.2 禁止

- 不可用指标不显示 0、不补 100、不按音符数估算“准确率”。
- 试听/无输入不显示用户得分。
- `free` 不显示标准分。
- 设备/时钟问题不显示成用户漏弹/错音。
- 未完成 Take 不显示 Completed。

---

## 6. 核心匹配器验收计划

> 当前实时引擎是 onset-only；下面区分“当前可验收”和“B0 后才能验收”的语义。任何 B0 前的实现都不得声称已经支持 pitch 级匹配。

| 场景 | 当前语义 | 验收条件 | 批次 |
|---|---|---|---|
| 多弹音后继续对齐 | `HitMatcher` 中过早/窗口外事件为 Extra，不消费 target；target 仍 pending | 在正确目标前插入 1–3 个额外音：产生 Extra，后续目标仍按原时间/索引匹配；不出现级联 Miss；最终 replay 与实时一致 | B0 回归；当前可先测 onset |
| 漏弹音后继续对齐 | 目标窗口过期 -> Miss；后续 target 保持原时间 | 第 N 个目标不弹，第 N+1 个按原时间仍可 Perfect/Good；不把 N+1 平移；最终报告 Miss 计数准确 | B0 回归；当前可先测 onset |
| 错音与额外音区分 | 当前匹配器忽略 `StrikeEvent.notes`；正确时间的错音仍可命中 | B0 必须定义：目标时间内错音 -> WrongPitch（不消费正确 pitch 目标）；目标时间外 -> Extra；报告分别计数，不能混为 Miss/Extra | B0（当前不通过） |
| 重复同音 | onset target 可连续命中；Note On/Off 由 key lifecycle 配对 | 同一 pitch 连续 2–4 个目标：每个 Note On 只消费一个 target；Note Off 不误关后续 occurrence；duration 与对应 target 关联 | B0；当前可先测 onset/lifecycle |
| 和弦 | 当前同 onset 合并为一个 rhythm target，任一起音可命中 | B0 定义 partial/full chord：完整和弦、少一个音、多一个音、同音重复声部；pitch set/completeness 结果与 onset 结果分离；不能一个音算完整三音和弦 | B0（当前不通过） |
| 固定延迟 vs 局部抢拍拖拍 | `analyzeTiming` 有 global offset/jitter 诊断；实时 matcher 只看窗口 | 全体 +100ms 固定延迟 -> global late，不是 unstable；局部 ±抖动 -> jitter/local；两者可同时存在；报告不把固定延迟误判成时值错误 | B0/B1；当前规则诊断部分可用 |
| 缺失 Note Off | `duration` 报告有 open note/unknown，不强行判错 | 缺 Note Off：duration=unknown，不进入 too_short/too_long；报告显示不可判断；不把按键时长当 0 | A2/B0；当前 duration 有 coverage，UI 需明确 |
| 暂停恢复 + 旧 CaptureEpoch | pause 平移 remaining targets；Take capture epoch 隔离旧包 | 暂停/恢复后剩余 target 正确平移；旧 epoch 包被 quarantine，不进入新 Take；不产生跨回合事件；报告不把暂停时长算偏差 | A2/B0；已有部分测试 |
| 旧 CaptureEpoch 事件隔离 | `routePacket`/coordinator 有 epoch 判定 | 旧 capture epoch 的包被拒绝；计数进入 quarantine/epochMismatch；新 Take 目标/报告不受污染 | A2/B0 |

B0 需要新增/明确命名的**产品链路**测试（当前不存在，不能算 PASS；core/Pause 已有局部单测不等于产品链路通过）：

- `extra_note_does_not_consume_target`
- `missing_note_does_not_shift_following_target`
- `wrong_pitch_is_not_extra_and_extra_is_not_wrong_pitch`
- `repeated_pitch_occurrences_do_not_cross_consume`
- `chord_partial_full_and_extra`
- `global_latency_is_not_local_jitter`
- `missing_note_off_is_unknown_duration`
- `pause_resume_quarantines_old_capture_epoch`
- `realtime_and_final_alignment_disagree_visibly`

补充必须覆盖：

- count-in 内输入不进评分；
- 乱序/重复序号/队列溢出使报告不可信；
- 同音重叠时 duration 标记 ambiguous，不强行配对；
- trace replay 与实时结果在相同输入下确定一致；
- 暂停跨按键的 duration 标记 crossed_pause_boundary。

---

## 7. 专项审查项

### 7.1 TargetSchedule 一致性

- 参考播放、Rust atoms、谱面光标、报告必须来自同一 `PlaybackPlan` / `planId` / `scoreFingerprint` / tempo 配置。
- 参考播放启动时必须校验 target 数量、`atMs`、小节；不一致阻止播放并报 `target_plan_mismatch`。
- 页面不得在 React 里重新生成另一套 target 时间。
- 验收：同一轮中播放/评分/光标 planId 一致；改 BPM/范围必须重建计划并创建新 Take。

### 7.2 音频/MIDI 时钟映射

- AudioContext 时间、Node monotonic、浏览器 `performance.now()`、MIDI 设备时间戳是不同域；不得直接相减。
- Take 级必须有 clock mapping id/quality/uncertainty；播放时钟和输入时钟都映射到同一个 session 相对时间。
- 质量 `unstable/unknown` 且存在已映射输入 -> 报告不可评分/降级；`estimated` -> 精度受限。
- 输出延迟校准未实现前，P07/P08 必须显示 `uncalibrated`，不得宣称物理发声与评分采样级一致。
- 验收：时钟质量差时 UI 可见；报告 `trustworthy=false`；设备切换/后台挂起有可见状态。

### 7.3 实时匹配与最终对齐

- 实时结果是暂定；最终报告必须用完整 Trace 重新对齐。
- 额外音不得消费目标；漏音不得让后续目标整体错位；和弦不得简单一对一。
- 最终 `scoring_v1` 未接线前，实时/最终只能使用 onset 语义；页面必须标明“节奏命中，不等同音高正确”。
- B0 后：实时/最终共用 target contract；错音、额外音、漏音、ambiguous 在报告中分开。
- 验收：同一 Trace 的实时与最终结果可解释差异；最终报告优先；实时不得覆盖最终。

---

## 8. 开发顺序与交付物

```text
文档审核（本文件）
  → A0 AppShell/路由
  → A1 P01-P04
  → A2 P05-P07 + A2 节奏/时长报告摘要
  → B0 评分链路（可与 A1/A2 并行，但 B1 阻塞于 B0）
  → B1 P08 完整报告
  → B2 P09 针对性复练
  → C1 P10-P11
  → C2 P12/音频校准/诊断包
  → C3 独立试听/播放光标/MXL/repeat/tempo/采样钢琴
```

### 每批交付物

| 批次 | 交付物 | 阻塞依赖 | 完成标准 |
|---|---|---|---|
| A0 | AppShell、页面路由/导航、离开确认 | 现有组件 | 所有页面可达；刷新不丢；练习中离开有保护 |
| A1 | P01-P04 真实数据页面 | AppShell、curves/score APIs | 导入→库→阅读可用；无 mock；`.mxl` 明确拒绝 |
| A2 | P05-P07 + 节奏/时长摘要 | A0/A1、Reference Playback | 连接→设置→练习→本轮节奏/时长摘要；不可用指标明确 |
| B0 | scorePerformance NAPI、ScoreEvent/PerformedNote、target 契约、专项验收 | 目标契约设计 | Rust/NAPI/服务端测试通过；报告数据可追溯 |
| B1 | P08 完整报告 | B0 | pitch/overall/每小节/confidence 真实；unavailable 规则生效 |
| B2 | P09 复练 | B1 | 从报告生成新 Take；不覆盖旧报告 |
| C1 | P10/P11 | A2/B1 数据 | 历史详情/进度真实；样本不足空状态 |
| C2 | P12/音频校准/诊断包 | A2/C1 | 设置/导出可用；不含 secrets |
| C3 | 独立试听/光标/MXL/repeat/tempo/采样 | 按项评估 | 每项单独验收，不与 A/B 混做 |

---

## 9. 验收命令与失败处理

### 9.1 通用命令

```bash
cd D:\123\rhythm-trainer-frontend
npx tsc -b
npx vitest run
npm run build
npm run selftest

cd D:\123\rhythm-trainer-core-v0.2
PATH="/c/Users/10178/dev-tools/w64devkit/bin:$PATH" \
  cargo test -p rhythm-core --target x86_64-pc-windows-gnu
```

页面/浏览器证据：使用 in-app browser 实际打开 `http://127.0.0.1:5173/`，记录路由、空状态、错误状态、截图/文字证据；不能只凭 build 通过说页面完成。

### 9.2 失败处理规则

1. **TargetSchedule 不一致**：阻止开始/播放，显示具体目标/planId；不得用旧计划继续。
2. **数据字段缺失**：显示 `unavailable`/“暂不可用”；不得填 0、不得补综合分。
3. **时钟/输入不可信**：报告降级或不可评分；允许试听但不声称同步精确。
4. **Note Off 缺失**：duration unknown，不判短/长。
5. **导入受限/repeat/tempo/MXL**：明确阻断或只读；不得静默线性化后严格评分。
6. **依赖未实现**（P09、独立试听、光标、P08 完整字段）：入口禁用并说明原因；不做假页面。
7. **测试失败**：该批次不交付；修复后重跑全套命令；不得用“仅本地通过”替代。
8. **真实页面验证失败**：视为未完成；仅编译通过不算验收。

---

## 10. 审核时需要确认的决策

1. **A2 是否接受“P07 内节奏/时长摘要”**，还是一定等 B0 完整评分？建议 A2 摘要、B1 完整 P08 页面。
2. **独立试听放 C3 还是提前到 A1/A2**？建议 C3，除非产品明确要“无 Take 试听”作为首批核心。
3. **Continue 练习**：建议定义为“用上次曲谱/配置新开一轮”，真正恢复 Take 另立需求。
4. **P07 绿色光标**：A2 保留当前用户节奏目标；PlaybackSnapshot 光标放 C3。
5. **`.mxl`**：建议 C3，A1 只支持 `.musicxml`。
6. **音频输出延迟校准**：建议 C2；A2/B1 必须显示 `uncalibrated`，不宣称精确物理同步。
7. **P09 是否必须在第一批闭环**：建议 B2，而不是 A2。

以上决策确认后，再进入代码实现；本文件不授权重写 Session、Take、Rust Core、MusicXML importer、MIDI Adapter 或评分器。
