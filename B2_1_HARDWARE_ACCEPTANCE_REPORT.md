# B2.1 真机评分端到端验收报告

- 日期：2026-10-22
- 范围：实体 `MEDELI SP-A500` → Node MIDI Adapter → Take/Trace/Journal → Rust `scoring_v1` → P08/P09
- 结论：**部分通过（PARTIAL）**。真实硬件输入、真实 Take、真实 Rust 评分输出、持久化和绿色光标链路已验证；完整的“有足够匹配的固定时间基准 Take”、真实 P09 自动处方和真实复练闭环仍未完成，不能标记为通过。

---

## 1. 环境与设备

| 项 | 实际值 |
|---|---|
| 平台 | Windows x64 |
| Node | v24.19.0 |
| 前端 | Vite 6.3.5，`http://192.168.1.2:5173`（局域网监听） |
| 引擎服务 | `http://127.0.0.1:8788` |
| MIDI 后端 | `@julusian/midi 3.8.1` |
| 设备 | `MEDELI SP-A500` |
| 设备 ID | `node-midi:0` |
| 输入健康 | `healthy` |
| 最新真实 `sourceSeq` | 156 |
| queueDropped | 0 |
| traceDropped | 0 |
| 音频延迟 | 仍未校准（uncalibrated） |

局域网最初无法访问，原因是 Vite 只监听 `127.0.0.1`。已改为 `0.0.0.0`，本机通过 `http://192.168.1.2:5173` 返回 200，页面/WS 代理可用。

---

## 2. 真实硬件测试记录

### 2.1 REAL_HARDWARE：真实 Take，产生 Rust scoreV1

- sessionId：`s-1792678711370-7`
- takeId：`take-1`
- practiceSessionId：`practice-1792678693982-3`
- traceId：`trace-practice-1792678693982-3-take-1`
- 模式：score，72 BPM，双手，4 小节 C 大调练习曲
- 真实 MIDI：14 个转发包，5 个 scoring events，2 个预备拍抑制
- key lifecycle：7 个完整配对
- 输入健康：`healthy`
- 时钟映射：`good`，mapped 14，unmapped 0
- Rust 统计：16 targets，0 Perfect，1 Good，15 Miss，4 Extra
- `scoreV1`：
  - targets 24，correct 2，wrongPitch 1，missed 21，extra 2
  - eventResults 包含 2 MATCH、1 WRONG_PITCH、21 MISSING、2 EXTRA
  - measure 1 matched 2；measure 2 matched 1 / missed 5；measure 3/4 全 miss
  - `confidence=low`
- `scoreStatus=INSUFFICIENT_DATA`
- 持久化：成功，`GET /api/sessions/s-1792678711370-7` 可重新读取同一份报告
- 结论：真实硬件事件确实进入 Take 和 Rust 评分；但有效匹配样本不足，不能作为“基准通过”。

### 2.2 REAL_HARDWARE：真实错误输入

同一 Take 中已经出现可复核的真实错误：

- E4/其它音高被配为 `WRONG_PITCH`（expected 74 → actual 65）
- 2 个 `EXTRA`（performedNoteId 131/134）
- 21 个 `MISSING`，主要因为后续小节未弹
- 事件结果带 scoreEventId、performedNoteId、measure、expected/actual pitch
- 目标/实际对应关系可从报告与 Trace 核对

这是**真实发生的错误输入**，但不是预先设计的“单一可控错误”场景；仍需补一轮固定时间、足够匹配样本的 deliberate error Take。

### 2.3 REAL_HARDWARE：绿色光标本身

在跟手等待模式实际弹完第 1 小节右手：

- 当前目标最终显示 `已完成`
- 结果：**完成 4 / 目标 4**，错误音 2，额外音 0
- 绿色光标确实按正确输入前进（此模式不生成 Rust Take/历史）

发现并修复的真实缺陷：

- Node MIDI 实体设备路径只把事件送入引擎，没有调用浏览器侧 `handleGuideNote`；因此引擎可判 MATCH，绿色光标却不前进。
- 修复：Node MIDI Note On 现在也更新同一个 guide 光标，不影响评分。

### 2.4 REAL_HARDWARE：暂停边界缺陷

真实暂停试验暴露：

```text
operation 'advance' is not valid in state 'paused'
```

根因：前端暂停后 tick 定时器仍在运行；客户端和服务端都未阻止暂停期间 `NativeSession.advance()`。

修复：

- 前端暂停时停止 tick，恢复时重启；paused/processing/idle 状态不再发送 tick。
- 服务端忽略暂停期间的迟到 tick，不把引擎错误推到 UI。
- selftest 增加“暂停期间 tick 不产生引擎错误”回归用例。

