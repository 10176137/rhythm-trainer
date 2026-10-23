# B2 教学处方与针对性复练 — 实施报告

- 日期：2026-10-22
- 范围：B2 only；已完成 P09、规则处方、新 Session/Take 创建、来源关联、历史读取和复练比较。
- 停止点：**B2 完成后停止，未进入 C2/C3。**
- 结论：处方是建立在 B1 Rust 报告真实数据上的可解释规则选择，不是第二套评分，也不是 AI 教学。没有可靠证据时只显示原因；复练只创建新任务，不修改原报告。

---

## 1. 实施结果

已完成：

1. **B2 审计**：`B2_TEACHING_AUDIT.md` 记录了 `Diagnostic` 的全局性质、`MeasureReport` 可用字段、`practice_ranges` 的真实生成条件、`EXTRA` 无小节映射、duration 无 bar，以及旧报告缺失字段。
2. **处方模型**：可序列化的 `TeachingPrescription` / `PrescriptionEvidence` / `PrescriptionAnalysis`。
3. **规则引擎**：局部起音、漏音、错音、有效按键时值、额外音（仅可靠 measure 时）和手动范围。
4. **P09**：报告内 P09 面板，展示证据、规则、范围、推荐 BPM/手别/模式，允许修改 BPM/手别，确认后创建任务；提供“取消并返回报告”收起入口，手动范围单独标识为用户选择。
5. **真实任务**：复用 `launchPractice` → Session/Take → 新 Take 的现有链路；新记录保存来源报告/Take、处方和曲谱指纹。
6. **比较**：服务端在复练完成时生成 `retryComparison`，只比较真实且定义一致的指标；不可比较时只给原因。
7. **历史**：历史行显示“复练”，详情重新读取 `scoreV1` 和 `retryComparison`，不修改原 Take/原报告。
8. **测试**：规则/门禁/SSR P09、Node 端到端复练、重复提交、来源不可变、历史重读和不可比较报告均有自动化或浏览器证据。

---

## 2. 修改文件

### 新增

