# V1 实施审计（RHYTHM_TRAINER_SCORING_REQUIREMENTS_v1.0 对照）

审计基准：本仓实际 HEAD（core 0.4.0 / frontend 0.4.0）。所有结论以文件/函数为证。

## 1. 仓库结构与构建

| 部分 | 位置 | 构建/测试 |
|---|---|---|
| Rust core | `crates/rhythm-core`（零第三方依赖） | `cargo test`（本机 GNU fallback，见 README） |
| N-API bridge | `bindings/node`（napi-rs 2） | `npm run build` |
| 引擎服务 | `../rhythm-trainer-frontend/server/engine-server.mjs` | `npm run selftest`（59 断言） |
| 前端 | `../rhythm-trainer-frontend`（React+Vite） | `npm run build` + `vitest`（9 解码器测试） |

## 2. 差距矩阵（v1.0 需求 ↔ 现状）

| v1.0 能力 | 状态 | 证据 / 缺口 |
|---|---|---|
| Raw MIDI Packet（source/seq/mono time/raw bytes） | implemented | `midi.rs RawMidiPacket`（v0.6 契约）；TS 侧 `midiAdapter` 只发 packets |
| velocity=0 → Note Off | implemented | `midi.rs decode_ingest_packet` + 测试 |
| Note On/Off 配对（重复音/缺失/孤立/歧义） | implemented | `midi.rs KeyLifecycleTracker`（source+channel+note 键、FIFO、AmbiguousPairing） |
| CC64 独立、不混入按键时长 | implemented | `midi.rs`（CC 仅解码）+ 测试 `cc64_messages_do_not_touch_key_lifecycle` |
| 确定性重放 | partial | `track_key_lifecycles`/`replay_score` 纯函数确定性有测试；**整会话 snapshot/replay API 未做** |
| MusicXML parser | **absent** | 仅 `sampleScore.ts` UI fixture；无任何解析器。ScoreEvent 契约含能力标记字段（本轮定义），子集解析器列 Phase 1 尾 |
| Score event ↔ performed 对齐 | **absent→本轮实作** | 现有 `HitMatcher` 只做节拍网格 onset 匹配（无音高/漏音/额外音/和弦对齐） |
| 音高/起音/IOI/速度比/抖动/漂移/补偿 | **absent→本轮实作** | 现有只有全体 mean/MAE/stddev（`stats.rs`）——无局部 IOI、无漂移、无补偿检测 |
| 按键时长分析 | implemented（v0.3） | `assess_presses` |
| 连续性/完成度/休止违规 | **absent→本轮实作** | |
| 整曲/小节/区间/声部报告 | **absent→本轮实作（小节/区间；声部以 part 过滤）** | |
| 样本数/置信度/权重归一化 | **absent→本轮实作** | |
| 版本化评分配置 | **absent→本轮实作**（`ScoringConfig`） | 现有阈值散落（`teaching.rs DiagnosisThresholds`、`DurationPolicy`） |
| 诊断（类别/证据/事件关联） | partial | `teaching.rs` 有 8 条规则但无 scoreEventIds 关联与小节范围；本轮 v1.0 诊断另建，教学规则保留 |
| PracticeProfile / 模式配置 | **absent→本轮实作核心配置** | 前端五模式目前仅影响目标筛选与 pitch 提示（用户观察属实） |
| 渐进提速 | **absent→本轮实作核心闸门** | |
| 历史对比 / JSON 导出 | partial | 会话 JSON 已持久化；兼容性对比未做 |

## 3. 风险

1. `HitMatcher`（节拍网格）与 v1.0 对齐引擎并存——两者用途不同（模式A节奏网格 vs 乐谱对齐），保留并列，文档标明用途边界。
2. 旧 `teaching.rs` 诊断与 v1.0 诊断并存——教学规则保留（模式A用），v1.0 诊断针对乐谱对齐报告。
3. 乐谱位置用 ticks（整数）为准，避免浮点拍位累计误差；对外输出 ms 由 tempo 换算。
4. 本机无 MSVC/无 SP-A500：MSVC 构建与实机项未验证。

## 4. 分阶段计划

- **Phase 1（数据可信）**：v0.6 契约已完成大半；本轮补 ScoreEvent 契约（ticks+能力标记字段）。MusicXML 子集解析器 = 下一里程碑（absent，如实标记）。
- **Phase 2（可解释评分）**：本轮实作 `scoring_v1.rs`（对齐+指标+评分+诊断+报告）＋ A–O 验收测试。
- **Phase 3（练习流程）**：本轮实作 PracticeProfile 配置＋渐进提速闸门＋练习区间推荐；历史对比/导出部分完成（JSON 持久化已有，兼容性对比未做）。
- **Phase 4**：不做。
