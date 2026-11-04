# Alignment V2 DP 候选评估与 Gate 决策记录

- 日期：2026-11-04
- 分支：`feat/teaching-experience-v1`
- 依据：`Rhythm_Trainer_Offline_Alignment_V2_PRD_and_Validation.md`（V1.0，Task B/C/D）+ `TS_RUST_PARITY_GATE_V1.md` 之外的对齐研究线（stage3/4/5 报告）
- 性质：本地验证（仓库无 CI，无 status checks；"通过"仅指本机复跑结果）
- 代码证据：`8632aba`（V2 域模型+标签 schema）、`5333b6e`（加权 DP 候选）、`1180a1d`（5 个 v2 场景）、`78cacce`（runner --dp + 指标）、本提交（性能实测 + 本报告）

## 结论（一句话）

**WeightedSequenceAlignerV2（块级带状 DP）作为候选算法通过合成范围 Gate B 与性能 Gate D；Gate A（真机数据）仍为 0 条、如实 BLOCKED；不发生任何生产默认切换，且现存默认打分器与 PRD 1.4#6 的偏差单独列为待用户 ADR 项。**

## 实现摘要

- `alignment_dp_v2.rs`：onset 块级带状 DP（`D[g][h] = min(块配对, 整块漏, 整块多)`），块内精确子集 DP 分配（确定性：降序 j + 严格 `<`，平局取前向字典序最小排列）；软时间代价（`|Δ|/tau` 封顶，永不硬拒）、有限错音代价；`AlignmentDpConfigV1` 全参数显式 + sha256 参数指纹；`max_cells` / `max_block_notes` 预算超限返回 `ALIGNMENT_RESOURCE_LIMIT`。行窗口化存储 `[lo_r, hi_r]` + extra 前缀和修正，窗口下沿 extra 转移经支配性证明省略——复杂度 O(G×W)。
- `score_performance_dp_v2`：复用 frozen v1 报告构建器（公式/权重/报告形状零改动），仅换对齐与版本戳 `scoring-v1.0.0+alignment-dp-v2`；资源超限回退 legacy 并**盖 legacy 版本戳**（不伪装成 V2 结果）。
- NAPI：`alignPerformancesDpV2`（含 ambiguousGroups/diagnostics/status/parameterFingerprint）与 `scorePerformanceDpV2`。
- 基准：数据集 30 → 35（新增 `tl-clock-degraded-v2`、`tl-pause-resume-v2`、`tl-same-time-diff-pitch`、`tl-adversarial-mixed`、`tl-selection-pass-boundary`，v2 标签 AJV schema-first 校验）；runner 新增 `--dp` 模式、级联计数（标签 clean 尾部上的预测偏差）、local IOI 残差对比、歧义覆盖率、资源限制状态。

## 门槛核对

| Gate 条件 | 实测 | 是否满足 |
|---|---|---|
| **B：硬集 macro F1 至少 +5pp**（对照 frozen v1） | hard-12 集：v1 0.8946 → DP **1.0000**（+10.54pp）；candidate 0.9952 | ✅ PASS（合成范围） |
| **B：hard 错配减少 ≥20%**（替代门槛） | DP 硬集错配 7 case → 0（-100%） | ✅ PASS |
| **B：clean F1 下降 ≤1pp** | `tl-clean-exact` 及 clean 组三算法均 1.0000，零退化 | ✅ PASS |
| **B：强制阻断回归集**（cross-hand-unison / wrong-pitch / mixed-errors / clean） | DP 全部 1.0000；cross-hand unison 输出确定性排列且 `assignment_ambiguous=true` + `SAME_PITCH_ASSIGNMENT_AMBIGUOUS` 组（PRD 要求歧义如实标记——该 v1 标签断言了物理上不可辨的具体排列，DP 与其一致且同时声明歧义） | ✅ PASS |
| **B：原始时间不被改写** | `onset_error_ms` 恒为原始差值；`validate_alignment_result_v2` 强校验（washing 值直接报错）；迟到配对保留 raw +300/+600 并发 `LATE_BUT_PAIRED_BEYOND_LEGACY_WINDOW` 诊断 | ✅ PASS |
| **B：确定性双跑** | 三模式两次运行 canonical hash 一致（`deterministic=true`，exit 0） | ✅ PASS |
| **B：资源超限不崩溃、不伪装** | 20 同 onset 音块 → `ResourceLimit`；`max_cells=10` → `ResourceLimit`；`score_performance_dp_v2` 回退并盖 legacy 版本（测试钉死） | ✅ PASS |
| **A：真机 ≥20 次 Take、4 类曲目/3 类错误强度、第三方复核** | 真机 MIDI 录音 **0 条**（audit-r1 全库无设备 trace；现有 QA 沙盒 trace 全部来自 mock node-midi） | ⛔ BLOCKED（与 stage3/root-cause/sidecar 报告一致，未恶化） |
| **C：Rust/NAPI 旧 wire 未变** | frozen `scoring_v1` 公共 API/行为零改动（`traced_and_frozen_results_are_identical` 等既有测试全绿）；`scorePerformance` 字节级不变；新端点全部独立导出 | ✅ PASS（代码事实） |
| **C：集成/前端/P08 消费** | 本轮未接入 engine-server/P08（DP 仅 benchmark/shadow 可达）；`RHYTHM_ALIGNMENT_SHADOW=1` 影子链路仍只对比 candidate | ⬜ NOT_STARTED（符合 PRD：未过门禁不集成） |
| **D：100–2000 音 P95 ≤2s（建议预算）** | 2000 音：DP 对齐 54–158ms、完整打分 73ms（本机 release addon，含 +300ms 相移最坏例）；5k：对齐 125–157ms / 打分 243–249ms；10k：对齐 257–300ms / 打分 769–784ms，线性扩展，RSS ≤74MB。产物 `alignment-v2/out/performance-local.json`（status=pass，gitSha 见文件） | ✅ PASS（本机实测；非统计保证） |
| **D：超限回退保留旧结果** | 见 B 资源行；回退路径有 Rust 测试 | ✅ PASS |
| **E：生产切换授权** | 未请求：DP 未接入 engine-server，无新默认开关；shadow 仍 opt-in `RHYTHM_ALIGNMENT_SHADOW=1` | ⬜ NOT_REQUESTED |

