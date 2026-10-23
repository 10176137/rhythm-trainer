# CLOCK DOMAIN CONTRACT（R1 交付物 3/5）

**日期：** 2026-10-23
**范围：** Rhythm Trainer 练习 Take 中所有时间坐标的定义、来源、单位、映射与不确定性；提出可版本化的 `clockId` + 分段映射契约。
**性质：** 设计契约 + 现状审计。**未修改任何时钟相关代码。**
**实测环境：** ZCode 内嵌 Chromium（Electron 41.0.3 / Chrome 146.0.7680.80），Windows x64。

---

## 0. 结论

1. **不存在一个会话级固定换算矩阵。** 当前实现把浏览器 `performance.now()` 当唯一权威 session 时钟，其余时钟通过**单点 affine（scale=1）+ 单一 offset** 靠过来，没有分段、没有漂移、没有把不确定性传进评分。
2. **Node 单调钟与浏览器单调钟没有被错误地当成同一 epoch**——代码明确用四时间戳估 `offsetServerMinusClient`。但它们被当成了**同一速率、且 offset 在整个 Take 内恒定**，这是未经验证的假设。
3. **暂停不是"排除时间段"**，而是"把未决目标整体后移"。数学上对已匹配目标等价，但没有 `SessionActiveTime` 这个一等概念，且**两条输入路径的暂停语义不一致**（Web MIDI 暂停时丢弃，Node MIDI 暂停时仍进入）。
4. **`getOutputTimestamp()` 在本栈可用，但有一个致命陷阱**：音频渲染开始前返回 `{contextTime: 0, performanceTime: 0}`。直接用它建立映射会得到"零延迟、完美对齐"的假象。音频运行后它才稳定（实测 6 次采样 `contextTime*1000 - performanceTime` 稳定在 −50803.14 ms ± 0.03 ms）。
5. **`getOutputTimestamp()` 不是物理扬声器延迟测量。** 它给出的是"正在渲染的采样帧"与"该帧被渲染的时刻"的关联，能估计输出路径的调度延迟，但不含空气传播、房间、扬声器/耳机硬件的绝对延迟；本报告不把它当作 C2 校准的替代。
6. 建议引入 `clock-contract-1`：8 个 `clockId`、版本化 `ClockCorrelationSegment`、`SessionClockSnapshot`（落盘进 Take）、以及"不确定性超标 → timing 指标降级"的门禁。

---

## 1. 现状：全部时间字段清单

### 1.1 字段表

