# R2-3h-R2 真实浏览器验收报告（Rust Planner opt-in，生产默认保持 rts）

**verifiedCodeSha：** `fb4c156397e465c86c6e06598232f83a858a0488`（`fb4c156`，本轮浏览器兼容修复；验收基线为 `38e29b5`，A–D 场景均在该修复后的工作树上执行）
**报告提交：** 单独提交（与被测 SHA 分开）。
**分支：** `r2-3-rust-planner`；`origin/main` 保持 `ba6d3c4`，未合并、未切换默认值。
**结论：** Rust opt-in 路径的 Timeline、Follow、故障安全失败与默认 rts 回归均完成真实浏览器观察；过程中发现并修复了一个会阻止应用启动的浏览器兼容缺陷（`node:crypto`）。生产默认仍为 `rts`。

## 1. 环境与基线

| 项目 | 值 |
|---|---|
| 平台 | Windows 10.0.26200 x64；Node v24.19.0 |
| 前端 | Vite 6.3.5，`http://127.0.0.1:5173`（既有 dev server） |
| 引擎 | `node server/engine-server.mjs`，`127.0.0.1:8788` |
| 浏览器 | ZCode In-app Browser（IAB），1280×720；非独立 Playwright/CI 套件 |
| Rust opt-in | 启动时临时 `RHYTHM_PLANNER=rust`；服务日志：`planner authority = rust (plannerVersion rust-planner-1)` |
| 默认回归 | 不设置 `RHYTHM_PLANNER` 重启；服务日志：`planner authority = rts (plannerVersion rust-planner-1)` |
| MIDI | 服务端持续输出 `MidiInWinMM::initialize: no MIDI input devices currently available`；**没有实体 MIDI**，全部输入为应用内模拟输入 |

仓库无 CI workflow，GitHub 上没有该提交的 status checks；以下均为本机运行时观察，不是 CI 结果。

## 2. 发现并修复的真实缺陷：浏览器端 `node:crypto`

**现象：** 在真实浏览器打开 `/workbench` 后，`#root` 为空，React 完全没有挂载（`root.innerHTML.length = 0`）。

**定位：** 动态导入 `src/main.tsx` 得到：

```
Module "node:crypto" has been externalized for browser compatibility.
Cannot access "node:crypto.createHash" in client code.
  at .../@id/__vite-browser-external:node:crypto
  at .../src/score-engine/contract-v1/plan-fingerprint.ts:1
```

`App.tsx` 在 R2-3h 为 `projectScoreDocumentV1` 引入了 `plan-fingerprint.ts`，该文件使用 `node:crypto` 的 `createHash`；Vite 把 Node 内建模块外部化后，模块求值即抛错，应用在挂载前终止。此问题在 tsc/Vitest 下不可见，只有真实浏览器路径会暴露。

**修复（`fb4c156`）：**

- `plan-fingerprint.ts` 的 SHA-256 改为项目已有依赖 `@noble/hashes/sha256` + `bytesToHex`（字符串按 UTF-8 编码，与 `createHash('sha256').update(string)` 字节一致）。
- 新增 wiring 守卫：浏览器投影模块不得出现 `from 'node:`，必须使用 `@noble/hashes/sha256`。
- 冻结指纹向量、contract/parity 测试与全量测试均通过，说明输出字节未变。

**修复后同一浏览器即可正常挂载**（`root.innerHTML.length ≈ 77k`），后续 A–D 均在此修复后的代码上执行。

## 3. 测试曲谱、配置与输入方式

| 项目 | 值 |
|---|---|
| 曲谱 | 晓之车（暁の車）.musicxml（乐谱库 id `score-mvic3rix-accb1e6b`） |
| 指纹 | `2654f28396448762febc969e69765cf4f928ea4b4b7f1dd4f02321a5bf65b935` |
| 规模 | 1 Part、2 谱表、113 小节、1610 音符；`READY_WITH_WARNINGS`，`strictAllowed=true`（1 条 `measure_underfull` 警告） |
| 手别映射 | 谱表 1 → 右手，谱表 2 → 左手（UI 中显式确认，`source=user`） |
| 练习范围 | 第 17–17 小节（右手只有 4 个单音目标，适合模拟输入） |
| 参数 | 80 BPM、右手、实时反馈、标准/宽松判定、严格按键时长、loop 只练一次 |
| 输入方式 | 页面“模拟按键”按钮（自动取当前目标首音）+ 虚拟键盘 C4（用于错音测试）；**非实体 MIDI** |

