# R2-3i 报告：Timeline Take 的规划器来源持久化（GAP-3）

**verifiedCodeSha：** `87f4a8ac9821326a78e0bf44979b1db7190da77e`（`87f4a8a`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**基线：** `d3242b4`（R2-3h-R2 + F1/F1b 显示修复）。
**范围：** 只补规划器来源追溯；不切换生产默认值，不合并 `main`，不改冻结契约。

## 1. 问题

Timeline Take 原先只持久化 `scoreFingerprint` 与 `playbackPlanId`。UI 能显示 Rust 响应的 `plannerVersion` / `planFingerprint`，但 Session JSON 不保存它们，因此一份已保存记录无法独立证明它由 `rts` 还是 `rust` 产生（R2-3e GAP-3）。Follow 不调用 `session.begin()`，其结果本来就不落盘，本任务**没有**把 Follow 伪装成 Timeline 严格 Take。

## 2. 字段与数据流

新增三个协议/持久化字段：

| 字段 | Rust Timeline | rts Timeline |
|---|---|---|
| `plannerAuthority` | `"rust"`（来自 plan-response） | `"rts"` |
| `plannerVersion` | `"rust-planner-1"` | `"playback-planner-1.0.0"` |
| `planFingerprint` | `plan-v1:sha256:…` | 不适用，保持 null |
| `playbackPlanId` | 计划运行 ID（已有字段） | 语义计划存在时写入 |

数据流：

1. `App.startRustPractice` 的 timeline accept 从 **Rust plan-response** 取 `plannerAuthority` / `plannerVersion` / `planFingerprint`，与 `plan.runtimeIds.planId`（`playbackPlanId`）一起传入 `session.begin`。
2. `usePracticeSession` / `EngineBridge.start` 把字段放进 WS `start`。
3. 服务端校验形状；`plannerAuthority="rust"` 时强制要求 `scoreFingerprint`、`plannerVersion`、合法 `planFingerprint`、`playbackPlanId`，否则拒绝启动（不写半标识记录）。
4. 字段写入 `take_started` journal、`meta`、Session JSON、`report` 帧。
5. `/api/sessions` 列表与 `/api/sessions/:id` 详情返回这些字段；历史页显示 `Rust 计划` / `RTS 计划` 徽标，展开后显示版本、计划指纹、运行 ID。

`playbackPlanId` 即计划运行 ID，不另造重复字段。rts 路径没有 `planFingerprint`（冻结指纹门禁只覆盖 Rust 计划），保持 null，不伪造。

## 3. 真实浏览器闭环（单场景，非 A–D 重跑）

临时以 `RHYTHM_PLANNER=rust` 启动服务，在真实浏览器中打开《晓之车》第 17–17 小节、右手、Timeline，启动并结束（未输入），得到 Session `s-1792950402182-1`。

Session JSON：

```
plannerAuthority: "rust"
plannerVersion: "rust-planner-1"
planFingerprint: "plan-v1:sha256:01d1850c755eeb42c7bf90a1818f8080b485c6c85f4babb2694222bc7d6aa2d9"
playbackPlanId: "plan:2654f28396448762:m17-17:once:playback-planner-1.0.0:hand=right"
scoreFingerprint: "2654f28396448762febc969e69765cf4f928ea4b4b7f1dd4f02321a5bf65b935"
report.state: "completed"
```

同一记录：

- `take_started` journal 第 2 行包含相同的四个来源字段；
- `GET /api/sessions/s-1792950402182-1` 返回相同值；
- `GET /api/sessions` 列表项包含相同值；
- 历史页显示 `Rust 计划` 徽标，展开详情显示：`规划器：rust · rust-planner-1 · 计划指纹 plan-v1:sha256:01d1850… · 运行 ID plan:2654f283…m17-17…`。

这是针对新持久化能力的单场景运行，不是 R2-3h-R2 A–D 的重复验收。

## 4. 自动化测试

`server/plan-protocol.test.mjs` 新增两项，使用真实 engine-server + 真实 Rust NAPI：

1. **完整闭环**：`plan-request`（timeline）→ 使用该 `plan-response` 的 atoms/scoreEvents → `start`（带三个来源字段）→ `finish` → 断言 report 帧、磁盘 Session JSON、`/api/sessions` 列表、`/api/sessions/:id` 详情四处字段一致。
2. **旧记录兼容**：复制一份有效 Session、删除来源字段后写入磁盘；详情 API 不返回这些键，列表 API 返回 `null`；页面类型为可选字段，不显示徽标/来源行，不伪造 `rts`/`rust`。

`src/score-engine/plan/r2-3h-wiring.test.ts` 新增结构守卫：Rust timeline 的 `session.begin` 必须携带 `plannerAuthority: response.plannerAuthority`、`plannerVersion: response.plannerVersion`、`planFingerprint: response.planFingerprint`。

## 5. 运行结果

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run`（全量） | **503 passed / 4 skipped**（48 文件通过 / 2 跳过） |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed** |
| `npm run selftest` | **251/251** |

## 6. 可信度边界

- 来源字段由客户端从服务端 plan-response 转发，服务端只做**形状/完整性校验**，不在 `start` 时重新计算 `planFingerprint`（start 请求没有 document/config）。因此它是可审计的**来源声明**，不是密码学校验；真正的计划指纹门禁仍在 plan-request 路径（服务端 planner-service + 冻结 Gate）。
- Follow 仍不调用 `session.begin()`，结果不落盘；本任务没有改变 Follow 语义。
- 旧记录保持可读；新字段缺失时 API 返回 null/缺省，UI 不显示来源，不推断。
- 无 CI、无实体 MIDI、无自动化浏览器 E2E；以上为本地真实浏览器 + 本地测试。
- 生产默认仍为 `rts`；未合并 `main`，未授权切换。
- 未修改冻结的 `EngineScoreEvent`、评分核心、golden、Gate、schema、wire protocol、`build_schedule`、matcher 或 `scoring_v1`；R2-3c/R2-3d 证据 JSON 未提交。

## 7. 下一步（按用户计划）

R2-3j：基于当前真实服务端路由、R2-3h-R2 验收、F1/F1b 显示修复和本报告的持久化证据，更新切换就绪评审。只有该评审明确 GO 且用户单独授权后，才讨论把默认规划器从 `rts` 改为 `rust`。