| # | 坐标 | 字段/表达式 | 单位 | 产生者 | 权威用途 | 代码位置 |
|---|---|---|---|---|---|---|
| 1 | 乐谱位置 | `RationalBeat{numerator,denominator}` | 四分音符拍（有理数） | importer | 音乐结构、onset/duration、tie span | `score-engine/domain/rational.ts:6` |
| 2 | 乐谱 tick | `startTick`, `durationTicks` | tick（960/四分音符） | `scoreOccurrencesToEngineAtoms` | Rust 目标时刻表 | `playback-planner.ts:239` |
| 3 | 计划相对时间 | `PlaybackOccurrence.playbackBeat` | 四分音符拍（相对 range 起点 + pass 偏移） | planner | 计划顺序 | `playback-planner.ts:140` |
| 4 | 计划毫秒 | `EngineScoreEvent.targetOnsetMs` / `ReferencePlaybackNote.atMs` | ms（f64，**含 count-in**） | `buildEngineScoreEvents` / `buildReferencePlaybackPlan` | **最终评分目标** / 参考音频 | `score-events.ts:23`、`reference-playback-plan.ts:212` |
| 5 | 计划毫秒（实时期望） | `TargetHit.at_ms` / `EngineTarget.atMs` | ms（f64，含 count-in） | Rust `build_schedule` | 实时判定、UI 光标 | `schedule.rs:105` |
| 6 | 会话时间 | `atMs = sessionTimeMs` | ms（相对浏览器 session origin） | 前端映射 / Node 映射 | 演奏事件、判定、评分输入 | `usePracticeSession.ts:144`、`engine-server.mjs:888` |
| 7 | 浏览器单调时间 | `performance.now()` | ms（页面 performance 时间线） | 浏览器 | session origin、tick、pause/resume 边界 | 多处 |
| 8 | Web MIDI 源时间 | `MIDIMessageEvent.timeStamp` | ms（同一 performance 时间线，Chromium） | 浏览器 | `capturedAtMs` | `midiAdapter.ts:82` |
| 9 | Node 单调时间 | `performance.now()`（Node） | ms（**Node 进程自己的时间线**） | Node | `capturedAtMonotonicMs` | `server/midi/adapter.mjs` |
| 10 | Node→浏览器 offset | `clockOffsetServerMinusClientMs` | ms | `computeClockSample` | `mapNodeEventToSession` | `server/midi/clock-map.mjs:16` |
| 11 | 时钟质量 | `clockQuality` ∈ good/estimated/unstable/unknown | 枚举 | `selectClockSample` | 仅用于 `scoreStatus` 降级 | `clock-map.mjs:30` |
| 12 | 时钟不确定性 | `clockUncertaintyMs` = RTT/2 | ms | 同上 | **有记录但不参与评分** | `clock-map.mjs:26`、`engine-server.mjs:969` |
| 13 | AudioContext 时间 | `ctx.currentTime` | 秒（AudioContext 时间线） | 浏览器 | 音频调度 | `audioEngineAdapter.ts:88` |
| 14 | 音频↔performance 锚点 | `audioAtOrigin` | AudioContext 秒 | 前端一次性采样 | 参考播放 | `reference-playback-controller.ts:184` |
| 15 | 墙上时间 | `new Date().toISOString()` | ISO-8601 | Node | 仅 `finishedAtIso` 展示/审计 | `engine-server.mjs:1817` |
| 16 | 暂停边界（原始） | `atSourceMs` | ms（浏览器 performance 绝对时间） | 前端 | 批量评分的目标平移 | `engineBridge.ts:187` |
| 17 | 暂停区间（源） | `pauseIntervalsSourceMs[]` | ms（成对） | 前端→Node | 同上 | `engine-server.mjs:1479` |

### 1.2 值得注意的单位混用

- #4/#5 都是"含 count-in 的 session 相对 ms"，但**由两个不同模块分别计算**（TS `countInBeats*(60000/bpm)` vs Rust `start_at_ms`），靠 server 的 onset 容差互验。
- #6 存在两种来源：Web MIDI 直接 `timeStamp - origin`（同一时间线，零换算），Node MIDI 走 `node perf → 减 offset → 减 origin`（两次换算）。**同一字段承载两种误差模型**，但协议里没有区分（`clockMappingId` 字符串不同，`'web-performance-same-timeline'` vs `'node-to-browser-performance'`）。
- #12 `clockUncertaintyMs` 进了 `EngineIngestMidiPacket`、进了 trace，但 `score_performance` 的输入里没有它。

---

## 2. 现状：拓扑与映射公式

```
                    ┌─────────────────────────── 浏览器进程 ───────────────────────────┐
                    │  performance.now()  ──┬── session origin (onStarted)             │
                    │        ▲              ├── tick(50ms) → server {tick, nowMs}     │
                    │        │              ├── pause/resume atSourceMs                │
MIDIMessageEvent    │        │              └── Web MIDI capturedAtMs = timeStamp      │
.timeStamp ─────────┴────────┘                                                           │
                    │  AudioContext.currentTime ──► 音频调度（reference playback/metronome）│
                    └───────────────────────────────────────────────────────────────────┘
                                   ▲                          ▲
                 WS 四时间戳采样     │                          │  WS 消息（session 相对 ms）
                                   │                          │
                    ┌──────────────┴──────────────────────────┴─────────── Node 进程 ────┐
                    │  performance.now()（Node 自己的单调钟）                              │
                    │    └── capturedAtMonotonicMs ──► - offset ──► - origin ──► sessionMs │
                    │  四时间戳：c0=clientSendPerf, s1=serverReceive, s2=serverSend,     │
                    │            c3=clientReceive                                        │
                    │  offset = ((s1-c0) + (s2-c3)) / 2 ;  uncertainty = rtt/2            │
                    └────────────────────────────────────────────────────────────────────┘
```

### 2.1 四时间戳采样（`clock-map.mjs:16`）

