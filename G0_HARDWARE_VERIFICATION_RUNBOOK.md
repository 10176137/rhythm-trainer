# G0 真机验证执行手册

**日期：** 2026-10-23
**适用范围：** `main` @ `ae9d6ec`（P1-2B 之后）
**设备：** MEDELI SP-A500（Node MIDI Adapter）
**性质：** 真机（REAL_HARDWARE）验收步骤。**本仓库的自动化测试与 mock 结果不能替代本手册的任何一项。**

> 本手册由 ZCode 编写，但**无法代跑**：它需要实体键盘、真实按键和 USB 拔插。执行者需在设备旁逐项操作并记录证据。

---

## 0. 开始前

1. 启动引擎服务：`cd rhythm-trainer-frontend && npm run server`（8788）。
2. 打开 `/device`，连接 `MEDELI SP-A500`，确认：
   - `inputHealth = healthy`
   - `queueDropped = 0`
   - `sourceSeq` 随按键递增
3. 选一份短谱，**至少 5 个目标**。
   > 少于 5 个匹配时 `min_rhythm_samples = 4` 会让 confidence 变低，`scoreStatus` 可能是 `INSUFFICIENT_DATA`，而不是设备问题。
4. 记录本轮配置：曲谱 fingerprint、BPM、手别、小节范围、count-in（默认 3 s）、scoring config 版本。
5. 每一轮都开新 Take，**不要覆盖或删除历史记录**（`%APPDATA%\rhythm-trainer-frontend`）。
6. 音频输出延迟仍为 `uncalibrated`：不要把 onset 偏差全部归因于演奏。

---

## 1. 基本输入（单音 / 错音 / 漏音）

**操作**

1. 固定时间模式，完整弹一遍正确音符。
2. 第二轮：只把一个音改成相邻半音（节奏不变）。
3. 第三轮：故意漏掉一个中间音，其余照常。

**预期**

| 检查 | 期望 |
|---|---|
| `scoreStatus` | `AVAILABLE`（≥5 目标、health healthy、clock 可用） |
| 正确音 | `eventResults` 为 `MATCH`，`pitch.correct` 等于目标数 |
| 错音 | 唯一 `WRONG_PITCH`，`scoreEventId`/`measure` 指向该音 |
| 漏音 | 唯一 `MISSING`，后续音**不整体错位** |
| 额外音 | 未故意多弹时 `EXTRA = 0` |
| 实时 vs 最终 | 同一 Take 的实时判定与 `scoreV1.eventResults` 在该音上结论一致（允许实时 Miss/最终 WrongPitch 的已定义差异，但必须能解释） |

**记录**：`sessionId`、`takeId`、`scoreStatus`、`pitch` 四项、`eventResults` 中非 MATCH 的条目、`scoreV1.overall.score`。

---

## 2. 时序与连击（快速连续 / 同音重复 / 和弦）

**操作**

1. 快速连续弹 8–12 个十六分音符（或当前 BPM 下最快可弹）。
2. 同一音重复 4 次。
3. 弹 3–4 个和弦，允许几毫秒的横向展开。

**预期**

| 检查 | 期望 | 失败含义 |
|---|---|---|
| `captureDiagnostics.admission.suppressedNoteOns.outOfOrder` | **0** | >0 表示映射后的 session 时间出现倒退，Policy B 丢弃了该音。记录原始时间，这是策略过于激进的证据 |
| `suppressedNoteOns.duplicate` | 0 | >0 表示设备/适配器重复发送同一 `sourceSeq` |
| `captureQuarantinedPackets` | 0 | >0 表示 epoch/序号被隔离 |
| `inputHealth` / `queueDropped` | healthy / 0 | 非 0 先查设备与 USB |
| 和弦 | 同 onset 多音不互相吞掉；无整段 miss | 对齐或分组问题 |
| 同音重复 | 每个起音独立计数 | 重复音被合并 |

> **注意**：`outOfOrder > 0` 在真机上不是"必然失败"，但必须记录该音的原始 `capturedAt`、映射后的 `sessionTime` 与前后事件时间；它意味着这次按键被丢弃，不能算作"已正确处理"。

---

## 3. 暂停与恢复

**操作**

1. 按住一个琴键，保持发声时点暂停。
2. 暂停期间按另一个键并释放。
3. 恢复，再松开第一个键。
4. 继续弹完剩余目标。

**预期**

