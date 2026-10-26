# Stage 2 单一可验证 Plan Bundle：Gate 2 验证报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 实现提交：`753238b`（`feat(stage2): validated PracticePlanBundleV1 with fail-closed launch gates`）
- 性质：**本地验证，无 CI**（仓库无 CI workflow）。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §5 / Gate 2

## 1. 范围与非目标

本阶段只做「正确答案」的一致性与可验证性：

- 新增内部 additive `PracticePlanBundleV1`，覆盖 occurrence/group/atom/scoreEvent 与统一时间基；
- 在严格练习启动前执行 fail-closed 一致性门禁；
- Timeline 与 Follow 使用同一 bundle 门禁（Follow 不消费 atoms，但组/occurrence/scoreEvent 仍绑定）；
- 统一 count-in 为 `3_000_000 µs`，`countInBeats` 只作为显示/节拍器派生值；
- 将 repeat 策略、count-in、ticksPerQuarter 纳入 launch context key。

明确未做：

- 未修改 `ScoreDocumentV1`、`planFingerprintV1` 固定向量、parity golden、`EngineScoreEvent` wire shape、`scoring_v1`、`HitMatcher`、`build_schedule`、`RHYTHM_PLANNER` 默认值；
- 未切换生产默认 Planner，未合并 `main`；
- 未新增用户可见功能或 UI；
- 未接通生产 multi-pass / 无限循环；`repeatSelection` 仍为 `none`，bundle 仅对未来 `range-loop(count)` 做形状/范围校验；
- 未把 bundle 持久化为独立文件；Take 仍保存 atoms/scoreEvents/followGroups 作为冻结输入。

## 2. PracticePlanBundleV1（内部 additive DTO）

实现：`rhythm-trainer-frontend/src/score-engine/plan/practice-plan-bundle.ts`

核心字段：

- `schemaVersion: 1`、`planId`、`planFingerprint`、`scoreFingerprint`、`authority: 'rust-planner' | 'rts-projection'`、`plannerVersion`；
- `config: PracticeConfigSnapshotV1`：mode/advanceMode、BPM 有理数、range、repeatSelection、hand、handMapping、`countInUs`、`countInBeats`（精确有理数）、ticksPerQuarter、unsupportedNotationPolicy、plannerVersion；
- `timebase`：ticksPerQuarter、countInUs、countInBeats、`sessionTimeUnit: 'microsecond'`、`roundingPolicyVersion: 'time-conversion-v1'`；
- `occurrences[]`：occurrenceId、sourceScoreEventId、groupId、源 locator、passIndex、playbackIndex、bar/measure、playbackBeat/durationBeat、staff/voice、midiNote/spelling、tie、`targetOnsetUs`、`targetDurationUs`；
- `groups[]`：groupId、passIndex、bar、playbackBeat/durationBeat、occurrenceIds、sourceScoreEventIds、成员 MIDI 音高（保留同音重复）、组 onset、组时长（最长成员）；
- `atoms[]`：groupId、startTick、durationTicks、bar、beat；
- `scoreEvents[]`：scoreEventId、occurrenceId、sourceScoreEventId、measure、pitch、µs 时间、partId、parseConfidence、passIndex、源 locator；
- `integrityReport`：`ok`、`checks[]`、`issues[]`（稳定 code、phase、entityId、blocking）。

时间：

- `targetOnsetUs = countInUs + beatToMicroseconds(playbackBeat, bpm)`；
- `targetDurationUs = beatToMicroseconds(durationBeat, bpm)`；
- `countInBeats = rational(countInUs × bpmNum, 60_000_000 × bpmDen)`；
- 所有时间在 bundle 内是整数微秒；只有 `engineScoreEventsFromBundle()` 在冻结 wire 边界除以 1000 一次。

## 3. 构建路径

### 3.1 Rust Planner 路径

`buildPracticePlanBundleFromRust()`：

