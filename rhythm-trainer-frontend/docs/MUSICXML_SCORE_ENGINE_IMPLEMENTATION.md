# MusicXML / Score Engine v1.0 实施与审计报告

日期：2026-10-21  
依据：`MUSICXML_SCORE_ENGINE_DESIGN_v1.0.md`、`PROMPT_FOR_ZCODE_MUSICXML_SCORE_ENGINE_v1.0.md`、PRD v2.2（Rust Core）、仓库真实代码。

## 1. 真实仓库审计

- 前端：React 19 + TypeScript 5.8 + Vite 6.3.5，`rhythm-trainer-frontend`。
- 引擎服务：Node ESM `server/engine-server.mjs`，通过 napi-rs 调用 `rhythm-trainer-core-v0.2` 的 Rust `NativeSession`；`buildSchedule(pattern,bpm,countInMs,profile)` 是目标时间入口，判定/报告由 Rust Core 产出。
- 模式 ID：`rhythm / score / hands / loop / free`（`src/config/modeRegistry.ts`、`server/mode-config.mjs`）。
- 修改前 score 链路：
  1. `App.tsx` 以 `practiceScoreDocument`（简化的 `src/features/score/musicXmlParser.ts`）得到旧 `ScoreNote[]`；
  2. `buildPracticePlan` 按 beat 分组，生成 `EngineAtom[]`；
  3. `usePracticeSession.begin` 发送 WS `start`；
  4. `engine-server.mjs` 调用 Rust `buildSchedule`，Rust 产生 targets/judgments/report；
  5. `ReportPanel` 只展示引擎结果。
- 已有可复用 DTO：`EngineAtom`、`EngineTarget`、`EngineJudgment/Report`、`usePracticeSession`、`EngineBridge`。
- 修改前缺失：独立 `ScoreDocument/ImportReport`、RationalBeat、稳定 scoreEventId、tie/chord/backup/forward 领域语义、PlaybackPlanner/TempoMap、严格支持能力门禁、OSMD 依赖与真实 mapping。
- 测试命令（来自 `package.json` / Cargo workspace）：`npm test`、`npm run build`、`npm run selftest`、`cargo test --target x86_64-pc-windows-gnu`。
- OSMD 修改前未安装；本次锁定并安装 **opensheetmusicdisplay 2.2.1**（package exact）。实际 API 通过 package 的 `.d.ts` 与浏览器 spike 验证，未臆造。

## 2. 新增/修改文件

### 新增 `src/score-engine/`

- `domain/rational.ts`：精确 `RationalBeat`、约分、加/减/比较、`duration/divisions` 归一化、tick 精确转换。
- `domain/types.ts`：`ScoreDocument/ScorePart/ScoreMeasure/ScoreEvent/Pitch/ScoreSourceRef/TieSpan/ImportReport/PlaybackPlan/PlaybackOccurrence/ScoreOccurrence/TempoMap`。
- `import/musicxml-importer.ts`：纯函数 MusicXML partwise importer；不读取时间/React/OSMD/MIDI/文件系统。
  - 文件扩展名与 10 MiB 限制、XML 良构校验、禁用 `<!ENTITY>`/内部 DTD 子集/XInclude；外部 DOCTYPE 只作为惰性元数据，不访问网络。
  - `score-timewise` 明确 `unsupported_score_timewise` 拒绝。
  - divisions/time/key/staves/clef/transpose；note/rest/chord/backup/forward；tie/tied 分离；grace/cue/tuplet/lyric/articulation；稳定 fingerprint 与 event ID。
