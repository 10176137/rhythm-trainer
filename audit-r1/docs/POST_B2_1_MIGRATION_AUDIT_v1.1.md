# POST_B2_1 迁移审计 v1.1（R1 阶段交付物 1/5）

**审计日期：** 2026-10-23
**审计范围：** `D:\123\rhythm-trainer-frontend`（React + TS + Node 本地引擎服务）与 `D:\123\rhythm-trainer-core-v0.2`（Rust core + napi 绑定）
**依据文档：** `RHYTHM_TRAINER_POST_B2_1_ARCHITECTURE_AND_REQUIREMENTS_v1.0.md`、`RHYTHM_TRAINER_ARCHITECTURE_CRITICAL_REVISIONS_v1.1.md`（v1.1 对 v1.0 具有覆盖优先级）
**本次性质：** 仅审计 + 最小 anchor spike + fixture 设计。**未修改任何生产业务代码**（见 §12 变更清单）。

---

## 0. 结论摘要（TL;DR）

1. **架构比 v1.0 文档假设的更接近目标**：真正的 `ScoreDocument → PlaybackPlan → occurrences → atoms/scoreEvents` 流水线已存在于 TypeScript，使用**精确有理数拍**（`RationalBeat`，无浮点累加），tie/chord/rest/multi-voice/backup-forward 都有明确语义和 ImportReport 状态。R2/R3 不是"从零开始"，也存在真实的"是否需要先换语言"问题（见 `R2_R3_ROUTE_DECISION.md`）。
2. **但"单一权威计划"目前不成立**：同一次练习有两条时间线来源——Rust `buildSchedule`（从 atoms 生成、驱动实时判定与 UI）与前端 `buildEngineScoreEvents`（驱动最终 `scorePerformance`）。两者只在 server 端用 **onset 0.5 ms 容差**互相验证；**不校验 pitch、数量、ID 唯一性、measure 覆盖、config/plan fingerprint**。
3. **不存在 planFingerprint**：`PlaybackPlan.planId` 是字符串（含 score fingerprint + range + loop + planner 版本），前端把它当 `playbackPlanId` 传给 server 并落盘，但 server 从不校验它，也没有从 plan 内容计算的哈希。v1.0 §5.3 / v1.1 §1.2 要求的 `planFingerprint` 是**待建**能力。
4. **OSMD 锚点问题已被实测证实**（不是理论风险）：OSMD 2.2.1 **完全不保留** MusicXML `note@id`（10 个 case，内部对象与 DOM 命中数均为 0）。当前 adapter 的 `measure:staff:voice:pitch` 组合键在**重复同音**场景下会发生碰撞，而它对外的自检（mapped==count && duplicates==0）**仍然报告 PASS**——这是静默错高亮，不是理论缺陷。详见 `SCORE_ANCHOR_SPIKE_REPORT.md`。
5. **时钟域是"单点 affine + 单一 offset"模型**：浏览器 `performance.now()` 为权威 session 时间；Node MIDI 用四时间戳估一次 offset；暂停靠"平移目标"而不是"排除时间段"；`getOutputTimestamp()` 未使用。实测该 API 在本机 Chromium **在音频渲染前返回 `{0,0}`**，音频运行后才有意义——直接使用会产生假的完美映射。详见 `CLOCK_DOMAIN_CONTRACT.md`。
6. **G0（B2.1 真机验收）仍未完成**：既有报告与记忆记录显示存在一次干净真机 `AVAILABLE` Take（`s-1792769578764-7`），但**受控错误 Take、成功的 P09 前后比较、断连/旧 epoch 边界**仍未取得。因此本轮只做 R1 审计，未触碰生产路径。
7. **最大工程风险不是"用不用 Rust"**，而是：目标身份（source/score/occurrence/anchor）没有分层、目标校验只看 onset、以及两条时间线。这三项必须在 R2 之前用契约固定，否则迁到 Rust 只是把同一个问题换个语言。

---

## 1. 审计方法与证据等级

| 等级 | 含义 | 本文标记 |
|---|---|---|
| 本次实测 | 我在本次会话中真实运行命令 / 浏览器实验得到 | 【实测】 |
| 代码阅读 | 直接阅读当前源码得出，附 file:line | 【代码】 |
| 既有报告 | 引用仓库内 A0–B2.1 报告或项目记忆，未在本次复跑 | 【既有】 |
| 未验证 | 代码存在但本次未运行，或其正确性无法由现有证据判定 | 【未验证】 |

**明确边界（本次没有做的事）：**
- 未做任何真机 SP-A500 演奏；本文任何"通过"都不代表实体键盘验收。
- 未运行 synthetic MIDI 端到端；selftest 内部使用的是 mock backend / 直接 WS 消息。
- 未修改生产代码、未迁移任何逻辑到 Rust、未新增 golden 测试到仓库。

---

## 2. 仓库基线

### 2.1 版本控制状态（重要）

| 项 | 结果 |
|---|---|
| `D:\123` 是否 git 仓库 | **否** 【实测 `git status` → `fatal: not a git repository`】 |
| `D:\123\rhythm-trainer-frontend` | **否** |
| `D:\123\rhythm-trainer-core-v0.2` | **否** |

**后果（必须记录为风险 R0）：**
- 无法回答"当前分支 / 未提交改动 / 是否有用户未提交修改"。
- 无法用 diff 证明"本次未改生产代码"，只能靠不在源码目录写入来保证。
- 无法回滚。v1.1 §4.4 / v1.0 §7.6 的"回滚到上一个稳定版本"在当前状态下**不可执行**。
- 建议：进入 R2 之前先建立版本控制（至少对两个目录做本地 git init + 首次基线提交），否则任何迁移都不可审计、不可回滚。这不是"顺手做"，是 R2 的前置条件。

### 2.2 关键依赖版本（以锁文件为准）【实测】

| 组件 | 版本 | 来源 |
|---|---|---|
| `opensheetmusicdisplay` | **2.2.1**（精确锁定，非 `^`） | `frontend/package.json` + `package-lock.json` |
| `react` / `react-dom` | 19.1.0 | 同上 |
| `vite` / `vitest` | 6.3.5 / 3.2.7 | 同上 |
| `typescript` | 5.8.3 | 同上 |
| `fast-xml-parser` | ^5.11.2 | 同上 |
| `@noble/hashes` | 1.8.0 | 同上 |
| `@julusian/midi` | ^3.8.1 | 同上 |
| `rhythm-core` (Rust) | 0.5.0 | `core/Cargo.toml` |
| `rhythm-trainer-native` | 0.5.0，napi 2 / napi8 | `core/bindings/node/Cargo.toml` |
| `SCORING_ALGORITHM_VERSION` | `scoring-v1.0.0` | `crates/rhythm-core/src/scoring_v1.rs:15` |

前端 `package.json` version 0.6.0，core 0.5.0（与项目记忆一致）。

### 2.3 目录结构（关键部分）

```
rhythm-trainer-frontend/
  src/score-engine/            ← 语义域（当前 TS 权威）
    domain/rational.ts         精确有理数拍
    domain/types.ts            ScoreDocument / ScoreEvent / PlaybackPlan / Occurrence / Group
    import/musicxml-importer.ts
    playback/playback-planner.ts
    playback/tempo-map.ts
    playback/score-events.ts   ← buildEngineScoreEvents（生产目标生成）
    playback/reference-playback-plan.ts
    view/score-view-adapter.ts ← OSMD 映射（生产 UI 用）
    legacy-bridge.ts           → 旧 React 视图模型（display-only）
    practice/follow-session.ts 跟手模式
  src/features/{playback,practice,midi,score}
  src/services/{engineBridge,deviceBridge,practiceRepository}.ts
  server/engine-server.mjs     ← 本地引擎服务（WS + REST，8788）
  server/midi/*                ← Node MIDI adapter / clock-map / trace / journal
rhythm-trainer-core-v0.2/
  crates/rhythm-core/src/{schedule,matcher,session,scoring_v1,midi,take,teaching,duration}.rs
  bindings/node/src/lib.rs     ← NAPI 导出
```

