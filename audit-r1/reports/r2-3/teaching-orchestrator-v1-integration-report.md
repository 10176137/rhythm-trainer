# Teaching Orchestrator V1 — 后端集成报告

- 报告日期：2026-10-26
- 分支：`r2-3-algorithm-upgrade-v1-1`
- 基线：`e29b8a5`（远程分支 HEAD）
- verifiedCodeSha：`a5323bea41f23332b565832a80bb849af38a2a33`
- 代码提交：`feat(teaching): integrate Teaching Orchestrator V1 REST workflow`
- 验证性质：**本地验证，无 CI**。仓库没有 CI workflow，本报告不把本地结果表述为 CI 通过。

## 1. 范围

按交付包的 `README.md` / `INTEGRATION.md` 将 Teaching Orchestrator V1 加入新分支：

- 新增 `server/teaching-orchestrator.mjs`：LessonRun 持久化、版本化命令、Take 引用校验、证据门槛、教学动作选择、UI DTO。
- 新增 `server/teaching-orchestrator.node-test.mjs`：交付包自带 8 项独立 `node:test`。
- 新增 `server/teaching-orchestrator.api.test.mjs`：真实 engine server 上的 REST 集成测试。
- `server/engine-server.mjs` 注册 `TeachingOrchestrator`、`lesson-runs` 数据目录、三条 REST 路由。
- `package.json` 增加 `test:teaching` 脚本。
- `server/take-persistence.test.mjs` 的故障注入改为跨平台实现（见 §4）。

明确未做：

- **未实现 TS `TeachingRunRepository` / `LessonWorkspace` / `TeachingStepPanel`**。按 `INTEGRATION.md` §5，这是下一阶段；本轮只完成后端纵向切片的 API 与持久化。
- 未迁移现有 `TargetedPracticePanel` / `buildTeachingPrescriptions()` 的 TS 处方计算。
- 未改动评分、matcher、`build_schedule`、`scoring_v1`、`ScoreDocumentV1`、`PracticePlanBundleV1`、FollowRuntime 或 Take 内容语义。
- 默认 planner 仍为 `rts`；未合并 `main`。

## 2. 领域边界

- `Take` 仍是单次演奏的唯一权威持久化记录。编排器只保存 `takeRefs` 与决策证据引用，不复制 Take 报告。
- `LessonRun` 是教学进度，不是 PracticeSession 聚合，不拥有 `takes[]` 内容。
- 编排器不计算音高、起音误差、时值或匹配；只读取已保存 Take 中 Rust 产出的报告。
- `record-take` 只接受 `takeId`，服务端通过 `readTakeById()` 读取已落盘 Take；拒绝客户端提交报告/诊断/处方。
- 本 V1 以逐小节 Timeline 报告为主要证据；Follow-only Take 进入 `collect_more_evidence`，不会虚构诊断或 Timeline 分数。

## 3. REST 集成

新增路由（在 `handleApi` 的 GET 守卫之前注册）：

- `POST /api/teaching/runs`
- `GET /api/teaching/runs/:runId`
- `POST /api/teaching/runs/:runId/actions`

服务实例：

```js
const teachingOrchestrator = new TeachingOrchestrator({
  dir: path.join(DATA_DIR, 'lesson-runs'),
  readTake: (takeId) => readTakeById(takeId),
});
```

错误映射：

- `TeachingOrchestratorError` → 其 `status`/`code`（400/404/409）。
- `readJsonBody` 的 `ScoreLibraryError`（`INVALID_JSON` / `INVALID_BODY` / `PAYLOAD_TOO_LARGE`）→ 对应 4xx，而不是 500。
- 其他异常 → 500 `TEACHING_INTERNAL_ERROR`。

命令语义（与交付包一致）：

- `begin`、`complete-step`、`skip-step`、`record-take`、`retry-current-step`、`abandon`。
- 每个命令带唯一 `commandId` + 当前 `expectedRevision`；旧 revision → 409 `STALE_TEACHING_REVISION`；相同 `commandId` 重放返回 `duplicateCommand: true`，不重复执行。
- `record-take` 核验：Take 存在、`scoreFingerprint` 与 LessonRun 一致、`assessment.persistenceStatus` 为 `persisted`（新增守卫）。失败不会推进教学。