### 逐算法对比（28 timeline cases，deterministic 双跑）

| 集合 | frozen v1 | rule candidate | **DP v2** |
|---|---|---|---|
| 全部 timeline F1 | 0.9473 | 0.9976 | **1.0000** |
| 全部 timeline class accuracy | 0.9291 | 0.9955 | **1.0000** |
| hard-12 F1 | 0.8946 | 0.9952 | **1.0000** |
| clean F1 | 1.0000 | 1.0000 | **1.0000** |
| 级联错误（clean-tail） | 0 | 0 | **0** |
| local IOI MAE vs label | 0 ms | 0 ms | **0 ms** |
| 失败 case | tempo-drift、one-note-400ms-late、late-300-return、late-300-phase、late-600-phase、early-300-control、adversarial-mixed | early-300-control（0.933） | **无** |

`tl-early-300-control` 对 DP 为 1.0000（candidate 保持 0.933 不变——早音单侧改进非本轮目标）。

## 已知缺口（如实）

1. **Gate A 真机数据 0 条**：所有"1.0000"均为合成构造标签上的结论。合成集无法覆盖真实设备时钟抖动分布、真实错音强度分布与跨手真实演奏。
2. **歧义语义与 v1 标签的张力**：`tl-cross-hand-unison`（v1 标签）断言了一个物理上不可观察的具体排列；DP 恰好给出同排列并如实标 `assignment_ambiguous`。若真机排列不同，DP 的确定性分配同样"正确但不可辨"——需 v2 标签的 `ambiguousPairs` 域（schema 已支持，真机标注时使用）。
3. **相位变化检测未实现**：`phaseChangeCount` 仅作标签记录，预测属 Task E（TimingAnalyzerV2）范围。
4. **配置标定来自验收测试而非学习**：`AlignmentDpConfigV1::default()` 的代价数值由 21 个验收测试钉行为，未经真机标注集校准；PRD §4.4 要求阈值由标注集校准后写入配置版本。
5. **默认打分器与 PRD 1.4#6 的偏差（待用户 ADR）**：当前 `engine-server.mjs` 的 `RHYTHM_FINAL_ALIGNMENT_SCORER` 默认为 `candidate`（远端合并 `096f4d8` 所置），而 PRD 验收定义 #6 要求"未过门禁不切换，默认继续 scoring_v1"，且 Gate A 真机数据仍为 0。本轮**未改动该默认**。选项：(a) 回滚默认 legacy，candidate/dp 走 env 显式开启；(b) 维持 candidate 默认并接受其作为灰度实验。需用户明确批准其一；在 ADR 之前本报告不宣称任何"算法升级上线"。
6. Parangonar 对照未重跑（本机无 .venv；stage4 结论保持有效且未被推翻——本轮 DP 是与 DualDTW 不同的候选路线）。

## 决定

- WeightedSequenceAlignerV2 保留为**候选算法**：仅 benchmark（`--dp`）、shadow 与显式 opt-in 入口可达；不新建生产默认开关，不改动 `engine-server.mjs`。
- 不重写旧 golden：30 个 v1 case 的 trace/labels/期望零改动；新场景全部为新增文件。
- 不改冻结 `scoring_v1` 公共语义；报告构建器复用是共享代码路径而非语义变更（既有 229 项 rhythm-core 测试全绿）。
- Task E（TimingAnalyzerV2 / P08 诊断 / V2 评分策略）按 PRD 门禁**不启动**。

## 后续触发条件

1. 真机采集 ≥20 次独立 Take（覆盖 4 类曲目/节奏、3 类错误强度、双手和弦/重复音，第三方复核关键错误片段）→ 重跑 Gate A；在此之前任何生产切换都是未授权的。
2. 用户就"默认打分器"（candidate 保持 vs 回滚 legacy）出具 ADR → 修改 `engine-server.mjs:134` 一行 + 对应协议测试期望。
3. 真机标注集到位后校准 `AlignmentDpConfigV1` 代价并升级参数指纹版本。
4. Gate A+B 同时 PASS 且用户批准后，方可按 PRD Gate E 流程申请小范围 shadow/opt-in 上线。

> DP 在合成集上把硬集从 0.8946 修到 1.0000 这一事实，与 stage5"Parangonar 未达标不替换"不矛盾：那是另一条候选路线的结论，本报告的门槛与豁免均以本轮实测为准，且全部未触发生产路径。