### 2.4 测试与构建基线（本次全部实跑）【实测】

| 命令 | 结果 |
|---|---|
| `cd rhythm-trainer-frontend && npx vitest run` | **30 files / 175 tests passed**，1.62s |
| `cd rhythm-trainer-frontend && npm run build`（`tsc -b && vite build`） | **通过**；`dist/assets/index-*.js` 514 kB，OSMD chunk 1436 kB（>500 kB 警告，既有） |
| `cd rhythm-trainer-frontend && node server/selftest.mjs` | **"全部自测通过"，155 条 `ok` 断言** |
| `cd rhythm-trainer-core-v0.2 && cargo test`（默认 MSVC） | **失败**：`link.exe` 不可用（本机无 MSVC/SDK）。这是环境问题，不是代码失败 |
| `cd rhythm-trainer-core-v0.2 && PATH=$HOME/dev-tools/w64devkit/bin:$PATH CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=... cargo test --target x86_64-pc-windows-gnu` | **110 passed**（82 unit + 1 benchmark + 1 e2e + 5 property + 21 scoring_v1 acceptance） |

> 结论：R1 基线可复现。任何后续阶段必须沿用 GNU target 命令，否则会得到假的"链接失败=代码坏"或更糟：`napi build` 静默产出旧二进制（项目记忆已记录该坑）。

### 2.5 现有 fixtures

| 位置 | 内容 |
|---|---|
| `src/score-engine/test/fixtures/*.musicxml` | 13 个：单声部、和弦、跨小节 tie、多声部 backup/forward、拍号调号变化、三连音、弱起、休止、overflow、invalid chord anchor、malformed、missing divisions、不支持 repeat/tempo curve |
| `src/score-engine/test/fixtures/*.expected.json` | 2 个（`golden.expected.json`、`piano-two-staff-basic.expected.json`） |
| `src/features/score/fixtures/*.musicxml` | 3 个（内置练习示例、ledger lines 示例、2 小节阅读示例） |
| `D:\123\score-latest.musicxml`（仓库根） | **113 小节 Audiveris OMR 真实谱**（1610 音、301 个 `<chord />`、31 个 tie span、双谱表、multi_voice、tuplets）；经曲谱库导入，不在测试 fixture 内。本次实测：`READY_WITH_WARNINGS` / `strictAllowed=true` / 0 error / 1 warning（第 36 小节 underfull）/ 117 ms；plan 1579 occurrence、1018 group、16 ms、ID 全部唯一（见 `spike/out/real-score-check.json`） |
| `core/test-fixtures/*.json` | golden MIDI traces、scoring example trace |
| **本次新增（审计专用，不在生产目录）** | `D:\123\audit-r1\fixtures\*.musicxml`（G1–G8） |

**关键观察**：现有 `*.expected.json` 是**从当前实现 dump 出来的**，不是手工推导真值。不能直接升级为 golden。本次新增的 5 个 golden 全部手推，见 `GOLDEN_FIXTURES.md`。

---

## 3. 真实调用链（逐节点）

### 3.1 总览

```
[1] MusicXML text (file / score library)
        │  App.tsx: importMusicXml / scoreImport.ts
        ▼
[2] importMusicXml()  ──►  ImportReport + ScoreDocument（RationalBeat 精确拍）
        │  score-engine/import/musicxml-importer.ts:840
        ▼
[3] launchPractice()  ──►  buildPlaybackPlan()  ──►  PlaybackPlan（occurrences + groups）
        │  App.tsx:912-1050 / playback-planner.ts:89
        ├──► filterPlaybackPlanByHand() → scopedPlan（手别过滤后的唯一目标集合）
        │      reference-playback-plan.ts:103
        ├──► buildReferencePlaybackPlan() → 参考播放计划（含 count-in 的 session ms）
        │      reference-playback-plan.ts:172
        ├──► buildEngineScoreEvents(scopedPlan, bpm, countInBeats) → EngineScoreEvent[]
        │      score-events.ts:11        【最终评分目标】
        └──► scoreOccurrencesToEngineAtoms(scopedPlan, 960) → EngineAtom[]（无 pitch）
               playback-planner.ts:239    【实时判定/引擎时刻表】
        ▼
[4] usePracticeSession.begin() → EngineBridge.start() → WS {type:'start', atoms, scoreEvents, ...}
        │  usePracticeSession.ts:313 / engineBridge.ts:140
        ▼
[5] engine-server.mjs  case 'start'（:1114）
        ├─ resolveModeScoringConfig()（唯一 mode→config 解析点）
        ├─ 校验 scoreEvents 字段合法性（:1252）+ 处方范围（:1260）
        ├─ addon.buildSchedule(pattern, bpm, countInMs, profile)  → targets  ← Rust
        │     schedule.rs:71；chord 同 tick 合并为 1 个 target
        ├─ 校验每个 scoreEvent.targetOnsetMs ∈ targets.atMs ±0.5ms（:1286）
        ├─ NativeTakeCoordinator.beginTake() → takeId/captureEpoch（take.rs）
        ├─ new NativeSession(targets, 512, 80)（session.rs / matcher.rs）
        └─ 回包 {type:'started', targets, firstTargetAtMs, countInMs, captureEpoch, takeId...}
        ▼
[6] 练习运行：前端 tick(50ms) / raw-midi / pause / resume
        ├─ Web MIDI: midiAdapter.ts handler → timeStamp(performance timeline) → ingestPacket
        ├─ Node MIDI: adapter.mjs → handleNodeMidiEvent → mapNodeEventToSession() → sessionTimeMs
        └─ ingestRawPacket（:885）→ decodeMidiPackets（Rust）→ pushHit → processPending → judgments
        ▼
[7] finish（显式按钮 / 断连 interrupted）→ finishSession（:1514）
        ├─ native.finish() → EngineReport（perfect/good/miss/extra）
        ├─ addon.decodeMidiPackets(ingests) → sessionTimeMs per event
        ├─ trackKeyLifecycles(ingests) → KeyPressObservation[]
        ├─ performedNotes = 映射成功的 note-on（过滤 < scoringStartMs 的 count-in）
        ├─ adjustedScoreEvents = scoreEvents 按 pauseInterval 平移 targetOnsetMs
        ├─ addon.scorePerformance(adjustedScoreEvents, performedNotes)  （:1753）← Rust scoring_v1
        ├─ addon.analyzeTiming / assessKeyPresses
        ├─ atomicWriteJson(SESSIONS_DIR/<sessionId>.json)（:1874）
        └─ WS {type:'report', report, scoreV1, scoreStatus, captureDiagnostics, ...}
        ▼
[8] usePracticeSession.onReport → React state → P08 FullScoreReport
        │  usePracticeSession.ts:260
        ▼
[9] P09：teachingPrescription.ts（纯函数，只消费 scoreV1）→ TargetedPracticePanel
        └─ 确认后 App.startTargetedPractice → launchPractice(overrideConfig, targetedSource)
           → server 校验来源记录/处方一致性 → 新 PracticeSession/Take
```

### 3.2 节点明细

