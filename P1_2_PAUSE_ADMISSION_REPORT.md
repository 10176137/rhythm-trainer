# P1-2 实施报告：统一暂停边界的输入决策与最终评分（Policy B）

**日期：** 2026-10-23
**基线：** `main` @ `e33f529`（保留 `c6f6d49`，未回滚）
**语义选择：** **B — 入口决策为准；实时路径抑制的起音永不进入最终评分**
**范围：** Node 输入入口、准入决策账本、最终 `scoreV1` 输入筛选、诊断与回归测试。
**未改动：** `scoring_v1` 算法、NAPI 评分接口、MusicXML/PlaybackPlan 语义、UI、参考播放、P1-3/P1-4、R2。

---

## 1. 结论

- 复现向量（`pauseAt = target+20ms`、`onset = target+8ms`、暂停中送达）现在得到**唯一结论**：实时抑制、最终评分也拒绝，`scoreInputNoteCount = 0`，`scoreV1` 不把它判为命中。
- 每个输入包在入口产生**一条不可变 admission decision**；最终评分只消费该决策，**不再按 onset 重新判断暂停/count-in**。
- **重复 eventId 现在 fail-closed**：第二个同 ID 包被标记 `duplicate`，不进入实时引擎、不覆盖账本；最终评分另有"一个 Note On 至多一条生命周期"的消费守卫。
- **乱序 Note On 在入口隔离**：早于最近一次成功 `pushHit` 的起音标记 `out-of-order`，不进入实时/最终评分，也不再让 Take 变成 `Invalid`。
- 三层计数分别定义并可断言守衡：packet、Note On、performed-note lifecycle。
- 真实 Node MIDI、raw packet、迟到事件、暂停中结束 Take、count-in 边界、clock 不可映射均有回归测试。
- mutation check 证明测试有效：绕过最终评分端的准入过滤后 T1/T3/T4 立刻变红（13 项断言失败）。

---

## 2. 决策优先级（实现即契约）

```
CaptureRouter quarantine（epoch/序号/quarantine，独立于评分准入，不产生 admission）
  → 重复 eventId（账本已有同一事件）                reason = duplicate
  → 当前处于暂停（到达时）                         reason = paused
  → session 时间不可用                              reason = clock（对所有包，不只 Note On）
  → 事件时间落在已闭合暂停段                        reason = paused
  → Note On 早于 scoringStart                      reason = count-in
  → 完整 Note On 时间早于最近一次成功 pushHit 的起音  reason = out-of-order
  → admitted
```

**重复判定放在最前**：身份重复与时序无关，重复包无论是否在暂停中都不能成为第二个证据。`duplicateOf` 记录首次决策的 `decisionId`，便于从 Trace 追溯。

实现位置：`rhythm-trainer-frontend/server/engine-server.mjs` 的 `recordAdmission()`。
与任务卡建议顺序一致；未调整。所有判定都在**同一个 ingress 函数**（`ingestRawPacket`）内完成，Web/模拟 raw packet 与 Node MIDI 共用。

---

## 3. 决策结构与关联键

```ts
{
  decisionId: 'adm-<n>',          // Take 内递增，稳定
  eventId: '<sourceId>#<sourceSeq>',  // 与 Rust 解码一致，用于关联生命周期
  sourceId, sourceSeq, kind,
  decisionSegmentId,              // 'active-N' 或 'pause-N'
  capturedAtMs,                   // 源/单调时钟，原样保留
  handlerAtMs,                    // 入口时间（可用时）
  sessionTimeMs,                  // 仅当映射有效，否则 null，不回填
  clockDomainId,
  suppressionReason: 'count-in' | 'paused' | 'clock' | 'duplicate' | 'out-of-order' | null,
  duplicateOf: string | null,     // 重复包指向首次决策
  eligibleForRealtime: boolean,
  eligibleForFinalOnsetScore: boolean,
}
```

**关联键**：Rust `decode_ingest_packet` 生成 `event_id = "{sourceId}#{sourceSeq}"`（`crates/rhythm-core/src/midi.rs:545`），`KeyPressObservation.noteOnEventId` 引用同一个值。因此最终评分用 `admissionByEventId.get(observation.noteOnEventId)` 关联，**不使用数组下标、音高或时间近似**。

**暂停段**：`pauseSegments = [{ segmentId, startSession, endSession|null }]`。暂停时创建 `pause-N`，恢复时关闭并切到 `active-N`；Take 在暂停中结束时保留开放段 `endSession = null`。决策记录当时的 `decisionSegmentId`。

---

## 4. 生命周期语义

