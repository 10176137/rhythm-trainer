# R2-3g-R1 验证报告（ESM 导入 + 服务端语义校验 + follow 交叉引用守卫）

**verifiedCodeSha：** `0301c52c76e9a6498333bdcd372e8cf6f87834aa`（`0301c52`）
**报告提交：** 单独提交（与被测 SHA 分开，审计纪律）。
**修复基线：** R2-3g 实现提交 `51a7ccf` 上的独立审查三项发现。

## 修复对照

| 发现 | 修复 | 位置 |
|---|---|---|
| 1. ESM 导入（`__dirname` 不存在） | `fileURLToPath(import.meta.url)` 推导模块目录；**原生 Node 导入验证**（`node --input-type=module`，非仅 Vitest loader） | `planner-service.mjs:6-12`；测试 11 |
| 2. 时间线语义校验只在测试里 | `verifyTimelineSemantics` 进入**服务执行路径**（`buildRustPlan` 步骤 1b，响应组装前）：runtimeOccurrenceId↔occurrence 双射、`targetOnsetUs === countInUs + beatToMicroseconds(playbackBeat, bpm)`、`targetDurationUs === beatToMicroseconds(durationBeat, bpm)`、group↔atom 的 startTick/durationTicks 对 PPQ 网格精确对应、无重复/缺失/dangling。**用生成时的同一份可信 config 与真实 NAPI 原语**。atom 层在 `atomIssueCodes` 非空时跳过（tick_grid_rounding 是 planner 诚实状态，由 atom-issue 守卫拒绝，验证器不重复诊断）。失败 → `TIMELINE_SEMANTICS_REJECTED`，不取整不补齐 | `planner-service.mjs` verifyTimelineSemantics + buildRustPan 1b |
| 3. follow 交叉引用守卫缺失 | `verifyFollowCrossReferences` 进入服务路径：组内重复引用、dangling occurrence、scoreEventId 不匹配、locator 不匹配、occurrence 被遗漏（unreferenced）或重复引用（multi-referenced）全部拒绝 → `FOLLOW_CROSSREF_REJECTED`；atoms/scoreEvents 仍在 follow 门外 | 同上 |

## 测试结果（verifiedCodeSha = `0301c52` 上执行；本地运行，非 CI）

| 命令 | 结果 |
|---|---|
| `node --input-type=module -e "import('./server/planner-service.mjs')…"`（原生 ESM） | 成功（两次：开发期 + 固定 SHA 复验） |
| `npx vitest run server/planner-service.test.mjs` | **18 passed / 0 failed** |
| `npx vitest run`（全量） | **454 passed / 4 skipped**，exit=0 |
| `cargo test --locked --target x86_64-pc-windows-gnu` | **173 passed / 0 failed**，exit=0 |
| `node server/selftest.mjs` | **251/251** |

测试基线全部来自**真实 Rust 链路**生成的计划（无 plan mock）：篡改均施加于副本——onset/duration ±1µs、atom tick 偏移、runtimeOccurrenceId 重复/删除、组内重复引用（双成员组 A4-multivoice）、dangling id、scoreEventId/locator 替换、occurrence 从所有组移除；另有"篡改计划注入 `buildPlanV1` 返回处 → 链路内部拒绝且门禁不可达"的服务路径证明（测试 17）。既有行为（rts 默认/禁用不回退/多 Part/版本验证/冻结套件）在测试 18 + 全量回归中保持。

## 未验证项

无新增。既有边界不变：真实谱端到端依赖本地 gitignored fixture（GitHub 不可复跑，边界照旧）；浏览器接入属下一阶段。