| # | 真实文件:行 | 导出符号 | 调用者 | 关键数据字段 | 相关测试 |
|---|---|---|---|---|---|
| 1 | `src/features/score/scoreImport.ts:19`、`src/features/score/musicXmlParser.ts:22` | `importScoreFile` / `parseMusicXml`（包装） | `App.tsx`、ScoreLibraryPage | 原始 XML、fileName | `musicXmlParser.test.ts` |
| 2 | `src/score-engine/import/musicxml-importer.ts:840` | `importMusicXml` | 上面两个 + `osmdSpike.ts` + 测试 | 见 §4.1 | `score-engine/test/importer.test.ts`（28）|
| 3 | `src/score-engine/playback/playback-planner.ts:89` | `buildPlaybackPlan` | `App.tsx:922`（跟手）、`:972`（固定时刻）| `PlaybackPlan{planId,scoreFingerprint,occurrences,groups,rangeStartBeat,rangeDurationBeat}` | `importer.test.ts`、`score-events.test.ts` |
| 3b | `reference-playback-plan.ts:103` | `filterPlaybackPlanByHand` | `App.tsx:937`、`buildReferencePlaybackPlan` 内部 | 手别 → occurrence 子集；`planId:hand=X` | `reference-playback.test.ts`（10）|
| 3c | `reference-playback-plan.ts:172` | `buildReferencePlaybackPlan` | `App.tsx:987` | `ReferencePlaybackNote{atMs,durationMs,voices[]}` | 同上 |
| 3d | `score-engine/playback/score-events.ts:11` | `buildEngineScoreEvents` | `App.tsx:1005` | `EngineScoreEvent{scoreEventId,measure,beatPosition,pitch,targetOnsetMs,targetDurationMs,partId,parseConfidence}` | `score-events.test.ts`（3）|
| 3e | `playback-planner.ts:239` | `scoreOccurrencesToEngineAtoms` | `App.tsx:1010` | `EngineAtom{startTick,durationTicks,kind,bar,beat}` | `importer.test.ts` |
| 3f | `playback-planner.ts:276` | `buildScoreOccurrences` | **仅测试**（`view-mapping.test.ts`、`importer.test.ts`） | `ScoreOccurrence` | — |
| 3g | `tempo-map.ts:14` | `buildTempoMap` | `reference-playback-plan.ts:198`、测试 | `beatToMs`（f64）、`beatToTicks`（精确或 null） | `reference-playback.test.ts` |
| 4 | `src/features/practice/usePracticeSession.ts:313` | `begin` | `App.tsx:1056` | BeginRequest（atoms、scoreEvents、fingerprints、处方） | 无组件级测试 |
| 4b | `src/services/engineBridge.ts:140` | `EngineBridge.start` | `usePracticeSession` | WS JSON | `selftest.mjs`（协议级） |
| 5 | `server/engine-server.mjs:1114` | `handle('start')` | WS | 同上 + `scoringConfig` | `selftest.mjs` 155 断言 |
| 5b | `crates/rhythm-core/src/schedule.rs:71` | `build_schedule`（经 `bindings/node/src/lib.rs:426` `buildSchedule`） | server | `TargetHit{id,index,at_ms,bar,beat,perfect/good_window_ms,nominal_duration_ms}` | Rust 单测 + `scoring_v1_acceptance` |
| 6 | `server/engine-server.mjs:885` | `ingestRawPacket` | WS `raw-midi` + `handleNodeMidiEvent` | `ingest.packet`、`sessionTimeMs`、`clockQuality` | `adapter.test.mjs`、`clock-map.test.mjs` |
| 6b | `crates/rhythm-core/src/matcher.rs:52` | `HitMatcher::ingest` | `NativeSession.pushHit` | `Judgment{grade,target_id,error_ms}` | Rust 单测 |
| 7 | `server/engine-server.mjs:1514` | `finishSession` | WS `finish` / socket close | 见 §4.4 | `selftest.mjs` |
| 7b | `crates/rhythm-core/src/scoring_v1.rs:552` | `score_performance`（经 `lib.rs:1634` `scorePerformance`） | server | `SessionScoreReport` | `tests/scoring_v1_acceptance.rs`（21）|
| 8 | `src/components/FullScoreReport.tsx` | P08 报告视图 | App 工作台 + HistoryView | `scoreV1`、`scoreStatus` | `FullScoreReport.test.tsx`（4）|
| 9 | `src/features/practice/teachingPrescription.ts` | `buildTeachingPrescription` | `TargetedPracticePanel` | `TeachingPrescription` | `teachingPrescription.test.ts`（9）|

### 3.3 生产路径 / 仅测试 / 旧代码 判定

| 代码 | 判定 | 依据 |
|---|---|---|
| `importMusicXml` + `ScoreDocument` | **生产** | `scoreImport.ts` / `musicXmlParser.ts` 被 App 使用 |
| `buildPlaybackPlan` | **生产** | `App.tsx:922/972` |
| `filterPlaybackPlanByHand` | **生产** | `App.tsx:937`（跟手）+ 参考播放内部 |
| `buildReferencePlaybackPlan` | **生产** | `App.tsx:987` |
| `buildEngineScoreEvents` | **生产（权威评分目标）** | `App.tsx:1005` → server → `scorePerformance` |
| `scoreOccurrencesToEngineAtoms` | **生产（引擎时刻表）** | `App.tsx:1010` |
| `buildScoreOccurrences` | **仅测试** | 只有 `view-mapping.test.ts` / `importer.test.ts` 调用；生产不调用 |
| `toLegacyScoreDocument`（legacy-bridge） | **生产（display-only）** | `scoreImport.ts` / `musicXmlParser.ts` 用它生成 React/OSMD 视图模型 |
| `OsmdScoreViewAdapter` | **生产（高亮）** | `App.tsx` 高亮路径；本次 spike 证明其存在静默错映射风险 |
| `buildPracticePlan`（`src/features/score/practicePlan.ts`） | **不可达的遗留防御分支** | `App.tsx:1033` 的 `else`（`scoreDoc.engine` 缺失）。但所有生产入口都只能产出带 `engine` 的文档或直接抛错：`parseMusicXml`/`importScoreText` 都经 `toLegacyScoreDocument` 注入 `engine`，`practiceScoreDocument` 也来自 `parseMusicXml`。因此该分支当前**不可达**，属死代码（R4 删除） |
| `systemDuet.ts`（振荡器伴奏） | **生产（跟手模式引导音）** | `App.tsx:62` import、`:257/:272/:633/:1179` `new SystemDuetPlayer()`、`:630` `playNow(notes, 600)`。注意：它的音符来自 `noteMidiById`（legacy 视图），**不来自 PlaybackPlan**——是第四条音频/音符来源（见 F9b） |
| `score-engine/practice/follow-session.ts` | **生产（跟手模式）** | `App.tsx` `new FollowSession(...)` |
| `score-engine/dev/osmdSpike.ts` + `osmd-spike.html` | **开发/诊断**（Vite 页面，不进主 App） | 独立 HTML 入口 |
| `server/trace-replay.mjs` | 诊断/重放 | `selftest` 与 `/api/traces` |
| `NativeSession`（实时判定） | **生产** | `server` start 时创建 |

---

## 4. 数据契约现状（逐字段）

### 4.1 ScoreDocument（`src/score-engine/domain/types.ts:193`）

| 字段 | 存在 | 说明 |
|---|---|---|
| `schemaVersion` | ✅ `1` | `IMPORT_SCHEMA_VERSION` |
| `parserVersion` | ✅ `1.0.0` | `SCORE_ENGINE_VERSION` |
| `supportProfileVersion` | ✅ `musicxml-v1.0` | |
| `fingerprint` | ✅ | **原始 XML 文本的 SHA-256**（`signatureFingerprint`，importer:147）。改动任意一个字节即变 |
| `workTitle` / `composer` / `source{format,xmlVersion,doctypePresent}` | ✅ | |
| `parts[]` → `id,name,staves,measures[]` | ✅ | part 结构完整 |
| `measures[]` → `ordinal,printedNumber,implicit,startBeat,durationBeat,attributes{divisions,time,key,staves,clefs},events[],barlines[],tempoMarks[],capabilities[]` | ✅ | `startBeat`/`durationBeat` 均为 RationalBeat |
| `events[]` → `ScoreEvent` | ✅ | `id,kind,source{partId,measureOrdinal,printedMeasureNumber,voiceId,staffNumber,xmlId,sourceOrdinal},onsetBeat,durationBeat,notatedType,dots,pitch{step,alter,octave,midiNote,spelling},chordGroupId,tieStart,tieStop,tiedStart,tiedStop,isGrace,isCue,lyricText,articulations[],capabilities[],timeModification,tieSpanId` |
| `tieSpans[]` → `id,pitchKey,eventIds[],startBeat,endBeat` | ✅ | 已解算为 sounding span |
| `tempoMarks[]` | ✅（采集） | **但 PlaybackPlan 不消费**（固定 BPM） |
| `capabilities[]` | ✅ | `ties/chords/tuplets/multi_staff/multi_voice/grace/cue/repeat/tempo_curve/transpose/microtone/...` |
| `strictAllowed` | ✅ | 由 issue.blocksStrict 推导 |

