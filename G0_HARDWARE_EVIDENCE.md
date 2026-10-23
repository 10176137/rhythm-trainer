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
