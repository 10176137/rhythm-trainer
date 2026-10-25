# R2-3h-R1 验证报告（权威未知 fail-closed + 过期计划取消）

**verifiedCodeSha：** `86b450e4d6861720f9aed5d18ba37ec5167760b9`（`86b450e`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**修复基线：** `8589ac1cc829255f457a4c3c3058588bd361b266`（R2-3h），复审结论 `NEEDS REVISION`。

## F1 — 权威未知不得静默走 TS

修复：新增 `src/score-engine/plan/launch-flow.ts` 的 `decideAuthority(cached)`，返回 `blocked | rts | rust`；`null`（初次查询未返回、查询失败、WebSocket 断连）一律 `blocked`（`AUTHORITY_UNKNOWN`）。

- App 两处启动点（Follow `App.tsx` follow 分支、Timeline 时间线分支）在进入任何分支**之前**调用它：`blocked` → 主动 `refreshPlannerAuthority()` + 可见错误 + 终止启动，**TS planner 在该路径不可达**；仅 `rts` 才继续既有 TS 路径。
- 并发/断连：`plannerAuthoritySeqRef` 单调世代使较慢的旧查询无法覆盖新结果；`usePracticeSession` 新增 `onEngineDisconnected` 回调，App 在断连时清空缓存并递增世代（作废在途查询）。
- 不新增浏览器端 env 开关；`App.tsx` 中无 `RHYTHM_PLANNER` 读取（wiring 测试断言）。

## F2 — 过期计划不得启动

修复：`startRustPractice` 在请求发出时记录 **launch token**（`generation` + `planContextKey`（hand/tempo/mode/loop/loopStartBar/loopEndBar/range/handMapping）+ score fingerprint），并通过 `orchestrateRustLaunch` 编排：请求 → **用 refs 读取当前 App 状态**做货币性判定 → 才进入模式门禁/解析/启动。

| 取消码 | 触发条件 |
|---|---|
| `STALE_SUPERSEDED` | 出现新的启动流程（generation 变化） |
| `STALE_SCORE` | 曲谱切换或选择被清空（`scoreDocRef.current.engine.fingerprint` 变化/null） |
| `STALE_CONTEXT` | tempo/hand/mode/loop/range/handMapping 任一变化 |
| `AUTHORITY_LOST` | 权威在中途失效或无法确认 |

`accept()`（内含 `session.begin` / `FollowSession` 构建）仅在货币性通过后才执行；被取代的启动静默退出（由新启动掌控 UI），其余在当前世代上可见报错并终止。

## 回归测试（新增 12 项，全部断言副作用而非源码字符串）

`src/score-engine/plan/r2-3h-r1-launch.test.ts`：

1. status 仍在等待时启动 → `blocked`，**TS planner 与 session 均未被调用**；
2. 查询失败 → 缓存清空 → `blocked`（不静默切换权威）；
3. 明确 `rts` → TS 路径可用；3b. 非法状态值（`'legacy'`/空串/null/7/对象）一律 `blocked`；
4. 等待期间切谱（指纹变化/null）→ 延迟返回的旧计划 `cancelled(STALE_SCORE)`，`beginSession` 未调用；4b. follow 模式下 `FollowSession` 未构建；
5. 等待期间配置/范围变化 → `STALE_CONTEXT`；新启动取代 → `STALE_SUPERSEDED`；均未调用 accept；
5b. 权威中途失效 → `AUTHORITY_LOST`，accept 未调用；
6. 正常响应仍成功启动（timeline/follow 两条 accept）；6b/6c. 请求失败与模式门禁失败 → `failed` + 冻结码，accept 未调用；
6d. `evaluatePlanCurrency` 逐原因判定。

既有 7 类之外的 compat：`r2-3h-wiring.test.ts` 更新为 `decideAuthority` 门禁断言（两处启动点、无 env 读取、free play 独立、rts 仍走 TS）。

## 运行结果（verifiedCodeSha = `86b450e`；本地执行，非 CI）

| 命令 | 结果 |
|---|---|
| `npx tsc -b --noEmit` | 通过 |
| `npx vitest run`（全量） | **494 passed / 4 skipped**，exit=0（R2-3h 基线 482 + 12 新增） |
| `cargo test --locked --target x86_64-pc-windows-gnu` | **173 passed / 0 failed**，exit=0 |
| `node server/selftest.mjs` | **251/251** |

## 边界与未覆盖

- 无浏览器 E2E（Playwright）：F1/F2 的行为通过对真实 launch-flow 助手注入 spy/延迟 promise 断言（含 `beginSession`/`FollowSession`/TS planner 调用的负断言），未在真实浏览器 UI 中自动化。
- 真实谱未经浏览器路径执行；Rust 生产默认仍为 `rts`；无 CI status checks（仓库无 workflow），以上均为提交者本地结果。
- 冻结 Gate/golden/case index/schema/wire/`build_schedule`/matcher/`scoring_v1` 未改动；R2-3c/R2-3d 归档报告未被覆盖。
