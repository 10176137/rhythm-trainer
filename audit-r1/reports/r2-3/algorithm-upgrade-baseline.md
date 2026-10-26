# Rhythm Trainer 算法完善与工程化：Stage 0 真实基线

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- verifiedCodeSha：`02083ee0e8925edc03a9f7a65e974f80241fd2ce`
- 工作方式：本地验证，无 CI（仓库无 CI workflow）。本报告不把本地结果表述为 CI 通过。
- 依据文档：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md`（Stage 0 / §4）

## 1. 仓库与工作区状态（实测）

| 项 | 值 |
|---|---|
| 当前分支 | `r2-3-rust-planner` |
| HEAD | `02083ee0e8925edc03a9f7a65e974f80241fd2ce`（2026-10-26T04:09:29+08:00） |
| 远端跟踪 | `origin/r2-3-rust-planner` 与本地一致；工作区干净 |
| `origin/main` | `ba6d3c46bdc6abce666da9ec68e82dcf211528d4`（未改动，未合入） |
| 本地 `main` | 无本地分支；仅 `origin/main` |

本次基线开始前，`node_modules/`、`target/`、原生 `.node` 产物已按仓库 `.gitignore` 排除，不在版本库内。

## 2. 运行环境

| 项 | 值 |
|---|---|
| OS | macOS 27.2（Build 26B118），arm64 |
| Node | v26.12.0 |
| npm | 10.8.3 |
| Rust | rustc 1.99.1（58cf8f9c3 2026-10-13）/ cargo 1.99.1（stable，aarch64-apple-darwin） |
| Rust target | 原生 `aarch64-apple-darwin`（README 中的 Windows GNU 说明不适用于本机） |
| 原生 addon | `rhythm-trainer-core-v0.2/bindings/node/rhythm_trainer_native.node`，8,138,528 bytes，debug 构建，2026-10-26 14:15 由当前 HEAD 源码编译 |
| 真实谱 fixture | 未提供（`RHYTHM_REAL_SCORE_PATH` 未设置） |
| 真实 MIDI 硬件 | 未接入；本轮没有硬件验收 |

## 3. 测试命令与结果（实测）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b`（frontend） | 0 | 通过，无输出 |
| `npx vitest run`（frontend 全量） | 1 | 测试文件 49 passed / 1 failed / 2 skipped（52）；测试 510 passed / 1 failed / 5 skipped（516） |
| `cargo test --workspace`（core） | 0 | 11 个 test binary，177 passed / 0 failed / 0 ignored |
| `npm run selftest`（engine） | 0 | 251 项 `ok`，全部通过 |

### 3.1 Rust 测试分布

`100 + 1 + 23 + 11 + 1 + 7 + 7 + 1 + 5 + 21 + 0 = 177`（与既有 Follow 报告记录的 177 一致）。

### 3.2 前端分组结果（从全量日志归类）

- **Planner parity / contract**：
  - `contract-v1.test.ts` 61 passed / 1 skipped
  - `rust-parity.test.ts` 63 passed
  - `r2-3d-evidence.test.ts` 4 tests：3 passed / 1 failed（E5，见 §4）
  - `parity-diff.test.ts` 16 passed；`case-bundle.test.ts` 11 passed
  - `acceptance-a/b/c/v.test.ts` 2/10/13/11 passed
  - `real-score-parity.test.ts` 2 skipped；`rust-parity-inputs.test.ts` 1 skipped
- **Server integration**（真实 engine server + 真实 NAPI）：
  - `follow-protocol.test.mjs` 5 passed
  - `plan-protocol.test.mjs` 11 passed
  - `planner-service.test.mjs` 24 passed / 1 skipped
  - `follow-runtime-parity.test.ts` 1 passed
  - 其余 server 测试（score-library、take-templates、mode-config、midi adapter、clock-map）全部通过
- **前端其余 39 个测试文件**全部通过。

## 4. 失败与跳过分类

### 4.1 唯一失败：E5 真实谱回归（环境阻塞）

- 测试：`src/score-engine/parity/r2-3d-evidence.test.ts` → `writes the E6 migration-evidence report and the E7 gate matrix BEFORE the verdict`
- 原因：`RHYTHM_REAL_SCORE_PATH` 指向的第三方真实谱 fixture 在本机不存在。测试按设计把 E5 标记为 `NOT RUN` → `BLOCKED`，E7 门禁因此为 `BLOCKED`，最终断言失败并以非零退出。
- 分类：**环境失败**，不是代码回归，也不是新引入失败。
- 处理：按计划「不允许通过更新 snapshot/golden 或增加 skip 来修绿基线」，保留失败事实；不增加 skip、不修改断言。
- 既有证据：仓库中 `r2-3d-e5-real-score-result.json` 仍保存 Windows 真机运行结果（`D:\123\score-latest.musicxml`，sha256 `2654f283...`，113 小节 / 1579 occurrences / 1018 groups）。本机运行会用 `NOT RUN` 覆盖该文件，因此本轮已用 `git checkout --` 还原，未把本机缺失 fixture 的结果提交为证据。