修复后受影响的真实基准 Take 仍未补完；当前报告不会把这次缺陷修复后的完整 Take 说成已验证。

---

## 3. 关键证据分类

| 测试/能力 | 分类 | 结果 |
|---|---|---|
| SP-A500 连接、Note On/Off、力度 | REAL_HARDWARE | 通过（多次真实事件） |
| LAN URL 访问 | REAL_HARDWARE（本机 LAN 验证） | 本机 200；外部平板仍需用户确认防火墙 |
| 真实硬件 Take | REAL_HARDWARE | 通过链路，scoreStatus INSUFFICIENT_DATA |
| Rust `scoreV1` / eventResults / measures | REAL_HARDWARE + Rust | 已生成，来自真实 Take |
| 历史重新读取同一报告 | REAL_HARDWARE | 通过 |
| 跟手绿色光标 | REAL_HARDWARE | 通过（4/4，2 wrong） |
| 固定时间绿色光标 + 足够匹配基准 | REAL_HARDWARE | **未完成** |
| 真实 deliberate error Take | REAL_HARDWARE | **未完成**（已有非受控真实错误） |
| P09 真实自动处方 | REAL_HARDWARE | **未执行**（真实报告 insufficient，门禁阻止自动处方） |
| P09 真实复练 + 比较 | REAL_HARDWARE | **未执行** |
| 暂停期间 tick | REAL_HARDWARE 触发 + 回归测试 | 缺陷已修复，待真机复测 |
| 断连/重连、旧 CaptureEpoch、迟到事件 | NOT_RUN（实体）；SYNTHETIC_MIDI/固定 Trace 已有 | 不能算真机通过 |
| 重复 STOP、旧事件不改报告 | 既有测试 | 不作为 B2.1 真机通过 |

---

## 4. 已修复缺陷与回归

### 4.1 Node MIDI 绿色光标

- 文件：`src/App.tsx`
- 修复：Node MIDI Note On 也调用 `handleGuideNote`（timeline 模式）
- 观察：真实跟手练习完成 4/4

### 4.2 暂停 tick

- 文件：`src/features/practice/usePracticeSession.ts`
- 文件：`server/engine-server.mjs`
- 修复：暂停停止 tick；恢复重启；服务端忽略暂停 tick
- 验证：engine selftest 152 项通过，其中包括暂停 tick 回归

### 4.3 谱面显示改进

- 单右手时，非目标手音符透明度 `0.22`，并增加“仅作上下文”提示。
- 乐句循环时，非循环小节覆盖半透明绿色遮罩；覆盖层 `pointer-events:none`，不拦截点击。
- 已验证第 2–4 小节生成 3 个绿色遮罩。

### 4.4 完整乐谱启动导致引擎崩溃

真实使用完整乐谱时发现 `/api/scores` 返回 500、设备断开。根因不是乐谱元数据损坏，而是：

- 完整乐谱的 `start` 消息携带 per-note `scoreEvents`，1,600 音已超过旧的 WebSocket `maxPayload=256KB`。
- `ws` 抛出 `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`，Node 连接上的未处理 `error` 事件直接杀死整个引擎进程。
- 因此所有 REST/WS 同时失效，看起来像乐谱库和 MIDI 同时坏了。

修复：

- `maxPayload` 提高到 `8MB`，并按完整乐谱的目标数量保留有界上限。
- 每个 WebSocket 连接增加 `error` handler；单个坏消息只关闭该连接，不再杀死服务。
- 新增 selftest：发送 300KB 的非法 start 消息必须得到结构化错误，随后同一连接仍可继续启动。
- 验证：selftest 152 项通过；`/api/scores` 恢复 200；服务在超大帧后仍存活。

这是 `FAULT_INJECTION` 回归，不是真机通过证据。

### 4.5 OSMD 谱面空白

真实浏览器切换曲谱库/工作台后，OSMD 曾在容器宽度已经恢复时仍保留 `width=0` 的 SVG（`viewBox="0 0 0 ..."`），谱面显示为空白，但工具栏和 MIDI 仍在。

修复：增加可见容器宽度检查；若 host 宽度 > 0 而 SVG width 仍为 0，则重新挂载/渲染一次。验证后 SVG 为 `1510 × 248.5`，音符恢复；无评分/目标变更。

### 4.6 连接断开时的 Take 持久化

换设备/刷新页面会关闭当前 WebSocket；旧实现只 abort，活动 Take 没有报告，历史里看不到。

已实现最小安全策略：