**精确时间**：`onsetBeat`/`durationBeat` 为 `RationalBeat{numerator,denominator}`，全整数运算（`rational.ts`），`fromMusicXmlDuration(duration, divisions)` 精确归一化到四分音符拍。**不存在浮点累加**（这是相对 v1.0 文档假设的一个正面意外）。

**身份**：
- `source.xmlId` 保留原始 `note@id`（可选，可能重复/非法，importer 不校验唯一性——**待补**）。
- `event.id = ${fingerprint[:16]}:${partId}:m${measureOrdinal}:e${sourceOrdinal}`（importer:644）→ **revision-local、确定性**，但换 revision（改任意字节）后全部 ID 改变。
- `chordGroupId = chord:${anchorEventId}`（importer:629）。

### 4.2 PlaybackPlan（`types.ts:295`）

| 字段 | 值/语义 |
|---|---|
| `planId` | `plan:{scoreFp[:16]}:m{start}-{end}:{once|loopN}:playback-planner-1.0.0`（planner:107） |
| `scoreFingerprint` | 来自 ScoreDocument |
| `range` / `rangeStartBeat` / `rangeDurationBeat` | 精确拍 |
| `occurrences[]` | `occurrenceId(=planId:p{pass}:{eventId}), scoreEventId(=eventId), playbackIndex, passIndex, measureOrdinal, playbackBeat, beatInMeasure, bar, staffNumber, voiceId, pitch, durationBeat, chordGroupId, isTieOnset` |
| `groups[]` | 同 pass+beat 聚合；`groupId, playbackBeat, occurrenceIds[], scoreEventIds[], pitches[], bar, beatInMeasure, staffNumbers[], voiceIds[], durationBeat(=组内最长)` |
| `strictAllowed` / `issues` | 阻断语义（repeat、score_not_strict_ready、no_playable_notes） |

**行为要点（实测，见 `importer-dump.json`）**：
- tie continuation **不生成 occurrence**；onset occurrence 的 `durationBeat` 被延长为整条 tie span（G3：1 个 occurrence，duration 4 拍）。
- 同 onset 和弦 → 同 `playbackBeat` 的多个 occurrence + 1 个 group。
- 休止符、grace、cue 不进入 occurrences。
- 排序：playbackBeat → passIndex → bar → occurrenceId（确定）。

### 4.3 引擎 DTO

`EngineScoreEvent`（`types/engine.ts:19`）：
```
scoreEventId  = occurrenceId          // 注释写 "Stable occurrence ID"
measure       = occurrence.bar
beatPosition  = toNumber(playbackBeat)      // f64，范围起点相对
pitch         = pitch.midiNote
targetOnsetMs = countInMs + beatToMsAtBpm(playbackBeat)   // 含 count-in
targetDurationMs = beatToMsAtBpm(durationBeat)            // 不含 count-in
partId        = "staff-{n}:voice-{v}"       // 合成字符串，非 ScorePart.id
parseConfidence = 1                          // 硬编码
```

`EngineAtom`（`types/engine.ts:11`）：`startTick, durationTicks, kind, bar, beat(=beatInMeasure+1，f64)`。**无 pitch**。

`EngineRawMidiPacket`（`types/engine.ts:243`）：`sourceId, sourceSeq, clockDomainId, capturedAtMs, handlerAtMs?, rawBytes[], transport, captureEpoch?`。
`EngineIngestMidiPacket`（`:265`）：`packet, sessionTimeMs|null, clockMappingId|null, clockUncertaintyMs|null, clockQuality`。

### 4.4 报告与持久化

`EngineReportMessage`（`types/engine.ts:390`）承载：`report`（legacy judgments）、`analysis`、`durations`、`keyLifecycles`、`captureDiagnostics`、`scoreV1`、`scoreStatus`、版本号、`takeId/practiceSessionId/takeSnapshot`、`traceId/trace`、`scoringConfig`、`scoreFingerprint`、`playbackPlanId`、`scoreImportStatus`、`hand`、`scoreBarCount`、处方来源、`retryComparison`。

落盘 `record`（`engine-server.mjs:1813-1864`）包含：`schemaVersion, sessionId, interrupted, finishedAtIso, modeId, bpm, profile, assisted, durationPolicy, scoreEvents, scoringConfig, scoreFingerprint, playbackPlanId, scoreImportStatus, hand, scoreBarCount, sourceReportId/TakeId/prescriptionId/prescription, takeTemplate*, retryComparison, coreAlgorithmVersion, atoms, countInBeats, ticksPerQuarter, practiceSessionId, takeId, takeIndex, takeSnapshot, trace, journal, captureDiagnostics, report, analysis, durations, keyLifecycles, scoreV1, scoreStatus, scoreConfigVersion, scoreAlgorithmVersion, scoreInputNoteCount, scoreUnmappedNoteCount, pauseAdjusted`。

**缺少的持久化字段（相对 v1.0/v1.1 要求）：**
- `planFingerprint`（当前只有字符串 `playbackPlanId`，且无校验）
- `clockSnapshot`（clockId / segments / uncertainty / pause segments）
- `scoreDocumentFingerprint`（有 `scoreFingerprint`，语义接近；但没有 parserVersion/plannerVersion 一起进 report 顶层）
- anchor manifest（`mappingVersion` / `osmdVersion` / unmapped / conflicts）
- `provenance`（哪些目标是 Rust 生成、哪些是前端生成）——目前 atoms 与 scoreEvents **不同源**，记录里看不出来

### 4.5 Rust 侧契约

`scoring_v1::ScoreEvent`（`scoring_v1.rs:83`）：`score_event_id, measure:u32, beat_position:f64, pitch:u8, target_onset_ms:f64, target_duration_ms:f64, part_id:String, parse_confidence:f32`。
注释明说 `beat_position` "rational type is a future upgrade"——Rust 侧接收的仍是 **f64**，精确性只存在于 TS 域。

`scoring_v1::ScoringConfig::default()`（`:63`）：`max_onset_deviation_ms=250, onset_tolerance_ms=60, pitch_mismatch_penalty=3.0, miss_penalty=4.0, extra_penalty=2.5, min_rhythm_samples=4, global_offset_ms=30, jitter_ratio_mad=0.08, drift_ratio_slope=0.01, duration_tolerance_ms=50, duration_tolerance_ratio=0.15, weights=pitch30/onset20/rhythm30/duration15/continuity5`。
**NAPI 调用固定使用 `ScoringConfig::default()`（`bindings/node/src/lib.rs:1640`）；mode 配置不参与权重**（与项目记忆一致）。

---

## 5. 关键发现（按影响排序）

### F1 — 目标校验只看 onset，不校验语义（P0）

`engine-server.mjs:1252-1294`：
- 只检查 `scoreEventId` 非空、`targetOnsetMs/DurationMs` 有限、`pitch∈[0,127]`、`measure≥1`。
- 之后只验证 **每个 scoreEvent 的 onset 能在 `targets[].atMs` 里找到 ±0.5 ms 的匹配**。
- **没有**：数量相等、pitch 与 target 对齐、ID 唯一性、measure 覆盖、`planFingerprint`/`config` 一致性。

**后果**：如果前端 bug 或恶意客户端提交"onset 正确但 pitch/measure/duration 错误"的 scoreEvents，server 会接受，并用错误目标评分；最终报告仍是 `AVAILABLE`。
**归属阶段**：R2 出口条件（v1.0 §R2.7）必须补齐；这是可以在 R1 之后立刻做的低风险加固。

### F2 — 两条时间线（P0，结构性风险；当前输出一致）