## 4. A. Timeline 实际练习

### 4.1 计划请求/响应（WS 原始帧）

`plan-1-kz9qw7`（第一次）与 `plan-2-qjjtpd`（第二次）请求字段一致：

- `mode: "timeline"`
- `document.source.sourceFingerprint: "sha256:2654f283…b935"`，单 Part、113 小节
- `config.range = {startMeasureOrdinal: 17, endMeasureOrdinal: 17}`
- `config.hand = "right"`；`handMapping.parts[0].staves = [{1:right},{2:left}]`
- `config.bpm = {numerator:80, denominator:1}`；`countInUs = 3000000`；`ticksPerQuarter = 960`

响应字段：

- `ok: true`，`plannerAuthority: "rust"`，`plannerVersion: "rust-planner-1"`
- `scoreFingerprint: "2654f283…b935"`（与请求指纹一致）
- `planFingerprint: "plan-v1:sha256:cf0ebc0bc0ae91f1c78f37871cd259f9a5a2859fd5e4fd5df996523d3eecdad5"`
- `strictAllowed: true`
- `plan.occurrences/groups/atoms/scoreEvents` 各 4 项；第 17 小节首个 occurrence 为 `…:P1:m17:e1`，`playbackBeat "0/1"`，`durationBeat "1/1"`，`pitch G5 / midiNote 79`

### 4.2 UI 与消费证据

- 启动后可见：`练习已开始（引擎计划）`、`乐谱跟练 · 80 BPM · 计划 rust-planner-1 · 指纹 plan-v1:sha256:cf0ebc0…`。
- 倒数显示 `距离首音`；当前目标从 `G5` 开始，与计划首个 occurrence 一致；进度 `0/4`，模拟按键可用。
- 两次运行都经历了真实的 `session.begin`：WS 中新增 `start` / `started`（服务端 targets 时间 `3000, 3750, 4500, …`ms），不是只显示“开始成功”提示。
- 结束后的报告事件级表格直接引用 Rust 计划运行 ID（`plan:2654f283…:m17-17:once:playback-planner-1.0.0:…`），并给出目标/实际音高 `79 / 79`、`matched · complete`，证明消费的是该计划产生的 atoms/scoreEvents。

### 4.3 评分与持久化

| 运行 | 输入 | 结果 | 报告持久化 |
|---|---|---|---|
| A1 | 无输入 | 4 目标，4 Miss，0 Extra | UI `报告已保存`；文件 `s-1792948279863-1.json`（targetCount 4，judgments 4×miss） |
| A2 | 4 次模拟按键 | 4 目标，0 Perfect / 0 Good / 4 Miss / 1 Extra；音高匹配 1/4（25%），平均起音 +186.8ms；报告提示样本不足、不输出总体分 | UI `报告已保存`，提示会话 `s-1792948317442-2`；文件存在（targetCount 4，judgments miss/extra/miss/miss/miss） |

**观察到的限制：** Timeline 到达 `4/4` 后状态仍为“练习中”，需要手动点“结束”才生成报告；报告本身正常。该行为与 Rust 计划消费无直接关系，本轮未改。

**持久化边界：** 会话 JSON 保存了 `scoreFingerprint`、`playbackPlanId`、`atoms`、`scoreEvents` 与报告，但**没有保存 `planFingerprint`/`plannerVersion`**（R2-3e 已知 GAP-3）。因此“该会话由 Rust 权威产生”的证据来自 WS 帧、UI 的计划版本/指纹与事件级 plan ID，而不是持久化文件本身。

