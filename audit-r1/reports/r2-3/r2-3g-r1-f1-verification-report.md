# R2-3g-R1-F1 验证报告（mode-scoped 验证边界修正）

**verifiedCodeSha：** `1af479c3071539161630e3cc3f67b15f47219f24`（`1af479c`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**修复基线：** `0301c52`（R1）上的单一阻断项。

## 阻断项与修复

**阻断项：** `buildRustPlan()` 无条件执行 `verifyTimelineSemantics()` + `verifyFollowCrossReferences()`。前者校验 `scoreEvents` 数量/ID/起音/时值——即使 follow 不消费这些字段，异常也会让 follow 计划被拒绝，违反 follow 只依赖 groups/occurrences 的边界。

**修复（逐条对应 F1 要求）：**

| 要求 | 实现 |
|---|---|
| 1. 入口区分 timeline/follow，不得推测或静默默认 | `buildRustPlan({…, mode})`：`mode` **必填**，仅接受 `'timeline' \| 'follow'`；缺失/未知 → `INVALID_REQUEST`（含明确 message）。 |
| 2. timeline 执行 `verifyTimelineSemantics` + 严格门禁 | `mode==='timeline'` → 时间线语义验证器（scoreEvents 双射/µs 精确/atom tick 精确对应）；`assertTimelineUsable` 守卫保持不变。 |
| 3. follow 只执行 `verifyFollowCrossReferences` + 自身必需检查 | `mode==='follow'` → 仅交叉引用验证器；`assertFollowUsable`（strict/scope/missing/groups 引用/指纹）不变。未消费字段异常**不再拒绝** follow。 |
| 4. 两模式均保留请求校验/可信版本/冻结指纹门禁/无 TS 回退 | 三者位于模式分支之前/之后共享路径，未改动。 |
| 5. 语义校验使用与生成相同的配置与**对应注入模块** | `verifyTimelineSemantics(plan, config, nativeModule = native)`；链路传入自身 `nativeModule`。测试 23 用"返回值错误的注入原语"证明不再使用模块级全局。 |

## 测试（18 → 24；真实 Rust 基线，无 plan mock）

| # | 覆盖 |
|---|---|
| 19 | mode 必填：缺失 / `'both'` / `undefined` 均 `INVALID_REQUEST` |
| 20 | **timeline**：篡改 `scoreEvents[0].targetOnsetUs`(+1µs)、`[1].targetDurationUs`(+1µs)（groups/occurrences 保持合法）→ 服务路径 `TIMELINE_SEMANTICS_REJECTED` |
| 21 | **follow**：同一批被篡改的 scoreEvents、`scoreEvents=[]`、`atoms=[]` → 计划**被放行**（返回合法 planFingerprint） |
| 22 | **follow**：dangling occurrence / scoreEventId 替换 / locator 篡改 → 仍 `FOLLOW_CROSSREF_REJECTED` |
| 23 | 注入"说谎"的 `beatToMicrosecondsJson` → timeline 拒绝；注入真实模块 → 通过（验证使用注入模块） |
| 24 | `tick_grid_rounding` 保留：timeline 由 atom-issue 严格守卫阻断（链路本身不拒绝），follow 不受影响 |
| 1–18 | 既有：原生 ESM 导入、真实计划/指纹、scope 阻断、多 Part、伪造版本、生成==门禁、禁用不回退、rts 默认、真实谱端到端、R1 各篡改负例 |

## 运行结果（verifiedCodeSha = `1af479c`；本地运行，非 CI）

| 命令 | 结果 |
|---|---|
| `node --input-type=module -e "import('./server/planner-service.mjs')…"` | 成功（开发期 + 固定 SHA 复验） |
| `npx vitest run server/planner-service.test.mjs` | **24 passed / 0 failed** |
| `npx vitest run`（全量） | **460 passed / 4 skipped**，exit=0 |
| `cargo test --locked --target x86_64-pc-windows-gnu` | **173 passed / 0 failed**，exit=0 |
| `node server/selftest.mjs` | **251/251** |

## 边界

仅修改 `server/planner-service.mjs` 与 `server/planner-service.test.mjs`；未触碰冻结 Gate/golden/case index/schema/协议/评分核心；rust 生产路径默认关闭；未合并 `main`。未验证项：无新增（真实谱测试依赖本地 gitignored fixture 的既有边界不变；浏览器接入仍属下一阶段）。