- **时间线 A（实时）**：`atoms → addon.buildSchedule → targets.atMs`（Rust，`schedule.rs:71`）。chord 被合并成 1 个 target（按 `start_tick`）。
- **时间线 B（最终评分）**：`occurrences → buildEngineScoreEvents → targetOnsetMs`（TS，`score-events.ts:11`）。chord 保持每个音一个 scoreEvent。
- 二者在 server 用 onset 容差互验（F1），并且参考播放另有一份 `ReferencePlaybackNote.atMs`（`reference-playback-plan.ts:212`），再用 `validateReferencePlanAgainstTargets`（`:301`，4 ms、按索引）对齐。

**本次实测（重要，避免夸大风险）**：在真实谱（1018 个 atom / 1579 个 scoreEvent）上，用**真实 NAPI addon** 跑 18 种组合（BPM ∈ {40,60,70,80,90,100,120,133,177} × count-in ∈ {4 拍, 3 秒换算}）：
- `rustTargets = 1018`（恒定）、`tsScoreEvents = 1579`（恒定）；
- **`offPlan = 0`、`maxGapMs = 0`（18/18 组合）**——即 TS 的每个 onset 与某个 Rust target **完全相等**（不是"差一点但在 0.5 ms 内"）。
- 数据：`audit-r1/spike/out/timeline-crosscheck.json`。

**结论**：当前没有观察到实际不一致；风险是**结构性的**——两份计划由不同代码生成，没有任何不变量/指纹保证它们继续一致。将来若改 hand 过滤、chord 分组、count-in 表示法或引入 repeats，一致性会静默破裂，而 server 只用 onset 0.5 ms 兜底（且不校验 pitch）。因此仍应在 R2 收敛为单一来源，而不是因为"现在看起来一致"就保留双份。
**归属阶段**：R2（把 plan 生成收敛到 Rust）→ R4（移除重复）。在 G0 与契约完成前直接做 R4 会破坏功能。

### F3 — 身份层级混淆（P0）

| v1.1 要求的身份 | 当前实现 |
|---|---|
| `sourceNoteId` | `ScoreEvent.source.xmlId`（可选，不校验唯一性） |
| `scoreEventId` | `ScoreEvent.id`（fingerprint-local） |
| `occurrenceId` | `PlaybackOccurrence.occurrenceId` |
| `anchorId` | **不存在**（adapter 内部临时复合键） |

线上协议把 `occurrenceId` 直接命名为 `scoreEventId`（`types/engine.ts:21`、`score-events.ts:29`），评分报告里也叫 `score_event_id`。将来一旦支持 repeats，同一 `scoreEventId` 会有多个 occurrence，这个命名会让"事件身份"与"演奏实例"彻底不可分。
**归属阶段**：R1 契约（定义清楚），R2 落地。

### F4 — 没有 planFingerprint，planId 含 `Date.now()`（P0）

- 前端 `PlaybackPlan.planId` 是字符串拼接，不含内容哈希。
- server 端生成 atom pattern 时用 `id: 'frontend-${modeId}-${Date.now()}'`（`engine-server.mjs:1271`），Rust 的 target id 又是 `format!("{}:tick:{}", pattern.id, tick)`（`schedule.rs:110`）→ **target ID 每次运行都不同**，不可用于跨会话比较或重放对齐。
- `playbackPlanId` 落盘但**从不校验**，报告里也没有 plan 版本字段。

**归属阶段**：R1 定义 `planFingerprint`（规范化 plan 内容的哈希 + plannerVersion），R2 实现。

### F5 — 浮点在边界处（P1）

| 位置 | 表达式 | 影响 |
|---|---|---|
| `score-events.ts:31` | `beatPosition: toNumber(occurrence.playbackBeat)` | 三连音变 `0.3333333333333333` |
| `playback-planner.ts:263` | `beat: beatInMeasure + 1` | atoms 的 beat 是 f64 |
| `tempo-map.ts:27` | `toNumber(beat) * quarterMs` | 目标 ms 是 f64（本身不可避免） |
| `reference-playback-plan.ts:255` | `beat: num/den + 1` | 显示用 f64 |

精确性在 TS 域保持（`RationalBeat`），但**一旦越过 DTO 边界就变成 f64**，且没有版本化舍入规则。tick 转换反而更严格：`planToTicks` 不整除时**返回 null 并阻断 strict**（`playback-planner.ts:269`），960 PPQ 无法表示 7 连音——这是正确的 fail-closed。
**归属阶段**：R1 定义单位/舍入版本，R2 在 Rust 内部保留整数/有理。

### F6 — 暂停用"平移目标"而非"排除时间段"（P1）

- 实时：`native.pause(nowMs)` → `HitMatcher.shift_remaining(delta)`（`matcher.rs:147`）把未决目标整体后移。
- 批量：`finishSession` 用 `pauseIntervalsSourceMs`（来自客户端 `atSourceMs`）换成 session 区间，然后**只平移 `targetOnsetMs`**（`:1739-1750`）。
- 演奏事件的时间**不平移**（它们本身已含暂停时长，因为 `originRef` 冻结）。

在数学上自洽（两边都含暂停），但：
- 语义不是"排除暂停"而是"计划后移"，`SessionActiveTime` 概念不存在。
- 暂停区间来自 **浏览器 performance 时间**，与 Node MIDI 的映射是另一条链路（见时钟文档），两条链路的误差在暂停边界会叠加。
- **暂停期间 Node MIDI 事件仍会进入**：`handleNodeMidiEvent`（`:939`）只检查 `native/meta/activeTake`，不检查 `pausedAtMs`；而 Web MIDI 的 `ingestPacket` 在 `status==='paused'` 时返回 null（`usePracticeSession.ts:485`）。两条输入路径的暂停语义**不一致**。【未验证：未在真机暂停中按键测试，仅有代码证据】

### F7 — 时钟映射是单点 offset，无分段/漂移/不确定性传播（P1）

见 `CLOCK_DOMAIN_CONTRACT.md`。要点：
- 四时间戳采样估 `offsetServerMinusClient`，取最低 RTT 的一个，quality ∈ {good, estimated, unstable}。
- 全 Take 只有**一个** offset；采样在 Take 中继续更新会**静默改变**后续事件的映射，但 `clockMappingId` 恒为 `'node-to-browser-performance'`。
- `clockUncertaintyMs` 存在每个 ingest 里，但**不参与评分**；只有 quality 影响 `scoreStatus`。
- 浏览器侧 `toSessionMs` 在非 performance timeline 且时间戳越界时会**回退到 handler 时间**（`sessionTime.ts:24`），即"把迟到事件重定时为现在"——这是明确的静默改时风险（对符合规范的 Chromium 不会触发）。

### F8 — 手别过滤基于谱号启发式（P2）

`filterPlaybackPlanByHand` 需要 `handByScoreEventId`，而该 map 来自 `scoreDoc.notes`（legacy 视图），其中 `hand = staff === 'bass' ? 'left' : 'right'`（`legacy-bridge.ts:72`）。即：**左手右手由谱号推断**，不是由 MusicXML part/staff 语义或显式配置。跨手声部、单手记谱、双高音谱表会判断错误。缺失时 `missingEventIds` 阻断启动（fail-closed，正确）。
**归属阶段**：R2 应把 hand 归属作为 PracticePlanConfig 的一部分并在 Rust 校验。

### F9 — 死代码：`buildPracticePlan` 兜底分支不可达（P3）

`App.tsx:1033` 的 `else` 分支调用 `buildPracticePlan(scoreDoc.notes, ...)`（`src/features/score/practicePlan.ts`），条件是 `scoreDoc.engine` 缺失。审计结论：**该条件在生产中不可达**——`parseMusicXml`（`musicXmlParser.ts:22`）与 `importScoreText`（`scoreImport.ts:19`）都只在 importer 成功时返回，且都经 `toLegacyScoreDocument` 注入 `engine`；失败时抛 `ScoreImportError` 或返回 `doc: undefined`；`practiceScoreDocument` 同样来自 `parseMusicXml`。

