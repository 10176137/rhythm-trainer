# R2-3d §2 只读盘点（任务卡 §2；基线 `6d596ba`，冻结 Gate blob `29d7e6ea…` 核验一致）

## 1. 现有测试与确切命令（以仓库为准）

| 证据项 | 现有资产 | 命令 | 状态 |
|---|---|---|---|
| E2 主体 | `rhythm-trainer-frontend/src/score-engine/parity/rust-parity.test.ts`（15 case 三方对拍：`loadExpected` 独立真值 vs TS 现跑 vs Rust NAPI 现跑；冻结判据 reportPasses；expectedOutcome 双侧校验；L1 指纹；L3 不变量） | `npx vitest run src/score-engine/parity/rust-parity.test.ts` | **已有**；缺 §7 语义点映射标注 → E2 增量 |
| E3/V（Rust） | `crates/rhythm-core/tests/contract_v1_vectors.rs`（6 向量 canonical bytes + 哈希 byte-exact，含 UTF-16 非 BMP 负例） | `cargo test --locked --target x86_64-pc-windows-gnu --test contract_v1_vectors` | **已有**；缺逐向量明细 JSON → E3 增量 |
| E4-A（TS） | `acceptance-a.test.ts`（reuse map 钉住 contract-v1.test.ts 四锚点 + N-PITCH-S2 新增断言） | `npx vitest run …/acceptance-a.test.ts` | TS 侧**已有**；Rust 侧等价执行缺失 → 补 |
| E4-B（TS） | `acceptance-b.test.ts`（FAULT_SPECS 六故障，对 TS 候选注入，断言路径+semantic-defect+fail） | 同上 | TS 侧**已有**；Rust 候选注入缺失 → 补 |
| E4-C（TS） | `acceptance-c.test.ts`（消息锚点→规范码映射 + 契约层 reuse）+ `normative-codes.ts` | 同上 | TS 侧**已有**；Rust 侧四规范码（duplicate_target_id / invalid_target_pitch / measure_coverage_mismatch / target_outside_prescription_range）**无实现无测试** → 补（Gate §6：Rust 从第一天直接产生规范码） |
| E4-V | `acceptance-v.test.ts`（`RUST_V_CLASS_STATUS='DEFERRED_TO_R2-3'`；仅 TS 侧向量存在性+手工表） | 同上 | **缺口**：需 NAPI 导出 Rust 原语（compute fingerprint / canonical bytes）并由 acceptance-v 实际执行 6 向量后翻转 |
| E5 | `real-score-parity.test.ts`（TS 侧；`RHYTHM_REAL_SCORE_PATH` 缺失=**skip**；冻结 113/1579/1018/1018 + capabilities 五枚举 `['chords','multi_staff','multi_voice','ties','tuplets']` + 指纹重复稳定） | 设 env 后 `npx vitest run …/real-score-parity.test.ts` | TS 侧**已有**；Rust 侧真实谱回归缺失 → 补（实跑非 skip） |
| E1 | golden 手工真值 `audit-r1/fixtures/golden/g{1..5}.expected.json` + 转换器 `goldenToExpected`（case-bundle.ts） | — | Rust 侧逐字段 exact 对照缺失 → 补（直读 golden 原始字段做对照明细） |
| E6 | R2-3c 报告形状 `r2-3c-dual-run-report-v1`（已承载双侧 gitSha/plannerVersion/契约版本/逐 case diffs 全文） | — | E6 需新的 `r2-3d-migration-evidence-v1` 汇总形状（E1–E7 逐项）→ 新建，不覆盖 R2-3c 报告 |

## 2. 冻结基准与来源核实

- **向量标识**：`V-single` / `V-rest-gap` / `V-chord` / `V-tie` / `V-hand`（5 规范整数 BPM）+ `V-rational-bpm`（175/2 BPM、count-in 35/8）——§7"至少一个非整数有理 BPM 向量"已由 R2-2 补齐，**无需新增向量提案**。
- **真实谱基准**：113 measures / 1579 occurrences / 1018 groups / 1018 atoms / capabilities 恰五枚举（`real-score-parity.test.ts` FROZEN_COUNTS，来源 R1/R2 audit 实测，路线决策 §3.2）。真实谱文件 `score-latest.musicxml` 为 **gitignored 本地第三方文件**：E5 实跑使用本地文件，证据记录来源说明 + sha256 校验值 + 实际路径与环境，并明确标注 GitHub 复审方不可独立复跑该项（无文件）。测试缺失环境为 skip——E5 证据必须来自实际执行的运行并区分 skip。
- **指纹稳定性方法**：重复**完整**流程比较（R2-3c 复审确立的判据：候选/计划逐字节相同且门禁结果相同），E5 同法。
- **C 类码表**（Gate §6 映射表）：4 个候选输出规范码 Rust 侧需新建同层校验（`contract_v1/normative.rs`，镜像 `normative-codes.ts` 判据，不改生产 server）；其余 C 项（N-ID-C2/C3a-c、N-PITCH-C2、N-FP-C1..C4）Rust 已有机器码与测试（a2/a3/b/c 各轮），E4-C 做逐项映射核对。
- **B 类注入对象**：Rust 候选（NAPI 实时产出）为被篡改侧；冻结 bundle/golden 只读；diffCandidates 断言路径+分类+报告 fail。

## 3. 缺口实施清单（获批范围）

1. `contract_v1/normative.rs`：候选输出目标校验（4 规范码）+ 单元测试（C 类 Rust 层）。
2. NAPI 增量导出 `computePlanFingerprintV1Json` / `canonicalBytesJson`（E4-V 的 Rust 实际执行通道）+ addon 重建 + acceptance-v 接入翻转（有实际执行支撑）。
3. Rust E4-A：对提交向量 payload 的敏感性/不变性测试（N-PITCH-S1/S2、N-FP-S1 九项、N-FP-S2）。
4. Rust E3：逐向量明细证据 JSON。
5. TS E1：G1–G5 golden 原始真值逐字段 exact 对照（Rust 侧）。
6. TS E4-B：六故障对 Rust 候选注入。
7. TS E5：真实谱 Rust 回归（实跑；来源+sha256+路径留痕；skip 显式记录为 NOT RUN）。
8. E6/E7：`r2-3d-migration-evidence-v1.json`（逐项 E1–E7、命令、case ID、期望/实际、L1/L2/L3、稳定性、规范码、diffs 全文、双侧 SHA/版本；先写盘后断言）+ gate matrix + Markdown 摘要。

## 4. 规范歧义

无 BLOCKED 项：所有基准（计数/五枚举/向量/C 类码表/时间协议）均可在冻结资产中唯一定位。