## 5. B. Follow 实际练习

### 5.1 计划与启动

- 请求 `plan-3-tf1elo`，`mode: "follow"`，曲谱指纹/范围/手别与 A 相同；响应 `ok:true`、`plannerAuthority:"rust"`、`plannerVersion:"rust-planner-1"`、同一 `planFingerprint cf0ebc0…`，`occurrences/groups` 各 4。
- UI：`跟手等待模式已开始（引擎计划）`，进度 `0/4`，当前目标 `G5`，模拟按键可用。
- **未调用 `session.begin`：** 启动前后 WS 计数保持 `CLIENT->SERVER start = 2`、`SERVER->CLIENT started = 2`；Follow 的推进完全在浏览器内由 `FollowSession` 完成。

### 5.2 错音与正确音

| 操作 | 观察 |
|---|---|
| 点击虚拟键 C4（错音） | 当前输入 `C4`，最近判定 `音高错误`；进度保持 `0 / 4`，目标保持 `G5` |
| 点击“模拟按键”（正确首音） | 最近判定 `已推进`；进度 `1 / 4`，目标仍 `G5`（第 2 个目标） |
| 再次点击“模拟按键” | 最近判定 `已推进 +2400ms`；进度 `2 / 4`，目标 `C6` |
| 手动结束 | Follow 结果：完成 `2 / 4`、标准 `0`、错误音 `1`、额外音 `0`、重复音 `0`；节奏 MAE `+2400ms`；表格显示两个 G5 目标，首个间隔 `0ms`、第二个 `+2400ms` |

界面明确注明“这不是固定时间 strict 成绩”。**Follow 结果没有服务端持久化**（与未调用 `session.begin` 一致）：未观察到 session/report 文件，仅页面内展示。这是当前设计的限制，报告如实记录。

## 6. C. 故障与安全失败

### C.1 权威未知/WebSocket 断连

停止 8788 服务后点击“开始练习”：

- 可见错误：`无法确认规划权威`；`尚未确认服务端的规划器（引擎服务可能未连接）。本次练习不会启动，也不会在浏览器内改用其他规划器。（AUTHORITY_UNKNOWN）请确认本地引擎服务已启动后重试。`
- 没有创建会话（`start`/`started` 计数不变，无可练习目标），也没有退回 TS planner 的迹象。

### C.2 Rust 规划请求失败

为验证客户端对服务端 coded failure 的处理，在**服务端边界**做了一次一次性故障注入（仓库外的 `ws` 发送钩子，把下一个 `plan-response` 替换为 `ok:false, error.code=NATIVE_PLAN_FAILED`；不修改仓库代码，也不影响生产服务）：

- 请求 `plan-4-7uq1v0`，`mode:"follow"`；注入响应：`{ok:false, error:{code:"NATIVE_PLAN_FAILED", message:"injected server-side plan failure (acceptance C.2)"}}`。
- UI 显示：`无法从引擎获取严格计划`；`NATIVE_PLAN_FAILED: …本次练习不会启动，也不会回退到浏览器内规划。`
- `start`/`started` 计数保持 2，未生成新报告；应用仍可继续操作。

### C.3 恢复连接

- 重启 Rust 权威服务后，第一次点击启动仍按 fail-closed 阻断，同时后台重新查询 `planner-status` 并得到 `{authority:"rust", plannerVersion:"rust-planner-1"}`；**第二次点击**成功启动 Follow（`0/4`，目标 G5），无需刷新页面或重启浏览器。
- 用默认 rts 服务重启后，恢复行为相同：第一次点击阻断并查询到 `authority:"rts"`，第二次点击走既有 TS Follow 路径并正常启动。实际表现是“重连后需再点一次启动”，不是页面级故障。

## 7. D. 默认 `rts` 与自由弹奏回归

服务端以默认配置重启，日志为 `planner authority = rts`。

