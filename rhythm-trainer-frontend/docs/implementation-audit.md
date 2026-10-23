# Rhythm Trainer 实现审计（2026-10-21，设备层实施后）

> 2026-10-22 后续：Reference Playback P0 已实施（见根目录 `REFERENCE_PLAYBACK_IMPLEMENTATION_REPORT.md`）；本文件中“PlaybackPlan 未实现”等条目已过期，保留作历史基线。

审计对象：`D:\123\rhythm-trainer-core-v0.2`、`D:\123\rhythm-trainer-frontend`。
基线资料：`rhythm-trainer-current-baseline-2026-10-21`（PRD v2.2、架构指南 v1.0、Session v1.0、Logging v1.0、MIDI Device v1.0、Teaching v0.2）。
本文件记录仓库真实状态与证据，不把设计文档版本当成实现完成。

## 1. 总体结论

- Rust Core 评分、确定性重放、N-API、Node 引擎服务、React 工作台、练习记录/能力画像已实现。
- **生产输入路径已改为 Node MIDI Adapter**（`@julusian/midi`）：服务端枚举/打开/关闭、连接代次、`sourceSeq`、Node 单调采集时间、有界队列、热插拔轮询、原始 Trace 和 UI 输入监视器已接通。
- Browser Web MIDI 适配器保留为 legacy/dev 代码，但 UI 已不再使用；正式路径只有 Node。
- Node ↔ 浏览器单调时钟映射已实现（10 次四时间戳握手，选择低 RTT 样本，把 Node 采集时间映射到浏览器 session 时间）。
- 实机已验证：OS/后端枚举、应用列表、打开端口、UI 连接、Node 路径 Note On/Off（56 对 complete）、力度变化、重复音、Trace、最小实机 Take 与报告。物理热插拔、显式三音和弦、macOS 仍 NOT RUN。
- Session Journal 与持久化 MIDI Trace 已实现；DiagnosticBundle 未实现；MusicXML 导入为有限浏览器端子集，但已接入服务端按名称持久化的乐谱库（CRUD）；完整导入/ScoreOccurrence/PlaybackPlan 仍未实现。

## 2. 已实现

| 能力 | 证据 |
|---|---|
| Rust 评分/对齐/诊断/学生模型 | `crates/rhythm-core/src/{scoring_v1,matcher,teaching,session}.rs`；104 个测试通过 |
| Session/Take、CaptureEpoch、Cursor 模型 | `crates/rhythm-core/src/take.rs`；`NativeTakeCoordinator` |
| Node 引擎服务、WS/REST、历史/画像、原子 JSON | `server/engine-server.mjs` |
| Node MIDI Adapter（生命周期/序号/代次/队列/Trace） | `server/midi/adapter.mjs`、`julusian-backend.mjs`、`codec.mjs` |
| 每轮 Take 的 MIDI Trace 持久化 | `server/midi/trace-recorder.mjs`；JSONL + manifest；`GET /api/traces/:id` |
| Session Journal 切片 | `server/journal.mjs`；每 Take JSONL（take_started/pause/resume/stop/finalized/aborted，journalSeq 单调）；`GET /api/journals/:id` |
| MusicXML 乐谱库 CRUD | `server/score-library.mjs`；`scores/<id>.musicxml` + `.meta.json`；`GET/POST /api/scores`、`GET/PUT/DELETE /api/scores/:id`；名称唯一、10 MiB 上限、原子写入；设置面板按名称载入/重命名/替换/删除 |
| 输入健康回写 Rust Take | `NativeTakeCoordinator.setInputHealth`（N-API）；take 内最差健康写入 `captureDiagnostics.inputHealth`，degraded/disconnected 的尝试不计入掌握证据（passed/trustworthy=false） |
| Trace 确定性重放 | `server/trace-replay.mjs`；`GET /api/sessions/:id/replay` 用持久化 trace + 原 atoms 重建 targets 重放到 Rust Core；两次重放统计一致（selftest 验证） |
| 模式→ScoringConfig 接线 | `server/mode-config.mjs`（mode-config-1.0.0）：五模式各有判定档位/时值策略/音高提示/诊断范围/不可用项声明；start 时单一解析点，N/A 覆盖被拒绝；快照进 started/report/Journal；`SCORING_ALGORITHM_VERSION`/`MIDI_CONTRACT_ALGORITHM_VERSION` 经 NAPI 导出用于报告追溯 |
| MIDI probe（不评分、不写历史） | `server/midi/probe.mjs`；`npm run midi:probe` |
| Node↔浏览器时钟映射 | `server/midi/clock-map.mjs`；EngineBridge 10 次 ping/sample |
| 设备 REST/WS + 热插拔轮询 | `/api/midi/devices|status|trace`；`midi-refresh|connect|disconnect` |
| UI 设备面板/输入监视器 | `src/services/deviceBridge.ts`、`src/App.tsx` |
| 专业谱面 OSMD/Bravura | `src/components/OsmdScoreView.tsx`、`score-view-adapter.ts`：原始 MusicXML → OSMD 2.2.1/Bravura，1610/1610 事件映射、目标高亮、点击详情；自研 SVG 谱面已移除；3 秒准备倒计时；系统伴弹（默认开）按引擎 target 时间表连续演奏并逐音标红（强制固定时间）；系统音乐可独立开关；蓝=用户命中、绿=用户节奏目标（不随时间前进）；跟随仅在弹对目标后触发 |
| 整谱多系统排版 + 跟随 | `src/components/ScoreViewer.tsx`、`scoreLayout.ts`：按 MusicXML 每小节时长/拍号布局，默认每行 4 小节，每小节 320px、整行约 1510px 宽不压缩；每行重复谱号/调号/拍号与起始小节号，首系统 Piano/♩=BPM，空谱表补小节休止符；窄容器横向滑动、宽窗口自动隐藏滑块并居中；系统起始小节号对齐，练习时纵向跟随当前系统；上次载入的乐谱 ID 持久化并在刷新后恢复 |
| 暂停跨键质量、倒计时抑制、评分/传输序号分离 | `duration.rs`、`engine-server.mjs`、`selftest.mjs` |
| 自动化测试 | core 104、selftest 101、vitest 121、tsc/build 通过 |

