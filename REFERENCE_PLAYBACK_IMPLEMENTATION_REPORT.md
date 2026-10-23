# Reference Playback v1.0 实施报告

- 日期：2026-10-22
- 实施范围：`rhythm-trainer-frontend` 的参考播放 P0 核心；Rust Core 未重写。
- 结论：**共享目标计划、播放控制器、逐音时值、快照、诊断、暂停/停止清理和时钟质量门禁已实现；但 P0 尚未全部完成**。反复段、音频只手静音、独立试听、跟手统一 Take 时钟、采样钢琴和播放光标仍列为未完成/已知限制。

---

## 1. 修改文件与职责

### 新增

| 文件 | 职责 |
|---|---|
| `src/score-engine/playback/reference-playback-plan.ts` | 手别过滤、`ReferencePlaybackPlan` 生成、逐 occurrence 的 voice/duration、与 Rust target 的数量/时间/小节校验。 |
| `src/features/playback/sharedAudioContext.ts` | 节拍器、参考播放、跟手提示共用一个 `AudioContext`；手势内创建/恢复和失败语义。 |
| `src/features/playback/synthPiano.ts` | 本地加法合成钢琴 voice；每个 voice 独立 gain/oscillator，支持正常 note-off 和强制停止。 |
| `src/features/playback/audioEngineAdapter.ts` | `PlaybackAudioEngine` 接口与 Web Audio 实现：note on/off、all-notes-off、gain、compressor、dispose。 |
| `src/features/playback/playbackClock.ts` | AudioContext 时间 ↔ session 相对时间；start/resume 锚点、clockId、mappingVersion、quality。 |
| `src/features/playback/reference-playback-scheduler.ts` | 150ms 前瞻窗口、25ms 控制器 tick、每 voice 自己的 note-off、欠载汇总与错误上报。 |
| `src/features/playback/reference-playback-controller.ts` | 播放状态机、runId 隔离、PlaybackSnapshot、诊断、暂停/继续/停止/完成、AudioContext 挂起处理。 |
| `src/features/playback/reference-playback.test.ts` | 计划/手别/和弦/tie/目标校验/控制器调度/暂停/欠载/时钟挂起测试。 |
| `src/features/playback/synthPiano.test.ts` | 未来音符 hard-stop、正常 note-off 时间测试。 |
| `src/features/practice/metronome.test.ts` | session origin → AudioContext 映射、预备拍、拍号重音测试。 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | 严格目标计划增加手别过滤；构建/启动参考播放；`onStarted` 同步引擎 origin；暂停/继续/停止/重置联动；快照状态/小节显示；红标改为快照驱动；系统音乐只改 gain；右手模式验证。 |
| `src/features/practice/usePracticeSession.ts` | `onStarted` 回调；节拍器 BPM/拍号/开关接入；`captureDiagnostics` 回传。 |
| `src/features/practice/metronome.ts` | 改用共享 AudioContext；修复 session-relative 时间被当成绝对时间的 bug；按 request BPM 而不是 target 间隔计算；按拍号重音；`metronomeOn` 生效。 |
| `src/features/practice/systemDuet.ts` | 改用共享 AudioContext 和同一合成钢琴；`stopAll` 使用 hard-stop；不再关闭共享 context。 |
| `src/types/engine.ts` | 增加 `captureDiagnostics.clockMapping` 类型。 |
| `server/engine-server.mjs` | Node 输入时钟 `unstable/unknown` 时把报告标为不可信（`trustworthy=false`）并写入 `clockMapping`；`estimated` 标记为有限精度。 |
| `README.md` / `CHANGELOG.md` | 记录 Reference Playback P0 与已知边界。 |

---

## 2. 关键数据流

```text
MusicXML
  → ScoreDocument（现有 importer）
  → PlaybackPlan（现有 planner；含 occurrence / chord group / tie 语义）
  → filterPlaybackPlanByHand（新；target scope）
  → ReferencePlaybackPlan（新；每个 occurrence 的 voice 和时值）
      ├→ scoreOccurrencesToEngineAtoms(scopedPlan) → Rust Core 评分 target
      └→ ReferencePlaybackController
            ├→ PlaybackClock（AudioContext 时间）
            ├→ ReferencePlaybackScheduler（look-ahead）
            └→ WebAudioEngineAdapter → 合成钢琴

Rust onStarted(originPerfMs, targets)
  → controller.start(plan, { originPerfMs, engineTargets })
  → 校验 target 数量 / atMs / 小节
  → COUNT_IN → PLAYING
  → PlaybackSnapshot → App 状态标签 / 红标 / 诊断 feedback
```

参考播放和评分共用同一份 `ReferencePlaybackPlan` / `scopedPlan`；不再用 `planGroupsRef[target.index]` 作为音频音高的隐式来源。音频事件的时间来自计划，评分 target 来自同一 groups 转换出的 atoms。

---

## 3. 状态机与播放语义