- socket close 时若仍有活动 Take，先按 `interrupted` 结算并持久化已采集的 Trace/Journal/报告。
- 记录 `interrupted: true`，`report.trustworthy=false`，输入健康标记 `disconnected`，不进入掌握度。
- 历史列表显示“中断”，报告仍保留真实事件与 `scoreV1` 字段；P09 自动处方会因 DEGRADED 门禁被阻止。
- selftest 新增断连自动结算回归，150 项通过。

边界：这是**中断 Take 的持久化**，不是跨设备继续同一个活动 Take。跨设备续弹需要 Take 所有权转移/重放设计，当前未实现，不能宣称已支持。

### 4.7 保存 Take 模板 CRUD

按用户确认的首版模型实现“保存的 Take 模板”：

- `/api/take-templates` 支持列表、创建、读取、重命名/更新、删除。
- 模板保存曲谱指纹/名称、模式、BPM、手别、循环开关、范围、判定/时值/推进配置。
- 设置面板可选择并应用模板；应用后开始练习会创建新的 Session/Take，并写入 `takeTemplateId/takeTemplateName`。
- 历史列表显示 `Take`，详情显示关联 Take 名称；模板本身不被演奏覆盖。
- 目前不保存“活动 Take 事件所有权”，因此仍不是换设备续弹；该能力留待数据库/活动 Take 阶段。

验证：Take 模板存储单测、API CRUD + 启动关联 selftest、浏览器应用模板并生成关联记录均通过。测试记录已清理。

### 4.8 多浏览器/多设备的权威边界

本地 engine service 所在机器的数据目录是唯一持久化权威；但活动 Take 需要额外租约，否则两个浏览器同时 start 会抢全局 MIDI sink。

已实现单一活动 Take 租约：

- 第一个成功 start 的连接持有活动 Take；其他连接 start 返回“另一个设备有进行中的练习”。
- 第一个 Take finish 或断连结算后释放租约，其他连接才可开始。
- 历史、乐谱库和 Take 模板本身是共享的；每个浏览器仍有自己的 localStorage 配置/当前曲谱选择。
- 租约 owner 断连会走 interrupted 自动结算，另一个设备可以开始新 Take，但不能续接同一条活动 Take。

selftest 新增双客户端并发租约回归，152 项通过。

### 4.9 首音倒计时（后续修复）

固定时间练习原先固定等待 3 秒，然后才启动引擎；引擎内部还有 4 拍预备，导致用户需要经历“3 秒准备 + 一段没有明确提示的倒数”。用户进一步确认默认预备段应为 3 秒。

修复后：

- `started` 由后端显式返回 `firstTargetAtMs`（`targets[0].atMs`，已包含预备段和谱面前休止）及 `countInMs`。
- 预备段默认固定 3 秒，并按当前 BPM 换算成拍数：40 BPM = 2 拍、80 BPM = 4 拍、120 BPM = 6 拍。
- 固定时间模式点击开始立即启动引擎，不再先等客户端 3 秒；覆盖层按 `firstTargetAtMs` 倒数，数字归零即第一个音。
- 首音前的暂停/恢复会随后端 `deltaMs` 顺延倒计时终点。
- 跟手/自由模式没有后端首音时间，仍保留独立的 3 秒准备层。

浏览器实测（40 BPM，右手，真机已连接但本节不演奏）：后端首音 3000ms，覆盖层 3→2→1，约 3.1s 归零并切换“练习中”，没有再叠加额外等待。

### 4.10 2026-10-23 真机补充验收（AVAILABLE 基线与 P09）

**平板访问确认**：平板 `192.168.1.2` 通过 LAN 连接到主机 `192.168.1.4:5173/workbench`；MIDI 输入仍在主机 Node 适配器，平板只负责显示/控制。新增 `/workbench?takeTemplate=<id>` 深链接，可在平板自动应用共享 Take 模板，避免手动切换 loop/判定。

**REAL_HARDWARE 干净基线** `s-1792769578764-7`：

- 配置：40 BPM、右手、loop 第 1 小节、relaxed、4 个目标
- `scoreStatus=AVAILABLE`，置信度 high，Overall **83.97**
- 2 Perfect + 2 Good，0 Miss、0 Extra，targetHitRate 100%
- 音高 4/4 正确；onset MAE **46.1ms**，抖动 1.8%，连续性 100%
- 8 个 MIDI 包、4 个 Note On，输入 healthy、时钟映射 good、无丢弃

这是第一条**真机、数据质量干净、完整评分可用**的 Take。

**REAL_HARDWARE P09 来源** `s-1792767914539-5`：

