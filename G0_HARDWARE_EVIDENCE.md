# G0 真机证据（滚动记录）

**记录时间：** 2026-10-23T18:42Z（本地 02:42）
**代码：** `main` @ `ae9d6ec`（P1-2B 之后，服务端已重启为当前代码）
**设备：** MEDELI SP-A500（`node-midi:0`，adapter generation 1）
**环境：** `inputHealth = healthy`、`clockQuality = good`（uncertainty ≈ 1.0 ms）、`queueDropped = 0`、所有事件 `transport = node-midi`
**配置：** loop 1 小节、40 BPM、relaxed、固定时间、count-in 3 s
**目标时间：** 3000 ms@C4(60)、4500 ms@E4(64)、6000 ms@G4(67)、7500 ms@C5(72)

---

## 1. 三轮实弹（同一 PracticeSession，take 1–3）

| # | sessionId | takeId | 实际起音（ms@音高） | 与目标偏差（ms） |
|---|---|---|---|---|
| 1 | `s-1792780932471-1` | take-1 | 3229@60, 4146@64, 5686@67, 7519@72 | +229, **−354**, **−314**, +19 |
| 2 | `s-1792780945501-2` | take-2 | 3201@60, 4579@64, **6035@65**, 7548@72 | +201, +79, +35, +48 |
| 3 | `s-1792780958088-3` | take-3 | 3403@60, 5931@67, 7388@72 | **+403**, −69, −112（漏 64） |

`scoreDeviation` 的配对上限是 `max_onset_deviation_ms = 250`。超过它的起音不参与配对，会同时产生 `MISSING` + `EXTRA`——这是第 1、3 轮里出现额外 `MISSING/EXTRA` 的原因，不是判分错误。

---

## 2. G0-A 受控错音：**PASS**（take 2）

仅把第 3 个音从 G4(67) 改弹成 F4(65)，其余照常：

| 检查项 | 结果 |
|---|---|
| `scoreStatus` | **AVAILABLE** |
| 音高统计 | `correct=3, wrongPitch=1, missed=0, extra=0` |
| 错音定位 | `WRONG_PITCH` → `scoreEventId …:P1:m1:e3`，`measure=1`，`expectedPitch=67`，`actualPitch=65` |
| 其他音 | 三个 `MATCH`，未因错音整体错位 |
| 事件数 | 4 个 Note On / 4 个目标，无多余事件 |
| 输入/时钟 | healthy / clock good，4/4 映射，`queueDropped=0` |
| 版本 | `scoring-v1.0.0`、`scoring-v1.0.0:default` |

该轮完整记录：`sessionId = s-1792780945501-2`，`takeId = take-2`，`traceId = trace-practice-1792780921751-1-take-2`。

**G0-A 通过**（单错音、可复核、逐事件定位正确）。

---

## 3. 第 1、3 轮的差异解释（不是缺陷）

- **take 1**：第 2、3 个音分别早 354/314 ms，超出 250 ms 配对窗口 → `MISSING` + `EXTRA`；第 1 个音晚 229 ms（窗口内）→ `MATCH`，但起音误差 229 ms 被计入 onset 指标。`scoreStatus=INSUFFICIENT_DATA` 是因为只有 2 个匹配，不是设备问题。
- **take 3**：漏掉 E4(64) 是对的；但第 1 个音晚 403 ms，超出窗口 → `MISSING(e1)` + `EXTRA(60)`，因此该轮有 2 个 `MISSING`。`INSUFFICIENT_DATA` 同样是匹配数不足。

两轮都说明：**3 秒预备拍后的第一个音容易偏晚**，40 BPM 下 200–400 ms 的偏差就会跨出配对窗口。与音频输出延迟未校准（uncalibrated）叠加时，不应把这类偏差全算作用户错误。

---

## 4. 实时 vs 最终（已记录、可解释）

| take | 实时（HitMatcher） | 最终（scoring_v1） | 原因 |
|---|---|---|---|
| 1 | 1 Perfect / 3 Miss / 3 Extra | 2 MATCH / 2 MISSING / 2 EXTRA | 实时 good 窗口远小于 250 ms；晚 229 ms 的音实时判 Extra 并错过目标，批量对齐把它配成 MATCH |
| 2 | 2 Perfect / 1 Good / 1 Miss / 1 Extra | 3 MATCH / 1 WRONG_PITCH | 第 1 个音晚 201 ms：实时窗口外 → Extra + 目标 Miss；批量 250 ms 内 → MATCH。错音在两侧都是"错" |
| 3 | 1 Good / 3 Miss / 2 Extra | 2 MATCH / 2 MISSING / 1 EXTRA | 同上，首音晚 403 ms |

这是两套算法的已知差异（实时=窗口+单调游标、最终=250 ms 配对+和弦分组），不是 P1-2/P1-2B 的回归；但**最终报告才是权威**，实时判定不应被当作成绩。

---

## 5. 准入与时钟（P1-2/P1-2B 真机验证）

三轮全部满足：