| 字段 | 期望 |
|---|---|
| Take | 不失败；能正常 finish 并生成报告 |
| `admission.suppressedNoteOns.paused` | ≥1（暂停期间按下的 Note On） |
| `pauseSuppressed` | ≥ 暂停期间的按键包数（含 Note Off） |
| `pauseExcludedFromScore` | 等于被暂停准入拒绝的 performed-note 生命周期数 |
| `admission.pauseSegments` | 含已闭合段；若暂停中结束 Take，则含 `endSession = null` 的开放段 |
| 按住跨暂停的键 | `durations.assessments` 中该键 `quality = crossed_pause_boundary`，时值不作严格成绩，但起音保留 |
| 恢复后 | 同一 Take 继续；不出现"暂停期间按键变成恢复后的迟到 Extra" |

---

## 4. 断连与重连

**操作**

1. 开始新 Take，弹 2–3 个音。
2. 练习中拔掉 USB。
3. 重新插入，观察设备页与工作台。

**预期**

| 检查 | 期望 |
|---|---|
| Take 状态 | 断连若关闭 socket → 自动结算为 `interrupted`，`trustworthy = false` |
| 报告 | `scoreStatus` 为 `DEGRADED` 或 `INSUFFICIENT_DATA`，**不得**虚假 `AVAILABLE` |
| 诊断 | `captureDiagnostics.inputHealth = disconnected/degraded`；`node.staleGenerationEvents` 或 `unmappedEvents` 有记录 |
| 持久化 | Trace/Journal 仍落盘，`journal.entryCount > 0` |
| 重连后 | 新 generation；旧 generation 事件被丢弃，不映射到新时钟段 |

---

## 5. P09 真实比较

**前置**：一份真机 `AVAILABLE` 来源报告（≥5 目标）。

1. 从历史打开该报告，确认自动处方（例如 `LOCAL_ONSET_V1`）。
2. 确认处方 → 准备态 → 手动开始（不要立即自动开始）。
3. 严格按处方 BPM / 手别 / 小节复练，优先保证每个目标都在窗口内。
4. 读取两份报告与 `retryComparison`。

**预期**

| 检查 | 期望 |
|---|---|
| 来源与复练 | 两份均 `AVAILABLE` |
| 引用 | `sourceReportId` / `sourceTakeId` / `prescriptionId` 正确；来源报告未被覆盖 |
| 比较 | `retryComparison.comparable = true`，指标按同一口径 |
| 失败时 | 若复练仍 `INSUFFICIENT_DATA`，如实记录为"未完成"，不要降低门槛 |

---

## 6. 每项证据清单

每个步骤记录以下内容（可直接复制成表）：

| 字段 | 来源 |
|---|---|
| 设备 / 端口 / adapter generation | 设备页、`GET /api/midi/status` |
| `sessionId` / `takeId` / `traceId` / `journalId` | 报告、`GET /api/sessions/:id` |
| BPM / 手别 / 范围 / count-in / scoringConfig 版本 | 报告与配置 |
| `scoreStatus`、`scoreInputNoteCount`、`scoreUnmappedNoteCount` | 报告记录 |
| `captureDiagnostics.admission` 全部计数 + `pauseSegments` | `GET /api/sessions/:id` |
| `scoreV1`：pitch / onset / eventResults / measures / overall | 同上 |
| Trace / Journal | `GET /api/traces/:id`、`GET /api/journals/:id` |
| 结论 | PASS / FAIL / NOT RUN + 备注 |

**准入门计数含义（真机排查用）**

| 字段 | 单位 | 期望 |
|---|---|---|
| `admission.packets` | 包 | = `noteOns + nonOnsets` |
| `admission.noteOns` | Note On | = `admitted + countIn + paused + clock + duplicate + outOfOrder` |
| `admission.admittedNoteOns` | Note On | = `pushHitCount` |
| `admission.captureQuarantinedPackets` | 包 | 正常 0 |
| `admission.duplicateEventIds` | 包 | 正常 0 |
| `admission.finalPerformedNotes` | 生命周期 | 进入 `scorePerformance` 的数量 |
| `admission.finalSkippedByAdmission` | 生命周期 | 被准入拒绝而跳过的数量 |

---

## 7. 判定

只有 1–5 全部执行、失败项如实记录、且没有把 `INSUFFICIENT_DATA`/`DEGRADED` 当作通过时，G0 才能标记为完成。任何一项 `outOfOrder > 0`、暂停输入复活、断连后虚假 `AVAILABLE` 都属于需要先处理的发现，而不是"通过但有小问题"。

**R2 在 G0 完成前不启动。**