| 文件 | 作用 |
|---|---|
| `src/types/teaching.ts` | 处方、证据、手动任务、复练比较 DTO。 |
| `src/features/practice/teachingPrescription.ts` | 纯规则处方选择器；不计算评分。 |
| `src/features/practice/teachingPrescription.test.ts` | 9 项规则/门禁测试。 |
| `src/components/TargetedPracticePanel.tsx` | P09 报告内交互。 |
| `src/components/TargetedPracticePanel.test.tsx` | 4 项 SSR 展示/门禁测试。 |
| `B2_TEACHING_AUDIT.md` | B2 数据与调用链审计。 |
| `B2_IMPLEMENTATION_REPORT.md` | 本报告。 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/types/engine.ts` | start/report 增加 `hand`、`scoreBarCount`、来源报告字段、处方、`retryComparison`；duration assessment 增加 `bar/beat`。 |
| `src/App.tsx` | `launchPractice` 支持受控 override 与来源元数据；新增 `startTargetedPractice`；P09 回调；目标任务强制 loop + fixed timeline；正常 start 发送 hand/barCount。 |
| `src/features/practice/usePracticeSession.ts` | 透传/保存 takeId、scoreFingerprint、hand、scoreBarCount、来源引用、处方和比较。 |
| `src/services/engineBridge.ts` | start 请求新增 B2 字段。 |
| `src/components/ReportPanel.tsx` | 接入 P09 和 comparison；透传报告身份/配置。 |
| `src/components/FullScoreReport.tsx` | 显示复练前后比较；只在可比时显示数值。 |
| `src/components/HistoryView.tsx` | 历史详情透传 B2 字段；复练标记；当前曲谱指纹。 |
| `src/services/practiceRepository.ts` | `SessionSummary`/`SessionDetail` 新增 B2 字段。 |
| `server/engine-server.mjs` | duration bar 映射；来源验证；目标处方字段持久化；新 PracticeSession key；比较生成；历史 summary 标记字段。 |
| `server/selftest.mjs` | B2 复练、来源不可变、重复提交、失败无半成品、不可比较报告场景。 |
| `src/styles.css` | P09 面板/证据/配置/比较表样式。 |
| `README.md` / `CHANGELOG.md` | B2 能力、测试数量与限制。 |

**未修改 Rust Core、NAPI 算法、Session/Take/TargetSchedule/Reference Playback 语义。**

---

## 3. 处方数据契约

`TeachingPrescription`：

```ts
{
  prescriptionId, sourceReportId, sourceTakeId,
  ruleId, problemType,
  evidence: PrescriptionEvidence[],
  confidenceStatus: 'high'|'medium'|'low'|'not-assessable',
  measureRange: { startMeasure, endMeasure },
  recommendedBpm, recommendedHand,
  recommendedMode: 'loop',
  reason, action,
  status: 'EXECUTABLE'|'MANUAL'|'BLOCKED',
  createdAtIso,
  sourceScoreFingerprint
}
```

`PrescriptionEvidence` 只保存真实来源和数值：

```ts
{
  source: 'score-measure'|'score-event'|'duration-assessment'|
          'score-diagnostic'|'practice-range'|'user-selection',
  metric, value, measure?, eventId?, detail?
}
```

`PrescriptionAnalysis`：

- `prescriptions`（可执行）
- `blocks`（不可自动执行，带规则和原因）
- `canCreateManual`
- `manualBlockReason`

手工处方显式设置：

- `ruleId: MANUAL_RANGE_V1`
- `problemType: manual-range`
- `status: MANUAL`
- `confidenceStatus: not-assessable`
- evidence `source: user-selection`
- reason 明确“用户手动选择，不是系统诊断”。

---

## 4. 首批规则与真实证据

### 4.1 局部起音 `LOCAL_ONSET_V1`

数据来源：

- `scoreV1.measures` 的 `matched`、`missed`、`meanAbsOnsetErrorMs`；
- 可选的 `practice_ranges` 作为辅助证据。

条件：

- 报告 `AVAILABLE`、confidence 不是低/不可评估、`dataDegraded=false`；
- `matched >= 2`；
- 该小节没有漏音（漏音交给 missing 规则）；
- `meanAbsOnsetErrorMs > 60ms`；
- 如果报告有多个可比较小节，该小节误差至少比全曲小节中位数高 20ms；单个可比较小节允许自身误差，不把全曲平均强加为局部原因。

证据包含小节 MAE、匹配数、全曲中位数、核心 practice range（如存在）。

> 这是“局部起音偏差”，不是逐小节 jitter。当前 core 的 `local-jitter` 等诊断没有 `measure_range`，B2 不会把它们包装成小节 jitter 结论。

### 4.2 漏音 `MISSING_NOTES_V1`

- 只从 `eventResults` 的 `MISSING` 且 `measure` 有效的事件分组；
- 证据包含 MISSING 数量、scoreEventId、小节；
- 不使用 `performedNotes.length !== targetCount` 推断。

### 4.3 错音 `PITCH_ERRORS_V1`

- 只从 `eventResults` 的 `WRONG_PITCH` 且 measure 有效的事件分组；
- 证据包含期望/实际 pitch；
- `AMBIGUOUS` 单独进入不可执行 block，不转成确定错音。

### 4.4 按键时值 `DURATION_V1`

- 使用 `durations.assessments`；
- 服务端已把 `targetIndex` 映射到 target 的 `bar/beat`；
- 只接受 `quality === 'ok'` 且 `within_tolerance/too_short/too_long` 的有效配对；
- 同一小节至少 2 个有效 graded，且有实际偏短/偏长；
- `unknown`、缺 Note Off、open/interrupted/crossed-pause 不参与确定性时值结论；
- 证据包含实际/目标时值、durationErrorMs、小节、目标 ID。

### 4.5 额外音 `EXTRA_NOTES_V1`

- 仅当 `EXTRA` 事件本身带可靠 measure 时生成；
- 当前 NAPI 的额外音没有 measure，因此实际会显示 `EXTRA_NO_MEASURE_V1` 不可执行原因，不猜小节。

### 4.6 全局诊断

`global-offset`、`local-jitter`、`rhythm-compensation`、`tempo-drift` 没有小节范围；若没有其他可靠局部候选，显示“全局指标，缺少小节定位”，不生成任务。

### 4.7 无证据

若无处方且无 block，P09 显示：

> 本次没有足够证据生成针对性复练建议。

不生成默认处方。

---

## 5. 报告可执行性门禁

| 状态/条件 | 自动处方 | 手动选择 |
|---|---|---|
| `AVAILABLE` + 足够 confidence + 明确证据 | 允许 | 允许 |
| `AVAILABLE` 但没有局部证据 | 无 | 允许（明确用户选择） |
| `DEGRADED` | 禁止 | 允许，带不可比/数据质量提示 |
| `INSUFFICIENT_DATA` | 禁止 | 允许（用户选择，不是诊断） |
| `UNAVAILABLE` / `INVALID` | 禁止 | 禁止 |
| `AMBIGUOUS` 事件 | 不转成确定错音 | 不作为自动证据 |
| 缺 Note Off / unknown 时值 | 不生成时值结论 | 不自动使用 |
| 额外音无 measure | 不生成额外音范围 | 不自动使用 |
| 旧报告缺 scoreV1/指纹/小节 | 禁止 | 禁止或明确不可用 |

P09 在曲谱指纹不一致时禁用所有创建按钮，并显示原因。

---

## 6. 新复练任务流程

```text
P08 报告
  └─ P09 选择系统处方 / 手动范围
       ├─ 编辑 BPM、手别
       ├─ 确认
       └─ App.startTargetedPractice
            ├─ 校验当前 active score fingerprint == source fingerprint
            ├─ 校验小节范围在当前曲谱内
            ├─ 构造 loop + fixed timeline 配置
            ├─ 设置 loopStartBar/loopEndBar、BPM、hand
            ├─ 必要时 navigate('/workbench')
            └─ launchPractice(override, source meta)
                 ├─ buildPlaybackPlan(range) → atoms/reference/scoreEvents
                 └─ session.begin(...) → 新 PracticeSession/Take

