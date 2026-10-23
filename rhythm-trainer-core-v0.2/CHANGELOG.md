# Changelog

## Unreleased — NAPI scoring_v1 export and chord-group alignment

- **NAPI `scorePerformance`**: `bindings/node` now exposes the existing
  `rhythm_core::score_performance` report through JS. Inputs are per-note
  `ScoreEvent` and `PerformedNoteV1` DTOs; output includes per-note
  `MATCH` / `WRONG_PITCH` / `MISSING` / `EXTRA` / `AMBIGUOUS` event results,
  pitch/onset/rhythm/duration/continuity metrics, measure reports, overall
  (including `renormalized`), confidence, diagnostics and practice ranges.
  The implementation calls the Rust core directly; there is no second
  TypeScript scoring algorithm.
- **Chord-group alignment**: `align_performances` now groups targets with the
  same onset and matches that group by pitch before advancing the monotonic
  cursors. A human chord spread across a few milliseconds and played in a
  different pitch order is no longer reported as missing/wrong/extra. A note
  at or after the next distinct target onset is not consumed by the chord.
- **Acceptance**: added p–u to `tests/scoring_v1_acceptance.rs` (extra/missing
  do not cascade, wrong-pitch vs extra, repeated pitch, chord spread, missing
  release). The full Rust workspace passes 110 tests, including the 21 scoring
  acceptance tests. The addon was rebuilt with the GNU toolchain and
  `scorePerformance` was verified through Node.
- **Boundary**: this is a deterministic post-finalize API. It does not add live
  scoring, a second matcher, or hardware validation. `parse_confidence` remains
  carried metadata and is not used by the current scoring metrics.

## v0.5.0 — v1.0 评分引擎（对齐 + 可解释指标 + 诊断 + 练习计划）

按 `docs/SCORING-REQUIREMENTS-v1.0.md` 实作 Phase 1–3 核心（`scoring_v1.rs`），
验收测试 A–O 全数落实于 `tests/scoring_v1_acceptance.rs`（15 个测试）。

- **对齐**（`align_performances`）：单调贪心 + 音高前瞻（§5.2 允许等效算法），
  漏音/额外音/错音分类、和弦簇支援、max_deviation 窗口；错音插入按代价模型配对为
  wrong-pitch（3.0 < miss 4.0 + extra 2.5），后续音符不错位（验收 D）。
- **指标**：音高（recall/precision、错音/漏音/额外）、起音（signed mean/median、MAE、
  P50/P90、容差外比例）、节奏（匹配对局部 IOI 速度比、MAD 抖动、每目标序号漂移斜率、
  **节奏补偿检测**——结尾对齐但内部抖动高 ≠ 稳定，验收 A）、按键时长（仅 complete
  配对，ratio/过短/过长）、连续性（覆盖率/最长连续/小节覆盖）、小节 rollup。
- **评分**：五分项（pitch/onset/rhythm/duration/continuity，默认权重 30/20/30/15/5），
  缺数据分项标 `unscored` 并**重归一化剩余权重**（验收 L），原始指标全部保留。
- **诊断**：global-offset / local-jitter / rhythm-compensation / tempo-drift /
  missed-notes / extra-notes / pitch-errors / duration / rest-violation /
  low-confidence；每条含 evidence（指标+样本数+阈值）、confidence、suggestedAction、
  score_event_ids / performed_event_ids（验收 O）。固定延迟与演奏偏差分离（验收 B）。
- **练习计划**：按小节漏音/误差推荐 1–3 个练习区间；`PracticeProfileV1` 渐进提速闸门
  （连续 N 次达标 +stepBpm、封顶 maxTempoBpm、单次失败维持、连续失败按 fallbackBpm
  回退且下限 40 BPM，验收 N）。
- 边界：空/单样本/除零/异常时间戳/负时长均有测试；`Confidence` 分级显式报告。