```
rtt        = (c3 - c0) - (s2 - s1)
offset     = ((s1 - c0) + (s2 - c3)) / 2        // server - client
uncertainty= rtt / 2
quality    : rtt ≤ 3 且样本数 ≥ 5 → 'good'；rtt ≤ 15 → 'estimated'；否则 'unstable'
```
客户端在连接建立后 12 ms 间隔发 10 个 ping（`engineBridge.ts:119`），每次 pong 回一个 `clock-sample`；server 保留 **最低 RTT 的那一个**（`selectClockSample`），**采样窗口 32 个**。

### 2.2 事件映射（`clock-map.mjs:50`）

```
clientPerfMs = capturedAtMonotonicMs - offset
atSessionMs  = clientPerfMs - sessionOriginClientPerfMs
```
`sessionOriginClientPerfMs` 由客户端在 `onStarted` 时发送（`usePracticeSession.ts:185` → `engineBridge.sessionOrigin`）。

### 2.3 浏览器事件映射（`sessionTime.ts:13`）

```
if (override 存在且合法):
    sessionMs = override - originPerfMs
    if 0 ≤ sessionMs < 24h: return sessionMs
    if clockDomainId == 'web-page-performance-timeline': return null      // 隔离
    否则 fallthrough
fallback: return performance.now() - originPerfMs                        // 以"现在"重定时
```

### 2.4 播放时钟（`playbackClock.ts:28`）

```
audioTimeForPosition(posMs) = anchorAudio + (posMs - anchorPos)/1000
currentPositionMs()         = anchorPos + (ctx.currentTime - anchorAudio)*1000
quality()                   = ctx.state === 'running' ? GOOD : UNSTABLE
mappingVersion              = 'audio-context-performance-1'
```
锚点建立：`reference-playback-controller.ts:180-187`
```
audioAtOrigin = audio.currentTime() - (performance.now() - originPerfMs)/1000
clock.resetAt(positionMs, audioAtOrigin + positionMs/1000)
```
即：**一次性采样一次两钟关系，之后当作永真**；`resume()` 时重建 clock（重新采样），但新锚点**没有落盘**。

---

## 3. 现状缺陷（按影响排序）

### C1 — 单点 offset 覆盖整个 Take，没有分段（P0）

- `clockOffsetServerMinusClientMs` 在 Take 进行中仍会被 `clock-sample` 更新（`engine-server.mjs:1046-1065`），于是**前半段事件与后半段事件用了不同 offset**，但它们的 `clockMappingId` 完全相同（`'node-to-browser-performance'`）。
- 没有 drift 估计；两进程 `performance.now()` 的速率差（不同时钟源/电源状态）不可测。
- 不可确定性重放：同一 Trace + 同一份 offset 无法复现当时的映射，因为 offset 随时间变化且只保留最后一个值。

### C2 — 不确定性有记录、无门禁（P0）

`clockUncertaintyMs = rtt/2`。**本次未采样真实 WebSocket RTT**，因此不对典型值下结论；只在契约上要求：该值必须随事件传入评分，并在超过阈值时降级 timing 指标（蓝牙/USB hub/高负载下的真实分布需在 C2 或专门实验中测量）。
它被写进每个 ingest、写进 trace，但：
- 不进入 `score_performance`；
- 不参与 `onset` 指标降权；
- 只有 `clockQuality === 'unstable' | 'unknown'` 会把 `scoreStatus` 置 `DEGRADED`（`engine-server.mjs:1546-1567`）。

也就是说：**"估计值差 40 ms 但 quality 叫 estimated" 仍会输出精确到 0.1 ms 的 onset 均值**。

### C3 — 暂停语义不对称（P1）

| 输入路径 | 暂停时的行为 | 代码 |
|---|---|---|
| Web MIDI | `ingestPacket` 在 status 非 countdown/running 时返回 null → **丢弃** | `usePracticeSession.ts:485` |
| Node MIDI | 只检查 `native && meta && activeTake` → **继续 ingest**，`pushHit` 打到 paused session | `engine-server.mjs:939-979` |

Rust 侧 `NativeSession.pause` 之后 `pushHit` 的行为本次**未验证**；但无论如何，两条路径的产品语义应当一致。契约要求：**暂停期间的输入必须进入 trace 但不得计分**（或明确"暂停即停止采集"）。