- 输入真实 `RustPlanResponse` + `toPlaybackPlan()` 投影 + 冻结练习配置 + `ScoreDocument/ImportReport`；
- atoms 来自 Rust `response.plan.atoms`，scoreEvents 来自 Rust `response.plan.scoreEvents`（不重新生成时间）；
- 用 `planFingerprintV1` 以响应中的 `plannerVersion` **重算**指纹并与服务端 `planFingerprint` 比较；不一致即阻断；
- 比较响应 `scoreFingerprint`、`runtimeIds.planId` 与 PlaybackPlan；
- `atomIssueCodes` 在 Timeline 下阻断；Follow 下仅作为非阻断证据；
- 每个 Rust scoreEvent 的 locator/pass/source id 必须与 occurrence 一致。

### 3.2 rts 投影路径

`buildPracticePlanBundleFromPlayback()`：

- occurrences/groups 来自同一 `PlaybackPlan`；
- atoms 由 `scoreOccurrencesToEngineAtoms()` 从同一 plan 派生，网格不可精确表示时阻断（Timeline）；
- scoreEvents 由同一 occurrences 精确派生（µs），并只在 wire 边界转 ms；
- 计算 `planFingerprintV1`（含 plannerVersion、range、hand、handMapping、repeatSelection、BPM、ticks、countInBeats、plan）；
- `planFingerprintV1` 失败（例如 clef-heuristic 未确认映射）时 fail-closed。

## 4. 启动前一致性门禁（实现）

`validatePracticePlanBundle()` 执行的检查（稳定 code）：

- **config**：schema/identity、BPM 20–300、countInUs 非负安全整数、ticks 正整数、countInBeats 精确公式、range、repeat 形状/1..32、fingerprint 格式与期望值；
- **occurrence**：ID 唯一、groupId 归属唯一、bar/measure/range、staff/pass/playbackIndex、MIDI 音高、正时值、`countInUs + beatToMicroseconds` 精确相等；
- **group**：ID 唯一、非空成员、成员存在且只属于一个组、成员 bar/beat/pass 与组一致、sourceScoreEventIds 1:1、组 onset 公式、组时长 = durationBeat = 最长成员、组音高列表与成员一致、组顺序不倒退；
- **atom（Timeline）**：数量 = group 数、groupId/bar 对齐、ticks→µs（含 BPM 与 round-half-up）与组 onset/duration 精确相等；Follow 下跳过严格 atom 并对「未消费」给 warning；
- **scoreEvent**：ID 唯一、每个 occurrence 恰一个、无悬空/多余、pitch/measure/pass/sourceId/locator/partId/confidence 与 occurrence 一致、µs 时间逐字段相等；
- **fingerprint**：格式、重算/期望值、scoreFingerprint。

失败通过 `PlanBundleRejected('PLAN_BUNDLE_REJECTED', issues)` 抛出；调用方不得修补或回退到另一个计划。

## 5. 启动接线（fail-closed）

`src/App.tsx`：

- Rust Timeline/Follow：在 `assertTimelineResponseUsable` / `assertFollowResponseUsable` 之后构建并断言 bundle；Timeline 的 atoms/scoreEvents 改为 `engineAtomsFromBundle()` / `engineScoreEventsFromBundle()`；
- rts Timeline：在生成 `scopedPlan` 后构建 bundle 并断言；atoms/scoreEvents 来自 bundle（不再单独调用 `buildEngineScoreEvents` / `scoreOccurrencesToEngineAtoms`）；
- rts Follow：在同一 `scoped.plan` 上构建并断言 bundle（advanceMode=follow），再由服务端 Rust FollowRuntime 消费 groups；
- 任何 bundle 异常都在现有 try/catch / `orchestrateRustLaunch` 中变成可见的启动失败，不会回退到 TS 规划。

## 6. 统一 count-in

- 前端：`DEFAULT_COUNT_IN_MS = 3000` → `countInUs = 3_000_000`，同时传给 bundle、`session.begin`、Rust plan config；
- 服务端 `start`：新增 additive `countInUs`；若提供，必须是安全非负整数微秒，且与 `countInBeats` 的换算一致（容差 1e-6），否则拒绝启动；`countInMs = countInUs / 1000`；
- 旧客户端未提供 `countInUs` 时保留 `countInBeats × 60000 / bpm` 兼容路径；
- Take/`started` 记录 `countInUs`；`countInBeats` 只用于节拍器/显示。