已知缺口（下一里程碑）：MusicXML 解析器仍缺（ScoreEvent 契约已含能力标记字段，
fixture 直接喂 ScoreEvent）；N-API `scorePerformance` 导出与前端报告 UI 接线已在
Unreleased 完成；历史对比的兼容性判定仍未做。

## v0.4.0 — v0.6 权威事件契约（RawMidiPacket → decode → key lifecycle）

按 `docs/EVENT-CONTRACT-REDESIGN-v0.6.md` 实作（golden fixtures 全过）。

- 新模组 `midi.rs`：`RawMidiPacket`（sourceId/sourceSeq/clockDomainId/capturedAtMs/
  handlerAtMs/rawBytes/transport）→ `IngestMidiPacket`（+sessionTimeMs/clockMappingId/
  uncertainty/quality）→ `decode_ingest_packet()`（Note On、0x80 与 9nH,V=0 两种 Note Off、
  CC、Poly/Channel Pressure、Program Change（两字节不越界）、Pitch Bend 14-bit、
  truncated/unknown → Other+diagnostic）→ `KeyLifecycleTracker`（按
  sourceId+channel+noteNumber 配对，FIFO 同音重叠→AmbiguousPairing、orphan/missing/
  interrupted 诊断、seq gap/duplicate/regressed/time regression/clock domain change 诊断）。
- 时值只由 `complete` 配对以同源捕获时间差计算；ambiguous/missing/interrupted 一律
  `unknown`，绝不猜测。CC64 只是 ControlChange，不碰按键状态。
- 单一配对实现：`duration.rs` 的 `pair_note_events` 改为旧契约的薄适配层，内部走同一
  tracker；`assess_presses()` 为唯一时值评分入口（`assess_durations` 变 legacy 包装）。
- N-API：`decodeMidiPackets`、`trackKeyLifecycles`、`assessKeyPresses`。
- Golden fixtures：`test-fixtures/golden-midi-traces.json`（v0.6 资料包附带的 7 个案例）
  + `examples/golden-fixtures-run.mjs` 全过（含 replay determinism）。
- 已知缺口（M3/M4）：`RawMidiPacket` 尚未带 channel（decoder 由 status byte 推导 channel，
  tracker 按 source+channel+note 配对已就绪）；`NativeSessionEngine.ingestPacket` 完整
  snapshot/replay API 与 `EngineOutput` 统一 UI DTO 属下一里程碑；本仓 snapshot/replay
  仍以原始事件重放为主。

## v0.3.0 — 按键时值评估（Note On/Off 配对，v0.3 需求 M1+M2）

按 `docs/DURATION-REQUIREMENTS-v0.3.md` 实作。三条时间线刻意分开：起音误差（何时按下）、
按键时长（按了多久 = Note Off − Note On）、起音间隔（到下一个起音的间距）——三者不得互换。

- 新模组 `duration.rs`（纯函数、可回放）：
  - `pair_note_events()`：Note On/Off 配对。FIFO 处理同音重复（永不覆盖未闭合音符）、
    velocity=0 的 Note On 正规化为释放、孤立 Note Off 计数（永不产生负时长）、
    未闭合 Note 标记 `OpenNoteInterrupted`、同音重叠标记 `OverlappingSamePitch`。
  - `assess_durations()`：以起音匹配结果（judgment `strike_seq` ↔ performed `onset_seq`）对齐，
    按 `DurationPolicy` 评分。策略：`strict-keydown`（名义时值即目标按键时长，容差取
    `max(tolerance_ms, nominal×ratio)`）与 `disabled`（只记录不评分）。缺 Note Off、
    未匹配起音、无可信目标时值一律 `Unknown`，绝不猜测。
- `TargetHit` 新增 `nominal_duration_ms`：由 merged atoms 的 duration_ticks 按当前速度换算
  （和弦取最长）。时值源头是谱面拍数，不是实测猜测；速度改变只改毫秒换算。