## 3. 部分实现 / 已验证边界

| 项 | 状态 | 缺口 |
|---|---|---|
| 真实设备 Note On/Off（Node 路径） | **PASS（2026-10-21 真机会话）** | `captureDiagnostics.node`: 112 forwarded / 112 mapped / 0 unmapped / 0 stale；`keyLifecycles` 56 个 complete 配对 |
| 力度变化 / 重复音 | **PASS（真机会话）** | velocity 14–54（21 个不同值）；A6/B6/C7/D7/E7 分别重复 12/12/6/19/7 次，均保留独立事件 |
| 最小实机 Take | **PASS（真机会话）** | 8 目标：1 Perfect + 2 Good + 5 Miss + 35 Extra，报告 `trustworthy=true`；报告已保存 |
| 显式三音和弦 | **NOT RUN** | 记录中只有 6 组近同时起音（<15 ms），未确认为三音和弦 |
| 设备热插拔（物理拔插） | **NOT RUN** | 代码有 2s 轮询和缺失端口关闭；未做物理拔插 |
| UI 监视器（真实事件） | **PASS** | 截图/当前页面显示真实 Note On/Off（E7/D7/B6/C7 等） |
| Trace | **PASS（内存/REST/持久化）** | `/api/midi/trace` 实时返回；每轮 Take 另写 `traces/<traceId>.jsonl` + `.manifest.json`，`GET /api/traces/:id` 可读；尚无 Trace replay |
| Session Journal / DiagnosticBundle | 部分 | Take Journal（JSONL+REST）与确定性重放已实现；无全局 DiagnosticBundle/轮转 |
| 时钟质量 | 部分 | 四时间戳映射与 uncertainty 已实现；未做长期漂移/不对称延迟实测 |
| 输入健康传播 | 已实现 | adapter→`setInputHealth` 回写 Rust Take；take 内最差值进 `captureDiagnostics.inputHealth`；降级尝试不计 mastery；UI 显示 health |
| 测试覆盖 | 部分 | 软件 mock 覆盖队列/代次/归一化/转发；真实 Note On/Off/力度/重复音/最小 Take 已验证；物理热插拔/显式和弦未覆盖 |

## 4. 未实现

- 全局 DiagnosticBundle 导出、Trace replay 的 UI 入口、日志轮转/保留策略、崩溃恢复扫描。Journal 与 Trace 持久化、确定性重放 API 已实现。
- 完整 MusicXML 导入（多 part、复杂节奏/连音线/重复记号等）、ScoreOccurrence/PlaybackPlan、Cursor 与真实 Alignment 的接线。有限浏览器端导入已实现，见 `docs/score-reading-assist.md`。
- 跨会话历史对比、`scorePerformance` NAPI 导出。
- macOS 构建/枚举/按键验证（本机 Windows，NOT RUN）。
- 物理热插拔、显式三音和弦；Node 路径的音符/力度/重复音/最小实机 Take 已由 2026-10-21 会话补齐。

