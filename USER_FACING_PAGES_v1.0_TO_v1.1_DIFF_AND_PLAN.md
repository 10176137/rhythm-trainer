# 用户视角页面需求 v1.0 → v1.1 差异与实施计划

- 日期：2026-10-22
- 状态：**仅文档修订，未修改任何业务代码；等待审核后再实施**
- 修订全文：`RHYTHM_TRAINER_USER_FACING_PAGES_v1.1_REVISED.md`
- 原文件：`RHYTHM_TRAINER_USER_FACING_PAGES_v1.0`（微信目录）
- 依据：`REFERENCE_PLAYBACK_IMPLEMENTATION_REPORT.md`、`PROJECT_STATUS_AND_ENGINE_GAPS_2026-10-22.md`、当前仓库代码审计

---

## 1. 修订原因

v1.0 的方向正确，但把“完整消费级产品”直接作为 P0，和当前仓库存在三类错位：

1. **页面结构错位**：当前是单页练习工作台（`App.tsx` 的 `view` 状态），没有首页/曲谱库/阅读/练习/报告的独立路由；v1.0 的 P01-P10 需要 AppShell 和页面拆分。
2. **引擎能力错位**：`scoring_v1` 的 pitch/overall/confidence/每小节诊断没有 NAPI 导出，也没有进最终报告；当前报告只有 onset 统计 + 独立按键时长。P08 完整报告和 P09 复练因此被阻塞。
3. **播放能力错位**：Reference Playback P0 核心已有，但独立试听（不建 Take）、PlaybackSnapshot 光标、只手静音、采样钢琴仍未完成；`.mxl` 也不支持。

因此 v1.1 不再把 P08/P09 和上述未完成能力放进“最小可用闭环”。

---

## 2. 主要文档差异

| v1.0 内容 | v1.1 修订 | 原因 |
|---|---|---|
| P01-P09 全部列为 P0 | 拆为 Track A（P01-P07）、Track B（P08-P09）、Track C（P10-P12 + 扩展） | 避免页面实现被未接通的引擎能力阻塞 |
| P08/P09 当 P0 完整能力 | A2 只在 P07 内做“节奏/时长摘要”，不新建 P08 页面；完整 P08 页面在 B1；P09 在 B2 | 当前没有 pitch/overall/每小节/事件级诊断 |
| P08 要求 Pitch/Overall/Confidence | 明确标为“仅 Rust 库、产品未接通”，A2 显示 unavailable | 不得把库存在当产品完成 |
| 独立试听作为 P04/P06/P07 的 P0 | 移至 C3；A1/A2 只在能力可用时启用，否则禁用并说明 | 当前参考播放依附 practice Take，没有独立预览链路 |
| 页面要求“播放光标” | 明确当前绿色仍是用户节奏目标；Snapshot 光标在 C3 | 现状与文档不同，不能假装 |
| P02 状态标签 | 增加“状态必须持久化到 library meta”；A1 补字段 | 当前 meta 无 ImportReport 状态 |
| `.musicxml` 与 `.mxl` 首期优先 | A1 只支持 `.musicxml`；`.mxl` 移到 C3 | 当前 importer 不支持 MXL |
| PDF 可阅读 | 保留“只读参照”；不做音符级评分承诺 | 避免把 PDF 当可评分谱 |
| “继续练习” | 明确当前无可恢复 Take；A1 只能“用上次曲谱/配置新开一轮” | 没有 Take 恢复接口 |
| P04 出版式谱面 | A1 要求 OSMD + 缩放/适合宽度/小节导航；像素级复刻不是首期 | 当前固定 1510px、`Zoom=1.0` |
| 页面验收以功能为主 | 增加每项能力的状态、代码依据、依赖、批次、验收条件矩阵 | 便于审计和排期 |
| 无专门匹配器验收 | 新增 8 类核心匹配器验收（多弹/漏弹/错音/重复音/和弦/延迟/缺 Note Off/暂停+epoch） | 评分核心必须先定义语义 |
| 无专项时钟/TargetSchedule 审查 | 新增 TargetSchedule 一致性、音频/MIDI 时钟、实时 vs 最终对齐三个专项审查项 | 防止播放/评分各用一套时间 |
| 无报告 MVP 边界 | 新增“允许展示/禁止展示”表；不可用不得补 0/100 | 符合“不伪造评分” |
| 无批次/失败规则 | 新增 A0-A2/B0-B2/C1-C3、交付物、阻塞、验收命令、失败处理 | 可逐批验收，避免一次性大改 |

### 保留不变

