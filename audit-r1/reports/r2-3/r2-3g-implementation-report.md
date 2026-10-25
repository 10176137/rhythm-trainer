# R2-3g 实施报告（第一阶段：Rust 权威计划生成链路）

**被测代码 SHA（verifiedCodeSha）：** `51a7ccfc9685588eafbb3ca7fcafa66d226fb99e`（`51a7ccf`）
**报告提交：** 单独提交（见本文件所在提交的 SHA；按审计纪律与被测 SHA 分开）。
**执行架构：** R2-3f ADR 方案 A（服务端 Node + Rust NAPI 单一权威）。

## 实际改动

| 文件 | 变更 | 理由 |
|---|---|---|
| `rhythm-trainer-frontend/server/planner-service.mjs` | 新增 | 五步生成链（请求校验 → 可信 plannerVersion → `buildPlanV1` → `planFingerprintV1Gate`（同输入恰一次）→ 响应组装）+ `assertTimelineUsable`/`assertFollowUsable` 会话守卫 + `RHYTHM_PLANNER` 开关语义（默认 `rts`，未知值 fail-closed）+ `MULTI_PART_PLANNER_UNSUPPORTED` 拒绝 + plannerVersion 允许列表 + GAP-5 `usToMs` |
| `rhythm-trainer-frontend/server/planner-service.test.mjs` | 新增 | 10 项真实 NAPI 验收（无 plan mock） |
| `rhythm-trainer-core-v0.2/bindings/node/src/lib.rs` / `index.d.ts` | 追加 `beatToMicrosecondsJson` | scoreEvents↔groups 时间一致性校验原语（冻结 time-conversion-v1） |
| `audit-r1/docs/R2-3F-PLANNER-EXECUTION-ARCHITECTURE-ADR.md` | 追加 §11 | 随实现补充的实际代码约束（任务卡四允许） |

## 运行命令与结果（verifiedCodeSha = `51a7ccf` 上执行）

| 命令 | 结果 |
|---|---|
| `npx vitest run server/planner-service.test.mjs`（cwd rhythm-trainer-frontend） | **10 passed / 0 failed** |
| `npx vitest run`（全量） | **446 passed / 4 skipped**，exit=0 |
| `cargo test --locked --target x86_64-pc-windows-gnu`（GNU 工具链 env） | **173 passed / 0 failed**，exit=0 |
| `node server/selftest.mjs` | **251/251**（addon 重建后生产零回归） |

独立验证边界：以上为提交者本地执行结果（日志按 `*.log` 约定不入库）；GitHub 无 CI runs/status checks，复审方未独立重跑——不表述为 GitHub 已验证。

## 通过项（对照任务卡 §三）

1. ✅ 正常请求调真实 Rust NAPI：计划 + 指纹（两次稳定）+ 整数 µs 时间线经 `beatToMicrosecondsJson` 逐事件精确校验；
2. ✅ `scopeCodes=['hand_mapping_incomplete']` 且 `missingEventIds=[]`（staff-2 rest 场景）→ timeline 守卫拒绝；
3. ✅ `atomIssueCodes=['tick_grid_rounding']` 且 `planStrictAllowed=true` → timeline 拒绝（该组 atom 缺失不补齐）；
4. ✅ 同一响应 follow 守卫**通过**（不消费 atoms/scoreEvents），而 follow 自身依赖缺失（部分 hand mapping → `missingEventIds`）时拒绝；
5. ✅ 多 Part + `hand=both` → `MULTI_PART_PLANNER_UNSUPPORTED` 显式拒绝，无计划产出；
6. ✅ 伪造 `plannerVersion='client-forged-42'` → `INVALID_PLANNER_VERSION` 拒绝，服务端不回显；
7. ✅ 生成与门禁同版本同输入（独立重放链指纹 === service 指纹）；
8. ✅ Rust 失败/禁用路径为 coded 拒绝（`INVALID_REQUEST`/`PLANNER_PATH_DISABLED`），结构上无 TS 回退（模块零 TS planner 依赖）；
9. ✅ 默认 authority=`rts`、未知值 `INVALID_PLANNER_AUTHORITY`；engine-server 未修改（TS 默认路径/Free Play 行为不变）；冻结资产与全量既有测试零变化。
10. ✅（追加）真实谱端到端（本地 gitignored fixture，sha256 已在 R2-3d 归档）：1579/1018/1018/1579 计数命中、指纹稳定、timeline 守卫通过——**本地执行，非 CI 可复跑**（边界照旧标注）。

## 失败项与未验证项

- 失败项：无。
- 未验证/边界：真实谱测试依赖本地 gitignored 第三方 fixture（GitHub 复审方不可复跑）；浏览器端接入（App.tsx 消费下发计划）属下一阶段任务卡，本阶段未接 UI——`session.begin` 实际切换不在本阶段。