### C4 — 暂停靠平移目标，没有 `SessionActiveTime`（P1）

- 实时：`HitMatcher.shift_remaining(delta)`。
- 批量：只把 `targetOnsetMs` 平移（`engine-server.mjs:1739`），演奏事件不平移。
- 结果：报告里的 `onsetErrorMs` 混入了"两次独立链路的换算误差"（目标来自浏览器 pause 时刻，演奏来自 Node 映射），在暂停边界上误差会叠加。
- 没有字段说明"本结果已排除 X ms 暂停"（只有布尔 `pauseAdjusted`）。

### C5 — `toSessionMs` 的"重定时回退"（P1）

在非 `web-page-performance-timeline` 的时钟域里，若时间戳越界，会**悄悄改用 `performance.now()`**（把迟到/陈旧事件当作"现在发生"）。对 Chromium 的正规 `timeStamp` 不会触发（会被隔离成 null），但对其他 UA / 自定义 adapter 是明确的静默改时风险。契约要求：**越界必须 null + 记录，不得回退**。

### C6 — AudioContext↔performance 锚点未落盘、未版本化（P1）

一次采样建立锚点，`resume()` 重建，但报告里没有：
- 锚点数值；
- 采样时刻的 `ctx.state`；
- `baseLatency` / `outputLatency`；
- 该锚点对应的 session segment。

若用户报告"参考播放整体偏了 30 ms"，当前无法从 Take 快照复现或证伪。

### C7 — `getOutputTimestamp()` 未使用，且有一个已知陷阱（P2，但会误导实现者）

实测（见 §4）：
- 音频渲染前：`{contextTime: 0, performanceTime: 0}`。
- 音频运行后：稳定。

如果将来有人"顺手"用它来取代 §2.4 的一次采样而不做有效性校验，会得到零延迟的假映射。契约必须写明**有效性判定**。

### C8 — 设备重连没有产生新段（P2）

`adapter.mjs` 维护 `generation`；`handleNodeMidiEvent` 对 `connectionGeneration !== adapterStatus.generation` 的事件计 `nodeEventsStale` 并丢弃（`:942`）。这是正确的 fail-closed，但：
- 重连后同一 `sourceId` 的时钟可能不同（不同 USB 口/不同设备），没有 `sourceClockId` 的新版本；
- `clockMappingId` 仍是常量字符串。

---

## 4. `getOutputTimestamp()`：本栈实测

### 4.1 能力

| 项 | 值 |
|---|---|
| `AudioContext.prototype.getOutputTimestamp` | 存在（function） |
| `baseLatency` | `0.01` s（10 ms） |
| `outputLatency` | 创建后 `0`；音频开始后 `0.04` s（40 ms） |
| `sampleRate` | 48000 |
| 返回结构 | `{ contextTime, performanceTime }` |

### 4.2 关键陷阱：渲染前返回 0

```
new AudioContext() → state='running'
getOutputTimestamp() → { contextTime: 0, performanceTime: 0 }     ← 假值
```
此时 `contextTime*1000 - performanceTime = 0`，看起来是"完美同步"。**必须**用 `contextTime === 0 && performanceTime === 0` 或"`contextTime` 未推进"判定为**无效样本**。

### 4.3 音频运行后的样本（6 次，间隔 ~120 ms，短振荡器）

| # | `ctx.currentTime` | `performance.now()` | `contextTime` | `performanceTime` | `contextTime*1000 - performanceTime` | `outputLatency` |
|---|---|---|---|---|---|---|
| 1 | 0.120 | 50874.7 | 0.06804 | 50871.2 | −50803.159 | 0.04 |
| 2 | 0.240 | 51000.3 | 0.18807 | 50991.2 | −50803.128 | 0.04 |
| 3 | 0.371 | 51125.4 | 0.31805 | 51121.2 | −50803.146 | 0.04 |
| 4 | 0.491 | 51248.3 | 0.43808 | 51241.2 | −50803.122 | 0.04 |
| 5 | 0.621 | 51374.0 | 0.56805 | 51371.2 | −50803.149 | 0.04 |
| 6 | 0.741 | 51499.5 | 0.68806 | 51491.2 | −50803.140 | 0.04 |