### 4.2 五个跳过（全部为 fixture/环境门禁）

| 文件 | 跳过数 | 门禁 |
|---|---|---|
| `src/score-engine/parity/real-score-parity.test.ts` | 2 | 真实谱 fixture 缺失 |
| `src/score-engine/parity/rust-parity-inputs.test.ts` | 1 | 生成器开关未启用 |
| `src/score-engine/contract-v1/contract-v1.test.ts` | 1 | 依赖真实谱文件 |
| `server/planner-service.test.mjs` | 1 | 依赖真实谱文件 |

以上均为 `skipIf` 环境门禁，非本轮新增 skip。

## 5. §4 已知缺陷逐项核查（以当前代码为据）

| 项 | 状态 | 证据 |
|---|---|---|
| 4.1 P1 Follow 保存失败后不丢草稿、不谎报成功 | **部分修复，核心缺陷仍在** | `engine-server.mjs:1569-1580` 已捕获 `persistenceError` 并把 `persisted` 发给前端；但 `followFinalized` 只保留 `{takeId, report, persisted, persistenceError, endReason}`，没有保留 `takeRecord` 草稿，随即清空 `followRuntime/followContext`（1580-1584），没有重试入口。前端 `App.tsx:443-463` 完全不读 `persisted/persistenceError`，完成态固定提示「已保存为一个 Follow Take」。仓库中没有写盘故障注入测试。 |
| 4.2 P1 Node 不权威修改 Follow 音乐语义 | **部分修复** | 已记录 `targetSource=client-plan-projection` 并在有 `scoreId` 时校验曲谱指纹；但 `normalizeFollowGroups()`（`engine-server.mjs:1389-1428`）仍在 Node 内对同 onset 同 MIDI 音做静默去重（`1422: if (seenNotes.has(midiNote)) continue;`），没有保留被去重成员映射或诊断，且该函数同时作用于服务端 Rust plan 与客户端投影两条路径（1960/1979）。 |
| 4.3 P2 统一 Timeline / Follow 结算基础设施 | **仍存在** | Follow 使用 `finalizeFollowTake()`（1488），Timeline 使用另一条记录构建/结算路径（3137-3243）；两者只共用 `writeTakeOnce()`（426）与 `atomicWriteJson()`（138），没有共享的生命周期/幂等/重试服务。 |
| 4.4 P2 拆分 attempt/input/authority/integrity/score/persistence 状态 | **部分修复** | Take `assessment` 目前只有 `trustworthy` 与 `scoreStatus`（Timeline：3168-3172；Follow：1553-1561）以及 Follow 的 `scope/strictTiming`。`plannerAuthority` 在 `context`、`captureDiagnostics.inputHealth` 在证据内，但没有 `attemptStatus` / `inputQuality` / `planIntegrity` / `persistenceStatus` 这些正交字段，也没有统一映射函数。 |

## 6. 测试副作用观察（未修改代码）

完整运行 Vitest 会重写 3 个被跟踪的证据文件：

- `audit-r1/reports/r2-3/r2-3c-dual-run-report.json`（`generatedAt` 与 `gitSha`）
- `audit-r1/reports/r2-3/r2-3d-e5-real-score-result.json`（真机结果被替换为 `NOT RUN`）
- `audit-r1/reports/r2-3/r2-3d-migration-evidence-v1.json`（`verifiedCodeSha` 与 `e5` 段）

这是证据 harness「先写报告再断言」的既有设计。Stage 0 不改生产代码；上述文件已还原到 HEAD 内容。该行为是否需要在后续阶段增加「仅在显式证据模式写入」的保护，留待 Stage 1 范围评审，不在本阶段擅自修改。

## 7. Gate 0 结论

- 基线已建立：仓库状态、工具链、addon 构建、四类验证命令与逐项结果均有实测记录。
- `tsc -b`、Rust 177 项、engine selftest 251 项全部通过；前端 510/516 通过。
- 唯一失败 E5 与全部 5 个跳过均由缺失真实谱 fixture 导致，属环境阻塞，不据此修改断言或 golden。
- §4 四项缺陷没有任何一项可判定为「已完全修复」：4.1/4.2/4.4 为部分修复，4.3 仍存在。
- 允许进入 Stage 1，且 Stage 1 只需处理上表中仍存在的部分；不重复修改已修复内容。