因此它不是"第二套在跑的目标生成器"，而是**未清理的防御性死代码**（基于 legacy `ScoreNote[]`/float beat）。风险是：未来有人让 `engine` 变成可选并走到这里，就会静默得到一条无 `scoreEvents`、无音高评分的路径。R4 删除，或在保留时让 UI 明确标注"仅节拍练习"。

### F9b — 跟手模式的引导音是第四条音符来源（P2）

`systemDuet.ts` 仍在生产使用：跟手模式下 `App.tsx:630` 调 `systemPlayerRef.current.playNow(notes, 600)`，其中 `notes` 来自 `noteMidiById = new Map(scoreDoc.notes.map(n => [n.id, n.midiNote]))`——即 **legacy 视图的 `ScoreNote`**，而不是 `PlaybackPlan`/`ScoreDocument`。

现状共有四条与"该弹什么"有关的数据路径：
1. `ScoreDocument.events`（语义真值）
2. `PlaybackPlan.occurrences/groups`（计划真值）
3. `EngineAtom[]`（Rust 实时目标）与 `EngineScoreEvent[]`（最终评分目标）
4. `scoreDoc.notes`（legacy 视图，供 OSMD 高亮与跟手引导音）

第 4 条与第 2 条都由同一个 `ScoreDocument` 派生，短期一致；但它不走 plan、不经过 fingerprint、也没有音符级校验。跟手模式的"系统示范音"因此**没有与评分计划共享指纹**。R4 应把它改为消费 plan（或明确接受其非权威地位并在报告里标注）。

### F10 — ImportReport 状态命名与 v1.0 不一致（P2）

实际：`READY | READY_WITH_WARNINGS | DISPLAY_ONLY | REJECTED`（`types.ts:7`）。
v1.0 要求：`READY | WARNINGS | RESTRICTED | FAILED`。
语义映射：READY↔READY，READY_WITH_WARNINGS↔WARNINGS，DISPLAY_ONLY↔RESTRICTED，REJECTED↔FAILED。建议**保留现有命名**（已贯穿 UI/持久化/selftest），在契约文档里给出正式映射表，不要为了对齐文档改一遍数据。

### F11 — `<alter>` 语义：TS 与 OSMD 一致（正面证据）

G8 fixture（G 大调，`<step>F</step>` 无 `<alter>`）：
- importer：F4 → midi 65（自然）。
- OSMD 2.2.1：`halfTone` → 65（自然），带 `<alter>1</alter>` 的音 → 66。

两者都用显式 `<alter>`（缺省 0），**不**用调号推断音高。这符合 MusicXML 语义（`<pitch>` 是发声音高），说明 importer 在这一项上不是异类。注意：若谱面作者期望"调号生效"而省略 `alter`，显示（有调号）与声音（F 自然）会矛盾——这是输入错误，不是解析错误，但 ImportReport 目前**不会**对此告警（可作为 R3 的 warning 候选）。

### F12 — `source.xmlId` 重复/非法未校验（P2）

v1.1 §2.2(5) 要求"重复或无效源 ID 必须有明确错误/修复策略"。当前 importer 只做 `attr(node,'id') || undefined`（importer:651），**不检测重复**。本次 G2/G8 的 id 变体里 id 均唯一，因此没有暴露。若将来把 `xmlId` 当锚点主键，必须补唯一性校验 + 冲突报告。

### F13 — 重复同音导致 adapter 静默错映射（P1，实测）

（详见 anchor spike 报告）当前 `OsmdScoreViewAdapter.buildMapping` 用 `measureIndex:staffIndex:voiceId:midi` 做桶并 `bucket.shift()`。G2（C4 在 0 拍和 1 拍各一次）与 G8（F4 在 0/2 拍，另一个 F#4）都产生 1 个碰撞桶（2 个音符），映射结果依赖 OSMD 的遍历顺序。`mappingSummary` 的通过条件是 `mapped==count && duplicates==0`，**在碰撞情况下依然返回 PASS**（因为 shift 消费掉了、不会重复）。

### F14 — `as any` 式动态属性（P3）

`importer.ts:835/927` 用 `(part as ScorePart & {tieSpans?: TieSpan[]}).tieSpans` 临时挂载再删除。功能正确，但属于"隐式索引/字段"设计债，R3 的 Rust 版应直接把 tie 解算结果作为 `parsePart` 的返回值。

### F15 — Parser 对多 part 的支持是"部分"的（P2）

`multiple_parts` 只是 `info`（不阻断），但：
- `rangeMeasures` 只以 `parts[0]` 的小节数做范围参考（planner:76）。
- `toLegacyScoreDocument` 的 `hand` 用谱号推断，`staves` 取 `Math.max`。
- UI 主路径假设钢琴双谱表。
即多 part 能解析、能显示、能生成 plan，但**手别/范围语义未定义**。R2/R3 若继续承诺多 part，需要独立 fixtures。

### F16 — `countInBeats` 是分数拍（P3）

`countInBeatsForTempo(bpm)` = `3000 / (60000/bpm)`（`countdown.ts:14`），70 BPM → 3.5 拍。`buildEngineScoreEvents` 与 Rust `build_schedule(start_at_ms=countInBeats*quarterMs)` 都接受分数，数学一致。但 `EngineScoreEvent.targetOnsetMs` 的 count-in 部分与 Rust target 的 count-in 部分是**分别计算**的两个 f64（`countInBeats*(60000/bpm)`），在浮点上等同于同一表达式，风险低但应在契约中固定为同一函数/同一舍入。

---

## 6. G0（B2.1 真机验收）状态评估

| 要求（v1.0 §G0） | 证据 | 状态 |
|---|---|---|
| 实体 SP-A500 完成一轮短曲谱真实 Take | `B2_1_HARDWARE_ACCEPTANCE_REPORT.md` + 记忆：`s-1792769578764-7`（40 BPM、右手、loop 1 小节、4/4、2 Perfect + 2 Good、0 Miss/Extra、Overall 83.97、MAE 46.1 ms、inputHealth=healthy、clock=good） | ✅ 已完成（既有证据，本次未复跑） |
| 保存真实 MIDI Trace / Journal / 目标计划 / key lifecycle / 报告 / 持久化标识 | 报告称有 traceId/journalId/sessionId；本次仅确认代码路径与字段存在 | ⚠️ 部分（未审计具体文件完整性） |
| 至少一轮有意错误的演奏，逐事件对照 | 记忆与报告：**未完成** | ❌ |
| 真机报告上的 P09 自动处方 | `s-1792767914539-5`（AVAILABLE，Overall 66.9）→ 自动生成 `LOCAL_ONSET_V1`（第 1 小节 / 40 BPM / 右手） | ✅（既有证据） |
| P09 复练 → 成功的前后比较 | 有一次真机复练，结果为 `INSUFFICIENT_DATA`（起音全在窗口外）；`retryComparison` 正确给出 `comparable=false`（报告 §6.4） | ❌ 成功比较未取得 |
| 记录"音频输出延迟未校准" | 报告保留 `uncalibrated` 表述 | ✅ |
| 断连 / 旧 CaptureEpoch / 重复 STOP / 迟到事件边界 | selftest 覆盖断连与单 Take 租约；真机边界未验证 | ⚠️ 仅 synthetic |

**结论：G0 未完成。** 按 v1.1 §7，这不阻塞 R1（本轮）与测试材料准备，但**阻塞 R2 之后的任何功能迁移**。本次严格按此边界执行。

---

## 7. TS / Rust / Node 职责现状 vs 目标