- 用户闭环目标、播放行为 vs 练习模式分离、无假数据、降级/不可评分、审计先行、OSMD、ScoreOverlay 与评分分离、报告可行动。
- 不重写 Session/Take/Rust Core/MusicXML importer/MIDI Adapter 的约束。

---

## 3. Track 与批次（摘要）

| Track | 批次 | 内容 | 当前是否可开工 |
|---|---|---|---|
| A 最小用户闭环 | A0 | AppShell/路由/离开确认 | 可以（页面骨架） |
| A | A1 | P01 首页、P02 曲谱库、P03 导入、P04 阅读 | 可以，但需补 library 状态字段 |
| A | A2 | P05 设备、P06 设置、P07 练习室 + 节奏/时长摘要 | 可以，复用现有 Reference Playback |
| B 完整评分/复练 | B0 | `scorePerformance` NAPI、ScoreEvent/PerformedNote、target 契约、三个专项 | 阻塞于目标契约设计 |
| B | B1 | P08 完整报告 | 阻塞于 B0 |
| B | B2 | P09 针对性复练 | 阻塞于 B1 |
| C 历史/进度/诊断/扩展 | C1 | P10/P11 | 可在 A2/B1 后 |
| C | C2 | P12、音频延迟校准、诊断包、playbackRunId 持久化 | 可在 A2 后 |
| C | C3 | 独立试听、Snapshot 光标、MXL、repeat/tempo、采样钢琴 | 按项评估，不与 A/B 混做 |

---

## 4. 当前状态摘要

### 页面

| 页面 | 状态 | 结论 |
|---|---|---|
| P01 首页 | 未实现 | 首屏是工作台，无 home |
| P02 曲谱库 | 部分实现 | CRUD/设置面板有；独立页/状态/筛选缺 |
| P03 导入 | 部分实现 | `.musicxml` 有；分阶段 UI/`.mxl` 缺 |
| P04 阅读 | 部分实现 | OSMD 有；缩放/适合宽度/导航缺 |
| P05 设备 | 部分实现 | Node MIDI 有；向导/Note Off 提示缺 |
| P06 设置 | 部分实现 | 弹窗有；播放方式/预备拍/音量缺 |
| P07 练习室 | 部分实现 | 工作台强；页面化/离开确认/独立试听/光标缺 |
| P08 报告 | 部分实现 | 节奏/时长有；pitch/overall/每小节/事件级缺 |
| P09 复练 | 未实现 | 无报告→新 Take 入口 |
| P10 历史详情 | 部分实现 | 列表/展开有；冻结配置/版本 UI 缺 |
| P11 学习进度 | 部分实现 | 模式级 MAE 趋势；曲目级/pitch/时值缺 |
| P12 设置/诊断 | 部分实现 | 设置/导出 Trace 有；音频校准/诊断包/版本缺 |

### 引擎

| 能力 | 状态 | 结论 |
|---|---|---|
| 练习内 Reference Playback | 已实现 P0 核心 | 共享 plan、逐 voice、暂停/停止、诊断已做 |
| 独立试听 | 未实现 | 控制器只从 onStarted 启动 |
| Snapshot 光标 | 部分实现 | Snapshot 有，绿色仍用户驱动 |
| Pitch/Overall/Confidence | 未实现（产品）；Rust 库存在 | `scoring_v1` 未导出/未接线 |
| 每小节/事件诊断 | 未实现 | `MeasureReport`/`practice_ranges` 未接线 |
| TargetSchedule 一致性 | 已实现（播放）/部分（报告） | 启动校验有；报告/页面未统一 |
| 音频/MIDI 时钟 | 部分实现 | Node 映射 + clockMapping 门禁；无统一 Take mapping/输出延迟 |
| 实时 vs 最终对齐 | 部分实现 | 实时 onset-only；最终 scoring_v1 未接通 |
| Repeat/tempo | 未实现 | importer 阻断/固定 BPM |
| MXL | 未实现 | 当前只收 `.musicxml` |
| 采样钢琴 | 未实现 | 当前合成钢琴 |
| 音频输出延迟校准 | 未实现 | Core README 明确未做 |
| playbackRunId 持久化 | 未实现 | 会话记录无此字段 |

---

## 5. 报告 MVP 边界（A2）

**允许展示（真实数据）：**

- 结果状态、目标数、Perfect/Good/Miss/Extra、命中率；
- 平均偏差/绝对偏差/标准差；
- 按键时长逐项/汇总（strict-keydown）；
- 输入健康、时钟映射质量（captureDiagnostics）；
- 规则诊断/练习建议；
- 可信/降级/不可评分状态。

**必须 unavailable：**