engine server start
  ├─ 校验 sourceReportId 存在
  ├─ 校验 sourceTakeId == source record.takeId
  ├─ 校验 source score fingerprint == current scoreFingerprint
  ├─ 校验 prescription 来源引用/范围/BPM/手别/mode
  ├─ 新 PracticeSession key（含 source/prescription）
  ├─ 保存 meta source fields
  └─ 失败时不创建 Take/不写半成品
```

保存字段：

- 新 record：`sourceReportId`、`sourceTakeId`、`prescriptionId`、`prescription`、`hand`、`scoreBarCount`、`scoreFingerprint`；
- 新 report message 同步返回；
- 历史详情可重新读取。

原报告只读：B2 不向来源文件写入任何东西；selftest 对来源详情做前后 JSON 比较。

`takeId` 是 PracticeSession 内编号；来源身份以 `sourceReportId + sourceTakeId` 组合关联。复练会创建新的 PracticeSession/Take；B2 selftest 检查 `practiceSessionId` 变化。

重复确认：

- P09 `creating` 禁用按钮；
- 服务端活动 Take 存在时拒绝第二次 `start`；
- 初始化失败不写入 record；
- 不创建“看起来可用”的空任务。

---

## 7. 复练前后比较

服务端在复练完成时生成并持久化 `retryComparison`。

可比较条件：

- 来源和复练都有有效 `scoreV1`；
- 两者 `scoreStatus === 'AVAILABLE'`；
- 曲谱指纹非空且一致；
- `scoreAlgorithmVersion` 和 `scoringConfigVersion` 一致；
- 至少有一个共同数值指标。

指标只包括定义一致的：

- pitch recall/precision；
- 平均绝对起音误差；
- rhythm jitter MAD；
- duration too-short/too-long ratio（graded > 0）；
- continuity covered ratio。

限制：

- BPM 不同：显示限制，不把差异全部归因于练习效果；
- 手别不同；
- 练习模式不同；
- 复练按处方/手动范围，原报告范围可能不同；
- 任一份 `DEGRADED`/`INSUFFICIENT_DATA`/`UNAVAILABLE`/`INVALID`：`comparable=false`，不给数值和进步百分比。

UI 只显示“原值 / 复练后 / 变化（上升、下降、持平）”，不把不同 BPM 的变化写成确定进步。

---

## 8. 实际验证

### 8.1 自动测试

```text
cd D:\123\rhythm-trainer-frontend
npm test
# 28 files, 168 tests passed