| 能力 | 目标（v1.0 §2.1） | 现状 |
|---|---|---|
| MusicXML 语义解析 | Rust | **TS**（`musicxml-importer.ts`，962 行，支持矩阵明确） |
| ScoreDocument | Rust | **TS**（精确有理数拍） |
| TempoMap / 时间换算 | Rust（rational/ticks 精确） | **TS**（`tempo-map.ts`，输出 f64 ms） |
| 演奏顺序 / range / hand 过滤 | Rust | **TS**（`playback-planner.ts` + `filterPlaybackPlanByHand`） |
| atoms（实时时刻表） | Rust | **Rust**（`build_schedule`，从 TS 传来的 atoms） |
| scoreEvents（最终评分目标） | Rust | **TS**（`score-events.ts`） |
| 对齐 / 指标 / 评分 | Rust | **Rust**（`scoring_v1`，f64 输入） |
| MIDI 解码 / key lifecycle | Rust | **Rust**（`midi.rs`） |
| 设备 I/O | Node | **Node**（`server/midi/*`） |
| Take/Session 编排 | Node | **Node**（`engine-server.mjs` + `take.rs`） |
| 会话时钟关联 | Node/TS（跨端采样） | **Node**（`clock-map.mjs`，单 offset） |
| 持久化 | Node | **Node**（JSON 文件） |
| 谱面渲染 / 锚点映射 | 前端 | **前端**（OSMD 2.2.1 + 复合键 adapter） |
| 参考播放调度 | 浏览器 AudioContext | **前端**（`reference-playback-*`） |

一句话：**评分在内核（Rust），计划在浏览器（TS），编排在 Node，三者靠 DTO 与 onset 容差粘合。**

---

## 8. 现有测试覆盖评估

| 层 | 覆盖 | 缺口 |
|---|---|---|
| Importer | 28 个测试：状态、边界（mxl/txt/XXE/大小）、确定性、overflow、chord anchor、tie、多声部、grace、microtone、clef carry、time/key change | **无** golden 手推真值（expected.json 是 dump）；无 source ID 重复/非法；无 `tie` 跨 part |
| Planner | 覆盖 range/repeat/loop 上限、strict 阻断、tie 合并、chord 分组、确定性 | 无"同一 onset 不同 voice 的 duration 取最长"的显式断言（G2 类）；无 hand filter 的语义测试（只有 plan 级） |
| scoreEvents | 3 个测试：count-in、tie 单次起音、chord 顺序 | **无** 与 Rust `buildSchedule` 的逐字段一致性测试 |
| Node server | selftest 155 断言：断连结算、模板 CRUD、单 Take 租约、非法输入、scoreEvents/atoms 不一致拒绝 | **无** pitch/数量/唯一性/measure 校验的负例（因为没实现）；无 pause 期间 Node MIDI 的语义测试 |
| Rust | 110 测试，scoring acceptance A–U 21 项（含 chord spread、repeated pitch、wrong vs extra、missing release） | 无"plan 来自 TS"的端到端；`beat_position` 仍是 f64 |
| OSMD 映射 | `view-mapping.test.ts` **1 个测试**，断言"映射前后 occurrence JSON 不变"，**不验证 DOM/图形对象正确性** | 无 anchor contract test；无重复同音/和弦 glyph/隐藏音符 |
| 前端组件 | FullScoreReport 4、TargetedPracticePanel 4 | 无 P08/P09 与真实 scoreV1 的字段级联动测试 |

---

## 9. R1–R5 拆分建议与阻塞依赖

| 阶段 | 本轮建议 | 阻塞依赖 |
|---|---|---|
| **R1（本轮）** | 5 份文档 + 5 个手推 golden + anchor spike + clock contract + route decision | 无（已完成） |
| **R0（建议新增）** | 建立版本控制；把 GNU 测试命令写进脚本（`npm run test:rust`），避免 MSVC 静默失败 | 无 |
| **R2** | 按 `R2_R3_ROUTE_DECISION.md` 的结论执行；最小落地顺序：`planFingerprint` → 目标校验加固 → plan 生成收敛 | G0 完成 + 路由决策经用户批准 |
| **R3** | 同上文档 | R2 的 schema/契约先冻结 |
| **R4** | 清除 F1/F2/F9 的重复路径，串 `planFingerprint` 到播放/评分/历史 | R2+R3 |
| **R5** | 仅在有失败 Trace 时启动；当前贪心+和弦分组已有 21 项验收 | G0 的真实错误 Take |

**在 G0 完成前不建议做的**：把 importer 搬进 Rust（会同时动语义+时间+身份，一旦回归无法判断是"迁移错"还是"原本就错"）。

---

## 10. 应保留 / 迁移 / 删除清单

### 保留（作为契约与回归基准）
- `src/score-engine/domain/rational.ts`（精确拍运算，直接可移植为 Rust `Ratio<i64>`/整数 ticks）
- `src/score-engine/domain/types.ts`（字段完整性高，是 `ScoreDocumentV1` 的天然草稿）
- `musicxml-importer.ts` 的**支持矩阵与 ImportIssue 码表**（错误码设计良好，Rust 版应逐一对应）
- `scoring_v1`（Rust，已验收 21 项）
- `server/engine-server.mjs` 的 Take/租约/journal/trace 编排
- `server/midi/*`（设备层与 clock-map 的纯函数部分）
- `src/features/playback/*`（AudioContext 调度，属于浏览器职责）

### 迁移（R2/R3）
- `tempo-map.ts`、`playback-planner.ts`、`filterPlaybackPlanByHand`、`score-events.ts` → Rust planner
- `musicxml-importer.ts` → Rust importer（按路由决策的节奏）
- 与 plan 相关的 f64 边界 → Rust 内部整数/有理

### 弃用 / 删除（R4）
- `App.tsx:1033` 的 `buildPracticePlan` **不可达**分支（§F9）
- `score-engine/practice/follow-session.ts` 中与 plan 重复的 onset/时值推导（保留交互状态机，删除时间计算）
- `buildScoreOccurrences`（当前仅测试使用，若 R2 后仍无生产消费者则删除）
- `(part as ScorePart & {tieSpans?})` 临时挂载
- `playback-planner.ts` 中 `scoreOccurrencesToEngineAtoms` 的 `beat = float + 1`（改为整数 tick + 明确 beat 定义）

### 改造（不是删除）
- `systemDuet.ts`：跟手引导音应消费 `PlaybackPlan`（而不是 `scoreDoc.notes`），并与评分共享 fingerprint；否则必须在 UI/报告里标注它是非权威示范音（§F9b）

### 不要删
- 旧历史记录里的 `scoreV1` / `scoreEvents` / `atoms`（回放与审计依据）
- `legacy-bridge.ts`（在 OSMD 视图迁移完成前仍是生产显示层）

---

## 11. 已验证 / 未验证 / 失败

### 已验证（本次实测）
1. 前端 175 测试全通过；构建通过；selftest 155 断言通过。
2. Rust 110 测试全通过（GNU target）。默认 MSVC 命令失败（环境）。
3. Importer 对 G1–G8 的实际输出（`audit-r1/spike/out/importer-dump.json`）：tie 合并、chord 同 onset、triplet 1/3 精确、3/4 小节长度、双谱表 unison、grace/hidden、调号与 alter。
3b. **真实 OMR 谱跑通完整 TS 流水线**（`spike/out/real-score-check.json`）：113 小节 / 1610 音 / 301 chord / 31 tie span → `READY_WITH_WARNINGS`（仅 1 条 `measure_underfull`）、0 阻断 issue、117 ms；plan 1579 occurrence / 1018 group / 16 ms；scoreEventId 唯一 1579/1579。
3c. **两条时间线在真实谱上一致**（`spike/out/timeline-crosscheck.json`）：真实 NAPI addon 的 `buildSchedule` vs TS `buildEngineScoreEvents`，18 种 BPM×count-in 组合下 `offPlan=0`、`maxGap=0 ms`（完全相等）。
4. OSMD 2.2.1 的 10 个 anchor case 全部跑通（`osmd-anchor-spike.json`）：XML id 完全不可达；复合键碰撞；高亮粒度=整个和弦。
5. `getOutputTimestamp()` 在当前 Chromium 的行为：渲染前 `{0,0}`；运行后 `contextTime*1000 - performanceTime` 稳定。
6. 代码路径：atoms/scoreEvents 双来源 + onset-only 校验（读源码逐行确认）。