## 7. 配置失效

`planContextKey()` 现在包含：

- hand、tempo、modeId、loop/range、handMapping；
- `repeatSelection`、`countInUs`、`ticksPerQuarter`。

launch token 的 currency check 仍先于 accept；范围/速度/手别/映射/重复策略/count-in 任一变化都会使未启动的旧计划成为 `STALE_CONTEXT`。

## 8. 测试与结果（实测）

环境：macOS 27.2 arm64；Node v26.12.0；npm 10.8.3；Rust 1.99.1；addon 由当前源码构建。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b` | 0 | 通过 |
| `npx vitest run`（全量） | 1 | 文件 53 passed / 1 failed / 2 skipped（56）；测试 549 passed / 1 failed / 5 skipped（555） |
| `cargo test --workspace` | 0 | 179 passed / 0 failed（未改 Rust 代码） |
| `npm run selftest` | 0 | 251 项 `ok` |
| `npm run build` | 0 | `tsc -b && vite build` 通过（仅既有 chunk 体积警告） |

- 唯一失败仍是 E5 真实谱回归：`RHYTHM_REAL_SCORE_PATH` fixture 缺失 → `NOT RUN/BLOCKED`；没有新增 skip、未改断言/golden。
- 5 个跳过仍是既有真实谱/生成器环境门禁。
- Stage 2 新增测试：
  - `practice-plan-bundle.test.ts` 26 项：正常 rts 计划、Rust 投影、**真实 Rust NAPI corpus**、Follow 语义、21 项 mutation（pitch/onset/duration/pass/ID/group membership/pitch list/atom/scoreEvent/BPM/count-in/countInBeats/repeat/fingerprint）；
  - `take-persistence.test.mjs` 新增 count-in 一致性拒绝（总计 4 项）；
  - `r2-3h-r1-launch.test.ts` 新增 repeat/count-in/ticks context key 覆盖（总计 16 项）。
- 完整 Vitest 仍会重写 3 个已跟踪证据 JSON；已还原，未纳入提交。

## 9. 已知限制与残余风险

1. **bundle 不持久化**：Take 保存 atoms/scoreEvents/followGroups 和 `planFingerprint`（Rust 路径），但没有完整 `integrityReport`/rts bundle 指纹。重放与审计仍以 Take 内冻结输入为准；若产品要求“从 Take 重算 bundle 校验”，需要后续 schema 决策。
2. **rts `planFingerprint` 仍为 `null`**：冻结契约规定 rts 不接受 `planFingerprint`；bundle 在浏览器内计算并用于门禁，但不写入 Take。Rust 路径仍写入服务端指纹。
3. **Follow 不消费 atoms**：Follow bundle 会记录 atoms 作为同计划证据，但严格 atom 失败只给 warning，不会阻止 Follow；这与 Follow 不使用固定时间轴一致。
4. **生产 repeat 仍为 none**：bundle 支持 `range-loop(count)` 的形状校验，但 App 当前不发送 count；未新增重复 UI/运行时。
5. **未做真实浏览器点击验收**：`npm run build` + 单元/协议测试通过，但没有在真实浏览器里完成一次 Rust/rts 启动；本报告不声称浏览器验收。
6. **E5 真实谱缺失**：仍无法在本机执行 113 小节真实谱回归；环境阻塞已如实记录。

## 10. Gate 2 结论

- 正常 Rust 计划（真实 NAPI corpus）与 rts 计划均通过同一 bundle 门禁；
- pitch、group membership、ID、onset、duration、pass、BPM、count-in、fingerprint 的 mutation 全部被阻断；
- atoms/groups/scoreEvents 的 1:1 绑定、时长=最长成员、精确 µs 公式均被验证；
- 启动路径只从 bundle 取 atoms/scoreEvents，失败 fail-closed；
- count-in 在 Plan/Bundle/wire 中统一为 `3_000_000 µs`，不一致会被拒绝；
- 冻结契约未改动，未切换默认 Planner，未合 `main`。

**Gate 2：通过。** 可以进入 Stage 3（标注算法基准集）；生产默认切换仍需独立批准。
