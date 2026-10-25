# 决策记录：Rust 全计算迁移与 R2/R3 路线的顺序

**状态：** Accepted（2026-10-26，基于 Phase 0 评审结论）
**基线：** `a938f36`（Phase 0 报告），代码基线 `dc18da6`
**相关：** `R2_3_RUST_PLANNER_TASK_CARD.md`、`TS_RUST_PARITY_GATE_V1.md`、`RUST_COMPUTE_API_V1_PHASE1_CONTRACT.md`

## 背景

新迁移计划（`rhythm-trainer-ts-ui-rust-compute-migration-v1.md`）提出的顺序是：

```text
Rust API/DTO → Rust MusicXML parser → Rust Planner 唯一权威
→ 全模式 runtime/matcher/scoring → Take/分析/Profile → 前端清理
```

既有 R2/R3 路线已经冻结了 Planner 契约、Parity Gate、七项迁移证据，并完成了 Rust Planner 的实现与大部分接线，但生产默认仍为 `rts`，正式切换尚未评审/授权。

如果直接按新计划从 parser 开始重写，会与既有验收顺序冲突，并可能绕过已经冻结的 Planner 证据门槛。

## 决定

1. **保留 R2-3 冻结契约与 Parity Gate。**
   `ScoreDocumentV1`、`planFingerprintV1` 向量、parity case index/golden、`EngineScoreEvent` wire、`scoring_v1`/matcher/`build_schedule` 语义不改；任何变更走独立提案。

2. **先完成 Rust Planner 的既有验收与切换就绪评审。**
   按 R2-3 任务卡的七项证据和既有评审流程收口；这不等于批准切换生产默认值。默认仍为 `rts`，切换需单独授权。

3. **Phase 1 接口/DTO 定稿可以立即进行。**
   它只定义 API、字段所有权、错误/时间/指纹/版本规则与黄金框架，不改变生产行为；与 Planner 验收并行。

4. **Rust MusicXML parser 在 Planner 验收/切换评审之后再进入生产迁移。**
   Phase 2 可以准备 Rust parser 与离线 oracle，但生产读取路径保持 TS parser，直到 parser 对照通过并单独批准。

5. **随后收敛 Follow、分析/处方、Profile。**
   Follow 的真实结果必须进入统一 Take Finalizer；不得伪装 Timeline 评分。Profile 从有效 Takes 重建；未测量维度保持 unknown。

6. **最后清理前端生产计算路径。**
   TS 只保留 UI/展示/交互/API 适配；旧 parser/planner/matcher/scoring 只作为测试 oracle，不进入生产 bundle。

7. **生产切换与回滚。**
   不按单次练习在 TS/Rust 之间动态回退；回滚以整版发布回退为单位，保留旧历史可读。

## 路线映射

| 既有 R2/R3 | 新计划阶段 | 处理 |
|---|---|---|
| R2-0 契约冻结、R2-1 Gate、R2-2 parity harness | Phase 1 基线 | 保持不变，继续作为冻结基线 |
| R2-3a–i（Rust planner/接线/Take A/B） | Phase 1/3 的前置实现 | 已完成部分保留，先完成验收 |
| R2-3j 切换就绪评审 | Phase 3 的门槛 | **先完成**，不因新计划跳过 |
| 新 Phase 1 API/DTO | Phase 1 | 现在进行，纯定义 |
| 新 Phase 2 Rust parser | Phase 2 | Planner 验收后进入；TS parser 作 oracle |
| 新 Phase 3 Planner 唯一权威 | Phase 3 | 与 R2-3 切换评审衔接；默认切换另批 |
| 新 Phase 4 runtime/matcher/scoring | Phase 4 | Follow/Free Play 收敛；Timeline 已有 Rust 实现 |
| 新 Phase 5 Take/分析/Profile | Phase 5 | 扩展 Take 到 Follow/Free；Profile 重建 |
| 新 Phase 6 前端瘦身 | Phase 6 | 最后清理生产计算 |
| 新 Phase 7 E2E/切换 | Phase 7 | 真实 MIDI + 单独审批 |

## 后果

- 新计划的长期目标不变：TS 只做界面/展示，Rust 做所有权威业务计算。
- 不会丢弃已完成的 Rust Planner 验证工作，也不会因为目标扩大而绕过冻结门槛。
- Phase 1 可交付接口定稿与顺序记录；生产默认、Schema、wire、golden、评分语义保持不变。
- 未决事项（Rust parser DTO 是否沿用 TS ImportReport 形状、Follow runtime 共享范围、Free Play 是否产生 Take、Profile 纳入策略）在 Phase 1/后续阶段按独立决策记录处理。