**解读（必须按这个口径写进文档）：**
- 两钟关系在此区间**稳定**：`contextTime*1000 - performanceTime` 的波动 ≈ **0.037 ms**，说明 scale ≈ 1。
- `currentTime - contextTime` ≈ **0.052 s**；`outputLatency` = **0.04 s**。差值 ~12 ms 是当前渲染块/缓冲的排队。
- `performanceTime` 落后 `performance.now()` **2.8–9.1 ms**（采样本身有调度抖动）。
- 因此该 API 能给出"输出管线估计延迟"（约 50 ms 量级），**但不是物理扬声器延迟**：没有麦克风回采、没有房间/硬件、没有设备切换后的重估。

### 4.4 契约中的使用规则

允许：
- 作为 `audio:context ↔ runtime:performance` 的**校准输入**，产生新的 `ClockCorrelationSegment`；
- 用于检测 `AudioContext` 被 suspend/重置（`contextTime` 跳变或不再推进）。

禁止：
- 在 `contextTime === 0 && performanceTime === 0` 时建立映射；
- 用其差值作为"用户起音偏差"的校正量；
- 声称它能测出扬声器/耳机的绝对延迟；
- 用单次样本覆盖整个 Take（必须按采样建立分段与不确定性）。

---

## 5. 提议契约：`clock-contract-1`

### 5.1 clockId 命名空间

| clockId | 定义 | 单位 | 单调 | 跨进程可比 | 权威用途 |
|---|---|---|---|---|---|
| `score:beat` | 乐谱拍位（有理数） | 四分音符拍 | 随小节推进 | 是（同 revision） | 音乐结构 |
| `plan:offsetUs` | PlaybackPlan 内相对播放起点的偏移 | 微秒（整数） | 是 | 是 | 目标排序、计划 |
| `audio:context:<instanceId>` | 某个 AudioContext 实例的时间线 | 秒（f64） | 是 | 否 | 音频调度 |
| `midi:source:<sourceId>:<generation>` | 设备/驱动提供的源时间 + seq | 设备相关 | 通常 | 否 | 原始证据 |
| `runtime:browser-performance` | 页面 `performance.now()` | ms | 是 | 仅经 segment 与 Node 比较 | session origin |
| `runtime:node-monotonic` | Node `performance.now()` | ms | 是 | 仅经 segment | 采集时刻 |
| `session:active` | 本 Take 的有效练习时间（排除暂停） | ms | 是 | 是 | 评分时间轴 |
| `wall:unixMs` / ISO | 人类可读时间 | ms | 否（可回拨） | 是（但不可用于排序） | 展示/审计 |

规则：
- `audio:context` 的 `instanceId` 在每次 `new AudioContext()` / suspend-resume 重启时间线时**必须变化**。
- `midi:source` 的 `generation` 在设备重连/驱动重启时**必须变化**。
- `wall` 永不参与排序、判分、map 计算。

### 5.2 `ClockCorrelationSegment`（v1.1 §3.3 的具体化）

```ts
interface ClockCorrelationSegment {
  segmentId: string;              // 稳定唯一
  contractVersion: 'clock-contract-1';
  sourceClockId: string;
  targetClockId: string;
  sourceStart: number;            // 源时钟单位
  sourceEnd?: number;             // 关闭后不可修改
  scale: number;                  // 速率比；默认 1，只在有统计证据时偏离
  offset: number;                 // target = source * scale + offset
  uncertaintyUs: number;          // 95% 区间半宽（或声明 confidence）
  uncertaintyMethod: 'rtt-half' | 'residual-p95' | 'quantization' | 'declared';
  calibrationMethod: 'ws-four-timestamp' | 'get-output-timestamp' | 'co-start' | 'single-sample';
  sampleCount: number;
  createdMonotonicMs: number;
  closedAtMonotonicMs?: number;   // 关闭后不可修改
  version: number;                // 单调递增
}
```

规则：
- **已关闭的 segment 不可修改**；任何新采样/暂停恢复/时钟重置 → **追加**新 segment。
- 每条演奏事件记录 `segmentId`（不是只记一个 `clockMappingId` 常量）。
- `uncertaintyUs` 必须随事件传到评分；超过阈值 → 该事件的 timing 指标 `degraded`，不给 0 也不给假精度。
- `scale` 只有在样本支持时才偏离 1（例：≥ 5 个样本、残差 < 阈值）；否则固定 1。

