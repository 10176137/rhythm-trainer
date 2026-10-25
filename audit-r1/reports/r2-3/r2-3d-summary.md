# R2-3d 迁移证据包摘要（§8 七项证据）

**任务卡：** R2-3d（DRAFT 获用户批准启动 @ `6d596ba`；冻结 Gate blob `29d7e6ea7f858d76adc7f21a223cd791dc2b3d74` 核验一致）
**被测代码 SHA：** 见 `r2-3d-migration-evidence-v1.json` 的 `verifiedCodeSha`（实现提交后于该固定 SHA 上执行并生成报告，报告单独提交）。
**结论（E7）：** `READY_FOR_SEPARATE_SWITCH_REVIEW` —— 仅构成切换评审材料；生产权威切换、`RHYTHM_PLANNER=rust` 启用与合并 `main` 均需用户另行授权，本证据包不构成授权。

## E1–E7 状态

| 项 | 状态 | 证据 | 命令 |
|---|---|---|---|
| E1 G1–G5 手工真值逐字段 exact | PASS | `r2-3d-e1-golden-exact.json`（913 项字段检查：occurrences/groups/atoms/scoreEvents/计数） | `npx vitest run src/score-engine/parity/r2-3d-evidence.test.ts` |
| E2 §7 扩展矩阵 | PASS | 报告 `e2.cases[]`（15 case 双管线 L1+L2+L3 + §7 语义点映射）；主套件 `rust-parity.test.ts` | 同上 |
| E3 固定向量 byte-exact | PASS | `r2-3d-rust-evidence.json` `vectors[]`（6 向量含 `V-rational-bpm`） | `cargo test --locked --target x86_64-pc-windows-gnu --test contract_v1_r23d_evidence` |
| E4 P8 A/B/C/V | PASS | A：`r2-3d-rust-evidence.json` `classA[]`（12 项）；B：报告 `e4.classB[]`（6 故障注入 Rust 候选，路径精确+semantic-defect+fail）；C：`contract_v1::normative` 单元测试（4 规范码逐判定）+ `acceptance-c.test.ts`；V：`acceptance-v.test.ts`（`EXECUTED_RUST_BYTE_EXACT`，经 NAPI 原语 6 向量 byte-exact） | cargo 同上 + `npx vitest run src/score-engine/parity/acceptance-v.test.ts` 等 |
| E5 真实谱回归（实际执行） | PASS | `r2-3d-e5-real-score-result.json` | 同 E1 命令（环境含真实谱 fixture） |
| E6 报告归档 | PASS | `r2-3d-migration-evidence-v1.json`（先写盘后断言；失败运行保留证据） | 随 E1 命令生成 |
| E7 切换门槛审计 | READY_FOR_SEPARATE_SWITCH_REVIEW | 报告 `e7`（E1–E6 全 PASS 方为 READY；任一 FAIL/BLOCKED/未执行 → BLOCKED） | 随 E1 命令生成 |

## E5 真实谱证据要点（审计要求逐条）

- **实际执行**：`executed: true`——非 skip；fixture 缺失环境下 E5 记 `NOT RUN` 且 E7 强制 `BLOCKED`。
- **来源**：第三方 OMR 乐谱，仓库 `.gitignore` 策略排除（不入库）；本地保留自 R1 audit 运行；GitHub 复审方无法独立复跑该项（无文件）——此边界已在报告 `e5.provenance` 显式记录。
- **稳定标识**：`fileSha256` 见结果 JSON（sha256 of 实际消费的文件字节）；消费路径与环境记录于同文件。
- **冻结基准命中**：113 measures / 1579 occurrences / 1018 groups / 1018 atoms / scoreEvents 1579；capabilities 恰为 `['chords','multi_staff','multi_voice','ties','tuplets']` 五枚举；Rust 指纹两次完整运行一致；Rust 门禁指纹 == TS 门禁指纹（同 fixture 双管线）。

## 审计纪律执行情况

- 冻结 Gate/golden/expected/case index/Schema/固定向量/wire/`build_schedule`/matcher/`scoring_v1` 零触碰；E5 不修改 gitignore 策略、不提交第三方乐谱。
- E4-V 状态翻转由实际执行的向量测试支撑（原 `DEFERRED_TO_R2-3` 常量若回退会使套件失败）。
- E2 的 `G2 chord × hand` 语义行映射到冻结 case index 的 `G6-A3-*` 系列（和弦 + 双手谱），未新增/改语义。
- 七项证据逐项独立判定；报告先写盘后裁决，失败运行留 JSON 证据并使 vitest 非零退出。
- Rust 侧候选输出规范码为第一日直产（Gate §6 码表边界）：`contract_v1::normative` 四码与 TS `normative-codes.ts` 逐判定镜像。
