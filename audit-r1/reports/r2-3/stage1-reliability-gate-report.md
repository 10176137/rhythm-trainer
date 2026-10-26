# Stage 1 可靠性缺陷修复：Gate 1 验证报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 实现提交：`21e1d50`（`fix(stage1): harden Take finalization and Follow authority`）
- 测试补充提交：`586d1a9`（`test(stage1): cover Timeline retry and mastery-once semantics`）
- 验证时 HEAD：`586d1a9883de3d3db42cb88008217998ae2e7c96`
- 性质：**本地验证，无 CI**（仓库无 CI workflow）。本报告不把本地结果表述为 CI 通过。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §4 / Gate 1

## 1. 范围与非目标

本阶段只修复 Stage 0 判定为「仍存在 / 部分修复」的四项可靠性缺陷，不改变评分语义、不切换生产 Planner、不合并 `main`。

明确未做：

- 未修改 `ScoreDocumentV1`、`planFingerprintV1` 固定向量、parity golden/expected outcome、`EngineScoreEvent` wire shape、`scoring_v1`、`HitMatcher`、`build_schedule`、`RHYTHM_PLANNER` 默认值；
- 未新增面向用户的练习功能；只增加「保存未成功」的如实提示与重试入口；
- 未引入 Python/外部算法（Stage 3+ 范围）；
- 未把待保存草稿跨进程持久化（见 §7 已知限制）。

## 2. 4.1 Follow 保存失败：草稿保留、幂等重试、UI 不谎报成功

### 实现

- 新增 `rhythm-trainer-frontend/server/take-finalization.mjs`：
  - `finalize(record, { onPersisted })` 在首次写盘前冻结 JSON 草稿；
  - 写入使用临时文件 → `fsync` → 原子 `rename`；失败时清理临时文件并保留草稿；
  - 失败状态为 `pending-retry`，`retry(takeId)` 只用同一 `takeId` 和同一内容重试；
  - 相同 `takeId` 的重复 finalize 返回首次结果，绝不覆盖；内容不同标记 `conflict`；
  - `onPersisted` 只在「本次真正创建了 Take 文件」时执行一次，重试成功也只执行一次；
  - 成功后释放草稿负载，仅保留指纹与摘要。
- `engine-server.mjs`：
  - `finalizeFollowTake()` 与 Timeline 结算都改用该服务；
  - 新增 additive WS 消息 `persist-retry` → `persist-retry-result`，可在原连接或新连接上重试；
  - `follow-report` / `report` 增加 `persistenceStatus`，`persisted` 只在写盘成功时为 `true`。
- 前端：
  - `App.tsx` 的 Follow 结果提示按 `persisted` 分支：失败时明确说「结果已固定但尚未保存」，不再说「已保存」；
  - Follow 结果面板与 Timeline 错误条都提供重试按钮，调用同一幂等重试；
  - `usePracticeSession` / `EngineBridge` 新增 `retryPersist(takeId)`，超时/断连会拒绝而不是假装成功。

### 测试

- `server/take-finalization.test.mjs`（4 tests）：正常写入、重复 finalize 不覆盖、ENOSPC 注入后保留草稿并重试成功、未知 takeId 不伪造。
- `server/take-persistence.test.mjs`（3 tests，真实 engine server + 真实 NAPI）：
  1. takes 目录只读 → `persisted=false`、`pending-retry`、无文件；恢复权限后重试成功；重复 finish 不新增文件；未知 takeId 返回 `unknown`；
  2. 失败后关闭连接，新连接用同一 takeId 重试成功；
  3. Timeline 失败 → 无 Take、无 profile 更新；重试成功 → 一个 Take、一次 mastery 更新；再次重试 → profile 字节不变、仍只有一个 Take。

## 3. 4.2 Node 不再权威修改 Follow 目标语义

### 实现

- Rust `crates/rhythm-core/src/follow.rs` 新增 `normalize_follow_groups()`：
  - 校验目标数量、groupId 非空/唯一/长度、bar、playbackBeat 有限且非降、音高非空、spelling 非空；
  - 同 onset 同 MIDI 音按规范只保留首个拼写，用于 Follow 光标；
  - 返回每个 group 的 `source_pitch_count`、`canonical_pitch_count`、`duplicate_midi_notes`、`duplicate_spellings`。
- NAPI 新增 `normalizeFollowGroupsV1(groups)`，`index.d.ts` additive 更新。
- `engine-server.mjs` 的 `normalizeFollowGroups()` 现在只做协议形状/数量上限检查，然后调用 Rust；删除 Node 内的去重/顺序/音高语义校验。
- 服务端 plan 与客户端 rts 投影两条路径都经过 Rust canonicalization；被去重的成员写入 Take 的 `evidence.captureDiagnostics.groupNormalization`，不再静默消失。
- 默认 rts 路径仍如实记录 `targetSource=client-plan-projection`、`planFingerprint=null`，不伪装成 Rust 计划。

### 测试

- Rust：`normalization_dedupes_unison_and_preserves_source_evidence`、`normalization_rejects_semantically_invalid_target_lists`。
- `server/follow-protocol.test.mjs`：断言 canonical pitches 与被去重成员证据（`g2` 的 `[60]` / `['C4']`）；新增乱序目标被 Rust 拒绝的测试。
- 既有 replay 测试继续用 Take 内 `followGroups` + `followInputs` 重放并逐字段一致。

