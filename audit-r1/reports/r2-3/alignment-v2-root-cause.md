# Alignment V2 P0 根因定位报告 — 晚音级联

- 日期：2026-11-04
- 分支：`r2-3-alignment-v2`（自 `5e8d9de` = `r2-3-algorithm-upgrade-v1-1` 拉出）
- 性质：**只读观测**，不改冻结的 `scoring_v1` 行为；官方评分路径未动。
- 上游文档：`Rhythm_Trainer_Offline_Alignment_V2_PRD_and_Validation.md`（2026-11-04）

## 1. 结论（先行）

1. **级联根因确认**：`scoring_v1::align_performances` 的 `MISS_WINDOW` 分支（`delta > 250ms`）把目标记 missed 但**不消费演奏音**，该音随后与下一个目标比较。后果分两种几何形态：
   - 漂移后落在下一目标窗口内（IOI−shift ∈ ±250）→ **抢占下一目标**，整条尾部错位，且因音高序列错开被标成 `WRONG_PITCH`（基准 `tl-late-600-phase`：4 个正确演奏的音被标错音）。
   - 漂移后落在两侧窗外（750ms IOI、+300ms 时：+300 / −450）→ 整条尾部 **miss+extra 对**（`tl-late-300-phase`：8 音中 5 miss 5 extra，classAcc 0.375）。
2. **不对称确认**：早音走 `EXTRA_WINDOW` 立即消费，不级联（`tl-early-300-control` 与单晚音 return 形态相同）。
3. **实时路径（`HitMatcher`）无错位级联，但有独立缺陷**：晚出 Good 窗口的音判 `Extra`、目标过期判 `Missed`（同一音被双重惩罚），后续音各自正常。 pinned 测试：`live_hitmatcher_reports_extra_and_missed_for_late_note`。
4. **音高 lookahead 只部分自救**：return 形态（晚音后恢复原网格）中，`LOOKAHEAD_SKIP_PERFORMED` 可在下一音已进入窗口时消费晚音，阻止级联——但晚音仍被双重惩罚（target MISSED + note EXTRA）。
5. **冻结行为证明**：插桩后重跑既有 26 case 基准，除 runtime/时间戳/gitSha 外**逐字节一致**；`align_performances` 与 `align_performances_traced` 结果恒等（测试 `traced_and_frozen_results_are_identical`）。

## 2. 方法（PRD Task A）

- `scoring_v1.rs` 新增 `AlignmentBranch` / `AlignmentStep` / `TracedAlignment` 与 `align_performances_traced()`：同一实现、每步决策记录 branch 码（`MATCH / MISS_WINDOW / EXTRA_WINDOW / LOOKAHEAD_SKIP_TARGET / LOOKAHEAD_SKIP_PERFORMED / WRONG_PITCH / CHORD_MATCH / CHORD_FALLBACK / CHORD_MISS / CHORD_PRE_EXTRA`）；冻结入口 `align_performances` 只是丢弃 trace 的委托。
- NAPI 新增只读入口 `alignPerformancesTraced`（诊断/基准用；`scorePerformance` 仍是唯一官方评分路径）。
- 新测试 `crates/rhythm-core/tests/alignment_v2_root_cause.rs`（5 项）：钉住当前级联形态作为"候选必须击败的基线"，任何候选不得静默改变。
- 基准新增 4 case（`generate-cases.mjs`，数据集 26→30）。

## 3. 基准证据（`out/latest.json`，deterministic=true）

| Case | 期望 pairs | 预测 pairs | missed | extra | WRONG_PITCH | Pair F1 | classAcc |
|---|---:|---:|---:|---:|---:|---:|---:|
| tl-late-300-return（新增） | 8 | 7 | 1 | 1 | 0 | 0.933 | 0.875 |
| tl-late-300-phase（新增） | 8 | **3** | **5** | **5** | 0 | **0.545** | **0.375** |
| tl-late-600-phase（新增） | 8 | 7 | 1 | 1 | **4** | **0.400** | **0.375** |
| tl-early-300-control（新增） | 8 | 7 | 1 | 1 | 0 | 0.933 | 0.875 |
| tl-one-note-400ms-late（既有） | 8 | 7 | 1 | 1 | 0 | 0.933 | 0.875 |
| tl-tempo-drift（既有） | 8 | 6 | 2 | 2 | 0 | 0.857 | 0.750 |

- 数据集 Timeline F1 聚合从 0.989 降到 **0.939**：纯粹因为 4 个新 hard case 加入（基线在级联 case 上本来就失败），不是回归。
- 逐步骤 trace（Rust 测试内断言）显示 `tl-late-300-phase` 的首个分叉：`step 1 = MISS_WINDOW (s2, p2, +300)`，随后每个决策都是错位配对。与 PRD §4.1 预期的分叉点一致。
- 600ms 形态即用户报告"一个音慢了后面全错位"的精确复现：晚音抢了 s5，此后每个音配前一个目标、全部标 `WRONG_PITCH`，最后一个音变 extra。

## 4. 实时路径（HitMatcher）观测

`HitMatcher::ingest` 对超出 `good_window_ms` 的晚音**不推进 cursor**：音判 `Extra`，目标随后由 `advance` 过期判 `Missed`。后续音不受影响（无错位级联），但晚音被双重惩罚。若未来把对齐 V2 的宽容窗口引入实时路径，需要单独评估 live 判定的教育语义（实时反馈的目标是即时纠正，不是结算准确性）。

## 5. 对齐 V2 候选的设计约束（由本报告证据直接推出）

1. 修 `MISS_WINDOW` 不消费的问题：晚音音高匹配时给"单向晚到窗口"，或消费为"晚到配对"；音高不符时必须消费（extra 或 wrong-pitch pair），禁止留给下一目标。
2. `tl-late-600-phase` 的 4 个 WRONG_PITCH 是级联的次生伤害：候选应以"局部相位阶跃"解释 +300..+600 的持续偏移，恢复逐音正确身份，同时**保留原始 onset 误差**（PRD §3.3 的双事实）。
3. 早音行为是当前正确基线，候选不得为修晚音而改变早音语义（`tl-early-300-control`、`tl-local-deviations` 必须保持满分）。
4. 既有 hard case（`tl-cross-hand-unison` / `tl-wrong-pitch` / `tl-mixed-errors` / clean）仍是强制阻断回归集。

## 6. 状态与未验证项

- **PASS**：Rust 全套（184 项 rhythm-core + workspace 12 个测试二进制全绿）；基准 deterministic 双跑一致；冻结输出与 `5e8d9de` 逐字节一致。
- **NOT RUN**：NAPI `alignPerformancesTraced` 已有 Node 冒烟验证（手工），未接入基准 runner（候选对比时再接）。
- **未验证**：真机 trace（Gate A 缺口，待 §6.3 手工录制协议）；本报告全部为合成数据结论。
