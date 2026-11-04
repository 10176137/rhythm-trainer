# Alignment V2 候选评估报告 — 规则式晚到窗口（candidate v2）

- 日期：2026-11-05
- 分支：`r2-3-alignment-v2`
- 算法性质：**单调、规则式贪心匹配器**；不是 DTW、不是 Needleman–Wunsch，也不是通用序列 DP。
- 正式评分接入：本分支 Node engine 默认选择 `scorePerformanceCandidate`；Rust `scorePerformance` 仍保留冻结的 v1 路径，可通过 `RHYTHM_FINAL_ALIGNMENT_SCORER=legacy` 回退。
- 评分公式：候选只替换音符配对结果；onset / IOI / duration / continuity / diagnostics / weights 复用 v1 评分实现。
- 前置证据：`alignment-v2-root-cause.md`。

## 1. 实际算法是什么

候选不是全局最小代价 DP。它按目标音符和演奏音符的起音时间排序，以双指针单调扫描，并沿用 v1 的和弦、早音及错音 lookahead 分支。

主要修正是单向晚到窗口：

```text
normal window = max_onset_deviation_ms (default 250 ms)
late window   = clamp(0.8 × interval_to_next_target, normal window, 600 ms)
```

当演奏音晚于正常窗口、但音高等于当前目标音，且迟到量仍在晚到窗口内时，候选把该音配回当前目标，并保留原始起音误差。末尾目标没有后继间隔时使用 600 ms 上限。

其他行为仍是规则分支，而非统一代价矩阵：
- 早音超出正常窗口时按原规则消费为 extra。
- 错音通过局部 lookahead 判断应当形成 wrong-pitch pair、miss，还是 extra。
- 同起音和弦沿用原来的分组匹配与最近音高优先策略。
- 对超出晚到窗口且没有后续目标可接管的音，候选会消费为 extra；存在后续目标可能接管时保留该音供后续判断。

**重要边界：**代码中没有“漏音 50 / 多音 30 / 错音 40”的转移代价，也没有“时间软惩罚 1.2”。这些数值属于另一个尚未实现的序列 DP 设计，不能用来描述当前候选。

## 2. 合成基准结果

数据集：30 cases（23 Timeline + 7 Follow），标签与实现分离，重复运行 deterministic。

| 集合 | case 数 | V1 Pair F1 | 候选 Pair F1 | V1 class acc | 候选 class acc |
|---|---:|---:|---:|---:|---:|
| hard（含级联/漏音/错音/和弦/漂移） | 11 | 0.8789 | **1.0000** | 0.8409 | **1.0000** |
| 其余 Timeline（clean 等） | 12 | 0.9944 | 0.9944 | 0.9896 | 0.9896 |
| Timeline 全部 | 23 | 0.9392 | **0.9971** | 0.9185 | **0.9946** |

关键 case：
- `tl-tempo-drift`：0.857 → **1.000**
- `tl-one-note-400ms-late`：0.933 → **1.000**
- `tl-late-300-return`：0.933 → **1.000**
- `tl-late-300-phase`：0.545 → **1.000**
- `tl-late-600-phase`：0.400 → **1.000**
- `tl-early-300-control`：0.933 → 0.933（早音未改善）

这些结果只证明候选在当前合成 case 集上没有已知回归，不等于真机准确率已被证明。

## 3. 接入与验证状态

| Gate | 状态 | 证据 / 限制 |
|---|---|---|
| A 数据可信性 | **BLOCKED** | 当前真机标注 trace 数仍为 0；需要收集真实 SP-A500 Take |
| B 合成算法正确性 | **PASS（当前数据集）** | hard macro F1 +12.1pp；clean F1 不变；关键级联 case 修复 |
| C Take 评分接入 | **PASS（实验分支）** | `scorePerformanceCandidate` 已接入 engine finalization；算法版本随报告记录；旧入口保留 |
| D 性能 / 稳定性 | **NOT VERIFIED** | 5k/10k 性能脚本存在，但没有提交可复核的运行结果；CI 的合成基准不是大规模性能测试 |
| E 发布决策 | **NOT APPROVED** | 仅在 `r2-3-alignment-v2` 分支启用，不代表 main / release 已切换 |

## 4. 需要继续验证的风险

1. **错音发生在晚到窗口内：**当前规则只对“音高等于当前目标”的晚音做直接回配。晚到且音高错误时，会走 miss / lookahead / wrong-pitch 分支，不存在统一 substitution cost；需要增加晚到错音、连续漏音等组合测试。
2. **同音额外音：**如果额外音与当前目标同音且落入晚到窗口，可能被吸收到当前目标；重复音密集场景需要更丰富的真机样本。
3. **窗口上限：**持续相位偏移超过 600 ms 不会被该规则回配；本候选不是通用 tempo / phase tracker。
4. **早音不对称：**早音继续使用旧规则；当前基准的 early-300 case 未改善。
5. **性能：**候选和 v1 评分路径均有按 ID 线性查找的循环，完整评分在长序列上可能出现二次复杂度热点。性能脚本目前只单独测候选对齐，不代表完整 `scorePerformanceCandidate` 的端到端耗时。
6. **真实教学效果：**配对成功不等于应该给高分；原始 onset error 必须继续参与评分，不能被对齐算法抹平。

## 5. 对“序列 DP / Needleman–Wunsch”方案的决策

把 DTW 与序列比对 DP 看作同属动态规划家族、但目标函数和转移模型不同，是合理的理论说明。

但把当前候选称为 Needleman–Wunsch 或“50/30/40 + 1.2 时间代价”的序列 DP，是不准确的。若要实现该方案，应建立独立版本（例如 `alignment-sequence-dp-v1`），明确 substitution / insertion / deletion / temporal cost，加入错音、漏音、多音、同音重复、跨手同音、和弦、相位突变等对抗测试，再与当前规则候选做 shadow / benchmark 对比。不要在当前候选上只改名称或把未经验证的代价数字写进说明。

**当前建议：保留规则候选作为可回退的实验分支方案；先收集真机 Trace，并补充晚到错音与长序列性能测试。满足证据门槛后，再决定是否实现序列 DP。**
