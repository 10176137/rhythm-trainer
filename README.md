# Rhythm Trainer

钢琴节奏/乐谱练习工具：浏览器端 React 应用 + 本地 Node 引擎服务 + Rust 评分内核。

- **rhythm-trainer-frontend** `0.6.0` — React 19 / Vite 6 / TypeScript 5.8。语义乐谱域在 `src/score-engine/`（精确有理数拍、MusicXML importer、PlaybackPlan、参考播放），OSMD 2.2.1 负责渲染；`server/engine-server.mjs` 是本地引擎服务（WebSocket + REST，默认 `127.0.0.1:8788`），持有 Rust addon、Session/Take 编排、Trace/Journal 与持久化。
- **rhythm-trainer-core-v0.2** `0.5.0` — Rust 领域核心（`scoring_v1` 对齐与指标、`midi.rs` 解码/key lifecycle、`take.rs`、`schedule.rs`）与 napi-rs 绑定（`bindings/node`）。
- **audit-r1** — R1 阶段的迁移审计交付物与实测证据，未改动生产代码。

## 当前状态

**G0 真机验收已通过（2026-10-23）**：受控错音（A）、P09 前后比较（B）、暂停边界（C）、断连/重连（D）全部在实体 SP-A500 上完成并记录；证据与过程中发现并修复的缺陷（未松键 releaseMs、拔线进程崩溃）见 [G0_HARDWARE_EVIDENCE.md](G0_HARDWARE_EVIDENCE.md)。
- R1 审计已完成，等待审核；R2/R3 尚未开始实现。
- 测试基线：前端 30 文件 / 175 项；引擎 selftest 155 条断言；Rust 110 项（GNU target）；`tsc -b && vite build` 通过。

## R1 关键结论

1. **单一权威计划尚未成立**：实时目标来自 Rust `buildSchedule`（atoms），最终评分目标来自前端 `buildEngineScoreEvents`（scoreEvents）；服务端只用 onset 是否落在某 target 的 0.5 ms 内互验，不校验 pitch、数量、ID 唯一性、measure 覆盖。
2. **没有 planFingerprint**：`playbackPlanId` 只是字符串，且无法校验。
3. **OSMD 2.2.1 不保留 MusicXML `note@id`**（10 个 case 内部对象与 DOM 命中数均为 0）；现有 adapter 的 `measure:staff:voice:pitch` 在重复同音时碰撞，且其自检仍报 PASS。
4. **时钟是单点 offset，无分段**；`getOutputTimestamp()` 在音频渲染前返回 `{0,0}`，直接使用会得到假的零延迟。
5. **路线决策：路线 A**（冻结语言无关的 `ScoreDocumentV1`，R2 用 Rust 做 planner，R3 再替换 importer），附四项前置修复与切换到路线 B 的触发条件。

完整证据、失败边界与未验证清单见下方文档。

## 审计文档索引

- [迁移审计（总报告）](audit-r1/docs/POST_B2_1_MIGRATION_AUDIT_v1.1.md)
- [OSMD 锚点 Spike](audit-r1/docs/SCORE_ANCHOR_SPIKE_REPORT.md)
- [时钟域契约](audit-r1/docs/CLOCK_DOMAIN_CONTRACT.md)
- [R2/R3 路线决策](audit-r1/docs/R2_R3_ROUTE_DECISION.md)
- [Golden Fixtures 真值规则](audit-r1/docs/GOLDEN_FIXTURES.md)
- [Hand 与多 Part 契约](audit-r1/docs/HAND_AND_MULTIPART_CONTRACT.md)
- [R1 收尾实施报告](R1_CLOSEOUT_IMPLEMENTATION_REPORT.md)
- [G0 真机验证执行手册](G0_HARDWARE_VERIFICATION_RUNBOOK.md)
- [G0 真机证据记录](G0_HARDWARE_EVIDENCE.md)
- [开发者架构（同步至 1b48e8e）](audit-r1/docs/DEVELOPER_ARCHITECTURE.md)
- [ScoreDocumentV1 契约](audit-r1/docs/SCOREDOCUMENT_V1_CONTRACT.md) · [planFingerprintV1 契约](audit-r1/docs/PLAN_FINGERPRINT_V1.md) · [R2-0 实施报告](R2_0_CONTRACT_FREEZE_REPORT.md)

原始证据：`audit-r1/fixtures/`（G1–G8 极简 MusicXML）、`audit-r1/spike/out/`（importer dump、OSMD 10-case JSON、真实谱跑通结果、18 组 TS/Rust 时间线交叉验证）。

## 运行与测试

```bash
# 前端
cd rhythm-trainer-frontend
npm install
npm test            # vitest
npm run build       # tsc -b && vite build
npm run server      # 本地引擎服务
npm run selftest    # 引擎自测（无需真机）

# Rust（本机无 MSVC，必须用 GNU target）
cd rhythm-trainer-core-v0.2
export PATH="$HOME/dev-tools/w64devkit/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="$HOME/dev-tools/w64devkit/bin/gcc.exe"
cargo test --target x86_64-pc-windows-gnu
```

## 未包含在仓库中

`node_modules/`、`target/`、`dist/`、原生 `.node` 产物、以及仅用于本地 OMR 测试的第三方乐谱与谱面截图（见 `.gitignore`）。真实练习数据存放在 `%APPDATA%\rhythm-trainer-frontend`，不进入版本库。