- `playback/playback-planner.ts`：A–B range、loop passes、occurrence ID、onset group、tie continuation 去重、`ScoreOccurrence`、`EngineAtom` 适配。
- `playback/tempo-map.ts`：固定 BPM 的 session-relative beat→ms/tick 映射。
- `view/score-view-adapter.ts`：OSMD 2.2.1 公开对象模型 mapping（`Sheet.SourceMeasures -> StaffEntries -> VoiceEntries -> Notes`，`rules.GNote(note) -> GraphicalNote`），颜色高亮/清除；不使用 SVG class 选择器。
- `legacy-bridge.ts`：把语义文档映射到现有 React SVG 展示模型；保留 `engine` 与 `importReport`。
- `test/fixtures/*.musicxml`：12 类语义 fixture + 跨系统 OSMD fixture + 现有默认练习/加线示例；`golden.expected.json`。
- `test/importer.test.ts`、`rational.test.ts`、`view-mapping.test.ts`。
- `dev/osmdSpike.ts` + `osmd-spike.html`：真实 OSMD 2.2.1 mapping spike（开发入口，非生产页面）。

### 修改

- `src/features/score/musicXmlParser.ts`：成为 score-engine importer 的兼容入口，只做 legacy view-model 映射；不再维护第二套解析语义。
- `src/features/score/practiceScore.ts`、`src/App.tsx`：默认练习/导入文档带 `engine + importReport`；开始练习改为 `buildPlaybackPlan → scoreOccurrencesToEngineAtoms`，严格支持被阻断时不允许开始；fallback 仅保留给旧手动 fixture。
- `src/core/sampleScore.ts`：legacy view model 增加 `engine/importReport` 与 tie/grace/cue 展示标记。
- `package.json`：新增 `fast-xml-parser`、`@noble/hashes`、`opensheetmusicdisplay@2.2.1`。
- `README.md` / `CHANGELOG.md` / `docs/visual-checks/README.md`：记录新链路、fixture、测试与限制。

## 3. 实际数据流

```text
用户文件/内置 XML
  → import boundary（扩展名、大小、XML 安全、SHA-256 fingerprint）
  → importMusicXml（纯 TS：RationalBeat + ScoreDocument + ImportReport）
  → legacy-bridge（现有 React SVG 展示模型；engine/report 原样携带）
  → buildPlaybackPlan（range/loop/occurrence/onset group；tie continuation 去重）
  → TempoMap（固定 BPM，session-relative）
  → scoreOccurrencesToEngineAtoms（960 tick 精确网格；不可精确时阻断 strict）
  → engine-server.mjs start → Rust buildSchedule / NativeSession
  → Rust judgments/report → ReportPanel
OSMD display path:
  → OSMD 2.2.1 load/render 原始 MusicXML
  → OsmdScoreViewAdapter mapping（scoreEventId ↔ GraphicalNote）
  → 当前音符/错误颜色（spike 已验证）
```

评分权威没有移动到 TypeScript：Planner 只产生目标时间与 pitch set，不产生 Perfect/Good/Miss/Extra。

## 4. 支持范围

- `score-partwise`，一个或多个 part；钢琴单/双谱表；G2/F4 谱号。
- 4/4、3/4 等拍号（布局/时间支持；非 x/4 会在 UI 桥接上受限）；调号、拍号变化。
- 四分/八分/十六分、附点、三连音/`time-modification` 的实际 duration、和弦、休止符、backup/forward。
- `<tie>` 声音连接与 `<tied>` 记谱连接分开保存；tie continuation 不新建起音 target。
- 显式 `alter/accidental`；非整数/超出 MIDI 表示的微分音被标记为不可严格表示。
- grace/cue：保留并显示，但默认不作为严格目标。
- repeat/ending、D.C./D.S./Coda/Fine、速度曲线文字：检测并阻断严格测验，不线性化后冒充可信成绩。
- 文件不支持 `.mxl`；不下载外部 DTD/实体。

## 5. Golden fixtures

`src/score-engine/test/fixtures/`：