## 4. 4.3 统一 Timeline / Follow 结算基础设施

- 两种模式共用 `TakeFinalizationService`：冻结草稿、Take ID、幂等重复结算、原子写、失败重试、持久化状态与 `onPersisted` 一次副作用。
- **结果构建器仍分离**：Follow 仍产出 `assessment.followReport` + `scope=follow` + `strictTiming=false`；Timeline 仍产出 `assessment.timelineReport`。没有把 Follow 填成 Timeline，也没有引入通用分数。
- Timeline 的 StudentModel 更新被移入 `onPersisted`，保存失败时不会污染派生的 mastery 缓存。

## 5. 4.4 正交状态维度

新增 `server/take-status.mjs`，写入 Take 的 `assessment`（additive）：

| 字段 | 取値 |
|---|---|
| `attemptStatus` | `completed` / `interrupted` / `rejected` |
| `inputQuality` | `healthy` / `degraded` / `unscorable` / `unknown` |
| `planAuthority` | `server-rust` / `client-rts-projection` / `legacy` / `unknown` |
| `planIntegrity` | `verified`（仅服务端签发的 Rust 计划）/ `unavailable` |
| `scoreStatus` | 既有值保持不变 |
| `persistenceStatus` | `persisted` / `pending-retry` / `failed` |

- `trustworthy` 保留为兼容投影，没有删除或改写旧语义。
- `readTakeRecord()` 对旧 Take 增加只读投影：缺失维度映射为 `unknown` / `unavailable` / `persisted`，绝不把旧记录标成 `verified`；磁盘上已有的字段优先。
- Legacy `sessions-json` 记录映射为 `planAuthority=legacy`、`planIntegrity=unavailable`、`inputQuality=unknown`。
- `/api/takes` 摘要暴露以上维度，便于后续 UI/诊断使用。
- Profile 的通过/可信门槛**未改变**（仍基于旧 `trustworthy` + input health），避免在未授权情况下改变评分/教学语义；新维度目前只记录与展示。

### 测试

- `server/take-status.test.mjs`（3 tests）：authority/integrity 映射、input quality 四态、unknown 不伪造 verified。
- `follow-protocol.test.mjs`：rts Follow Take 断言 `client-rts-projection` / `unavailable` / `completed` / `persisted`；中断 Take 断言 `interrupted`；legacy Take 断言 `legacy`。
- `plan-protocol.test.mjs`：Rust Timeline 与服务端 Follow 均断言 `server-rust` / `verified`。

## 6. 验证结果（实测）

环境：macOS 27.2 arm64；Node v26.12.0；npm 10.8.3；rustc/cargo 1.99.1 stable；addon 由当前源码 debug 构建。

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b` | 0 | 通过 |
| `npx vitest run`（全量） | 1 | 文件 52 passed / 1 failed / 2 skipped（55）；测试 521 passed / 1 failed / 5 skipped（527） |
| `cargo test --workspace` | 0 | 11 个 binary，179 passed / 0 failed |
| `npm run selftest` | 0 | 251 项 `ok`，全部通过 |

- 唯一失败仍是 Stage 0 记录的 E5 真实谱回归：`RHYTHM_REAL_SCORE_PATH` fixture 缺失 → `NOT RUN/BLOCKED`。没有新增 skip、没有修改断言或 golden。
- 5 个跳过仍是真实谱/生成器环境门禁，与 Stage 0 相同。
- 本阶段新增测试 12 项（finalization 4、persistence 3、status 3、protocol 2），全部通过。
- 完整 Vitest 仍会重写 3 个已跟踪证据 JSON；本次已用 `git checkout --` 还原，未纳入提交。

## 7. 已知限制与残余风险

1. **待保存草稿只存在进程内存**：服务器进程重启会丢失尚未写入的 draft。产品当前没有承诺崩溃恢复；Take 文件只有在写盘成功后才存在。若未来承诺，需要独立设计 draft journal。
2. **Take 文件内的 `persistenceStatus` 恒为 `persisted`**：因为只有成功写入才会产生文件；`pending-retry` 只存在于结算响应与服务内存状态。
3. **`planIntegrity=verified` 目前只覆盖服务端签发的 Rust 计划**；默认 rts 路径与旧记录诚实地为 `unavailable`。这不等同于 Stage 2 的 Plan Bundle 全量一致性门禁。
4. **Profile 门槛未升级**：新维度尚未参与 mastery 判定，避免未经批准改变教学语义。
5. **未做真实浏览器点击验收**：重试按钮通过类型检查与协议集成测试覆盖，但没有在真实浏览器里点击验证；本报告不声称浏览器验收。
6. **未做真实硬件验收**：本阶段不涉及 MIDI 设备链路变更；沿用既有 G0 证据边界。

## 8. Gate 1 结论

- 故障注入、幂等、重试与两种模式生命周期测试通过；
- Node 不再静默改变 Follow 目标语义，去重决策与成员证据归属 Rust；
- 旧 Take/legacy session 仍可读，新状态维度可区分且不伪造 verified；
- 本阶段新增测试没有 skip；
- 冻结契约未改动，未切换默认 Planner，未合 `main`。

**Gate 1：通过。** 可以进入 Stage 2（单一可验证 Plan Bundle）；生产默认切换仍需独立批准。
