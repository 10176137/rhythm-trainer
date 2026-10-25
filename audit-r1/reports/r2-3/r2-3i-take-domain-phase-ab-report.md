# R2-3i Take 领域模型阶段 A/B 报告：Timeline 权威 Take + 兼容历史

**verifiedCodeSha：** `6c44adc06ab5d4a4b688c7e607010868a516bdad`（`6c44adc`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**设计基线：** `rhythm-trainer-take-domain-design-v1.md`（V1.0），现有实现基线 `87f4a8a`。
**范围：** 设计书阶段 A（记录契约）+ 阶段 B（统一结算/独立写入）+ 阶段 D 的 Timeline 兼容读取 + 阶段 E 的“提交后更新/计数”部分；Follow 持久化（阶段 C）和画像重建（阶段 E 完整）留在后续。

## 1. 落地内容

### 1.1 Take 是唯一写入记录

- 新写入只进入 `takes/<takeId>.json`，不再写 `sessions/`。
- `takeId` 为全局唯一 `take-<uuid>`；引擎内部 `take-1`/`practiceSessionId`/`takeIndex`/`captureEpoch` 保留在 `engineDiagnostics` 与 `takeSnapshot` 中，不再作为业务主键。
- 不创建 `practice-sessions/<id>.json`，不维护持久化 `takes[]` 数组。
- 原子写入使用既有 tmp+rename；同一 `takeId` 已存在时绝不覆盖，重复 finalization 不会产生第二条记录。

### 1.2 TakeRecordV1（Timeline）

```text
schemaVersion: 1
takeId
score: { scoreId, scoreFingerprint, scoreSnapshotRef }
lifecycle: { startedAtIso, finishedAtIso, endReason, modeId }
context: { practiceConfigSnapshot, plannerAuthority, plannerVersion,
           planFingerprint, planSnapshotRef, planRunId }
evidence: { traceRef, journalRef, pauseIntervals, captureDiagnostics }
assessment: { trustworthy, scoreStatus, timelineReport }
engineDiagnostics: { practiceSessionId, engineTakeId, takeIndex, takeSnapshot }
```

- `timelineReport` 复用现有报告 DTO（report/analysis/durations/keyLifecycles/scoreV1/scoringConfig/…），避免重复发明同义类型。
- `endReason` 与 `scoreStatus` 分离：正常结束/中断/失败不再与“成绩是否可信”混为一个字段。
- `scoreSnapshotRef`：若 `scoreId` 在乐谱库中且 `importReportSummary.fingerprint` 与本次 `scoreFingerprint` 一致，则把 XML 复制到 `score-snapshots/<fingerprint>.musicxml`，历史不因后来替换同一 `scoreId` 的内容而失真。
- `practiceConfigSnapshot` 保存本次实际生效配置（不是历史展示时反推当前配置）。
- `pauseIntervals` 来自服务端 pauseSegments；`traceRef`/`journalRef` 指向既有过程证据。

### 1.3 兼容读取

- `/api/takes`：列出新 Take + 旧 session 的只读适配结果；`/api/takes/:takeId` 返回原生 TakeRecord；旧记录映射为 `legacy-<sessionId>`，带 `legacy` 字段。
- `/api/sessions`：保留旧形状；新 Take 映射成旧 summary/detail（`sessionId` = Take `takeId`），旧 `sessions/*.json` 继续可读；同一记录不会出现两次。
- `/api/sessions/:id/replay`、复练来源校验、`buildRetryComparison` 均通过统一 `readAnyRecord` 解析新旧记录。
- 旧记录缺少 provenance 时保持 null/缺省，不推断当前默认规划器，不伪造。

### 1.4 服务端可信 plan provenance

- `plan-request` 成功时，服务端在**当前连接**保存 plan context：`mode / authority / plannerVersion / planFingerprint / scoreFingerprint / planRunId`。
- Rust `start` 必须提供 `planRequestId`；服务端校验 mode=timeline、曲谱指纹、`playbackPlanId`（计划运行 ID）与上下文一致，并使用上下文里的来源字段落盘。
- 客户端传入的 authority/version/fingerprint 只做一致性校验；伪造会拒绝，不再作为事实来源。
- rts 路径记录服务端自身的 `rts` authority；不接受 `planFingerprint`。
- plan context 10 分钟过期、每次启动消费一次。

### 1.5 Profile 的当前切片

- `/api/profile` 的总练习/可信次数改为遍历统一 Take 列表（新 Take + 旧 session），不再只看 `sessions/`。
- `StudentModel.observeAttempt` 只在**新 Take 成功提交**后执行；重复 finalization 不会重复计入。
- 画像快照仍是派生缓存；完整的“全量 Take 重建 profile / 算法版本 watermark”尚未实现。

