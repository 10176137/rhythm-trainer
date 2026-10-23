# 修复报告：暂停期间 MIDI 输入导致 Take 失败（P1-1）

**日期：** 2026-10-23
**范围：** 仅修复 P1-1（暂停期间收到真实 MIDI → 引擎拒绝 → `failActiveTake` 丢轮次），并补回归测试。
**未改动：** `scoring_v1`、NAPI、Rust 任何文件、UI 布局、参考播放、R2 迁移。
**基线：** `main` @ `e33f529`

---

## 1. 缺陷确认（代码层）

调用链（修复前）：

```
Node MIDI adapter
  → handleNodeMidiEvent()            engine-server.mjs
  → ingestRawPacket()                engine-server.mjs（无暂停检查）
  → native.pushHit()                 → SessionEngine::push_event()
                                       crates/rhythm-core/src/session.rs:98
                                       if state != Running { return Err(state_error) }
  → catch → failActiveTake('invalid_input')   engine-server.mjs
      native = null; meta = null; activeTake = null; lease released
```

结论与审查记录一致：暂停中弹一个音，`push_event` 返回错误，Node 侧把整轮 Take 置为失败并清空会话状态。恢复后无法继续，整轮练习丢失。

---

## 2. 修复设计

### 2.1 入口拦截（实时路径）

`ingestRawPacket()` 在**写入 trace 之后、调用 `native.pushHit` 之前**判断该事件是否属于暂停窗口：

```js
const duringPause = isInPauseWindow(atMs);
traceRecorder?.append({ ..., duringPause });
if (duringPause) {
  pauseSuppressed += 1;
  if (decoded?.kind === 'note-on') takeJournal?.append('input_during_pause', {...});
  return;   // 保留证据，不进入实时引擎
}
```

- `isInPauseWindow(atMs)`：当前处于暂停 **或** 事件时间落在任一已闭合暂停区间 `[pauseStart, resumeSession)` 内。
- 暂停区间在 `resume` 时以**服务端记录的 session 时间**写入（`pauseIntervalsSessionMs`），不再从浏览器 `atSourceMs` 反推；Take 在暂停中结束时写入开区间（到 `MAX_SAFE_INTEGER`），仅用于排除输入，不用于平移目标。
- 覆盖两条输入路径（Web MIDI / Node MIDI），因为二者共用 `ingestRawPacket`。

**这不是"暂停即停止采集"**：原始字节、时间戳、session 时间照常进入 `ingests` 与 Trace，并带 `duringPause: true`；Journal 记录 `input_during_pause`。

### 2.2 最终评分兜底（批量路径）

`finishSession()` 用**同一份** `pauseIntervalsSessionMs` 过滤 performed notes：

```js
if (isPausedAt(onsetMs)) { pauseExcludedFromScore += 1; continue; }
```

即使某事件绕过了入口检查（例如时钟映射迟到、队列延迟），也不会变成 EXTRA 或 MATCH。

同时，目标平移改为使用 `closedPauseIntervals`（同一来源的已闭合区间），删除了原来"从 source ms 反推 session 区间"的第二套推导。这让实时判定与最终评分**共用同一份暂停区间**。

> 注意：这只统一了"哪些输入属于暂停"，**没有**解决审查中 P1-2 的"暂停发生在某个目标判定窗口内"的边界语义，也没有补对应的窗口边界测试。P1-2 仍未完成。

### 2.3 可观测性

`captureDiagnostics` 新增：

| 字段 | 含义 |
|---|---|
| `pauseSuppressed` | 暂停期间被采集但不送实时引擎的 packet 数（含 note on/off） |
| `pauseExcludedFromScore` | 最终评分阶段因 onset 落在暂停区间而扣除的 performed note 数 |

Trace 事件新增 `duringPause: boolean`；Journal 新增 `input_during_pause`。

---

## 3. 回归测试

新增 `scenarioPauseWithMidiInput()`（`server/selftest.mjs`），8 条断言：

| 断言 | 结果 |
|---|---|
| 暂停期间收到 MIDI 不产生引擎错误 | PASS |
| 暂停后仍可恢复，Take 未丢失（`deltaMs = 2000`） | PASS |
| 暂停期间的输入全部被抑制（`pauseSuppressed >= 3`） | PASS |
| 暂停输入未进入评分输入（`scoreInputNoteCount = 5`） | PASS |
| 暂停输入在最终评分中被扣除（`pauseExcludedFromScore = 3`） | PASS |
| Take 仍可评分且结果正确（`AVAILABLE`、5 correct、0 extra、0 missed） | PASS |
| Trace 保留暂停期间的 Node MIDI 事件并标记 `duringPause` | PASS |
| Journal 记录暂停期间的输入边界 | PASS |

