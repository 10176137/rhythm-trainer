# Alignment V2 候选评估报告 — 规则式晚到窗口（候选 v2.0-rule）

- 日期：2026-11-04
- 分支：`r2-3-alignment-v2`
- 性质：**候选评估**。默认评分路径未改；`scorePerformance` 仍调用冻结的 `scoring_v1`。
- 前置证据：`alignment-v2-root-cause.md`（P0，已推送 `9b5ae66`）
- 运行命令：`node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs --candidate`

## 1. 候选设计（最小修复）

在冻结贪心匹配上只加一条规则：

> 演奏音晚于当前目标超过 `max_onset_deviation_ms` 时，若音高与当前目标一致且迟到量在
> `late_window = clamp(0.8 × 本目标到下一目标的间隔, 250ms, 600ms)` 内，则配对到**当前**
> 目标，保留原始 `onset_error_ms`。

配套规则：

- 迟到量超过晚到窗口、且没有后续目标能按音高接管该音时，**消费该音为 extra**，不再留给下一目标（消除抢占）。
- 若有后续目标按音高落在其窗口内，则维持冻结语义（目标 miss、音保留），跳过（skip）场景不受影响。
- 同起音和弦分支、早音分支、音高错配 lookahead 全部保持 `scoring_v1` 原样。
- **不改写原始时间**：配对误差就是 `performed.onset - target.onset`，评分层（外部）自行决定如何扣分。

## 2. 合成基准结果（30 case，deterministic=true）

| 集合 | case 数 | V1 Pair F1 | 候选 Pair F1 | V1 class acc | 候选 class acc |
|---|---:|---:|---:|---:|---:|
| hard（含级联/漏音/错音/和弦/漂移） | 11 | 0.8789 | **1.0000** | 0.8409 | **1.0000** |
| 其余（clean 等） | 12 | 0.9944 | 0.9944 | 0.9896 | 0.9896 |
| Timeline 全部 | 23 | 0.9392 | **0.9971** | 0.9185 | **0.9946** |

逐 case 关键变化：

| Case | V1 F1 → 候选 F1 | 说明 |
|---|---|---|
| `tl-tempo-drift` | 0.857 → **1.000** | 累计漂移 350ms 内保持身份 |
| `tl-one-note-400ms-late` | 0.933 → **1.000** | 晚音配对自身目标 |
| `tl-late-300-return` | 0.933 → **1.000** | 不再 miss+extra 双罚 |
| `tl-late-300-phase` | 0.545 → **1.000** | 尾部 5 miss+5 extra 全部恢复 |
| `tl-late-600-phase` | 0.400 → **1.000** | 4 个 WRONG_PITCH 恢复为 MATCH |
| `tl-early-300-control` | 0.933 → 0.933 | 早音语义保持不变（未改善，未退化） |
| `tl-wrong-pitch` / `tl-mixed-errors` / `tl-cross-hand-unison` / chord | 1.000 → 1.000 | 强制阻断集全部保持 |

**无任何 case 退化**（逐 case 比较 F1 与 classAccuracy 均未下降）。

## 3. Gate 评估（PRD §5.5）

| Gate | 状态 | 证据 |
|---|---|---|
| A 数据可信性 | **BLOCKED** | 标签/输入分离、双跑 hash 一致已满足；**真机 trace 仍为 0**（PRD 建议 ≥20 次真实 Take） |
| B 算法正确性 | **PASS（合成范围）** | hard macro F1 +12.1pp（≥5pp 门槛）；clean F1 下降 0pp（≤1pp 门槛）；级联 case 全部 cascade=0；无已知回归 |
| C 报告/集成 | NOT_STARTED | 候选尚未接入 Take/sidecar，旧 wire 未动 |
| D 性能/稳定性 | 部分 | 双跑 deterministic；未测 5000/10000 音规模与内存上限 |
| E 上线决策 | NOT_REQUESTED | 未切换默认，未做 shadow/opt-in |

## 4. 已知边界与下一步

1. **晚到窗口有上限**：600ms 绝对上限 + 0.8×局部间隔。超过上限的持续相位偏移仍会 miss+extra（不级联）。真正的任意相位/速度建模留给加权 DP 候选。
2. **早音未改善**：`tl-early-300-control` 仍是 0.933（早音按 frozen 语义消费为 extra）。若产品要求对称宽容，需要单独设计并评估误吞真实 extra 的风险。
3. **重复同音**：窗口按当前目标音高匹配，`tl-fast-repeated-note` 保持 1.000；更大窗口对连续同音额外音的风险尚未测。
4. **接入顺序**：下一步是把候选作为**影子分析**接入 Take 结算（sidecar），默认评分不变；同时补 5000/10000 音性能与真机录制。
5. **只有用户批准后**才讨论生产切换；本报告不构成切换授权。
