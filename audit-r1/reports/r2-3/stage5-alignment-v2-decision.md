# Stage 5 alignment_v2 决策记录（不实现）

- 日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 依据：Stage 4 报告（`3e34c80`）与 §8 Gate 5
- 结论：**不实现 Rust `alignment_v2`。**

## 门槛核对

| Gate 5 条件 | 实测 | 是否满足 |
|---|---|---|
| hard-case macro alignment F1 相对基线提升 ≥5pp | Parangonar 0.981 vs 0.988（−0.7pp） | 否 |
| 或 hard-case 错配数量减少 ≥20% | 基线 3，候选 3（0%） | 否 |
| clean-case macro F1 不下降 >1pp | 未下降 | 是，但不足以单独放行 |
| 原始 onset MAE 不因时间扭曲虚假改善 | onset MAE vs label = 0 | 是 |
| 分层报告（clean/hard） | 已按 case 输出 | 是 |

## 决定

- 不新建 `alignment_v2.rs`；
- 不修改 `scoring_v1`、golden、parity expected outcome；
- 不切换生产默认算法；
- 保留 Stage 3 基准与 Stage 4 数据，供未来有真实数据时重新评估。

## 后续触发条件

只有同时满足以下条件才重新打开 Stage 5：

1. 有真实设备/公开许可的标注数据，且 hard-case 覆盖足够；
2. 候选在 clean-case 不退化，且 hard-case F1 ≥ +5pp 或错配数 ≥ −20%；
3. 原始 onset 误差仍从原始 session 时间计算；
4. 独立 ADR 与用户批准。

当前证据不足，按计划允许停止，不为了“引入算法”降低质量门。
