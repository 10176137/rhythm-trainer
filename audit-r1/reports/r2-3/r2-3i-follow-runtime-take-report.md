# R2-3i Follow：Rust 权威运行时与统一 Take 结算报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- verifiedCodeSha：`766be3ca0d889efb531855ab5f1d3fc8b5e677cc`
- 代码提交：`feat(r2-3i-follow): server-authoritative Follow runtime + unified Follow Take`
- 验证性质：**本地验证，无 CI**。仓库没有 CI workflow；本报告不把本地结果表述为 CI 通过。

## 1. 范围与结论

本阶段完成：

1. **Follow 权威运行时迁入 Rust**：目标推进、音高/顺序匹配、和弦间距、相邻正确起音间隔、容差判定、Follow 报告全部由 Rust `FollowRuntime` 计算；浏览器不再推进光标、不匹配音高、不计算 Follow 报告。
2. **Follow 统一进入 Take Finalizer**：一次完成/中断的 Follow 恰好写一个 `TakeRecordV1`，`assessment.scoreStatus = FOLLOW_ONLY`、`assessment.scope = "follow"`、`assessment.strictTiming = false`、`assessment.followReport`；不生成 `timelineReport`，也不伪装成固定时间 strict 评分。
3. **闭环测试**：默认 `rts` 启动路径、服务端 Rust plan 路径、暂停/恢复、真实服务端 mock MIDI 路由、重复完成不产生第二个 Take、中断结算、历史读取、旧 sessions 兼容、确定性 replay 均有测试。
4. **历史页切到 `/api/takes`**：Follow 与 Timeline 共用记录入口；Follow 渲染 `FollowReportPanel`，Timeline 继续渲染原 `ReportPanel`；旧 sessions 以 `legacy-<sessionId>` 只读适配。

明确未做（边界）：

- **生产默认仍是 `rts`**；未切换 `RHYTHM_PLANNER` 默认值，未合并 `main`。
- Take 领域模型的阶段完成**不等于** Rust 全计算化完成；Rust Planner 的功能测试通过**不等于**已获准成为生产默认。
- Follow Take 不更新 StudentModel/Profile；Profile 仍只消费有测量证据的 Timeline Take。
- 未提供独立的 UI/CLI replay 工具；replay 由测试用 Take 中保存的 `followGroups` + `followInputs` 确定性重放证明。

## 2. 实现

### 2.1 Rust `FollowRuntime`

新增 `rhythm-trainer-core-v0.2/crates/rhythm-core/src/follow.rs`：

- `FollowGroup { group_id, bar, playback_beat, pitches }`；`FollowRuntime` 持有序目标、匹配集合、错误/重复计数、首个正确时间、上一目标首音时间/拍位。
- 行为与浏览器旧 `FollowSession` 对齐：
  - wrong / duplicate 不推进；
  - partial 等到全部音高；
  - 完成时记录 `standard = clean && spreadOk && timingOk`；
  - `intervalErrorMs = actualGap − notatedBeatGap × 60000/bpm`；
  - `invalidateNextInterval()` 在暂停恢复后丢弃下一个间隔；
  - 完成后额外输入计入 `extra`（服务端在完成时自动结算，因此正常链路不会继续接收完成后的额外音）。
- 报告包含 counted targets、standard targets、pending target、wrong/extra/duplicate 数、timing samples / mean signed / mean absolute / stddev，且 `strict_timing = false`。
- 4 个 Rust 单测：不推进场景、间隔/standard、暂停失效、完成后额外音。

NAPI 新增 `NativeFollowRuntime`（`bindings/node/src/lib.rs`）及 DTO、`index.d.ts`。重建 addon 后确认 `NativeFollowRuntime` 可构造、`pushNote`/`progress`/`finish` 可用。

### 2.2 协议与 Finalizer

新增 WS 消息（additive，不改既有消息形状）：

- `follow-start`：支持两种来源
  - `planRequestId`：使用本连接上由服务端签发的 Rust plan 上下文（`targetSource = server-plan`）；
  - 默认 `rts` 路径：浏览器提交计划投影 `groups`，服务端校验形状/顺序/音高/group ID，记录 `targetSource = client-plan-projection`，**不标成 Rust 计划**。
- `follow-note`、`follow-pause`、`follow-resume`、`follow-finish`、`follow-abandon`。
- 服务端输出 `follow-started`、`follow-event`（含输入 note/atMs 与权威 result/progress）、`follow-report`。

关键约束：

