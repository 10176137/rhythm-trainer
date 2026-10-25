# R2-3h 验证报告（真实调用链接入 Timeline + Follow）

**verifiedCodeSha：** `8589ac1cc829255f457a4c3c3058588bd361b266`（`8589ac1`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**基线：** `ecf7df0865a86e40c2ffd83260df18f03743f4e3`（R2-3g-R1-F1）。

## 变更文件与关键调用链

| 文件 | 作用 |
|---|---|
| `server/engine-server.mjs` | 启动时一次解析规划权威（默认 `rts`，非法值启动失败）；新增 WS `planner-status` 与 `plan-request` 分派 → `planner-service.buildRustPlan`；失败返回 coded `plan-response`，绝不包装成空计划 |
| `server/planner-service.mjs` | NAPI 错误归一化（把 `"CODE: detail"` 转成 `error.code`，此前会泄漏 napi 的 `InvalidArg`） |
| `src/score-engine/plan/rust-plan.ts`（新） | 纯投影：PlannerOutput → PlaybackOccurrence/PlaybackGroup/EngineAtom/EngineScoreEvent（`n/d` 解析、locator 映射、`kind:'note'` 常量、**唯一一次** `us/1000`、range span 由 document 重建）；模式化启动门禁；纯函数 `bindPlanResponse`（requestId/指纹/陈旧响应） |
| `src/services/engineBridge.ts` | `requestPlan` / `requestPlannerStatus`：唯一 requestId、15s 超时、陈旧/未知响应丢弃、指纹不符拒绝、断连拒绝全部在途请求 |
| `src/features/practice/usePracticeSession.ts` | 暴露 `getPlannerStatus` / `requestPlannerPlan`（复用同一 WS 连接） |
| `src/App.tsx` | authority 从服务端查询一次（浏览器无第二开关）；follow 走 `mode:'follow'`（不调 `session.begin`、不发 atoms/scoreEvents）；timeline 走 `mode:'timeline'` 并用 Rust atoms/scoreEvents 启动；两者失败即中止并提示，**无 TS 重规划/回退**；reference 播放只用 `hand:'both'`（文档化的 no-op 过滤）做呈现派生 |
| `src/types/engine.ts` | 消息联合补充 `planner-status` / `plan-request` / `plan-response`（增量） |
| `src/score-engine/parity/r2-3d-evidence.test.ts` | 修正既有 `tsc` 类型缺口（native 类型缺两个方法声明），非语义变更 |

调用链：`App.launchPractice` → 服务端 scope 门禁 → authority==='rust' 时 `startRustPractice` → `projectScoreDocumentV1(engineDoc, report)` → WS `plan-request{mode,document,report,config}` → 服务端 `buildRustPlan`（文档/绑定/规划 → 模式化深度验证 → 冻结指纹门禁）→ `plan-response` → 客户端绑定校验 → 模式化门禁 → 解析投影 → `session.begin`（timeline，Rust atoms/scoreEvents）或 `FollowSession`（follow）。

## 测试（+22）

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `src/score-engine/plan/rust-plan.test.ts` | 11 | 真实 Rust 计划的逐字段投影、无 chordGroupId 伪造、group pitch 经 occurrence 还原、atom `kind` 常量、**单次 us/1000**、双模式门禁、篡改 scoreEvents/atoms 在 timeline 拒绝而 follow 放行、畸形有理数拒绝、绑定 accept/drop（陈旧、无 id）/reject（指纹不符、服务端码） |
| `server/plan-protocol.test.mjs` | 7 | **真实拉起 engine-server（RHYTHM_PLANNER=rust）**、真实 WS：authority 状态、timeline+follow 成功（requestId 回显、指纹、1579 级真实计划尺寸断言用 G1 的 5/5/5/5）、非法 mode、伪造 plannerVersion、异谱 report（`DOCUMENT_REPORT_MISMATCH`）、非法文档（`DOCUMENT_VALIDATION_FAILED`）、缺 requestId、`/api/health` 不受影响 |
| `src/score-engine/plan/r2-3h-wiring.test.ts` | 4 | rust 分支源码不含 `buildPlaybackPlan`/`scoreOccurrencesToEngineAtoms`/`buildEngineScoreEvents`/`filterPlaybackPlanByHand`；两处启动点均由 `plannerAuthorityRef.current === 'rust'` 把关且 App 不读 `RHYTHM_PLANNER`；free play 不请求计划；rts 路径仍走 TS |

## 运行结果（verifiedCodeSha = `8589ac1`；本地运行，非 CI）

| 命令 | 结果 |
|---|---|
| `npx tsc -b --noEmit`（cwd rhythm-trainer-frontend） | 通过 |
| `npx vitest run`（全量） | **482 passed / 4 skipped**，exit=0 |
| `cargo test --locked --target x86_64-pc-windows-gnu` | **173 passed / 0 failed**，exit=0 |
| `node server/selftest.mjs` | **251/251** |

`vitest` 新增 22 项（11+7+4），全量由 460 → 482。

## 未覆盖 / 边界

- **无浏览器 E2E（Playwright）**：Timeline/Follow 的界面级启动未在真实浏览器中自动化；本次证明的是服务端协议 + 客户端模块 + 源码结构约束，UI 交互仍依赖既有手工验证。
- **真实谱经浏览器路径未跑**：真实谱（gitignored 本地 fixture）只在服务端 planner/e2e 测试中执行，浏览器侧未跑。
- **Rust 生产默认仍关闭**：`RHYTHM_PLANNER` 默认 `rts`；本任务不切换、不合并 `main`。
- 冻结 Gate/golden/case index/schema/wire/`build_schedule`/matcher/`scoring_v1` 未改动；R2-3c/R2-3d 归档报告未被覆盖（运行后已恢复）。
- 无 CI：仓库无 workflow，GitHub 上此提交无 status checks；以上均为提交者本地执行结果。