## 2. 真实浏览器验证

由于本机 5173 被另一个项目（Echo）占用，Rhythm 使用临时 Vite `5174` + IAB，验收后已关闭；默认引擎仍为 `rts`。

### 2.1 默认 rts Timeline

真实浏览器《晓之车》第 17–17 小节、右手、Timeline 启动并结束，生成 Take `take-f46a7b76-814e-40f2-aebb-951d8e37ce3a`：

- `score`：`scoreId=score-mvic3rix-accb1e6b`、`scoreFingerprint=2654f283…b935`、`scoreSnapshotRef=score-snapshots/2654f283…b935.musicxml`；快照文件已实际写入。
- `lifecycle`：`endReason=completed`、`modeId=loop`、started/finished ISO 存在。
- `context`：`plannerAuthority=rts`、`plannerVersion=playback-planner-1.0.0`、`planFingerprint=null`、`planRunId=plan:2654f283…m17-17…`、完整 config 快照。
- `evidence`：trace/journal 引用存在，pauseIntervals 为空。
- `assessment.timelineReport.report.state=completed`，scoreStatus=`INSUFFICIENT_DATA`（无输入，符合“数据不足 ≠ 0 分”）。
- `/api/takes/:id` 与 `/api/sessions/:id` 均能读回；`/api/takes` 列表同时显示新 Take 与 legacy Take（`legacy-s-…`），`/api/sessions` 列表中新记录只出现一次。

### 2.2 Rust opt-in Timeline

以 `RHYTHM_PLANNER=rust` 重启后再次运行，生成 Take `take-ba3970bf-b868-4952-b751-1cf082e5254f`：

- `context.plannerAuthority=rust`
- `context.plannerVersion=rust-planner-1`
- `context.planFingerprint=plan-v1:sha256:68bae7800d2bb4e538b75b4803f2370fb7ce7463a30ef9feb8cfec425ee6f808`
- `context.planRunId=plan:2654f283…m17-17…`
- config 快照与 score 快照同样存在。

这说明 `App → plan-request → plan-response → planRequestId → start → Take` 的绑定在真实浏览器中成立，而不仅是服务器单测。

## 3. 自动化测试

- `server/plan-protocol.test.mjs`（10 项）：
  1. 真实 plan-response → start → finish → `takes/` 磁盘 → `/api/takes` + `/api/sessions` 四处字段一致；
  2. 无 `planRequestId` 的 Rust start 被拒绝；
  3. 伪造 `plannerVersion` 被拒绝；
  4. 旧 session 适配为 `legacy-<id>` Take，provenance 保持 null，不伪造；
  5. 新/旧历史 API 兼容。
- `server/selftest.mjs` 更新为检查 `takes/` 落盘；全部 251 项通过。
- `r2-3h-wiring.test.ts` 守卫 Rust start 必须携带 `planRequestId` / `scoreId` / `configSnapshot`。

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run`（全量） | **504 passed / 4 skipped**（48 文件通过 / 2 跳过） |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed** |
| `npm run selftest` | **251/251** |

## 4. 未完成 / 边界

- **阶段 C 未完成**：Follow 仍不调用 `session.begin`，没有提交 Take；Follow 结果仍只在页面内显示，未进入 `/api/takes`/历史。下一步需要为 Follow 提供可信结束 payload 并接入同一 Finalizer（保留 Follow 自己的报告语义，不伪装 Timeline）。
- **阶段 E 未完整**：profile 已改为“提交后更新 + 从统一 Take 计数”，但还没有从全部 Take 全量重建、算法版本/watermark、排除/降权策略的完整实现。
- **阶段 F 未做**：没有全仓 `session` → `take` 改名；旧 `sessions/*.json` 未迁移；`PracticeSession`/`PerformanceTake` 运行时结构保留。
- 旧记录的 `/api/sessions` 形状保持兼容；新 Take 在旧 API 中以 `sessionId=takeId` 出现，历史页无需立即改造。
- 无 CI、无实体 MIDI、无自动化浏览器 E2E；以上为本地真实浏览器 + 本地测试。默认 `rts` 未改，`main` 未合并。
- 未修改冻结的 planner/parity 资产、`EngineScoreEvent` wire protocol、`build_schedule`、matcher 或 `scoring_v1` 算法。

## 5. 下一步

1. 阶段 C：Follow 结束提交 → 统一 Finalizer → `takes/`，历史页/详情支持 Follow 报告。
2. 阶段 E：profile 从 Take 重建、版本/watermark、失败/不可信/中断的纳入策略。
3. 阶段 D 收尾：历史页切换到 `/api/takes` 语义；`/api/sessions` 仅保留兼容。
4. 阶段 F 仅在功能稳定后按引用证据收敛命名。