新增的持久化守卫（交付包未覆盖）：

```js
if (take.assessment?.persistenceStatus
  && take.assessment.persistenceStatus !== 'persisted') {
  throw new TeachingOrchestratorError('TAKE_NOT_PERSISTED', ... 409);
}
```

## 4. 跨平台测试修复

`server/take-persistence.test.mjs` 原先用 `chmodSync(takesDir, 0o500)` 注入写失败。Windows 上 `chmod` 不会阻止 owner 写入，导致 3 项测试失败。现改为：

- 写失败时把 `takes/` 目录重命名为 `takes/.blocked`，并在原路径创建一个普通文件；
- 任何写入 `takes/<id>.json` 的操作都会得到 `ENOTDIR`/`EEXIST`；
- 恢复时删除该文件并将目录改回，保留原有 Take。

这是**测试故障注入**的修改，不改变生产写入语义。恢复后四项目录故障注入测试均通过。

## 5. 测试结果

| 验证 | 结果 |
|---|---|
| `node --check server/engine-server.mjs` | 通过 |
| `npm run test:teaching` | **8/8 passed** |
| `npx vitest run server/teaching-orchestrator.api.test.mjs` | **3/3 passed** |
| `npx vitest run` | **555 passed / 4 skipped**（55 files passed / 2 skipped） |
| `npx tsc -b` | 通过 |
| `npm run build` | 通过；只有既有 chunk >500kB 警告 |
| `cargo test --locked`（GNU target） | **179 passed / 0 failed**（102+1+23+11+1+7+7+1+5+21） |
| `npm run selftest` | **251 ok**，全部通过 |

API 集成测试覆盖：

1. 创建 run → `begin` → 完成 study step → 读取 `practiceRequest`；
2. 从磁盘 Take 证据生成 `focus_range` 决策与 `MISSING_NOTES_V1` 处方（60 BPM、第 2 小节、loop）；
3. 相同 commandId 重放不重复执行；
4. 过期 revision → 409；
5. 指纹不匹配 → 409；
6. `pending-retry` Take → 409 `TAKE_NOT_PERSISTED`；
7. Follow-only Take → `awaiting_evidence` / `INSUFFICIENT_SCORE_EVIDENCE`，无处方；
8. 非法 JSON / 方法不允许 / 不存在的 run 均返回编码错误。

## 6. 已知限制

- 本 V1 是固定最小课程模板；没有 AI 课程生成、长期技能掌握推断或 Transfer Test。
- `scoreFingerprint` 是绑定标识，不是对浏览器数据的认证；真正开始演奏仍必须走现有 PlanBundle 门禁。
- 没有 TS 面板；用户目前无法从 React UI 创建/操作 LessonRun。
- 没有把现有 TS 教学处方迁移到 Node，也没有建立迁移 parity 测试。
- LessonRun JSON 文件没有过期清理；`appliedCommands` 仅保留最近 128 条回执（超长课程中极旧 commandId 可能失去幂等记忆）。
- 未把教学决策写入 StudentModel/Profile。
- 未使用真实物理 MIDI；本轮没有触碰演奏/评分链路，因此未重跑真机验收。

## 7. 复审检查清单

- [ ] `record-take` 是否只从磁盘读取 Take，且拒绝 pending-retry / 指纹不一致。
- [ ] 每个命令是否强制 `commandId` + `expectedRevision`，重放是否幂等。
- [ ] Follow-only Take 是否进入证据不足路径，而不是被当成 Timeline 分数。
- [ ] REST 错误是否保持编码 4xx，不把 malformed body 变成 500。
- [ ] 是否没有改动 Take/评分/PlanBundle/Follow 的既有语义。
- [ ] TS 面板仍为下一阶段，未把半成品 UI 混入本提交。