```
admission.packets      = noteOns + nonOnsets          (8=4+4, 8=4+4, 6=3+3)
admission.noteOns      = admitted + suppressed 各项   (4=4+0, 4=4+0, 3=3+0)
admission.admittedNoteOns = pushHitCount             (4=4, 4=4, 3=3)
suppressedNoteOns.outOfOrder = 0
suppressedNoteOns.duplicate  = 0
captureQuarantinedPackets    = 0
duplicateEventIds            = 0
```

`pauseSegments` 为空（三轮均未暂停），`finalPerformedNotes` 与 `scoreInputNoteCount` 一致。**没有出现 `out-of-order` 丢弃，也没有 Take 因输入失败**——这是该策略在真机上的首次正向证据。

---

## 6. 尚未执行

| 项 | 状态 |
|---|---|
| G0-A 受控错音 | **PASS**（take 2） |
| G0-B 成功 P09 前后比较 | **NOT RUN** |
| G0-C 暂停期间输入 / 跨暂停释放 | **NOT RUN** |
| G0-D 断连、重连、旧 generation | **NOT RUN** |
| 音频输出延迟校准 | 未校准（C2） |

G0 整体仍是 **PARTIAL**，不能标记完成。

---

## 7. 2026-10-23T18:50Z 第三批：暂停边界（G0-C）

三轮：`s-1792781374038-4` / `s-1792781396550-5` / `s-1792781424508-6`（同一 PracticeSession，40 BPM / 1 小节 / count-in 3 s）。

### 7.1 逐轮

| # | sessionId | 操作 | 结果 |
|---|---|---|---|
| 1 | `…-4` | 启动后在 4765 ms 暂停，未弹任何音就结束 | 0 输入、4 Miss；开放暂停段；`INSUFFICIENT_DATA` |
| 2 | `…-5` | 按下一个音（4833 ms）后未松手就结束 | **`INVALID`**：`releaseMs: null` 被 napi-rs 拒收 |
| 3 | `…-6` | 3154 ms 弹首音并按住 → 7222 ms 暂停 → 暂停中按 13 个音 → 15984 ms 恢复 → 20369 ms 再次暂停并结束 | 暂停链路通过 |

### 7.2 G0-C 判定：PASS（take-3）

| 检查 | 实际 |
|---|---|
| Take 是否失败 | 否；报告生成，`scoreStatus = INSUFFICIENT_DATA`（仅 1 个匹配），不是 `INVALID` |
| 暂停中的 Note On | `admission.suppressedNoteOns.paused = 13`，其余原因均为 0 |
| 包级抑制 | `pauseSuppressed = 26`（13 Note On + 13 Note Off） |
| 最终评分扣除 | `pauseExcludedFromScore = 13` |
| 暂停段 | `pause-1 [7222 → 15984]`（已闭合）+ `pause-3 [20369 → null]`（Take 在暂停中结束） |
| 跨暂停按键 | `durations` 14 条均为 `crossed_pause_boundary` / `unknown` |
| 已准入起音 | 3154 ms 的首音保留并计分（`correct = 1`） |
| 暂停输入 | 未进入 `scoreInputNoteCount`（=1），未产生 Extra |
| out-of-order / duplicate / quarantined | 0 / 0 / 0 |

**G0-C 通过**：暂停期间的输入被完整隔离、保留证据，跨暂停的起音保留但时值不作严格成绩，Take 未失败。

### 7.3 本轮发现的真实缺陷（已修）

- **现象**：take-2 `scoreStatus = INVALID`，`scoreV1.error = "Failed to convert napi value Null into rust type f64 on JsPerformedNoteInput.releaseMs"`。
- **触发**：Take 在按键未释放时结束（或设备断连导致缺 Note Off）→ `releaseMs` 为 `null` → napi-rs `Option<f64>` 拒收。
- **影响**：整轮评分不可用，且现有合成测试没有任何用例覆盖"未松键就结束"。
- **修复**：`releaseMs` 为空时**省略该字段**，Rust 侧得到 `None`（`missing-release`），而不是让它变成 `INVALID`。
- **回归**：新增 selftest 场景"未松键结束 Take → 不因 releaseMs=null 变成 INVALID"，断言报告非 INVALID、起音仍计分、时值为 `open_note_interrupted / unknown`。selftest 由 232 增至 **236**。

### 7.4 实时 vs 最终（take-3）

实时 0 Perfect / 4 Miss / 1 Extra，最终 1 MATCH / 3 MISSING / 0 EXTRA。首音 3154 ms 比目标 3000 ms 晚 153.8 ms：实时窗口外判 Extra + 目标 Miss，批量 250 ms 内配成 MATCH。与第二批同类差异，最终报告权威。

### 7.5 状态更新

| 项 | 状态 |
|---|---|
| G0-A 受控错音 | PASS（take 2，第二批） |
| G0-B 成功 P09 比较 | **NOT RUN** |
| G0-C 暂停边界 | **PASS**（take-3，第三批） |
| G0-D 断连/重连 | **NOT RUN** |
| 未松键结束 Take | 缺陷已修 + 回归测试 |