npm run selftest
# 138 assertions, 全部自测通过

npm run build
# tsc -b + vite build passed
# 仅 OSMD 1.44 MB / main 502 KB chunk 警告
```

Rust Core 未修改，仍为 110 项通过（82 unit + 1 e2e + 5 property + 1 benchmark + 21 scoring acceptance）。

B2 selftest 重点断言：

- 复练创建新的 PracticeSession/Take；
- report/record 保存来源、处方、hand/barCount/fingerprint；
- 来源报告前后 JSON 不变；
- 重复确认被拒绝；
- 来源 Take 不匹配时拒绝，且不新增 session；
- 可比较的复练生成 metrics 和 BPM/模式/范围限制；
- 零输入复练 `INSUFFICIENT_DATA`，comparison `comparable=false`、metrics 为空；
- B1/UNAVAILABLE/INSUFFICIENT/DEGRADED 回归仍通过。

### 8.2 浏览器（synthetic raw MIDI，不是实体键盘）

- 用当前 active score fingerprint 创建 synthetic B1 来源报告，P09 显示真实局部起音证据 `MAE 100ms`、规则 `LOCAL_ONSET_V1`、推荐 190 BPM。
- 点击确认后自动导航到 workbench，模式变为“乐句循环”，BPM 190，范围第 1 小节；feedback 显示“已创建针对性复练”。
- 复练报告持久化来源报告/Take、处方 ID、hand/barCount/scoreFingerprint。
- 复练无输入时状态 `INSUFFICIENT_DATA`，P8 comparison 显示不可比较原因，无虚假进步。
- 另一个 synthetic 复练（8 音匹配）生成可比表：原 100ms → 8ms，并显示 BPM/模式/范围限制；历史行显示“复练”标记。
- 临时测试 session/trace/journal 已清理。

---

## 9. 已知限制

1. **实体 MIDI 只完成输入链路验证**：后续已连接 `MEDELI SP-A500`，Node Adapter 收到 76 个真实 Note On/Off 事件（`healthy`、`queueDropped=0`），设备页可显示按键；但 B2 的 P09/复练端到端验证仍使用 synthetic raw MIDI，尚未完成实体键盘 Take/评分验收。
2. **局部节奏证据有限**：Rust `MeasureReport` 没有逐小节 jitter，因此 B2 只做“局部起音偏差”，不声称逐小节节奏不稳；全局 jitter/补偿只显示不可执行原因。
3. **时值范围需要至少 2 个有效配对**：缺 Note Off、unknown、跨暂停不用于确定性时值处方；这是故意的保守边界。
4. **额外音不能自动定位**：当前 EXTRA 无 measure，B2 只显示不可执行原因。
5. **旧报告限制**：旧 session 可能没有 scoreV1、scoreFingerprint、hand/barCount、duration bar；P09 会禁用自动/部分手动创建，不回填历史。
6. **比较限制**：只有两份 AVAILABLE 且指纹/版本一致才比较；BPM/手别/模式/范围不同会显示限制，但不把变化等同于进步。
7. **loop 仍是一次练习所选范围**：P09 文案和 action 都明确说明；没有自动重复循环。
8. **没有跨 Take 恢复/运行中变速**：按约束未实现。
9. **手动范围是用户选择**：`MANUAL_RANGE_V1` 明确标记，不是系统诊断；手动任务同样需要来源报告/Take 和曲谱指纹。
10. **未修改对齐算法**：B1 的贪心 + 和弦分组边界继续保留；B2 不把 `AMBIGUOUS` 包装成确定错音。
11. **未实现 AI 教学/长期课程/自适应编排**：首版仅规则。

---

## 10. 停止确认

B2 已完成并在此停止：

- 未进入 C2 音频延迟校准；
- 未进入 C3 独立试听/Snapshot 光标/MXL；
- 未实现 AI 自动授课、长期课程、跨 Take 恢复、动态变速或自动重复循环；
- 原历史报告和原 Take 未被修改。
