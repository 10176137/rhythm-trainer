# R2-3h-R1-F2 复审修复验证报告（实际启动模式纳入过期判定）

**verifiedCodeSha：** `3aa5e5745b8e83074a7b6903628a7a3293358304`（`3aa5e57`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**复审基线：** `637760fc14e1ad459c7a92d9c51850a31aed2596`（R2-3h-R1 报告），独立复审结论 `NEEDS REVISION`，唯一阻断项为 F2 未绑定实际启动模式。
**范围：** 仅修复该阻断项；F1（未知权威 fail-closed）未改动、未重做。

## 缺陷复述

旧 token 的 `launchContextKey` 包含 `modeId`（`score`/`loop`/`hands`/…），但不包含 `advanceMode`（`timeline`/`follow`）。Timeline ↔ Follow 切换不改变曲谱指纹、`modeId`、tempo 或范围，因此：

1. 用户以 Timeline 发起 Rust 计划请求；
2. 响应到达前把「练习推进」切到 Follow；
3. 旧 token 仍通过 generation / 曲谱 / contextKey / authority 全部校验；
4. `accept()` 按闭包中捕获的 `mode='timeline'` 调用 `session.begin()`，与当前 Follow 选择不符；反方向则会构建 `FollowSession`。

## 修复

**`src/score-engine/plan/launch-flow.ts`**

- `LaunchToken` 新增必填 `mode: ScoreAdvanceMode`（第 82 行）——记录本次启动**实际请求**的模式，而不是 `config.modeId` 的副本。
- `LiveLaunchState` 新增必填 `mode: ScoreAdvanceMode`（第 90 行）——由调用方在响应到达后读取当前界面选择。
- `evaluatePlanCurrency` 在 score 检查之后、contextKey 之前新增独立判定（第 116–118 行），取消码 `STALE_MODE`。
- `planContextKey` 的输入保持不变，并补充注释说明：启动模式是 token 的一等字段，故意不并入 contextKey，以便区分取消原因（否则只会得到泛化的 `STALE_CONTEXT`）。

**`src/App.tsx`**

- `startRustPractice` 的 token 绑定 `mode`（第 1002 行）——即决定请求与 accept 分支的实际启动模式参数。
- `live()` 返回 `mode: currentConfig.advanceMode`（第 1058 行）——响应到达后从 `configRef.current` 读取当前选择，而不是闭包快照。

两个字段在类型中均为必填，任何启动路径漏传都会直接编译失败（fail-closed）。`accept()` 仍然只会在货币性通过后执行，因此 `session.begin` / `FollowSession` 均不可达。

取消行为与既有 `STALE_CONTEXT` 一致：在最新世代上可见报错并终止，不启动任何会话；若已被更新的启动取代，则静默让位。

## 回归测试（`r2-3h-r1-launch.test.ts`，新增 3 项 + 既有断言更新）

| 编号 | 场景 | 断言 |
|---|---|---|
| 5c | Timeline 请求在途，用户切到 Follow | 返回 `cancelled(STALE_MODE)`；`beginSession` 与 `startFollow` 均**未调用** |
| 5d | Follow 请求在途，用户切到 Timeline | 返回 `cancelled(STALE_MODE)`；`FollowSession` 与 `beginSession` 均**未调用** |
| 5e | generation / 曲谱 / contextKey 完全相同，仅模式不同 | `evaluatePlanCurrency` 返回 `STALE_MODE`（证明 contextKey 单独无法捕获） |
| 既有 currency 用例 | 逐原因判定 | 增加 `mode: 'follow'` → `STALE_MODE` |
| 既有 6 | 正常响应 | Timeline 与 Follow 各自在模式一致时仍正常启动（Follow 用例显式使用 `mode:'follow'`） |

5c/5d 使用 `capturedMode()` 模拟 `App.startRustPractice` 的 union 类型 `mode` 参数，使 accept 分支与真实闭包一致；延迟 promise 由测试控制，切模式发生在 `resolve()` 之前。

**变异验证：** 临时禁用 `live.mode !== token.mode` 判定后，5c、5d、5e 与 currency 逐原因用例共 4 项失败（`expected 'started' to be 'cancelled'`）；恢复后 15/15 通过。说明新增测试确实覆盖该缺陷，而不是对实现文本的断言。

## 运行结果（verifiedCodeSha = `3aa5e57`；本地执行，非 CI）

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | 通过，exit=0 |
| `npx vitest run`（全量） | **497 passed / 4 skipped**（48 个文件通过 / 2 跳过），exit=0；R2-3h-R1 基线 494 + 3 新增 |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed**（crate 汇总），exit=0 |
| `node server/selftest.mjs` | **251/251** |

Rust 侧本轮无代码改动，重新执行用于确认未受影响；构建使用仓库既定的 w64devkit GNU 工具链（本机无 MSVC）。

## 边界与未覆盖

- **无独立 CI 验证**：仓库无 workflow，以上为提交者本地结果；GitHub 上没有该提交的 status checks。
- **无浏览器 E2E**：回归测试驱动真实的 `launch-flow` 助手并注入 spy / 延迟 promise，断言副作用（是否构建会话），未在真实浏览器 UI 中自动化模式切换。
- 生产默认规划权威仍为 `rts`；本报告不授权切换默认值，也不授权合并 `main`。
- 冻结契约、golden、case index、schema、wire、`build_schedule`、matcher、`scoring_v1` 均未改动；R2-3c/R2-3d 归档证据未重写。
- 报告由实施者生成本地验证，不替代独立复审；独立复审仍需针对 `3aa5e57` 复核实际启动模式绑定与 5c/5d 的负断言。