| 场景 | 观察 |
|---|---|
| rts Timeline | 启动提示 `练习已开始 · 乐谱跟练 · 80 BPM · 右手 · 按后端首音时刻倒数`（**没有** `计划 rust-planner-1`）；WS `start`/`started` 从 2 增至 3，`plan-request` 保持 5；结束报告生成并持久化（`s-1792948553789-1.json`，4 目标、4 Miss + 1 Extra） |
| rts Follow | 启动提示 `跟手等待模式已开始`（**没有** `（引擎计划）`）；没有新增 `plan-request`；模拟一次后进度 `1 / 4`；结束结果显示完成 `1 / 4`、标准 `1` |
| 自由弹奏 | 切换到“自由弹奏”后启动，提示 `自由弹奏开始只记录演奏事件,不做谱面评分`；按 C4 后输入次数 `1 次`；结束提示 `共记录 1 次按键`；全程没有 plan 请求或 session 启动 |

## 8. 协议计数汇总（整轮浏览器会话）

| 帧 | 次数 | 说明 |
|---|---:|---|
| `plan-request` | 5 | 2×Rust Timeline、1×Rust Follow、1×注入失败 Follow、1×Rust 恢复 Follow |
| `plan-response` | 5 | 其中 1 个被测试钩子替换为 `NATIVE_PLAN_FAILED` |
| `start` / `started` | 3 / 3 | 2×Rust Timeline + 1×rts Timeline；Rust/rts Follow 均未调用 |
| `report` | 3 | 2×Rust Timeline + 1×rts Timeline |
| `planner-status` | 4 | 页面加载 2 次 + Rust 恢复 1 次 + rts 恢复 1 次 |

## 9. 未执行 / 无法确认的边界

- **无实体 MIDI 验收**：本机引擎报告没有 MIDI 输入设备；全部输入为应用内模拟。不能把本轮结果描述为硬件验收。
- **无 CI**：仓库无 workflow，所有结果为本机运行；GitHub 提交无 status checks。
- **无独立浏览器 E2E 套件**：本轮是 IAB 中的人工/脚本化交互，不是 Playwright CI 测试。部分动画按钮的 Playwright 原生 click 会超时，实际交互通过页面内 `element.click()`/PointerEvent 触发应用的 real handlers；模拟输入走应用自身的“模拟按键”/虚拟键盘逻辑。
- **Follow 结果不持久化**；**Timeline 在 4/4 后不自动结束**（手动结束生成报告）。
- **手别映射不跨刷新持久化（观察）**：`localStorage['rhythm-trainer.practice-settings.v1']` 只包含 `config`/`metronomeOn`，不含 `handMappings`；页面刷新后需重新确认映射。该问题为既有行为，不阻塞本轮 Rust 接线验收，未在本轮修复。
- Rust 生产默认仍为 `rts`；本报告不授权切换默认值，也不授权合并 `main`。

## 10. 运行结果与可复现性

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run`（全量） | **498 passed / 4 skipped**（48 文件通过 / 2 跳过） |
| `npx vitest run src/score-engine/contract-v1/contract-v1.test.ts` | **60 passed / 1 skipped**（冻结向量与语义） |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed** |
| `npm run selftest` | **251/251** |

Rust opt-in 服务启动：`RHYTHM_PLANNER=rust node server/engine-server.mjs`；默认恢复：`node server/engine-server.mjs`。验收结束后已恢复默认 rts 服务、原练习设置与手别映射，并重新加载页面确认应用可正常挂载。

## 11. 禁止事项核对

- 未修改 `main`，未合并分支。
- 未把生产默认值改为 `rust`；结束时服务日志为 `planner authority = rts`。
- 未修改冻结 Gate、golden、case index、schema、wire protocol、`build_schedule`、matcher、`scoring_v1`。
- 未覆盖 R2-3c/R2-3d 归档报告；全量测试重写的两个证据 JSON 已 `git checkout --` 恢复，未提交。
- 未触碰 `audit-r1/spike/sync-r20-report.mjs`。
- 报告与实现提交 `fb4c156` 分开；报告中的 `verifiedCodeSha` 指向实际被测实现。