G0 整体仍为 **PARTIAL**。

---

## 8. 2026-10-23T20:05Z 第四批：断连测试（G0-D）——失败，进程崩溃（已修）

### 8.1 现象

操作：开始 → 弹 2–3 个音 → 拔掉 SP-A500 的 USB → 等待 → 插回 → 结束。

结果：拔线后 **8788 端口消失，引擎进程退出**；`sessions/traces/journals` 没有新增文件，这一轮 Take **未落盘**。stderr：

```
MidiInWinMM::initialize: no MIDI input devices currently available.
MidiInWinMM::openPort: error closing Windows MM MIDI input port (midiInUnprepareHeader).
```

### 8.2 根因

1. 2 秒一次的 hotplug 轮询调用 `adapter.refreshDevices()`；
2. 设备消失 → `adapter.close('device_missing')`；
3. 后端 `handle.close()` → `input.closePort()`；
4. RtMidi 的 `MidiInWinMM::closePort()` 在无效句柄上 `midiInUnprepareHeader` 失败，抛 `RtMidiError::DRIVER_ERROR`（C++ 异常跨 napi 边界）；
5. 随后的 `destroy()`/析构再次进入 close，进程被终止。JS 的 `try/catch` 无法拦截。

### 8.3 修复

- 设备消失时**不调用**原生 `closePort()/destroy()`：只移除 JS 监听并 `detach()`；adapter 用 `zombieHandles` 保留句柄引用，避免 GC 触发析构。
- `openInput` 改为**先列举设备再关闭旧端口**；若旧设备已消失，同样走 detach。
- 诊断事件携带 `nativeDetached`。
- 回归测试：`adapter.test.mjs` 新增 "detaches a vanished device instead of closing a dead native port"（mock backend 记录 `detachCount`，断言 `closeCount=0`、健康降级、可重新打开）。vitest 237 → **238**。

### 8.4 状态

| 项 | 状态 |
|---|---|
| G0-D 断连/重连 | **本轮 FAIL**（崩溃 + Take 丢失）；修复后需重测 |
| G0-A 受控错音 | PASS |
| G0-C 暂停边界 | PASS |
| G0-B P09 比较 | NOT RUN |

修复已部署到新进程（PID 17184），设备重新连接（generation 1、healthy）。G0 整体仍为 **PARTIAL**。

---

## 9. 2026-10-23T20:40Z 第五批：G0-D 重测（断开 + 重连）——通过

设备操作改为在琴边**关机/开机**（等价于 USB 设备消失/重现），不需要走到 PC。

### 9.1 逐轮

| # | sessionId | 操作 | 结果 |
|---|---|---|---|
| 4 | `s-1792787986066-4` | 重连后正常弹 3 个音 | 对照轮：health healthy、gen 5、3 个 Note On 全准入 |
| 5 | `s-1792788012876-5` | 开始 → 弹 2 个音 → 关琴 → 等 → 开琴 → 重连 → 再弹 1 个音 → 结束 | **G0-D 通过轮** |

### 9.2 G0-D 验收（take-5）

| 检查 | 实际 |
|---|---|
| 断开期间服务 | 未崩溃；8788 持续可用（PID 17184），err 日志无 `midiInUnprepareHeader` |
| 断开后继续 | 同一 Take 未失败；第 3 个音在 24167 ms 被接受 |
| 重连证据 | 第 3 个音的 `sourceSeq = 1`（新连接从 1 重新计数），结束时 `adapterGeneration = 7` |
| 旧 generation | `staleGenerationEvents = 0`、`unmappedEvents = 0`（旧端口已 detach，未再产生事件） |
| 输入健康 | 结束时 `inputHealth = disconnected`，`scoreStatus = DEGRADED` |
| 准入门 | 6 包 / 3 Note On / 3 准入 / 3 pushHit；outOfOrder、duplicate、quarantined 均为 0 |
| 持久化 | 报告、Trace、Journal 全部落盘；`interrupted = false`（浏览器 socket 未断） |

> `report.trustworthy = true` 在这里是既有设计：该字段表示"核心判定结果可信"，输入降级由 `scoreStatus=DEGRADED`、`inputHealth` 和掌握度门禁承担（`selftest.mjs:298` 明确断言了这一语义）。不是缺陷。

### 9.3 结论

**G0-D 通过**（断开不崩 + 重连后新 generation 被接受 + 报告诚实降级 + 证据完整）。

这两轮是设备边界操作，演奏内容本身不干净（take-5：0 correct / 1 wrong / 3 missed / 2 extra），不能当作音乐性证据；G0-A 仍以第二批 take-2 为准。

### 9.4 状态

| 项 | 状态 |
|---|---|
| G0-A 受控错音 | PASS |
| G0-B P09 前后比较 | **NOT RUN** |
| G0-C 暂停边界 | PASS |
| G0-D 断连/重连 | **PASS** |

G0 整体仍为 **PARTIAL**，只差 G0-B。