- `CoreError::InvalidConfig` 新变体。
- 10 个新单元测试覆盖规格 §10.1/§10.2/§11 的核心场景（时值与 IOI 分开、velocity=0、
  同音重复 FIFO、孤立 Off、缺 Off=unknown 非 0、容差边界包含、disabled 只测量、
  未匹配只报测量值、tempo 换算、和弦取最长时值）。全套 47 个 Rust 测试通过。
- N-API：新增 `assessDurations(targets, rawEvents, judgments, policy)`；`JsTarget` 带
  `nominalDurationMs`。前端/引擎服务的逐音时值反馈与聚合（偏短/偏长比例、平均时值误差）
  由该单一核心实现驱动。
- 新示例 `examples/note-value-demo.mjs`：四分 vs 八分密度的判定行为对照。
- 明确未做（M3/M4）：即时（非回放）时值反馈、articulation-aware 策略（连线/断奏/踏板语境）、
  MusicXML 声部对齐。页面现按住虚拟键或 MIDI 抬键即产生 Note Off。

## v0.2.1 — first verified build + property/benchmark tests + student-model persistence

- Added `demo/`: a local browser spacebar closed loop (Web Audio metronome +
  WebSocket + the Rust core via the N-API addon; loopback only, no scoring in
  the page). Verified end-to-end in a browser: synthetic hits landed as
  Perfect/Good with correct signed errors, count-in hits are Extras, missed
  targets finalize as Miss, and the report drives `analyzeTiming` coaching
  output.

- Fixed the never-compiled source: corrected `DiagnosticContext`/`DiagnosisThresholds`
  re-export names in the crate root and the N-API binding. The full workspace now
  compiles and all tests pass on Windows (GNU fallback toolchain documented in README).
- Fixed the JS examples and README to the real camelCase napi-rs contract
  (`atMs`, `startTick`, `ticksPerQuarter`, ...), matching the generated `index.d.ts`.
- `examples/node-smoke-test.js` is now a real assertion-based smoke test (grades,
  determinism, StudentModel roundtrip) that exits non-zero on failure.
- Added property-style tests (`tests/property_tests.rs`) with a deterministic xorshift
  generator: schedule windows never overlap, matcher outputs satisfy count/uniqueness/
  window invariants, final replay is deterministic and arrival-order independent,
  ring buffer preserves FIFO order under random push/pop with visible overflow.
- Added the PRD-required repeatable benchmark (`tests/benchmark.rs`): 10,000 targets +
  10,000 events through replay + statistics + feature extraction + diagnosis.
  Measured p95 ≈ 5.2 ms in release (budget 100 ms) on the reference Windows machine;
  the test asserts the budget so regressions fail loudly.
- Added `StudentModel::snapshot()/restore()` with duplicate/empty skill-id rejection
  (`CoreError::InvalidSnapshot`) and `skill_count()`.
- Changed `observe_attempt`: untrusted or below-minimum attempts no longer create a
  skill entry, so evidence-less observations leave no trace in persisted snapshots.
- Exposed `NativeStudentModel` through the N-API binding (constructor with optional
  restore data, `getSkill`, `observeAttempt`, `snapshot`, `skillCount`).

## v0.2.0 — explainable teaching foundation

- Added timing feature extraction: signed/absolute timing error, median, standard deviation, linear drift, miss/extra rates, and tagged rest-re-entry/offbeat group comparisons.
- Added a deterministic diagnosis ruleset with explicit evidence, severity and evidence-support labels.
- Added conservative exercise prescriptions linked to the top diagnostic finding.
- Added a rule-based student skill history with developing/provisional/consolidated/needs-review states.
- Added N-API `analyzeTiming` binding and TypeScript declarations.
- Added tests for timing-bias detection, untrusted-input suppression, offbeat grouping, exercise mapping, and mastery evidence requirements.

Limitations remain: no MusicXML importer, polyphonic score/MIDI alignment, pitch/duration/articulation diagnosis, or persisted N-API StudentModel in this version. The generation environment does not have Rust/Cargo installed; `cargo test` and native addon compilation have not been run here.
