# Stage 8 评审包：算法完善与工程化（V1.1 计划）

- 日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 生产默认：**未切换**（仍为 `RHYTHM_PLANNER=rts`）；`main` 未改动、未合并。
- 性质：本地验证，无 CI；所有结论均在仓库可获得的合成/mock 证据范围内。

## 1. 基线与环境

- 分支起点 `02083ee`；`origin/main` 保持 `ba6d3c4`。
- Stage 0 基线报告：`audit-r1/reports/r2-3/algorithm-upgrade-baseline.md`（`046ad6a`）。
- 环境：macOS 27.2 arm64、Node 26.12.0、npm 10.8.3、Rust 1.99.1、addon 由当前源码构建。
- 基线测试：tsc 通过；Vitest 510/516（1 个 E5 环境阻塞 + 5 个真实谱门禁 skip）；Rust 177 通过；selftest 251。

## 2. 已修复缺陷（Stage 1）

| 缺陷 | 修复 | 提交 | 证据 |
|---|---|---|---|
| Follow 保存失败丢草稿/谎报已保存 | 共享冻结草稿 + 原子写 + `persist-retry` + UI 如实提示/重试 | `21e1d50` / `586d1a9` | `take-finalization.test.mjs`、`take-persistence.test.mjs`、`FollowReportPanel`/`App` |
| Node 权威修改 Follow 目标语义 | 去重/顺序/音高校验迁入 Rust `normalize_follow_groups`，返回被去重成员证据 | `21e1d50` | Rust 单测、`follow-protocol.test.mjs` |
| Timeline/Follow 结算基础设施分裂 | 共用 `TakeFinalizationService`，报告构建器仍分离 | `21e1d50` | finalization/persistence 测试 |
| 只有单个 `trustworthy` | 新增正交状态（attempt/input/authority/integrity/score/persistence），旧 Take 只读投影 | `21e1d50` | `take-status.test.mjs`、协议断言 |

Gate 1 报告：`stage1-reliability-gate-report.md`（`4122f3b`）。

## 3. 单一 Plan Bundle（Stage 2）

- 内部 additive `PracticePlanBundleV1`：occurrences/groups/atoms/scoreEvents + 精确 µs + countInUs + 完整性报告。
- 构建来源：真实 Rust NAPI 计划与 rts 投影；启动前 fail-closed 校验。
- 校验覆盖：occurrence↔group↔scoreEvent 1:1、atom↔group 时间/时长、组时长=最长成员、targetOnsetUs 公式、fingerprint 重算/匹配、config/repeat/count-in。
- 启动接线：Timeline 的 atoms/scoreEvents 只从 bundle 取；Follow 使用同门禁但不要求 strict atoms。
- count-in 统一为 `3_000_000 µs`，服务端拒绝与 `countInBeats` 不一致的请求；旧客户端保留 fallback。
- Gate 2 报告：`stage2-plan-bundle-gate-report.md`（`b72ef3d`，实现 `753238b`）。
- 证据：26 项 bundle 测试（含真实 Rust corpus + 21 项 mutation）、launch context key、count-in 拒绝测试。

## 4. 标注基准集（Stage 3）

- `audit-r1/benchmarks/alignment-v1/`：26 case（Timeline 19 / Follow 7），trace 与 labels 分离。
- 一条脚本双跑，输出 JSON/CSV/Markdown；两次 canonical hash 一致。
- 基线（`scoring-v1.0.0` / FollowRuntime）：
  - Timeline 宏平均 precision 1.000、recall 0.954、F1 0.971、class 0.954；
  - Follow kind accuracy 1.000；
  - 已知失败：tempo drift、tie/long note、400ms late note。
- Gate 3 报告：`stage3-benchmark-gate-report.md`（`ce3c51e`，数据 `4fc685e`）。
- **缺口**：无真实设备 trace、无公开许可数据；来源覆盖未满足，已如实记录。

## 5. 候选算法评估（Stage 4/5/6）

### Parangonar（离线）

- 3.4.0，Apache-2.0，tag commit `737f6fa`；隔离 Python 3.13 venv；锁文件已提交。
- 18/19 可执行；同 18 case：F1 0.962 vs 基线 0.970，class 0.941 vs 0.951。
- 改善：tempo drift、400ms late；退化：cross-hand unison、wrong-pitch、mixed；tie 不变；空输入崩溃。
- **Stage 5 不实现 alignment_v2**：F1 未 +5pp，hard-case 错配 4→4（未 −20%）。决定记录：`stage5-alignment-v2-decision.md`。

### Matchmaker（Follow）

- `pymatchmaker` 0.3.0（Apache-2.0），Python 3.12 conda 隔离环境；离线 MIDI。
- 7/7 执行、deterministic；5/7 可比，index accuracy 1.0、false advance 0。
- duplicate 输入被合并（position 数不符）；score 结束后 extra 不可见；离线无法测延迟。
- **不实现 FollowPositionEstimatorV2**，保留现有 FollowRuntime。

报告：`stage4-parangonar-report.md`、`stage6-matchmaker-report.md`（`5121300`）。

## 6. 输入鲁棒性（Stage 7）

