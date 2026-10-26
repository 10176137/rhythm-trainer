# Stage 6 Matchmaker Follow 实验：Gate 6 报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 研究实现提交：`3e34c80`（仅 `audit-r1/benchmarks/matchmaker`；生产代码未变）
- 性质：**独立离线实验，无 CI**；不接入生产。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §9 / Gate 6

## 1. 环境与许可

| 项 | 值 |
|---|---|
| 包名 | **`pymatchmaker` 0.3.0**（不是 PyPI 上另一个 `matchmaker` 0.1.4） |
| Python | 3.12.15，conda 隔离环境 `audit-r1/benchmarks/matchmaker/.venv312`（gitignored） |
| 原因 | `pymatchmaker` 要求 `>=3.10,<3.13`；本机系统 3.9、Anaconda 3.13 均不满足 |
| 依赖 | librosa、partitura、parangonar、numpy 1.26 等；锁文件 `out/requirements-lock.txt` |
| 许可证 | PyPI 元数据 Apache-2.0 |
| 运行 | `Matchmaker(score.musicxml, performance.mid, input_type="midi")` 离线模式 |

未把 pymatchmaker 代码/模型加入生产依赖，未启动 Python 服务。

## 2. 方法

- 复用 Stage 3 的 7 个 Follow case（groups/inputs 与 Rust FollowRuntime 相同）。
- 为每个 case 生成最小 MusicXML（组作为 60 BPM 四分音符/和弦）与 MIDI（输入 Note On/Off）。
- 运行 Matchmaker 离线模式，收集 yielded score positions。
- 将 position 映射到最近的组 beat，与由 labels 推导的“当前应处组”比较：
  - partial/wrong/duplicate → 当前组；
  - correct/complete → 当前组后推进；
  - extra → 全部组之后。
- 指标：是否一输入一 position、index accuracy、false advance、correct recovery、是否达到 expected completed count。
- 两遍运行；runtime 排除后必须一致。

## 3. 结果

- 7/7 case 执行；两遍 deterministic。
- 5/7 可比（position 数 = 输入数）：index accuracy **1.0**，false advances **0**。
- 2/7 不可比，均为候选行为与产品语义不一致：
  1. `fw-duplicate-note`：4 个输入只产出 3 个 position（重复键被合并）；
  2. `fw-extra-after-complete`：score 结束后不产出 position，最终额外输入不可见。
- 当前 Rust `FollowRuntime` 在 Stage 3 对这 7 个 case 的 kind accuracy 为 **1.0**，并显式处理 duplicate/extra。
- 离线模式无法测响应延迟；pause 只是时间间隙，不是真实暂停事件。
- Matchmaker 只给 score position，不给本项目的 note-level occurrence ID；映射只能到组级别。

## 4. Gate 6 决策

按 §9 Gate 6：

- 候选在 5 个可比 case 的位置判断上正确，但没有证据优于现有 FollowRuntime；
- 重复输入被合并、score 结束后的输入不可观测，恰是本项目需要显式处理的错误/额外音场景；
- 没有延迟数据，无法证明“更快”或“更稳”；
- 因此**不设计/实现 `FollowPositionEstimatorV2`，不替换 Rust FollowRuntime，不引入 Python 服务**。

保留现有推进式 Follow 与暂停/恢复、错误跳转规则；未来若有真实 trace 与在线延迟测量，可重新评估。

## 5. 已知限制

1. 合成 Follow case，无真实设备/音频。
2. 离线 MIDI 文件，不是 live stream；延迟未测。
3. pause 语义未建模。
4. position→group 是最近 beat 映射，不是 note-level 对照。
5. pymatchmaker 0.3.0 与 Parangonar 3.4.0 同时安装；升级需重新核对依赖与许可。