- Pitch accuracy；
- Overall/Confidence；
- 每小节诊断；
- 事件级 WrongPitch/Ambiguous；
- 针对性复练入口。

规则：

- 不可用不补 0、不补 100、不拼综合分。
- 试听/无输入不显示用户得分。
- `free` 不显示标准分。
- 设备/时钟问题不显示成用户弹错。
- 未完成 Take 不显示 Completed。

---

## 6. 核心匹配器验收计划（摘要）

| 场景 | 验收要点 | 批次 |
|---|---|---|
| 多弹音后继续 | 额外音不消费 target；后续仍按原索引/时间匹配；不级联 | B0（onset 部分当前可测） |
| 漏弹音后继续 | 当前 Miss；后续 target 不平移；计数准确 | B0 |
| 错音 vs 额外音 | 目标窗口内错音 -> WrongPitch；窗口外 -> Extra；不能混 | B0（当前不通过，因 matcher 忽略 notes） |
| 重复同音 | 每个 On 只消费一个 target；Off 不误关后续 occurrence | B0 |
| 和弦 | 完整/缺音/多音/同音声部；partial/full 与 onset 分离 | B0（当前不适配） |
| 固定延迟 vs 局部抖动 | +100ms 全体 -> global offset；局部 -> jitter；不混淆 | B0/B1 |
| 缺 Note Off | duration unknown，不判短/长 | A2/B0 |
| 暂停恢复 + 旧 epoch | 目标平移正确；旧包 quarantine；不跨 Take | A2/B0 |

完整版本、补充用例和失败规则见修订全文第 6 节。

---

## 7. 专项审查项（摘要）

1. **TargetSchedule 一致性**：播放/atoms/光标/报告同一 planId/fingerprint/tempo；不一致阻止；改 BPM/范围必须新 Take。
2. **音频/MIDI 时钟映射**：不同时钟域不得直接相减；Take 级 mapping id/quality；unstable/unknown -> 不可评分；未校准输出延迟必须标 `uncalibrated`。
3. **实时匹配 vs 最终对齐**：实时暂定、最终权威；额外音不消费目标；漏音不整体错位；和弦不能一对一；`scoring_v1` 未接线前只允许 onset 语义并明确标注。

---

## 8. 开发顺序与验收

```text
审核本文件
 → A0 AppShell/路由
 → A1 P01-P04
 → A2 P05-P07 + 节奏/时长摘要
 → B0 评分链路
 → B1 P08 完整报告
 → B2 P09 复练
 → C1 P10-P11
 → C2 P12/音频校准/诊断包
 → C3 独立试听/光标/MXL/repeat/tempo/采样
```

### 验收命令

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

页面：in-app browser 实际打开 `http://127.0.0.1:5173/`，验证路由、空状态、错误/降级状态和截图；只 build 通过不算页面完成。

### 失败处理

- TargetSchedule 不一致 → 阻止，不沿用旧计划；
- 字段缺失 → `unavailable`，不补 0；
- 时钟/输入不可信 → 降级/不可评分；
- Note Off 缺失 → duration unknown；
- 导入受限/repeat/tempo/MXL → 明确阻断或只读；
- 依赖未实现 → 禁用入口并说明，不做假页面；
- 测试失败 → 该批次不交付，修复后重跑全套命令。

---

## 9. 审核时需要确认的 7 个决策

1. A2 是否接受“P07 内节奏/时长摘要”，还是等 B0 完整评分？**建议 A2 摘要、B1 完整 P08 页面。**
2. 独立试听放 C3 还是提前 A1/A2？**建议 C3。**
3. Continue 是否定义为“用上次曲谱/配置新开一轮”？**建议是；真正恢复 Take 另立需求。**
4. P07 绿色光标是否保留当前用户节奏目标？**建议 A2 保留，Snapshot 光标放 C3。**
5. `.mxl` 是否只放 C3？**建议是；A1 只支持 `.musicxml`。**
6. 音频输出延迟校准放 C2 还是更早？**建议 C2；A2/B1 标 `uncalibrated`。**
7. P09 是否必须在第一批闭环？**建议 B2，而不是 A2。**

---

## 10. 本次变更范围声明

- 新增：`RHYTHM_TRAINER_USER_FACING_PAGES_v1.1_REVISED.md`（修订全文）。
- 新增：本差异/实施计划文件。
- 未修改：`src/`、`server/`、`crates/`、`bindings/`、测试、构建配置。
- 未运行：业务构建/测试（本轮是文档修订；此前参考播放验证结果仅作为审计依据）。
- 下一步：等待上述 7 个决策审核；确认后按 A0 → A1 → A2 开始，B0 可并行设计但 B1 必须等 B0。