### 未验证
1. 真机 SP-A500 的任何本轮行为（未接线）。
2. 暂停期间 Node MIDI 是否真的产生错误判定（只有代码证据）。
3. 多 part 谱面的实际 plan/评分表现。
4. `source.xmlId` 重复时 importer 的行为（无 fixture）。
5. 7 连音或 960 PPQ 不可表示时 UI 的实际反馈（只有 `tick_grid_rounding` 阻断逻辑）。
6. P08/P09 在真实报告上的字段级正确性（既有报告声称，本轮未复跑）。
7. `validateReferencePlanAgainstTargets` 在真实演奏中是否触发过（无遥测）。

### 失败 / 不成立
1. 默认 `cargo test`（MSVC）不可用。
2. **"当前 adapter 的映射是可靠的"不成立**：G2/G8 碰撞且自检仍 PASS。
3. **"生产路径只有一个目标来源"不成立**：atoms 与 scoreEvents 分属 Rust/TS。
4. **"server 校验了目标语义"不成立**：只校验 onset 成员关系。

---

## 12. 本次改动清单

**生产代码：0 处修改。** 未在 `rhythm-trainer-frontend/src`、`server`、`rhythm-trainer-core-v0.2` 下写入任何文件。

新增（全部在 `D:\123\audit-r1\`，明确隔离）：
```
audit-r1/
  docs/                         ← 本报告与其余 4 份
  fixtures/*.musicxml           ← G1–G8 + 4 个 id 变体 + 生成脚本
  spike/index.html, spike.mjs, serve.mjs
  spike/importer-dump.mjs       ← G1–G8 的 TS 流水线 dump
  spike/real-score-check.mjs    ← 真实 113 小节谱跑 importer/planner
  spike/timeline-crosscheck.mjs ← TS 计划 vs Rust buildSchedule（18 组合）
  spike/out/importer-dump.json
  spike/out/osmd-anchor-spike.json      ← OSMD 2.2.1 实测原始数据（10 case）
  spike/out/real-score-check.json
  spike/out/timeline-crosscheck.json
  spike/out/*.bundle.mjs        ← esbuild 打包产物（可再生）
```

副作用（需知悉）：
- 运行 `npm run build` 刷新了 `frontend/dist/`（构建产物，非源码）。
- 未写入 `sessions/`、`traces/`、`journals/`（未运行 App，无 synthetic 会话污染）。
- 本地 8799 端口的 spike 静态服务已停止。

---

## 13. Batch vs Realtime 边界与预留接口（v1.1 §6 对应交付）

### 13.1 当前能力边界：确认是 batch

| 事实 | 证据 |
|---|---|
| `scorePerformance` 只在 `finishSession` 中调用一次 | `server/engine-server.mjs:1753`，位于 `native.finish()`（`:1540`）之后 |
| 输入是**完整数组** | `adjustedScoreEvents`（start 时收到的全量）+ `performedNotes`（整轮 key lifecycle 构造） |
| 输出是整轮报告 | `SessionScoreReport`（pitch/onset/rhythm/duration/continuity/measures/overall/diagnostics） |
| 没有流式/增量调用点 | 全仓库仅 1 处 `addon.scorePerformance` 调用 |
| 报告在结束后才持久化 | `:1874` `atomicWriteJson` 在评分之后 |

**同时必须准确说明"已经有的实时能力"**（避免把 batch-only 说成"完全没有实时"）：
- `HitMatcher`（`crates/rhythm-core/src/matcher.rs:52`）在每次 `pushHit` / `advance` 时产生 **perfect / good / miss / extra** 判定，经 `judgments` 消息实时推给 UI。
- 但这些判定：
  - 只比较 **onset 窗口**，`atoms` 里**没有 pitch**，因此**不判断音高**；
  - 不是对齐算法（无 lookahead、无 chord grouping、无 wrong-pitch 分类）；
  - 不产生任何分数、不进入 `scoreV1`、不持久化为权威结果；
  - 会与最终 `scorePerformance` 的结论**不一致**（例如实时判 Miss 的音，最终对齐可能配成 WrongPitch）。
- 因此准确表述是：**"实时节拍命中提示已存在；逐音实时判分与权威实时成绩不存在。"**

### 13.2 预留接口（仅语义，不实现）

以下只为 R2 之后的设计留位，**本轮不写代码**。命名沿用 v1.1 §6.2，落地时需专项设计确定生命周期。

```rust
// 语义示意，不是本仓库已存在的 trait
pub trait RealtimeMatcher {
    /// 输入一个规范化演奏事件，返回可能被后续更正的建议反馈。
    fn push_event(&mut self, event: NormalizedPerformanceEvent) -> Vec<ProvisionalFeedback>;
    /// 时间推进（用于超时判定/窗口关闭），不产生最终结论。
    fn advance_time(&mut self, session_time_us: i64) -> Vec<ProvisionalFeedback>;
    /// 用完整 trace 结束，产出可交付的最终报告。
    fn finalize(self, complete_trace: &[NormalizedPerformanceEvent]) -> ScoreReport;
}

pub struct ProvisionalFeedback {
    pub feedback_id: String,          // 可被 supersede
    pub plan_fingerprint: String,     // 必须与 batch 同一 plan
    pub score_event_id: String,       // 目标事件身份
    pub occurrence_id: String,
    pub performed_event_id: Option<String>,
    pub kind: ProvisionalKind,        // Match | WrongPitch | Extra | LikelyMiss
    pub at_session_us: i64,
    pub clock_snapshot_id: String,    // 来自 CLOCK_DOMAIN_CONTRACT
    pub uncertainty_us: u32,
    pub provisional: bool,            // 恒为 true
    pub superseded_by: Option<String>,
}
```

**硬性约束（写进未来验收）：**
1. `ProvisionalFeedback.provisional` **恒为 true**；UI 文案不得称之为"成绩/得分"。
2. 最终 `ScoreReport` 是唯一权威；两者必须引用**同一 `planFingerprint`、同一事件 ID、同一 `clockSnapshot`**。
3. 必须定义 **provisional → final reconcile 规则**：最终判为 `MISSING`/`EXTRA` 的，必须能撤回/更正对应的 provisional `MATCH`，UI 显式更正而不是留下矛盾。
4. 实时路径**不得阻塞 MIDI callback**：有界队列 + 溢出计数 + 丢失可见（沿用现有 `captureDiagnostics.queueDropped` 思路）。
5. 实时路径**不得在前端复制匹配规则**：匹配在 Rust 领域层，前端只渲染。
6. clock uncertainty 超阈值时，provisional 反馈必须降级为"不确定"或不给 timing 结论。
7. 不要求 realtime matcher 与 batch scorer 使用相同内部算法，但必须共享领域事件、ID、时间域与结果语义。

### 13.3 本轮明确不做

- 不实现 `RealtimeMatcher`。
- 不新增 WebSocket 消息类型。
- 不把 `judgments` 升级为"分数"。
- 不改动现有实时判定窗口（R5 才按证据触发）。
- 不在 UI 任何位置暗示"实时评分"。

### 13.4 未来验收要点（供后续阶段引用）

- 同一事件流 + 同一 batch trace → 最终报告与纯 batch 路径一致（逐字段）。
- provisional `MATCH` 后最终重判为 `EXTRA`/`MISSING` → UI 更正，无矛盾残留。
- queue overflow / clock uncertainty / pause-resume 下不产生虚假确定成绩。
- UI 动画帧只影响刷新，不影响判定时间与分数。
- 以上任一条未满足 → 不得发布实时反馈。

---

## 14. 下一步

本轮按 v1.1 §7 的停止条件结束。建议的下一阶段（等待用户指定，不自动执行）：

1. **R0（半小时级）**：建版本控制 + 固化 GNU 测试命令。
2. **R1 收尾**：把 `GOLDEN_FIXTURES.md` 的 5 个 case 落成仓库内测试（手推真值，不用 dump）。
3. **G0 收尾**：真机受控错误 Take + 成功 P09 比较。
4. 之后按 `R2_R3_ROUTE_DECISION.md` 的路线进入 R2。

**在没有用户明确指定阶段前，不开始任何代码实现。**
