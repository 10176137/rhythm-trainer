# Stage 3 标注算法基准集：Gate 3 验证报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 数据集/实现提交：`4fc685e`（`feat(stage3): labeled alignment benchmark v1 (26 cases)`）
- 性质：**本地验证，无 CI**。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §6 / Gate 3

## 1. 范围与非目标

本阶段只建立基准与基线观测，不替换算法：

- 26 个合成、精确真值的 case（Timeline 19 / Follow 7）；
- trace 与 labels 分文件；
- 一个 Node 脚本对真实 Rust NAPI 跑两遍，输出 JSON/CSV/Markdown；
- 记录当前 `scoring_v1` / `FollowRuntime` 的基线表现与失败场景。

未做：

- 未引入 Parangonar/Matchmaker（Stage 4/6）；
- 未修改生产算法或评分语义；
- 未伪造真实设备/公开数据来源。

## 2. 数据集

目录：`audit-r1/benchmarks/alignment-v1/`

- `manifest.json`：case 索引、场景、来源 `synthetic`、许可 `internal-test-only`；
- `cases/*.trace.json`：score targets、performed Note On/Off、quality signals；
- `labels/*.labels.json`：独立真值（配对、错音、漏音、插入音、不可判定、输入质量、可评估维度）；
- `out/latest.json`：两次完整运行 + 聚合 + run hashes；
- `out/latest.csv`、`out/summary.md`：机器可读/人读摘要。

覆盖：

| 类别 | 覆盖 |
|---|---|
| 干净/整体早晚/局部偏差 | clean、+50 ms、alternating local |
| 速度变化 | accelerando 0→350 ms drift |
| 漏音/错音/插入/混合 | one miss、3 consecutive、wrong pitch、extra、mixed |
| 和弦/同音 | reverse arrival order、cross-hand unison |
| 重复/长音 | fast repeated C4、tie/long note |
| 输入证据 | missing Note Off、duplicate packet、400 ms late |
| 证据不足 | missing Note On、device disconnect、empty input |
| Follow | clean、skip target、wrong→recover、chord spread、duplicate inside chord、pause/resume、extra after complete |

## 3. 标签规则

- 标签是合成时的**意图真值**，不是算法输出；
- label 中的 `onsetErrorMs` 由生成器按 `performed.onset - target.onset` 直接定义；
- 输入丢失（missing Note On/断连/空输入）标为 `unassessableScoreEventIds`，不算用户漏弹；
- 输入质量是独立标签（healthy/degraded/unscorable），runner 用简单信号分类器对照；
- `validateLabels()` 在运行前校验：pair 1:1、ID 存在、pitchMatched/onsetError 与原始事件一致、miss/extra/unassessable 不重叠；
- runner 只把 trace 的事件/groups/inputs 传给 Rust；labels 只参与比较。生产代码不 import 本目录。

## 4. 运行与确定性

```bash
node audit-r1/benchmarks/alignment-v1/generate-cases.mjs   # 可选，确定性
node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs
```

实测（2026-10-26，HEAD `4fc685e`）：

- 两次完整运行的 canonical case 结果 hash 相同：`deterministic=true`；
- `out/latest.json` 保存 `runs[0]`/`runs[1]` 与 `runHashes`；
- 单次总运行时间约几十毫秒（26 cases，不含进程启动）。

## 5. 基线结果

- Timeline 宏平均：precision **1.000**、recall **0.954**、F1 **0.971**、class accuracy **0.954**；
- `onsetMaeVsLabel = 0`：预测的原始 onset error 与标签逐 pair 一致，没有时间扭曲；
- 输入质量分类：19/19 正确；
- Follow：kind accuracy **1.000**，无计数/interval 错误；
- 基线失败（真实算法局限，作为后续候选对照起点）：
  - `tl-tempo-drift`：渐快后段身份丢失（recall 0.75）；
  - `tl-tie-long-note`：长音在 release 时刻紧接下一音，`scoring_v1` 把下一音判为 MISSING+EXTRA（recall 0.5）；
  - `tl-one-note-400ms-late`：超出匹配带后身份丢失（recall 0.875）。

这些失败不是 harness 错误：`tl-tie-long-note` 的 score/performed 原始数据经人工核对，标签正确；400 ms 迟到是明确的 out-of-band 场景。

## 6. 复现性与数据完整性

- 生成器使用固定 BPM/count-in/事件表，除 manifest `createdAt` 外重复生成字节一致；
- runner 的 label validator 在每次运行前执行，标签被篡改会直接报错；
- 算法版本（`scoring-v1.0.0`）、dataset manifest hash、Node 版本、git SHA 写入输出；
- 原始 trace 与 labels 不在同一文件，也不在运行时合并。

## 7. 已知缺口（必须如实记录）

1. **没有真实设备演奏 trace**：本机没有可用的真实 MIDI 录音与人工标注；未把合成数据包装成“真实硬件”证据。Stage 7 的输入鲁棒性测试与真实硬件验收仍需独立执行。
2. **没有公开许可的第三方对齐数据**：未核实并引入外部数据集；Stage 4 的 Parangonar 对照目前只能在本合成集上做。
3. **Timeline 暂停期间输入、队列溢出、多 pass/选区边界**未纳入本数据集，留给 Stage 7。
4. **Follow 的 pause 是 `invalidateNextInterval()` 模拟**，不是物理暂停事件。

## 8. Gate 3 结论

就本仓库可合法获得的证据范围内：

- 每个 case 都有独立、可校验的 expected result；
- 一条脚本可重复运行，输出 JSON/CSV/Markdown；
- 两次运行结果一致；
- trace/labels 分离，算法未读取 labels。

**Gate 3（合成子集）：通过。** 来源覆盖（真实设备/公开数据）**未满足**，这是明确的证据缺口，不是通过声明；Stage 4 的结论必须在该限制下解读。
