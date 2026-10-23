# B2 教学处方与针对性复练 — 数据与调用链审计

- 日期：2026-10-22
- 范围：B2 实施前审计；基于当前 B1 代码，不以需求文档假设代替仓库事实。
- 结论：现有 Rust `scoring_v1` 报告可以支持“全局指标 + 小节级漏音/起音误差 + 事件级音高/错音 + 有效按键时值”的规则处方；但它**不能**支持自动的“逐小节节奏抖动”处方，也不能从全局诊断直接推断具体小节。B2 必须显式提供不可执行状态。
- 实施结果：本审计的决策已落地，详见 `B2_IMPLEMENTATION_REPORT.md`；局部起音规则只使用 measure MAE/漏音/错音/有效 duration 证据，全局 jitter/offset 与无 measure 的 EXTRA 进入不可执行状态。

---

## 1. 审计对象

- `crates/rhythm-core/src/scoring_v1.rs`
- `bindings/node/src/lib.rs` / `index.d.ts`
- `src/types/engine.ts`
- `src/components/FullScoreReport.tsx`
- `src/components/ReportPanel.tsx`
- `src/services/practiceRepository.ts`
- `server/engine-server.mjs`
- `src/App.tsx` / `src/features/practice/usePracticeSession.ts`
- `src/config/modeRegistry.ts` / `src/types/practice.ts`

---

## 2. 报告数据结构

### 2.1 `SessionScoreReport`

当前真实字段：

- `algorithmVersion`, `configVersion`
- `alignmentPairs`, `missedScoreEventIds`, `extraPerformedIds`, `restWindowExtraIds`
- `eventResults`
- `pitch`
- `onset`
- `rhythm`
- `duration`
- `continuity`
- `measures`
- `overall`
- `confidence`
- `dataDegraded`
- `diagnostics`
- `practiceRanges`

### 2.2 `Diagnostic`

```
category: string
severity: 'info'|'moderate'|'high'
measure_range: Option<(u32,u32)>
evidence: string
confidence: high|medium|low|not-assessable
suggested_action: string
score_event_ids: string[]
performed_event_ids: string[]
```

**关键事实：当前所有诊断的 `measure_range` 都是 `None`。** 全局偏移、局部抖动、节奏补偿、渐慢/渐快、漏音、额外音、错音、时值、休止违规都没有核心生成的小节范围。因此不能把某条诊断直接变成一个“小节处方”。

### 2.3 `MeasureReport`

```
measure
matched
missed
mean_abs_onset_error_ms: Option<f64>
mean_speed_ratio: Option<f64>
```

- 有逐小节漏音数量和平均绝对起音误差。
- **没有**逐小节 jitter、局部速度比方差或“稳定/不稳定”标签。
- `mean_speed_ratio` 是该小节匹配目标的速度比；它不是置信度，也不能单独证明节奏不稳。

### 2.4 `practice_ranges`

核心生成条件（`scoring_v1.rs`）：

1. 仅考虑 `missed > 0` 或 `mean_abs_onset_error_ms > onset_tolerance_ms`（默认 60 ms）的 MeasureReport；
2. 按 `missed * 2 + mean_abs_onset_error / 100` 排序；
3. 最多 3 个，每个范围是单小节（`start == end`）；
4. `reason` 是拼接字符串，不是结构化证据。

因此 `practice_ranges` 可以作为**候选范围**，但必须回到 `measures`/`eventResults` 验证具体证据；不能把 `reason` 当完整诊断。

### 2.5 事件结果

`EngineScoreEventResult`：

```
result: MATCH | WRONG_PITCH | MISSING | EXTRA | AMBIGUOUS
scoreEventId, performedNoteId, measure
expectedPitch, actualPitch, onsetErrorMs
pairingStatus, reason
```

- `MATCH` / `WRONG_PITCH` / `MISSING` 有目标小节 `measure`（来自 ScoreEvent）。
- `AMBIGUOUS` 是配对歧义；不能改成确定的错音/漏音。
- **当前 `EXTRA` 没有 measure**（NAPI 只填 performedNoteId、actualPitch、reason）。额外音无法可靠落到小节。
- `MISSING` 的 measure 可用于漏音处方；但必须排除 `AMBIGUOUS`，且不能仅比较目标数与实际数。