- 暂停时不接受 `follow-note`，也不把硬件输入送入运行时；恢复时 `invalidateNextInterval()`。
- 双谱表同 onset 的同一 MIDI 音（unison）会去重为一个按键，group 仍保留全部 `scoreEventIds`；避免真实钢琴谱因同音重复无法推进。
- 若带 `scoreId`，服务端会与曲谱库指纹比对；不一致拒绝启动。
- 完成/中断/放弃统一走 `finalizeFollowTake`：
  - `writeTakeOnce` 原子写入，重复完成返回同一 Take；
  - `endReason = completed | interrupted`；
  - `assessment.trustworthy = !interrupted`；
  - `scoreStatus = FOLLOW_ONLY`、`scope = follow`、`strictTiming = false`；
  - `evidence.pauseIntervals`、`captureDiagnostics.targetSource`/容差/输入健康/输入数；
  - `evidence.followGroups`、`followBpm`、容差、`followInputs`（上限 20,000，超限标记 truncated），用于确定性 replay；
  - `engineDiagnostics.practiceSessionId = null`，没有伪造 NativeSession。
- 连接关闭时活动 Follow 结算为 interrupted Take；`/api/sessions/:followTakeId` 不返回伪造 Timeline 记录（测试断言 404）。

### 2.3 前端

- `EngineBridge` / `usePracticeSession` 新增 Follow 方法、`follow-started/event/report` 回调及启动确认 Promise；启动失败会清除 UI 并给出一条错误。
- `App`：
  - 删除了 Follow 的本地 `FollowSession` 推进/报告路径；Follow 只发送 `follow-start/follow-note/pause/resume/finish/abandon` 并渲染服务端事件；
  - `FollowSession` 仅保留给 Timeline 的“系统伴弹” UI 光标；
  - 模拟输入走 `follow-note`；硬件 Note On 由服务端直接送入 Rust 运行时，浏览器不再重复计数；
  - 暂停/恢复/结束/重置/切换曲谱都走服务端状态与中断结算。
- `HistoryView` 改读 `/api/takes`，Follow 渲染 `FollowReportPanel`，Timeline 继续 `ReportPanel`；行摘要对 Follow 显示完成/标准/错误音/节奏 MAE，不显示固定时间命中率。
- `FollowReportPanel` 修正 MAE/标准差的符号格式（负偏差/绝对值不再显示 `+`）。

### 2.4 顺带修复的真实缺陷

浏览器验收发现并修复两个既有问题：

1. **手别映射未持久化**：`serializePracticeSettings` 丢弃 `handMappings`，且 `rememberHandMapping` 保存的是整个 `HandMappingV1` 对象而非 `parts` 数组，重载后无法恢复。现改为保存 `parts` 数组，并兼容读取旧对象形状；单测 + 浏览器重载验证。
2. **同 onset 同音高被拒绝**：真实双谱表谱面会在同一 group 出现两个 C4，早期服务端校验报“音高重复”导致无法开始。现按 MIDI 音高去重，group 仍按一个起音目标计。

## 3. 闭环测试与证据

### 3.1 新增/扩展测试

- `server/follow-protocol.test.mjs`（5 tests，真实 engine server + 真实 NAPI，`RHYTHM_PLANNER=rts`）：
  1. `follow-start → follow-note* → follow-report`，默认 rts 投影路径，错误/部分/重复/和弦/完成、单一 Take、重复 finish 不新增文件、Take 字段、`/api/takes` 摘要/详情、`/api/sessions/:id` 404、同音去重；
  2. 暂停不接受输入、恢复失效下一间隔、`pauseIntervals`；
  3. mock MIDI 硬件 Note On 直达 Rust 运行时；
  4. legacy sessions 仍可读并暴露为 `legacy-*` Take；
  5. 断连产生 interrupted Take（不可信、`completedTargets` 保留）。
  
  第 1 项同时用 Take 中 `followGroups` + `followInputs` 重放，报告逐项一致。
- `server/follow-runtime-parity.test.ts`（1 test）：TS `FollowSession` 与 `NativeFollowRuntime` 对同一输入逐步结果和最终报告逐字段一致。
- `server/plan-protocol.test.mjs`（11 tests，新增 1）：`plan-request(mode=follow) → follow-start(planRequestId) → follow-note → follow-finish`，Take 记录 Rust plan 指纹/运行 ID、`targetSource=server-plan`，plan context 只能用一次。
- `src/features/practice/practiceSettings.test.ts`（新增 1）：手别映射跨存储 round-trip。
- Rust：`follow.rs` 4 个单测。