### 5.3 `SessionClockSnapshot`（落盘进 Take）

```ts
interface SessionClockSnapshot {
  schemaVersion: 1;
  contractVersion: 'clock-contract-1';
  takeId: string;
  sessionOrigin: {
    clockId: 'runtime:browser-performance';
    perfMs: number;                    // 客户端 performance.now() at start
    // 与 Node 侧的关系：
    nodeOffsetMs: number;              // server - client（最终采用值）
    nodeOffsetSegmentId: string;
  };
  segments: ClockCorrelationSegment[];
  pauseSegments: Array<{
    pauseSegmentId: string;
    startSessionMs: number;
    endSessionMs: number | null;       // null = 未恢复就结束
    startSourceMs: number | null;
    endSourceMs: number | null;
    reason: 'user' | 'audio-suspended' | 'device-disconnected' | 'visibility';
  }>;
  countIn: {
    beats: number;                     // 可为分数（3 s 换算）
    startPlanUs: 0;                    // count-in 是 PlanOffset 的 [0, countInUs)
    durationUs: number;
    scoringStartsAtSessionMs: number;  // = firstTarget - goodWindow
  };
  audio: {
    contextId: string;
    sampleRate: number;
    baseLatencySec: number | null;
    outputLatencySec: number | null;
    getOutputTimestamp: {
      supported: boolean;
      samples: Array<{ contextTime: number; performanceTime: number; atPerfMs: number; valid: boolean }>;
    };
  };
  midiSources: Array<{
    sourceId: string;
    generation: number;
    clockId: string;
    mappedEvents: number;
    unmappedEvents: number;
    staleGenerationEvents: number;
  }>;
  quality: {
    worstQuality: 'good' | 'estimated' | 'unstable' | 'unknown';
    maxUncertaintyUs: number | null;
    timingMetrics: 'exact' | 'degraded' | 'unavailable';
    reason: string;
  };
  createdAtIso: string;                // 仅审计
}
```

### 5.4 `SessionActiveTime` 定义

```
sessionActiveMs(t) = t - Σ(暂停区间长度 ∩ [0, t])
```
- `ScorePosition` 与 `PlanOffset` **不因实际暂停而改写**（理想音乐时间）。
- 播放/判定时把 `sessionActiveMs` 用于比较；实现上等价于当前的"目标后移"，但契约里必须显式定义，避免两套等价实现漂移。
- 暂停期间的输入：**进入 trace，标记 `duringPause=true`，不参与评分**（两条输入路径统一）。
- 恢复后继续同一 `PlanOffset`，不得把墙上时间差算作迟到。

### 5.5 Count-in

- 是 `PlanOffset` 的 `[0, countInUs)` 段，**不是**目标。
- `EngineScoreEvent.targetOnsetMs` 含 count-in（现状保留），但契约要求 `planOffsetUs + countInStartUs` 两个字段分开可辨（当前只能靠 `targetOnsetMs >= countInMs` 反推）。
- `countInBeats` 允许分数（3 s / 拍长），但必须在 snapshot 里记录实际 `durationUs`。
- count-in 期间的输入：`scoringStartMs = firstTarget - goodWindow` 之前的都排除（现状正确）。

### 5.6 AudioContext suspend/resume

- `suspend` → 追加 `pauseSegment{reason:'audio-suspended'}` + 关闭当前 `audio:context` segment；`resume` → 新 `instanceId` 或新 segment。
- 现状：`onAudioSuspended` 会触发 session pause（`App.tsx` controller 构造参数），**行为上已兜住**；契约要求把"为什么暂停"写进 `pauseSegments[].reason`，报告区分用户暂停与音频 suspend。
- `audio.playbackClock.quality()` 只在 `state !== 'running'` 时降级——不足以表达"运行中但设备切换导致时间线重置"。

### 5.7 设备重连

- `generation` 变化 = `midi:source` 新 clockId + 新 segment + `snapshot.midiSources[]` 追加一条。
- 重连前的事件保留原 segment；不重新映射。
- 若重连后 offset 无法估计 → `clockQuality='unknown'` → `timingMetrics='unavailable'`，音高/事件身份仍可评分（v1.1 §3.5：低置信时钟只降级 timing，不影响音高身份）。