- `IDLE → PREPARING → COUNT_IN? → PLAYING`
- `PLAYING/COUNT_IN → PAUSED → PLAYING/COUNT_IN`
- `PLAYING → COMPLETED`：所有目标已调度且播放位置达到 `lastEndMs`
- `PLAYING/COUNT_IN/PAUSED/PREPARING → STOPPED`
- 不可恢复错误 → `FAILED`；调度欠载/时钟挂起 → `health=DEGRADED`（播放器仍可继续或进入暂停）
- 每次 start 生成新的 `playbackRunId`；异步 prepare 完成时检查 runId/status，旧 run 不能启动新实例。
- 暂停：停止 scheduler tick，`allNotesOff`，冻结位置；继续：用暂停位置重新锚定 AudioContext，创建新 scheduler，从暂停位置之后的目标继续。
- 停止/完成：停止 tick，`allNotesOff`，防止未来已排程音符继续发声。
- 合成器 hard-stop 会覆盖“已安排但仍未开始”的 note-off；这是暂停后残音的关键修复。
- AudioContext 挂起：控制器暂停并回调 App 暂停 Take；用户继续按钮同时恢复引擎和参考播放。

调度参数：look-ahead 150ms，tick 25ms，late tolerance 30ms。晚到的音会尽量以剩余时值起音并记录 underrun；完全过去的音跳过并产生 `reference_playback.scheduler_underrun`，不会静默假装准确。

---

## 4. 第 23 小节降号听感问题的结论

用户截图中的第 23 小节不是 XML 与 OSMD 显示冲突：

- XML 调号为 `-2`（B♭ / E♭）。
- 第 23 小节第一个起音的 XML/MIDI 数据：
  - 右手：G4 2 拍、B♭4 2 拍、G5 2 拍；
  - 左手：E♭3 **0.5 拍**，随后 B♭3、E♭4、F4 等短音。
- 导入器和 legacy bridge 的 MIDI 音高是正确的（B♭4 = 70，E♭3 = 51 等），没有把降号当自然音。
- 旧系统伴弹把同一 onset 的所有 pitch 都用该组最长时值（2 拍）播放，导致 E♭3 和后续短低音被拖长，和声/低音线听起来糊掉。这是**播放时值分组 bug**，不是谱面音高冲突。
- 新 `ReferencePlaybackPlan` 按每个 occurrence 自己的时值生成 voice；调度器按每个 voice 的 `durationMs` 排 Note Off。上述 E♭3 现在是 0.5 拍（72 BPM 下约 416.7ms），G/B♭/G 和弦仍是 2 拍。
- 已加入回归测试：同一 onset 的 1 拍右手 + 2 拍左手必须得到各自的 750ms / 1500ms（80 BPM）。

**仍存在的评分层限制**：Rust target/atoms 仍以 onset group 的最长 duration 作为 `nominalDurationMs`。参考音频已逐音修正，但“同一 onset 内不同时值的按键时长评分”仍会使用组长时值；要彻底修正需要扩展 Rust target/atom 的逐音时值契约，本轮未做。

---

## 5. 测试命令与实际结果

### 前端

```text
cd D:\123\rhythm-trainer-frontend
npx vitest run
# 22 test files, 136 tests passed
```

新增 15 项：playback plan（4）、controller/scheduler（6）、synth voice（2）、metronome（3）。

```text
npm run build
# tsc -b + vite build 通过
# 警告：opensheetmusicdisplay chunk 约 1.44 MB (gzip 382.93 kB)
```

```text
npm run selftest
# 全部自测通过
```

### Rust Core

```text
cd D:\123\rhythm-trainer-core-v0.2
PATH="/c/Users/10178/dev-tools/w64devkit/bin:$PATH" \
  cargo test -p rhythm-core --target x86_64-pc-windows-gnu
# 82 + 1 + 1 + 5 + 15 = 104 tests passed, 0 failed
```

直接运行 cargo test 时 `x86_64-w64-mingw32-gcc` 不在 PATH 会链接失败；加入 w64devkit 后通过。

### 真实浏览器手工验证

使用 ZCode in-app browser，加载 `http://127.0.0.1:5173/`，恢复《晓之车（暁の車）》（1610 音符 / 113 小节）：

- 双手模式：引擎 target `1018`，参考播放状态 `播放中`，计划/引擎 target 校验通过；页面无 FAILED。
- 右手分手模式：引擎 target `856`，参考播放 `播放中`，说明手别过滤已进入 atoms/音频/UI。
- 暂停：参考状态变为 `已暂停`；等待 2 秒后仍停在同一小节，位置冻结。
- 继续：回到 `播放中`，小节继续推进。
- 结束：参考状态 `已停止`。
- 为确认不是只有 UI 在走，在页面中临时统计 `OscillatorNode.start()`：9 秒内 495 次，证明节拍器/参考钢琴实际在向 Web Audio 调度。
- 最新会话 JSON：`playbackPlanId=plan:2654f28396448762:m1-113:once:playback-planner-1.0.0`，atoms=1018，`captureDiagnostics.clockMapping={quality:'good', status:'ok'}`，`trustworthy=true`（无输入）。
- 重启引擎服务（`server/engine-server.mjs` 已修改）后再次加载页面并开始练习，参考状态仍为 `播放中 · 第 1 小节`，会话状态 `练习中`；结束后 `已停止`。