| 情形 | 行为 |
|---|---|
| Note On 被抑制 | 该生命周期不进入 `scorePerformance`；Note Off 只用于关闭/诊断；不会变成 MATCH 或 EXTRA |
| Note On 获准、Note Off 在暂停中 | 起音保留并参与评分；时值按既有 `crossed_pause_boundary` 处理，不作为严格时值成绩 |
| Note On 在暂停中、Note Off 在恢复后 | 整个生命周期排除；恢复后不会产生迟到的 EXTRA |
| 原始证据 | 所有包（含被抑制）仍进入 `ingests`、Trace、Journal；抑制表示不进入评分维度，不删除数据 |

T2 断言了 `crossed_pause_boundary`；T3 断言了"恢复后 Note Off 不复活生命周期"。

---

## 5. 计数单位与不变量

不允许跨单位加减。三层分别统计（`captureDiagnostics.admission`）：

| 层 | 字段 | 单位 |
|---|---|---|
| Packet | `packets`, `nonOnsets`, `captureQuarantinedPackets`, `duplicateEventIds` | 包 |
| Note On | `noteOns`, `admittedNoteOns`, `pushHitCount`, `suppressedNoteOns{countIn,paused,clock,duplicate,outOfOrder}` | Note On |
| Performed | `finalPerformedNotes`, `finalSkippedByAdmission`, `finalDuplicateLifecycles` | 生命周期 |
| 兼容 | `pauseSuppressed`（包）、`pauseExcludedFromScore`（生命周期） | 各自单位已注明 |

每个 Take 的测试都断言：

1. `packets === noteOns + nonOnsets`
2. `noteOns === admittedNoteOns + suppressedNoteOns.countIn + paused + clock + duplicate + outOfOrder`
3. `admittedNoteOns === pushHitCount`
4. 普通 Take `duplicateEventIds === 0`；T9 专门断言重复时为 1 且仍守衡 1–3

另：被 CaptureRouter 隔离的包**不进入** admission（不参与 1–2），单独计数，保持既有 quarantine 语义。

**clock 原因的口径**：对不在暂停中到达、且 session 时间不可用的包生效（包括 Note Off）；暂停中到达仍优先标记 `paused`（与优先级一致）。`suppressedNoteOns.clock` 仍只统计 Note On；Note Off 的 `clock` 只用于诊断，不改变起音准入（起音是否可评分由该 Note On 自己的决策决定）。

---

## 6. 测试矩阵（`server/selftest.mjs` → `scenarioPauseAdmissionLedger`）

| # | 场景 | 关键断言 | 结果 |
|---|---|---|---|
| T1 | **精确探针**：pause = target+20，onset = target+8，暂停中送达 | `paused=1`、`scoreInputNoteCount=0`、`scoreV1 0 命中/2 漏/0 extra`、实时同样 2 miss/0 extra、Trace 有 decisionId+segmentId | PASS |
| T2 | 起音在暂停前获准、Note Off 在暂停中 | 起音仍计分、`crossed_pause_boundary`、不额外抑制 Note On | PASS |
| T3 | 起音在暂停前、送达在暂停中、释放恢复后 | 整段排除，`0 命中/0 extra` | PASS |
| T4 | 已闭合暂停段内的起音恢复后送达 | 被抑制；同时验证"暂停前起音恢复后仍可准入" | PASS |
| T5 | count-in 边界 | `countIn=1`；边界后的 Note On 正常准入 | PASS |
| T6 | 暂停中结束 Take | 保留开放暂停段、0 输入、任务仍完成 | PASS |
| T7 | clock 不可映射的 Node MIDI | `clock≥1`、`nodeEventsUnmapped≥1`、不进入评分、不报崩溃 | PASS |
| T8 | 目标窗口关闭后暂停 | 实时 1 miss/0 extra，最终 1 命中/1 漏，一致 | PASS |
| T9 | **重复 eventId 且无 captureEpoch**（绕过 CaptureRouter） | `duplicateEventIds=1`、`duplicate 抑制=1`、`pushHit=1`、实时仅 1 次命中、最终仅 1 条生命周期 | PASS |
| T10 | **乱序 Note On**：先送 5008，再送 4008 | `outOfOrder=1`、`admitted=2`、`pushHit=2`、Take 未失败、实时/最终一致（1 命中/1 漏/1 extra）、Trace 保留乱序时间与决策 | PASS |
| T11 | 相同时间戳的两个 Note On | `outOfOrder=0`、两者均准入；第二个按既有规则成为 Extra | PASS |

### 6.1 Mutation check（实测）

把最终评分的准入判断临时改为 `if (false && !admission.eligibleForFinalOnsetScore)`：

