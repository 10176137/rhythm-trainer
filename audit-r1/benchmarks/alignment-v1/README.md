# Alignment Benchmark v1 (Stage 3)

目的：在**不修改生产算法**的前提下，建立可复现、带独立真值的对齐基准，量化当前 Rust `scoring_v1` 与 FollowRuntime 的基线表现，为 Stage 4/5/6 的候选算法对照提供证据。

- 数据集版本：`alignment-bench-v1`
- 基线算法：`scoring-v1.0.0`（Timeline）与 Rust `FollowRuntime`（Follow）
- 目录：`audit-r1/benchmarks/alignment-v1/`
- 不在生产依赖树中；生产构建不会 import 本目录。

## 目录

```
alignment-v1/
  manifest.json              # case 索引、场景、来源、许可
  generate-cases.mjs         # 确定性合成数据生成器
  run-benchmark.mjs          # 基准 runner（同一脚本双跑并比较）
  cases/<case>.trace.json    # 原始输入：score targets + performed events + quality signals
  labels/<case>.labels.json  # 独立真值：应配对/漏/多/不可判定、输入质量
  out/latest.json            # 机器可读结果（两次完整运行 + 聚合）
  out/latest.csv             # 每 case 一行
  out/summary.md             # 人读摘要
```

## 运行

```bash
# 可选：重新生成确定性数据（覆盖 cases/labels/manifest）
node audit-r1/benchmarks/alignment-v1/generate-cases.mjs

# 运行基准（需要先构建 bindings/node 的 addon）
node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs
```

runner 会执行两次完整数据集，比较去掉 runtime 后的规范化结果；`deterministic=false` 时退出码为 1。

## 数据与标签规则

- 所有 case 为**合成**数据，无个人信息、无第三方乐谱；来源/许可写在 manifest 与 label 的 `source`/`license`。
- Label 与 trace 分开文件存储；runner 只把 trace 的 `scoreEvents` / `performed` / `groups` / `inputs` 传给 Rust，label 只用于比较。
- 标签是“意图真值”，不是算法输出：
  - 每个目标音符的预期配对、错音、漏音、插入音；
  - `onsetErrorMs` 是合成时指定的 `performed - target`，不是算法回填；
  - 输入丢失（missing Note On、断连、空输入）标为 `unassessableScoreEventIds`，不算作用户漏弹；
  - 输入质量标签与 `qualitySignals` 独立记录，runner 用简单分类器对照。
- 时间全部按合成 case 的 BPM/count-in 计算；不包含 DTW warp 后的时间。

## 覆盖（26 cases）

Timeline（19）：

- clean、global late、local deviations、tempo drift；
- one/consecutive miss、wrong pitch、extra、mixed errors；
- chord reverse arrival order、cross-hand unison、fast repeated note、tie/long note；
- missing Note Off、duplicate packet、400 ms late note；
- missing Note On、device disconnect、empty input。

Follow（7）：

- clean、skip target、wrong-then-correct、chord spread、duplicate inside chord、pause/resume、extra after complete。

**未覆盖/缺口（明确记录）**：

- 没有真实设备演奏 trace：本机没有可用的真实 MIDI 录音与标注；不伪造“真实硬件”证据。Stage 7 会补输入鲁棒性，真实 trace 需在具备硬件时追加。
- 没有公开许可的第三方对齐数据：未引入外部数据集，避免许可与转换尚未核实。
- Timeline 的 pause 期间输入、队列溢出、多 pass/选区边界仍由 Stage 7 的输入鲁棒性测试覆盖；本数据集不冒充已覆盖。
- Follow 的 pause 通过 `invalidateNextInterval()` 模拟明确暂停语义，不包含真实设备断连。

## 指标

Timeline：

- `pairingPrecision` / `pairingRecall` / `pairingF1`：预测 pair 与标签 pair 的集合匹配（不把错音当成正确命中）；
- `classAccuracy`：MATCH / WRONG_PITCH / MISSING / EXTRA 分类与标签一致率；
- `onsetMaeVsLabel` / `onsetMaxDeltaVsLabel`：预测 onset error 与标签原始 onset error 的差（必须为 0，任何时间扭曲会立刻暴露）；
- 每小节错误率、输入质量分类正确性、单 case 运行时间。

Follow：

- 每次输入的 `kind` 与标签序列一致率；
- completed/standard/wrong/extra/duplicate/pending 计数；
- `intervalJudged` 序列；
- 输入质量分类。

## 基线结果（2026-10-26，`753238b`）

- Deterministic：**yes**（两次 canonical runs 的 SHA 相同，见 `out/latest.json` 的 `runHashes`）。
- Timeline 宏平均：precision 1.0、recall 0.954、F1 0.971、class accuracy 0.954、onset MAE vs label 0。
- Follow：kind accuracy 1.0、无计数/间隔错误。
- 基线失败（作为后续候选对照的起点，不是 harness 失败）：
  - `tl-tempo-drift`（渐快导致后段配对丢失）；
  - `tl-tie-long-note`（长音/延音后紧跟同 release 时间的音符被误判为漏+多）；
  - `tl-one-note-400ms-late`（超出匹配带后身份丢失）。

这些结果说明基准能区分“干净场景”和“困难场景”，也证明原始 onset 误差没有被时间扭曲掩盖。

## 复现性与边界

- 生成器使用固定 BPM/count-in/事件表；除 manifest 的 `createdAt` 外，重复生成字节一致。
- runner 不读环境变量决定算法；算法版本写入每个结果。
- 不把 `labels/` 的内容作为 NAPI 输入；这是 Gate 3 的硬约束。
- 本基准不是 CI 套件；仓库没有 CI workflow，报告只写“本地验证”。