1. `single-melody-quarter-eighth.musicxml` — 四分/八分。
2. `piano-two-staff-basic.musicxml` — 双谱表 + backup（含人工审核的 attached expected JSON）。
3. `triad-chord.musicxml` — 同起音三音和弦。
4. `multi-voice-backup-forward.musicxml` — backup/forward/多声部。
5. `rests.musicxml` — 休止符与休止后重入。
6. `dotted-triplet.musicxml` — 附点 + 1/6 拍 triplet。
7. `tie-across-measure.musicxml` — 跨小节 tie/tied。
8. `time-key-change.musicxml` — 4/4→3/4、C→G 调号。
9. `pickup-implicit.musicxml` — implicit pickup，下一小节从 1 拍开始。
10. `unsupported-repeat-tempo-curve.musicxml` — repeat/ending + rit. → DISPLAY_ONLY。
11. `malformed/missing-divisions/invalid-chord-anchor/duration-overflow` — 稳定错误与严格保护。
12. `piano-two-staff-basic` 重复解析/重建 — 确定性测试。

`golden.expected.json` 包含事件数、pitch spelling、onset/duration（分数）、voice/staff、chord、tie span、ImportReport status，以及关键 fixture 的 80 BPM timeline/atMs。

## 6. 实际命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | PASS：15 test files，100 tests |
| `npm run build` | PASS：tsc + Vite production build |
| `npm run selftest` | PASS：全部引擎服务自测通过 |
| `cargo test --target x86_64-pc-windows-gnu` | PASS：104 tests（core 单元/集成/属性/scoring_v1） |
| OSMD spike (`osmd-spike.html`) | PASS：单旋律 5/5、双谱表 12/12、三和弦 5/5、多声部 5/5、跨小节 tie 4/4、4 小节练习 24/24；duplicates 0；跨系统 fixture 24/24（`cross-system-layout.musicxml`，强制 new-system） |
| 前端浏览器 | PASS：默认 4 小节谱面加载；开始练习 → 引擎返回 16 targets；结束生成报告，无错误条。持久化会话记录含 `scoreFingerprint`、`playbackPlanId`（`plan:…:m1-4:once:playback-planner-1.0.0`）与 `scoreImportStatus=READY`。虚拟/无输入会话不是一次成功演奏。 |

OSMD spike 结果保存在 `docs/osmd-mapping-spike.json`，截图 `docs/visual-checks/osmd-mapping-spike.png`。OSMD 2.2.1 的 public `Note.halfTone` 实测比 MIDI 低一个八度（C4 = 48），adapter 已做明确规范化并在 spike 中验证；未依赖私有 SVG class。

## 7. 当前未实现 / 明确限制

- **完整 MusicXML**：多 part 的 UI 手别映射、复杂嵌套 repeat/ending 展开、D.C./D.S./Coda 播放顺序、复杂 tuplet/连音线排版、装饰音策略、歌词/力度、移调乐器、微分音、`.mxl` 未实现。
- **OSMD 生产 UI**：已完成真实 2.2.1 mapping spike 与 `ScoreViewAdapter`，但当前工作台仍使用现有 SVG 视图；OSMD 尚未接入 React 生产组件，音名/线间/手别/错误标记的 OSMD 叠加尚未实现。不得将 spike 说成完整 UI 集成。
- **严格支持门禁在客户端**：`ImportReport.strictAllowed` 与 PlaybackPlan 阻断已在 App 生效；start/report 已透传并持久化 `scoreFingerprint`、`playbackPlanId`、`scoreImportStatus`（仅元数据，不改变 Rust 评分）。`POST /api/scores/import` 仍未实现，导入仍由浏览器边界完成。
- **时长语义**：legacy `EngineAtom` 仍以每个 onset group 的时长输入 Rust；tie 已延长，但跨声部复杂时值/踏板未建模。
- 非 x/4 拍号、跨谱表复杂连线、所有不规则 tuplets 未承诺；不支持项会警告/阻断，不静默线性化。
- 未做真实硬件按键闭环本轮：设备可枚举/连接，但本轮没有物理 Note On/Off Take；硬件仍需单独测试。