```
FAIL  T1: 被抑制起音不进入最终评分输入 — 1
FAIL  T1: 最终评分不把暂停起音判为命中 — correct 1（应为 0）
FAIL  T3: 恢复后到达的 Note Off 不复活该生命周期 — extra 1
FAIL  T4: 暂停前的起音在恢复后仍可准入 — count 2（应为 1）
13 项断言失败
```

恢复实现后全绿。证明 T1/T3/T4 不是恒真测试。

### 6.2 Mutation check：重复准入

把 `const existing = eventId ? admissionByEventId.get(eventId) : undefined;` 临时改成 `undefined`：

```
FAIL  T9: 重复 eventId 被单独计数 — duplicateEventIds 0（应为 1）
FAIL  T9: 重复 Note On 记为 duplicate 抑制 — duplicate 0（应为 1）
FAIL  T9: 重复包不产生第二次实时命中 — admitted 2 / pushHit 2 / live extra 1
```

注意当时最终评分仍只有 1 条生命周期（消费守卫生效），这正好复现了"实时两次命中、最终一次"的不一致；补上入口拒付后两者都只剩一次。

### 6.3 Mutation check：乱序准入

把 `out-of-order` 分支临时短路为 `false && ...` 后重跑：场景以 `timeout waiting for report` 中止——乱序 Note On 进入 `pushHit`，Rust 返回 `OutOfOrderEvent`，`failActiveTake('invalid_input')` 清空 Take，因此不再产生报告。这正是本任务要消除的失败模式；恢复实现后 T10/T11 全绿。

---

## 7. 全量测试结果（本次实跑）

| 命令 | 结果 |
|---|---|
| `npm run selftest` | **PASS** — **232** 条断言（P1-1 后 163；P1-2 首版 219；补重复守卫 +5；补乱序隔离 +8） |
| `npm test` | **PASS** — 33 files / 237 tests |
| `npm run build`（`tsc -b && vite build`） | **PASS** — 4.19s |
| `cargo test --target x86_64-pc-windows-gnu` | **PASS** — 110（6 个 test binary 全部 ok；Rust 零改动） |

---

## 8. 改动文件

| 文件 | 改动 |
|---|---|
| `rhythm-trainer-frontend/server/engine-server.mjs` | admission ledger、决策优先级、暂停段、clock 决策、最终评分消费决策、诊断字段；删除 onset 重新推导 |
| `rhythm-trainer-frontend/server/selftest.mjs` | 新增 `scenarioPauseAdmissionLedger`（T1–T8）与不变量断言；`deltaMs` 断言改浮点容差 |
| `rhythm-trainer-frontend/src/types/engine.ts` | `EngineCaptureDiagnostics.admission` |

未改 Rust / scoring / importer / UI。

---

## 9. 未完成与残余风险

**仍未修（按任务卡范围）：**

- P1-3 服务端计划完整性校验（pitch/时值/数量/唯一 ID/measure 覆盖/planFingerprint）。
- P1-4 多 part 严格评分阻断（当前只有契约）。
- P2 后半段练习的小节统计、真实 OSMD 映射测试（后者上一轮已完成）。
- 时钟分段化与 uncertainty → timing 降级门禁。
- G0 真机项（受控错音、P09 比较、暂停/断连边界）全部 **NOT RUN**。

**残余风险（本任务未消除）：**

1. `admission` 账本只在内存与 Trace 中；报告只带计数与段列表，不带每条 decision。若需要跨进程重放"当时的决策"，应从 Trace 的 `admission` 字段读取，而不是重新推导。
2. 乱序 Note On 已由 `out-of-order` 规则在入口隔离，不会再以倒退的 atMs 进入 matcher，也不会让 Take 失败。但这意味着"时间更早、送达更晚"的起音会被丢弃（Policy B）；若要接受它们，需要缓冲/重排，本任务明确不做。
3. 重复 eventId 已 fail-closed 并有 T9 覆盖；但这条路径主要发生在 `captureEpoch` 缺失时，带 epoch 的输入仍由 CaptureRouter 先隔离，两种来源分开统计（`captureQuarantinedPackets` vs `duplicateEventIds`）。
4. T1 等使用 2 个目标时 `scoreStatus` 为 `INSUFFICIENT_DATA`（`min_rhythm_samples=4`），因此测试断言的是 pitch/事件结果与实时一致性，不是 `AVAILABLE`。
5. 未做真机验证；以上均为 synthetic/mock 路径。

---

## 10. 声明

**R2 仍未开始。** 本次没有 Rust planner/importer 迁移，没有修改评分算法或权重，没有实时 matcher，没有 UI 改动。