## 5. 与规格冲突 / 已处理

1. **输入路径冲突已处理**：原仓库只有 Browser Web MIDI；现已把 Node Adapter 接成正式路径，UI 不再调用 Web MIDI。`midiAdapter.ts` 仅保留为 legacy/dev，README 已注明。
2. **时钟**：PRD 要求 Node 时间映射到浏览器单调时钟；已实现四时间戳握手与 `session-origin`，不使用 WS 到达时间/`Date.now()`。
3. **设备状态**：已区分后端不可用、枚举失败、打开失败、已连接无事件；UI 显示 backend/health/error code。
4. **日志**：Take Journal/Trace 持久化与确定性重放已实现；与 Logging v1.0 的差距缩小到诊断包/轮转/崩溃恢复，未声称完成。
5. **输入质量**：队列溢出会降级 adapter health 并出现在 `captureDiagnostics`；尚未同步到 Rust Take 的 `input_health`。

## 6. 实际运行证据

在 `D:\123\rhythm-trainer-core-v0.2`：

```text
cargo test -p rhythm-core --target x86_64-pc-windows-gnu
# 82 lib + 其它目标，共 104 个测试通过
```

在 `D:\123\rhythm-trainer-frontend`：

```text
npx tsc -b                 # 通过
npm run build              # vite build 通过
npx vitest run             # 5 文件、30 测试通过（含 adapter/clock-map）
npm run selftest           # 101 项断言通过
npm run midi:probe         # 列出 1 个端口：node-midi:0 / MEDELI SP-A500
npm run midi:probe -- --device node-midi:0
                           # 打开成功 connected=true health=healthy；12s 内无按键事件
```

真实页面与会话：

- 服务端 `/api/midi/devices` 返回 `MEDELI SP-A500`；
- 页面设备面板显示该设备，点击连接后 `MIDI 已连接 / healthy`；
- 用 mock 后端注入 Note On/Off 后，UI 监视器显示：
  `Note On C4 v90 #1 0ms`、`Note Off C4 v0 #2 127ms`；
- 重启服务后 probe 能重新打开同一端口（服务退出释放端口）；
- **2026-10-21 真机 Node 会话 `s-1792586469094-1`**：
  - `captureDiagnostics.node`: 112 forwarded / 112 mapped / 0 unmapped / 0 stale；
  - 56 个 `complete` 按键生命周期（全部 `sourceId=node-midi:node-midi:0#g1`）；
  - velocity 14–54（21 个不同值）；A6/B6/C7/D7/E7 分别重复 12/12/6/19/7 次；
  - `/api/midi/trace`: 152 条事件、0 dropped、generation 1；
  - 8 目标：1 Perfect + 2 Good + 5 Miss + 35 Extra；`trustworthy=true`，报告保存；
  - 用户演奏的是 A6–E7 高音区，而目标是 C4–G4；音高提示与 Extra 因此很多。这不是输入故障，节奏匹配本身仍独立于音高。
- 物理热插拔、显式三音和弦、macOS 仍未验证。

## 7. NOT RUN / 环境限制

- 显式三音和弦：NOT RUN（仅观察到 6 组 <15 ms 近同时起音，未确认三音和弦）。
- 物理拔插/重连：NOT RUN。
- macOS 验证：NOT RUN。
- Session Journal / 确定性重放：已实现（JSONL + `GET /api/sessions/:id/replay`，selftest 验证两次重放一致）。
- DiagnosticBundle 导出、崩溃恢复：未实现。
- 输入健康已回写 Rust Take 并阻止降级尝试计入掌握证据。

## 8. 当前最短端到端路径

```text
SP-A500 USB TO HOST
  → OS MIDI
  → Node MIDI Adapter (@julusian/midi)
  → raw bytes + sourceSeq + Node monotonic time + generation
  → 四时间戳 Node↔browser 时钟映射 + session origin
  → 既有 raw-midi ingest → Take/CaptureEpoch 路由 → Rust Core
  → WS judgments/report → React UI
```

验证顺序：`npm run midi:probe` 列端口/打开 → UI 连接 → 按键/松键看监视器 → 开始最小 Take → 报告中的 `captureDiagnostics`。
