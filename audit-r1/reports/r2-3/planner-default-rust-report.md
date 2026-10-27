# 计划权威生产默认切换：rts → rust

- 分支：`feat/teaching-experience-v1`
- 日期：2026-10-27
- 性质：**用户直接授权的切换**（「你把rts改成rust启动」）。R2-3j 正式切换就绪评审此前未做，本报告如实记录这一点。
- 回滚方式：`RHYTHM_PLANNER=rts` 环境变量即可回到 TS 投影权威，无需回滚代码。

## 1. 变更

| 文件 | 变更 |
|---|---|
| `server/planner-service.mjs` | `resolvePlannerAuthority()` 兜底默认 `'rts'` → `'rust'`；注释更新（`RHYTHM_PLANNER=rts` 回滚） |
| `server/engine-server.mjs` | 启动注释同步（权威仍是启动时一次性解析、fail-closed、单一事实来源） |
| `server/planner-service.test.mjs` | 测试 9/11/18 断言默认权威为 `rust`；`PLANNER_PATH_DISABLED` 用例改为显式 `authority:'rts'` 验证回滚路径仍拒绝 rust 链 |
| `server/selftest.mjs` | selftest 显式以 `RHYTHM_PLANNER=rts` 起引擎（说明：时间线自检走 WS start + 内联 atoms 的 rts 投影路径；rust 权威完整链路由 plan-protocol/follow-protocol 测试覆盖） |

客户端**零改动**（设计使然）：浏览器没有第二开关，`decideAuthority` 从服务端 `planner-status` 取权威后自动走 rust 路由（plan-request → `start(planRequestId)` / `follow-start(planRequestId)`）；权威未知/断连仍然 fail-closed（R2-3h-R1 行为不变）。follow-start 的 `client-plan-projection` 分支仅在客户端路由为 rts 时才被使用，与全局默认解耦。

## 2. fail-closed 语义保持不变

- 权威值非法 → 引擎启动即失败（`INVALID_PLANNER_AUTHORITY`）。
- rust 权威下 `start` 缺 `planRequestId` / 计划过期 / 指纹或 planRunId 不一致 → 拒绝启动，绝不回落 TS。
- 计划失败 → 编码错误，绝不伪装成空计划。
- 权威未知（断连/查询失败）→ 浏览器拦截启动（`blocked`），不默认任何权威。

## 3. 验证（本地，仓库无 CI）

| 验证 | 结果 |
|---|---|
| `npx vitest run` | **577 pass / 4 skipped**（含 planner-service 24、plan-protocol 11（rust 权威真链路）、follow-protocol 5（rust 权威真链路）、launch-flow 权威路由 12） |
| `npm run selftest` | 251 项全部通过（显式 rts 投影路径） |
| `npx tsc -b` / `npm run build` | 通过 |
| **浏览器真实启动（mock MIDI）** | 正常曲目演奏（loop 1–4）启动 → Take `take-60e3dc50…`：**planAuthority=`server-rust`、plannerVersion=`rust-planner-1`、planFingerprint=`plan-v1:sha256:087be689…`、persisted** —— 与切换前同谱同径的 `client-rts-projection` Take 形成直接对照 |
| 引擎日志 | 启动打印 `planner authority = rust` |

## 4. 边界与如实说明

- **R2-3j 切换就绪评审未做**：按既定流程，切换默认权威前应完成该评审。本次为用户直接指令的切换，评审缺口由本报告记录而非掩盖；R2-3d §8 七证据、R2-3h 浏览器验收（rust Timeline/Follow、AUTHORITY_UNKNOWN 阻断、无兜底）此前均已 PASS，是本次切换的直接依据。
- 浏览器 Follow 的 rust 启动本轮未单独复测（设置面板切换未生效，时间因素）；其链路覆盖：follow-protocol 5 项以 `RHYTHM_PLANNER=rust` 真实 NAPI 跑通 + R2-3h-R2 浏览器验收（B 项 rust Follow）+ 客户端路由与 Timeline 共用同一 `plan-request` 入口。
- 物理 MIDI 未验证（一贯边界）。
- 历史 Take 不受影响：旧记录的 `client-rts-projection` 等来源字段如实保留。

## 5. 回滚

```bash
# 不回滚代码，仅回滚权威：
set RHYTHM_PLANNER=rts && node server/engine-server.mjs
```

行为恢复到切换前（客户端自动回到 rts 投影路由，无需其它改动）。