测试场景细节：

- 真实 Node MIDI 路径（`RHYTHM_MIDI_BACKEND=mock` + `midi-test-note` → adapter → clock map → ingest），不是直接伪造 WS `raw-midi`。
- 暂停发生在 count-in 之后（避免"倒计时抑制"掩盖缺陷），使用真实 session 时钟暂停。
- 同时覆盖三种向量：暂停中的 Node 事件、暂停中的 raw packet、**恢复后才送达但 onset 属于暂停窗口的迟到事件**。
- 5 个目标，使 `scoring_v1` 有足够匹配对达到 high confidence，从而能断言 `AVAILABLE`。

### 3.1 修复前失败的证明（实测）

把 guard 临时改为 `if (false && duringPause)` 后重跑同一 selftest：

```
FAIL  暂停期间收到 MIDI 不产生引擎错误
```

恢复后同一场景全绿。这证明该测试确实覆盖原缺陷，而不是"无论如何都通过"。

### 3.2 全部命令结果（本次实跑）

| 命令 | 结果 |
|---|---|
| `npm run selftest` | **PASS** — 163 条断言（原 155，+8） |
| `npm test` | **PASS** — 33 files / 237 tests |
| `npm run build` | **PASS** — 4.47s |
| `cargo test --target x86_64-pc-windows-gnu` | **PASS** — 110（无 Rust 改动，回归确认） |

---

## 4. 改动文件

| 文件 | 改动 |
|---|---|
| `rhythm-trainer-frontend/server/engine-server.mjs` | 入口 guard、`pauseIntervalsSessionMs`、最终评分过滤、诊断字段、resume/finish 区间记录；目标平移改用同一区间 |
| `rhythm-trainer-frontend/server/selftest.mjs` | 新增 `scenarioPauseWithMidiInput()` 并注册 |
| `rhythm-trainer-frontend/src/types/engine.ts` | `EngineCaptureDiagnostics` 增加两个可选字段 |

未改：Rust 任何文件、`score-events.ts`、`playback-planner.ts`、UI。

---

## 5. 行为变化与兼容性

1. **暂停期间的输入不再使 Take 失败**（目标行为）。
2. **暂停期间的输入不再计分**：以前 Web MIDI 客户端会丢弃、Node MIDI 会打进引擎；现在两条路径统一为"记录但不计分"。
3. **`pauseAdjusted` 语义**：现在仅当存在**已闭合**暂停区间（即确实平移了目标）时为 `true`；结算时仍处于暂停 → `false`（与旧行为一致）。
4. **目标平移的来源**从浏览器 `atSourceMs` 改为服务端记录的 session 时间。当客户端发送一致的 `atSourceMs` 时数值不变（`scenarioPauseScoring` 仍然通过）；当客户端未发送 `atSourceMs` 时，以前**不**平移、现在会平移——这是与实时引擎对齐的修正。
5. 旧报告不受影响：没有重算任何历史数据。

---

## 6. 仍未解决（本次明确不做）

| 项 | 状态 |
|---|---|
| P1-2 暂停发生在判定窗口内的实时/最终一致性，及窗口边界测试 | **未完成**（只统一了区间来源） |
| P1-3 服务端 plan 校验（pitch/数量/唯一 ID/measure 覆盖/planFingerprint） | **未完成** |
| P1-4 多 part 禁止严格计时 | **未完成**（仅有契约文档） |
| P2 后半段练习的小节统计 | **未完成** |
| P2 真实 OSMD 渲染下的锚点契约 | 上一轮已完成（8/8，`anchor-contract.json`），本轮未改 |
| 时钟映射分段化 / 同步未就绪事件污染 | **未完成** |
| G0 真机（受控错音、P09 比较、暂停/断连边界） | **NOT RUN**（无实体设备） |

R2 **未开始**。

---

## 7. 建议的下一步

按审查给出的顺序执行第 2 项：统一"暂停发生在目标判定窗口内"的实时与最终语义，并补三种边界测试（窗口前、窗口内、窗口后暂停）。这一步会直接触碰 `matcher.rs` 的 `shift_remaining` 与批量平移的等价性，建议单独任务卡，不要与 P1-3 混做。