### 3.2 本地验证结果

| 验证 | 结果 |
|---|---|
| `npx tsc -b`（frontend） | 通过 |
| `npm run build`（tsc + vite build） | 通过；只有既有 chunk >500kB 警告 |
| `npx vitest run` | **512 passed / 4 skipped**（50 files passed / 2 skipped） |
| `cargo test --locked`（GNU target） | **177 passed / 0 failed**（逐 binary 合计：100+1+23+11+1+7+7+1+5+21） |
| `npm run selftest` | **251 ok**，全部通过 |
| 浏览器验收 | 见 3.3 |

R2-3c/R2-3d evidence JSON 在完整 Vitest 后已用 `git checkout --` 恢复，未纳入提交。

### 3.3 真实浏览器验收（默认 `rts`）

环境：engine `PORT=8788 RHYTHM_MIDI_BACKEND=mock`（`RHYTHM_PLANNER` 未设置，即 rts）；Vite `127.0.0.1:5174`；通过页面完成一次 Follow。

- 关闭“系统伴弹”（系统伴弹会强制固定时间），设置推进为“跟手等待”，确认谱表→手别映射后开始。
- 通过服务端 mock MIDI 注入（不是物理键盘）：
  - 第一目标和弦 `C5 / Eb5 / C4` → 推进 1；
  - `G4` → 推进 2；
  - `G5` → 推进 3；
  - `C4 / D5 / F5` → 推进 4；
  - 点击“结束”，页面出现 Follow 结果面板，显示 `4 / 1018`，完成/标准/错误音/额外音/重复音，明确“非固定时间 strict 成绩”。
- 最终代码下另一次 2 目标验收 Take：
  - `take-11f150d1-763e-4db4-abe4-138f919abfa6`；
  - `scoreStatus=FOLLOW_ONLY`、`scope=follow`、`strictTiming=false`、无 `timelineReport`；
  - `targetSource=client-plan-projection`、`plannerAuthority=rts`、`planFingerprint=null`；
  - `evidence.followGroups=1018`、`followBpm=72`、`followInputs=4`；
  - 历史行显示 `Follow · RTS 计划 · 2/1018 · 标准 1 · MAE 36.8ms · 可信`。
- 历史页展开 Follow 显示 `FollowReportPanel`；展开旧 Timeline 行仍显示 `ReportPanel`（回归验证通过）。
- 手别映射持久化：旧对象形状和新 `parts` 数组形状都能在重载后恢复并开始 Follow；修复后保存的是 `parts` 数组。

## 4. 冻结边界与残余风险

**未修改**：R2-3 frozen gate、golden、case index、`build_schedule`、`HitMatcher`、`scoring_v1`、既有 WS 消息字段语义、既有 Schema/指纹向量。新增 `follow-*` 消息与 Take 的附加字段均为 additive。

**残余风险/限制**：

1. 默认 `rts` 的 Follow 目标来自浏览器计划投影；服务端校验结构并在有 `scoreId` 时校验曲谱库指纹，但没有服务端 plan fingerprint。Take 诚实记录 `client-plan-projection` / `planFingerprint=null`。要消除这一层，需要 Planner 切换（另行授权）。
2. 浏览器验收使用 mock MIDI，不是本轮物理键盘实机；Rust 运行时与硬件路由由服务端 mock 注入和 E2E 覆盖。真实硬件 G0 证据仍属于既有阶段。
3. 完整谱面的 Follow Take 因保存 `followGroups` 会变大（示例 1018 目标约 321KB）；这是可重放性的代价，仍在本地 JSON 可接受范围。
4. `followInputs` 上限 20,000 并标记 truncated；超限时 replay 不完整，报告不承诺完整重放。
5. 没有独立 replay UI/CLI；replay 目前是测试能力。
6. Follow Take 不进入 StudentModel/Profile；这是有意的评估范围隔离，不是遗漏。

## 5. 复审检查清单

- [ ] Rust `FollowRuntime` 与旧 `FollowSession` 的逐步/报告一致性（parity test）。
- [ ] `follow-start` 对 `planRequestId` 和 client projection 两条路径的 provenance 记录是否如实。
- [ ] 完成/中断/重复 finish 是否始终只产生一个 Take。
- [ ] `/api/sessions/:followTakeId` 不产生伪造 Timeline 报告。
- [ ] 历史页 Follow/Timeline 两种报告是否都正确渲染。
- [ ] 手别映射持久化修复是否覆盖旧格式。
- [ ] 默认 `rts`、未合 `main`、未切换生产默认值。