### 2.6 DurationReport

`EngineDurationAssessment` 当前字段：

```
targetIndex, targetId, onsetSeq, pitch
nominalDurationMs, actualKeyDownMs, durationErrorMs
allowedErrorMs, interOnsetIntervalMs
result: within_tolerance|too_short|too_long|unknown|disabled
quality: ok|overlapping_same_pitch|open_note_interrupted|crossed_pause_boundary
```

- 有实际/目标时值和误差，但**没有 bar/beat**。
- 可以按 `targetIndex` 映射回服务端 `meta.targets[targetIndex].bar`，B2 会补这个关联字段。
- `unknown`（缺 Note Off/中断/跨暂停）不能当“过短”；`quality != ok` 不用于确定性时值处方。

### 2.7 状态

B1 已有：`AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID`。

B2 门禁必须遵守；`AVAILABLE` 也不代表所有子指标都有足够样本，仍需检查具体 measure/event/duration 证据。

---

## 3. 评分与报告生成调用链

```
PlaybackPlan.occurrences
  ├─ atoms → NativeSession targets
  ├─ reference playback
  └─ EngineScoreEvent[] (scoreEvents)
        ↓
start / Take / raw MIDI / key lifecycles
        ↓
finish:
  native.finish()（节奏判定）
  trackKeyLifecycles + assessKeyPresses（时值）
  scorePerformance（scoring_v1）
  scoreStatus 解析
  session record JSON
        ↓
report message
  ↓
usePracticeSession.onReport
  ↓
FullScoreReport / HistoryView → ReportPanel
```

B2 的处方只能在 `scorePerformance` 结果和已有 `durations` 上做规则选择；**不得**在 TypeScript 重新计算 alignment、pitch、onset 或 overall。

---

## 4. 复练创建链路现状

### 4.1 练习配置

`PracticeConfig`：

- `modeId`: rhythm/score/hands/loop/free
- `tempo`, `timeSignature`, `hand`, `feedback`
- `loopStartBar`, `loopEndBar`
- `profile`, `durationPolicy`, `advanceMode`

`launchPractice`（`App.tsx`）当前：

- 只使用当前 `config` 状态；
- 对 `score`/`hands`/`loop` 从 `buildPlaybackPlan` 选择 range；
- `loop` 使用 `loopStartBar/loopEndBar`；
- 生成 atoms、ReferencePlaybackPlan、scoreEvents；
- `session.begin` 创建 Session/Take；
- 没有来源报告/处方字段；
- `follow` 分支不创建 Rust Take 评分，只运行 FollowSession；
- `loop` 只练所选范围**一次**，没有自动重复。

B2 必须复用这条链路，不能在 P09 里再建第二套 Session/Take。

### 4.2 当前报告缺失的来源信息

`start`/record 当前有：

- `scoreFingerprint`（可判曲谱一致）
- `playbackPlanId`
- `scoreImportStatus`
- `takeId`
- `scoringConfig` / versions

当前没有：

- 原曲谱的 `hand` 与小节总数（新报告可补）
- `sourceReportId` / `sourceTakeId` / `prescriptionId`
- 复练比较结果
- duration 的 bar/beat

B2 需要新增这些字段，但不得修改旧记录；旧记录缺失时显示不可自动处方。

### 4.3 历史

- 会话 ID：`s-...`，保存到 `sessions/<id>.json`；详情 API 返回原 record。
- `takeId` 存在，但当前 `SessionDetail` 前端类型未全部暴露。
- 旧记录可能没有 `scoreV1`、`measures`、`practiceRanges`、`scoreStatus` 或 `duration.bar`；B2 必须按不可用处理。

---

## 5. 可支持的规则与证据