- 覆盖 Note On/Off、velocity=0、孤立/缺失 Note Off、快速重复、重复包、非法/迟到/乱序时间、暂停输入、resume 单次平移、断连/重连、队列溢出、空输入、写盘失败/重试/重复 finish、replay。
- 实测：Vitest 550/556（1 E5 环境失败 + 5 真实谱 skip）；selftest 251；Rust 179。
- **未覆盖**：20k FOLLOW_INPUT_LIMIT 的真实截断、真实硬件、真实音频时钟长期漂移。
- 报告：`stage7-input-robustness-report.md`（`9c2a18d`，测试 `8914d73`）。

## 7. 性能、依赖与构建风险

| 风险 | 现状 |
|---|---|
| Bundle 门禁开销 | 每次启动做 O(n) 校验 + `planFingerprintV1` 重算；未在大谱上测时延，1018 群/1579 occurrence 的真实谱 fixture 不在本机。 |
| Rust/NAPI 构建 | 本机 debug addon 可构建；Rust 依赖未变；无新增生产依赖。 |
| 前端构建 | `tsc -b && vite build` 通过；只有既有 chunk >500kB 警告。 |
| Python 研究环境 | Parangonar/Matchmaker venv 约 1.1GB，gitignored，不进生产；pymatchmaker 要求 Python <3.13。 |
| 内存 | Take 草稿在内存保留至重试成功；summary map 上限 512；pending drafts 不在进程重启后恢复。 |
| 依赖/许可 | Parangonar/Partitura/pymatchmaker 均声明 Apache-2.0；未分发代码/数据；任何生产引入需独立许可与 ADR。 |
| CI | 仓库无 CI；全部为本地验证。 |

## 8. 错误码与不支持场景

- 新增稳定错误入口：`PLAN_BUNDLE_REJECTED`（含 issue code），启动路径 fail-closed；`persist-retry` 返回 `persistenceStatus=pending-retry` 而非假成功。
- 仍不支持/未验证：
  - 真实谱 E5（fixture 缺失），E7 门禁因此 BLOCKED；
  - 真实 MIDI 硬件、真实音频时钟、浏览器点击验收；
  - 生产 multi-pass/无限循环（repeatSelection 仍为 none）；
  - Follow 跨连接恢复（断连即 interrupted Take）；
  - 20k 输入截断端到端；
  - Rust `alignment_v2`（未实现）；
  - Python 候选的生产化。

## 9. 推荐结论

**保留现有生产算法：`scoring_v1` + Rust `FollowRuntime`。**

- 不切换 `RHYTHM_PLANNER` 默认值，不合并 `main`。
- Stage 1/2 的可靠性/一致性改动是 additive、可回滚的内部改进；是否带入生产需单独评审，不属于本计划自动授权。
- Parangonar 与 Matchmaker 仅保留为研究证据；没有达到 Stage 5/Gate 6 的质量门槛。
- 下一步优先级（若继续）：
  1. 用真实设备 trace/公开许可数据补 Stage 3；
  2. 补 20k 输入截断与真实硬件 Stage 7；
  3. 若产品承诺崩溃恢复，设计持久 draft journal；
  4. 若要 rts 计划指纹持久化，提交 additive schema/ADR；
  5. 大谱 bundle 门禁性能测量。

## 10. 回滚策略

- 分支未合并；直接回退到 `02083ee` 即可放弃全部改动。
- Take 字段为 additive；旧 Take/legacy session 仍可读；无批量迁移。
- Stage 2 门禁只影响浏览器启动；回退 App 接线即可恢复到原 atoms/scoreEvents 生成路径（但会失去一致性门禁）。
- 研究目录（`audit-r1/benchmarks/*`）可整体删除，不影响生产构建。
- Python venv 未入库，删除目录即可清理。
- 无数据库 schema 变更、无生产默认值变更、无外部服务引入。

## 11. §14 设计决策清单状态

| # | 决策 | 状态 |
|---|---|---|
| 1 | fingerprint 字节/字段/hash | 冻结契约沿用；rts bundle 重算已验证，但未持久化 |
| 2 | 源事件 ID 稳定性 | 沿用现有契约；未重新定义 |
| 3 | 同 onset/unison/tie 语义 | Follow 同音去重已迁 Rust；Timeline tie/long-note 仍为基准失败 |
| 4 | tick/beat→µs 取整/tempo | `time-conversion-v1` 冻结；countInUs 统一；swing/tempo map 未支持 |
| 5 | Pause/Resume 时钟 | 沿用停走 + 单次平移；有测试，无新契约 |
| 6 | 存储原子性/崩溃恢复 | 原子写+fsync；跨进程 draft 恢复未承诺 |
| 7 | raw trace 保留/隐私 | 未改；无新保留策略 |
| 8 | alignment 参数/ambiguous 阈值 | 未校准；baseline 配置冻结 |
| 9 | Follow 重定位确认 | 沿用现有运行时；Matchmaker 实验未产生替换证据 |
| 10 | 资源上限/超限错误 | `FOLLOW_INPUT_LIMIT=20000`；DP/band 上限未实现（无 alignment_v2） |
| 11 | 诊断阻断级别 | Bundle issue 有 blocking；UI 未全量呈现新维度 |
| 12 | 第三方数据/许可 | 仅 Apache-2.0 研究依赖；未分发数据 |

## 12. 最终声明

本评审包不授权任何生产替换：

- 不授权默认 Planner 切换；
- 不授权修改冻结契约；
- 不授权合并 `main`；
- 不把 mock/合成数据表述为真实硬件证据。

任何生产采用都需要独立 ADR、用户批准和回滚方案。