### 5.8 版本化

- `contractVersion = 'clock-contract-1'` 写入每个新 Take 与每种 DTO。
- 变更规则：新增字段 = minor；改变语义/单位 = major，并需重放兼容层。
- 报告必须能回答："这条 onset 误差用的是哪个 segment、不确定性多少、是否降级"。

---

## 6. 验收测试清单（R1 之后落地）

| # | 用例 | 期望 |
|---|---|---|
| T1 | 固定 BPM 下 rational beat → PlanOffsetUs | 精确（例：60 BPM，1/3 拍 = 333333 µs，舍入规则版本化） |
| T2 | 多 tempo segment 边界 | 本阶段未支持 → ImportReport `RESTRICTED`，不得静默按单 BPM |
| T3 | 4 拍 count-in（或 3 s 分数拍） | 预备拍输入不产生 Extra |
| T4 | 暂停 4 s 再恢复 | 后续 onset error 不含这 4 s |
| T5 | AudioContext suspend→resume | 产生新 segment；报告 reason=audio-suspended |
| T6 | 源时间戳缺失/倒退/跳变 | `sessionTimeMs=null` + degraded，不得回退到"现在" |
| T7 | 时钟 uncertainty 超阈值 | timing 指标 degraded/unavailable，pitch/事件身份不受影响 |
| T8 | offset 在 Take 中被更新 | 事件引用各自的 segmentId，重放可复现 |
| T9 | 设备断连→重连 | 新 generation；旧事件不被重新映射 |
| T10 | 同一 snapshot + trace 重放 | 逐事件 sessionTimeMs 完全一致（bit-identical） |
| T11 | `getOutputTimestamp()` 返回 `{0,0}` | 判定为无效样本，不产生映射 |
| T12 | 暂停期间按键（Node 路径） | `duringPause=true`，不计分、不进 eventResults |

现有测试只覆盖了 T3（部分）、T6（部分）、T9（synthetic 断连结算）。**T1/T2/T4 的逐字段断言不存在**。

---

## 7. 与现有实现的映射（迁移建议）

| 现字段 | 新契约字段 | 处理 |
|---|---|---|
| `sessionOriginClientPerfMs` | `snapshot.sessionOrigin.perfMs` | 直接落盘 |
| `clockOffsetServerMinusClientMs` | `segments[].offset`（node↔browser） | 每个采样窗口产生/更新一个 segment，**不覆盖历史** |
| `clockUncertaintyMs` | `segments[].uncertaintyUs` | ×1000，进入评分门禁 |
| `clockQuality` | `snapshot.quality.worstQuality` | 保留字符串，增加 `timingMetrics` 三态 |
| `clockMappingId`（常量） | `segments[].segmentId` | 事件级引用 |
| `pauseIntervalsSourceMs` | `snapshot.pauseSegments[]` | 带 reason |
| `pauseAdjusted`（bool） | 由 `pauseSegments.length > 0` 推导 | 保留以兼容旧报告 |
| `audioAtOrigin`（内存） | `segments[]`（audio↔performance） | **新增落盘** |
| `getOutputTimestamp`（未用） | `snapshot.audio.getOutputTimestamp.samples[]` | 新增（可选，采样 3–5 次） |

**兼容策略**：旧报告（`schemaVersion=1`）没有 snapshot → 报告 UI 显示"时钟映射不可审计（旧记录）"，不补造、不重算。

---

## 8. 未验证事项

1. Rust `NativeSession.pause` 之后继续 `pushHit` 的实际行为（本次只读代码，未跑）。
2. 长时间（>5 min）Take 的两进程 offset 漂移量（未测）。
3. 蓝牙 MIDI / USB hub 下的 RTT 与 uncertainty 典型值（未测）。
4. 真实 AudioContext suspend/resume 全链路（浏览器 tab 切后台）本次未在 App 内触发。
5. `getOutputTimestamp` 在用户独立安装的 Chrome/Edge 上的行为（只在 Electron 内嵌 Chromium 测过）。
6. 多输入设备并存时的 offset 是否一致（当前单端口绑定的设计下未测）。