| 规则 | 可用证据 | 可执行条件 | 不可执行示例 |
|---|---|---|---|
| 局部起音/漏音复练 | `MeasureReport` + `MISSING` event results + practice_ranges | `AVAILABLE`，置信度足够，measure 有 matched/明确漏音；局部误差与全曲基线有差异或明确漏音 | 只有全局 `local-jitter`/`global-offset`，没有小节范围 |
| 按键时值 | `durations` + target bar 映射 | `AVAILABLE`，`quality=ok`，至少 2 个有效 graded，明确 too_short/too_long；不含 unknown | 缺 Note Off/中断/跨暂停，或旧报告无 bar |
| 音高错音 | `WRONG_PITCH` event results（expected/actual/measure） | `AVAILABLE`，有 measure 和明确错音；AMBIGUOUS 除外 | 只有 AMBIGUOUS 或没有事件级 measure |
| 漏音 | `MISSING` event results | `AVAILABLE`，事件带 scoreEventId/measure | 仅目标数与实际数不同 |
| 额外音 | `EXTRA` event results | 仅当事件有可靠 measure；当前通常没有 | 当前 `EXTRA.measure=null`，所以默认不可自动生成 |
| 全局节奏抖动 | `rhythm.jitterRatioMad` / `diagnostics` | 不可生成范围任务 | 显示“全局证据，缺少小节定位” |
| 无证据 | `scoreStatus`/诊断/measure | 只显示“没有足够证据” | 不生成默认/占位处方 |

---

## 6. B2 决策

1. 处方生成是**规则选择**，不是评分；放在 TypeScript 的纯函数中，只消费 Rust 报告/时值报告，不重新算分。
2. 自动处方只允许 `AVAILABLE` + 足够证据 + 明确小节范围。
3. `DEGRADED`：不自动开处方；可允许“用户手动选择范围”的复练，必须标为用户选择，不是系统诊断。
4. `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID`：不生成自动处方；不显示可执行按钮。
5. `AMBIGUOUS` 不转成确定错音/漏音。
6. `EXTRA` 没有 measure 时只显示不可执行原因，不猜小节。
7. 局部节奏不得从全曲平均误差推断；需要逐小节 measure 证据或事件级漏音。
8. 每个自动/手动复练都创建新的 Session/Take，原报告只读，新记录保存来源引用。
9. 旧报告/无 scoreV1 报告只能显示原因；不补历史字段、不伪造来源。
10. 复练比较只在两份报告均 `AVAILABLE`、曲谱指纹一致、评分定义/版本一致时给出数值；BPM/手别/范围差异作为限制显示，不把质量恶化当成退步。

---

## 7. 需要新增的字段（B2 实施）

- start/record/report：`hand`、`scoreBarCount`
- start/record/report：`sourceReportId`、`sourceTakeId`、`prescriptionId`、`prescription`
- record/report：`retryComparison`
- duration assessment：`bar`、`beat`（服务端从 targetIndex 映射）
- `SessionDetail`：`takeId`、`scoreFingerprint`、`hand`、`scoreBarCount`、`sourceReportId`、`sourceTakeId`、`prescriptionId`、`prescription`、`retryComparison`
- `SessionSummary`：`sourceReportId` / `prescriptionId`（用于历史标记“复练”）

旧记录缺失这些字段时，B2 显示不可用；不回填、不修改原 JSON。

---

## 8. 明确不依赖的数据

- 旧 `analysis` 规则诊断（`EngineTimingAnalysis`）没有小节范围且与 B1 `scoring_v1` 诊断定义不同；B2 不用它生成确定性处方。
- `overall.score` 单独低不构成具体小节原因。
- `performedNotes.length != targetCount` 不是漏音证据。
- `extraPerformedIds` 没有 measure 时不是额外音小节证据。
- `duration` 的 unknown/非 complete 配对不是“过短”证据。
- `practiceRanges.reason` 的文本不是结构化指标；必须回查 measure/event。

---

## 9. 验收边界

- 不修改 Rust 对齐算法，不引入全局 DP（当前 B1 贪心和弦分组保留）。
- 不新增评分或 Session 体系。
- 不实现自动重复 loop；复练任务仍是“一次练习所选范围”。
- 不实现 AI 教学、长期课程、动态变速、跨 Take 恢复。
- 自动化/浏览器端到端验证仍使用 synthetic raw MIDI。2026-10-22 后续已连接实体 `MEDELI SP-A500` 并验证 Node Adapter 收到 76 个真实 Note On/Off 事件（healthy、无队列丢弃）；但尚未完成实体键盘 Take/评分，不能声称真机验收完成。
