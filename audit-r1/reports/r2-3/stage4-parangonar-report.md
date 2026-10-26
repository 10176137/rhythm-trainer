# Stage 4 Parangonar 离线候选评估：Gate 4 报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 研究实现提交：`3e34c80`（仅 `audit-r1/benchmarks/parangonar`；生产代码仍为 `753238b` 基线）
- 性质：**本地离线研究，无 CI**；不接入生产路径。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §7 / Gate 4

## 1. 环境与许可

| 项 | 值 |
|---|---|
| Python | 3.13.9（`/opt/anaconda3/bin/python3.13`；系统 Python 3.9 低于 Parangonar `>=3.10`） |
| 隔离环境 | `audit-r1/benchmarks/parangonar/.venv`（gitignored） |
| Parangonar | **3.4.0**，PyPI wheel；upstream tag `3.4.0`，commit `737f6fa32ac432ae17aa9bbc3adb21e4e8d15ced` |
| Partitura | 1.9.0 |
| 许可证 | Parangonar 元数据 `License-Expression: Apache-2.0` |
| 依赖锁 | `out/requirements-lock.txt` |
| 安装注意 | 3.4.0 的 `switching_outerhmm` 隐式 import `tqdm` 但未声明；额外安装 `tqdm` 才能 import |

未把 Parangonar/Partitura 代码、模型或数据复制进生产；未将其加入 Node/Rust 依赖树。

## 2. 方法

- 复用 Stage 3 的 19 个 Timeline trace + 独立 labels；同一 plan/config、同一 performed events、同一 ground truth。
- 从 trace 构建 Partitura note arrays：
  - score：`onset_beat/duration_beat/onset_div/duration_div/pitch/voice/id/is_grace/staff`；
  - performance：`PerformedPart.from_note_array`，`onset_sec` 由原始 session ms 转秒；缺失 Note Off 用 duration 0.0（不虚构时值）。
- 主候选：`DualDTWNoteMatcher`；每个 case 新建 `OnsetMatcherDTW(DTWSL())` 与 `CleanOrnamentMatcher()`，避免 Parangonar 默认参数共享实例造成跨 case 状态。
- 标签只用于比较，绝不进入 matcher；onset error 从原始 trace 计算，不使用 DTW warp 时间。
- 两遍运行；可执行 case 的预测身份必须一致。

## 3. 结果（同一 18 个可执行 case）

| 指标 | scoring_v1 | Parangonar |
|---|---|---|
| pairing precision | 1.000 | 1.000 |
| pairing recall | 0.951 | 0.939 |
| pairing F1 | **0.970** | **0.962** |
| class accuracy | **0.951** | **0.941** |
| onset MAE vs label | 0 | 0 |
| 可执行 | 19/19 | 18/19 |

- Parangonar 执行 18/19：`tl-empty-input` 抛 `IndexError: index -1 is out of bounds for axis 0 with size 0`。
- 两个真实改善：
  - `tl-tempo-drift`：F1 0.857 → **1.0**（class 0.75 → 1.0）；
  - `tl-one-note-400ms-late`：F1 0.933 → **1.0**（class 0.875 → 1.0）。
- 退化/限制：
  - `tl-cross-hand-unison`：F1 1.0 → **0.8**（同 onset 同音高成员被合并）；
  - `tl-wrong-pitch`：F1 1.0 → 0.933，class 1.0 → 0.875（pitch-based matcher 不配对错音目标）；
  - `tl-mixed-errors`：F1 1.0 → 0.923（含错音/漏音/插入混合）；
  - `tl-tie-long-note`：两者均 0.667（都失败）；
  - clean/local/chord/repeat/missing 等 case 均为 1.0，无退化。
- 可执行 case 两遍一致；空输入崩溃是候选限制，单独记录，不伪装成对齐结果。
- 全 19 case 基线参考：F1 0.971、class 0.954（与 18-case 基线 0.970/0.951 的差异来自被排除的空输入 case）。

## 4. 对比结论（对照 §7.3 问题）

- 对简单干净 MIDI：不退化（clean/local/late 均 1.0）；
- 对漏音/插入/错音连续：部分改善（tempo drift、400ms late），但同音/错音/混合场景退化；
- 和弦与重复同音：和弦顺序正常；跨手同音退化；
- 原始 onset 误差：保留在原始 session 时间域，未被 warp 改善（onset MAE vs label 0）；
- 计算开销：26 个 case 的 Parangonar 总运行约 24 ms（不含 Python 启动/导入），可用于结束后整段评分；
- 依赖/许可：Apache-2.0 可评估，但引入生产需要完整 license notice、版本与审计决策；本阶段不授权。

## 5. Gate 4 结论

- 已完成同一数据、同一标签下的离线对照；
- 输出了逐 case 指标、失败案例、版本/许可/锁文件；
- 未替换生产代码，未把 Parangonar 输出当 ground truth。

**Gate 4：通过（研究范围）。** 候选未达到 Stage 5 的门槛（见 §6）。

## 6. 对 Stage 5 的裁决

按 §8 Gate 5：

- macro alignment F1 需提升 ≥5 个百分点：Parangonar 0.962 vs 基线 0.970，**下降 0.8pp**；
- 或 hard-case 错配数量减少 ≥20%：基线 hard-case 错配（tempo drift 2、tie 1、400ms 1）共 4；Parangonar（tie 1、unison 1、wrong 1、mixed 1）共 4，**无减少**；
- clean-case F1 不下降超过 1pp：未下降，但不足以补偿整体退化。

**决定：不实现 Rust `alignment_v2`。** 保留 `scoring_v1` 作为生产基线；不创建 `alignment_v2.rs`，不更新 golden，不切换默认算法。

## 7. 已知限制

1. 合成数据 only；没有真实设备 trace 或公开标注数据。
2. 错音配对对 pitch-based 候选结构性困难，已如实报告，不据此认定候选“更差”。
3. 空输入下候选崩溃，无法评估。
4. 未做性能/内存压力测试；24ms 只是小数据集上的观测。
5. Parangonar 版本固定为 3.4.0；升级需重新评估 API、依赖与许可。