- `scoreStatus=AVAILABLE`，Overall 66.9，音高 4/4，onset MAE 128.5ms
- 自动处方：`LOCAL_ONSET_V1`，第 1 小节，40 BPM，右手
- 注意：历史行摘要仍显示 `0% 命中 / MAE —`，因为该摘要使用旧 live 节奏判定；完整报告是 `AVAILABLE`。这是已观察到的摘要差异，不能把行摘要当作评分结论。

**P09 任务与比较门禁**：

- 创建 `s-1792769554711-6` 和 `s-1792769705931-8` 时正确写入 `sourceReportId=s-1792767914539-5`、`sourceTakeId=take-4`、`prescriptionId=rx-s-1792767914539-5-LOCAL_ONSET_V1-1-1`。
- 早期“确认创建”会立即启动，用户从历史页切换回练习室时已经错过倒数；已改为**创建后进入准备态，等待用户点“开始练习”**。
- 修复后 `s-1792770190158-9` 正确等待用户开始，但仍只有 4 个 Note On：起音约为 `3206/4348/5680/7254ms`（目标 `3000/4500/6000/7500`），全部落在判定窗口外，`scoreStatus=INSUFFICIENT_DATA`。
- `retryComparison` 正确持久化并给出 `comparable=false`：`只有两份报告均为 AVAILABLE 才比较（原 AVAILABLE / 复练 INSUFFICIENT_DATA）`。这说明比较门禁没有伪造进步，但**成功的 P09 前后比较尚未完成**。

分类：以上两条 `AVAILABLE`、指纹/持久化/真机输入均为 REAL_HARDWARE；P09 空/未对齐复练为 REAL_HARDWARE 但结果为 INSUFFICIENT_DATA；没有把 synthetic 结果混入这些记录。

---

## 5. 自动化验证

```text
npm test
# 30 files, 175 tests passed

npm run selftest
# 155 assertions passed

npm run build
# tsc -b + vite build passed
# 仅 OSMD/主包 chunk 体积警告
```

Rust Core 未在本轮重写；B1 基线仍为 110 项通过。

实体验证不能由这些自动化结果替代；上表的 REAL_HARDWARE / SYNTHETIC / NOT_RUN 分类已分开。

---

## 6. 未完成项

1. **固定时间、足够匹配的真机基准 Take**：已完成。`s-1792769578764-7` 为 4/4、2 Perfect + 2 Good、Overall 83.97、`AVAILABLE`。
2. **真机 deliberate error Take**：仍**未完成**。尚未在固定时间模式中故意制造一个受控错音并检查 eventResults/小节映射。
3. **真实 P09 自动处方**：已完成。`s-1792767914539-5`（`AVAILABLE`）自动生成 `LOCAL_ONSET_V1`，第 1 小节、40 BPM、右手。
4. **真实 P09 复练闭环**：部分完成。来源引用、处方、原报告不变、比较门禁已持久化并验证；成功的有输入复练仍未达到 `AVAILABLE`，因此**比较结果仍未生成**（正确阻断为 `INSUFFICIENT_DATA`）。
5. **断连/重连、旧 CaptureEpoch、迟到旧事件**：仍有 selftest 级回归，**实体异常边界未在本轮真机完成**。
6. **平板外部访问**：已确认。平板 `192.168.1.2` 可访问主机 `192.168.1.4:5173`，并使用共享 Take 模板/深链接完成本轮演奏。
7. **音频延迟**：仍未校准。两次可比较 Take 的 onset MAE 分别为 46.1ms 与 128.5ms；只能作为练习反馈，不能声称采样级物理精度。

---

## 7. 结论与下一步

B2.1 **部分通过，仍不可标记为完整通过**：

- 实体 MIDI 输入、Take、Trace、key lifecycle、Rust `scoreV1`、持久化和平板 LAN 显示已经打通。
- 真机 `AVAILABLE` 干净基线已取得：`s-1792769578764-7`，4/4、Overall 83.97、MAE 46.1ms。
- 真实 P09 自动处方已取得：`s-1792767914539-5` → `LOCAL_ONSET_V1`。
- P09 来源引用、处方持久化、等待用户开始、以及“复练非 AVAILABLE 时不伪造比较”的门禁已验证。
- 但成功的有输入 P09 复练/前后比较、受控错误 Take、实体断连/旧 epoch 边界仍未完成；因此不能进入 C2/C3，也不能写成完整真机验收通过。

建议下一步只做 B2.1 收尾：

1. 从 `s-1792767914539-5` 再做一次 P09 复练，目标为 4 个起音全部落在窗口内，生成 `AVAILABLE` 复练报告和真实比较。
2. 用受控错音完成 eventResults/小节映射验收。
3. 在真机上触发断连、旧 CaptureEpoch、迟到事件和重复 STOP。
4. 再决定是否进入 C2 音频延迟校准。