> 若本机已有旧的 `npm run server` 进程，必须重启它，否则 `captureDiagnostics.clockMapping` 和时钟质量门禁不会生效；Vite 页面会热更新，但引擎服务不会。

---

## 6. 音色来源与许可证

- 当前音色：`src/features/playback/synthPiano.ts` 的**本地加法合成钢琴**，使用 4 个 sine 分音（1 / 2.01 / 3.04 / 4.09 倍频）、短 attack、最长 10s 自然衰减、release 包络。
- 无采样文件、无网络请求、无第三方音色包；因此没有采样许可证问题，也不依赖 CDN。
- 它不是采样钢琴，音色是“可辨识的钢琴式合成音”，不应在文档/报告中称为真实钢琴采样。
- 后续若改用采样钢琴，必须单独确认资源体积、离线加载和许可证；本轮不引入。

---

## 7. 需要手工测试的场景

- 真实扬声器/耳机：钢琴音量、和弦是否削波、短音/长音、重复同音、暂停/停止后残音。
- Windows 实体 MIDI：正常时钟质量下参考播放与按键同步；把时钟质量人为降为 `estimated/unstable` 时报告降级和 UI 提示。
- 浏览器后台标签页、系统音频设备切换、蓝牙耳机延迟：AudioContext 挂起后是否能恢复，Take 是否随参考播放暂停。
- iPad/Safari：手势激活、44px 控件、音频恢复。
- 长谱（113 小节 / 1610 音符）性能：红标逐音增长、OSMD 重绘、内存。
- 反复段/中途变速谱面：当前应被导入器阻断或按固定 BPM 处理，需确认提示清晰。
- 左手/右手同时起音但时值不同（第 23 小节类型）：听感应不再拖长短音；评分时长仍可能使用组长时值（已知限制）。

---

## 8. 已知限制 / 明确未完成

### P0 未完全完成

- **反复段/ending/D.C./Coda**：导入器仍 `blocksStrict`；App 仍不使用 `range-loop`。RP-FR-007 未完成。
- **播放中变速 / 谱面 tempo map**：仍是固定 BPM；`tempoMarks` 保留但播放/评分不使用。
- **独立试听**：参考播放仍依附练习会话和引擎 target；没有“只播放、不建 Take”的入口。
- **采样钢琴**：当前是合成音；没有采样资源/许可证决策。
- **播放光标**：绿色当前目标仍是用户节奏驱动；播放位置只用于状态标签和红标。P1 的“光标完全由 PlaybackSnapshot 驱动”未完成。
- **跟手模式统一 Take 时钟**：跟手仍是独立客户端 `FollowSession`，非 strict、不经 Rust/Take；与参考播放的固定时间模式互斥。
- **音频只手静音**：当前 `hand` 是 target scope（右手练习只要求右手目标）；没有“保留双手 target、只静音一手参考音”的 P1 功能。
- **播放诊断持久化**：`reference_playback.*` 诊断进入内存/反馈，但未写入 Take Journal/Trace；`playbackRunId` 未进入服务端会话记录。
- **逐音时长评分**：参考音频已逐 voice，Rust target 仍按 onset group 最长 duration；混合时值和弦的按键时长评分不精确。
- **时钟质量 UI 仅报告后提示**：服务端在 finish 时降级 `trustworthy`；播放中不实时显示 Node 映射质量。
- **红标与真实音频起音**：红标按计划位置/快照推进；若 underrun 跳过某音，红标仍可能按计划前进（健康状态会显示降级）。
- **主音量/音色选择**：没有参考钢琴与节拍器的独立音量 UI；`systemAudio` 是总开关。
- **物理输出延迟**：没有测量/补偿扬声器输出延迟；只保证 AudioContext 调度时间。
- **节拍器调度**：仍一次性排完整段 click grid，不是 look-ahead；超长谱会创建较多 oscillator。
- **系统伴弹中途开启**：当前显示“下次生效”，不会在运行中从当前位置启动；关闭会立即停止。
- **无真实音频听测**：本轮只能验证调度、快照和页面状态，无法替用户判断音色/音量是否满意。

### 已完成的 P0 核心（相对审计）

- 共享 target plan（校验数量/atMs/bar）。
- 逐 voice 目标时值、和弦同刻、重复同音独立 voiceId。
- 控制器状态机、runId、快照、诊断、暂停/继续/停止/all-notes-off。
- Web Audio 前瞻调度、欠载降级、AudioContext 挂起暂停 Take。
- 参考音不进入用户输入；输入仍走 raw MIDI/PerformedEvent。
- Node 时钟质量门禁（服务端 finish 时）。
- 节拍器 origin 映射、BPM/拍号/开关修复。
