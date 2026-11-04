# Alignment V2 — Timeline Take 影子 Sidecar 接线报告

- 日期：2026-11-04
- 分支：`r2-3-alignment-v2`（起点 `d56771b`）
- 目标：候选对齐只做观察与证据积累，`scorePerformance` 保持唯一权威；不影响 P08、mastery、Take 的保存状态
- 本报告为**代码实施记录，不是验证通过报告**。当前执行环境无法运行该仓库的本地 Rust N-API/完整集成测试。

## 1. 已实现

- `rhythm-trainer-frontend/server/alignment-shadow.mjs`：
  - 只读运行 `addon.alignPerformancesCandidate`，使用与 `scorePerformance` 完全相同的 `adjustedScoreEvents` 和 `performedNotes`；
  - 按 `scoreEventId` 比较基线与候选的 `performedNoteId`、`pitchMatched` 与原始 `onsetErrorMs`；
  - 保存匹配数、miss、extra、recovered/lost、分歧细节（最多 128 条）、算法版本和输入 SHA256；
  - 将候选异常转为 `status=error`、缺数据/超限转为 `status=skipped`，不修改官方评分；
  - 每个 Take 的观测保存在独立文件 `<DATA_DIR>/alignment-shadow/<takeId>.json`。
- `engine-server.mjs`：环境变量 `RHYTHM_ALIGNMENT_SHADOW=1` 才启用（默认关闭）；官方 scoreV1 先运行，候选在其后运行；权威 Take 成功写入后，在一次性 `onPersisted` 中存储 Sidecar。写失败只记录日志，不阻塞 Mastery 或 Take。
- 独立 Sidecar 采用写完临时文件再 hard-link 创建目标文件的 write-once 行为；相同 takeId 不覆盖。
- 未修改 `scoring_v1`、`scorePerformance`、评分权重、N-API DTO、golden、P08/前端、Plan/Planner 默认值、Take schema。
- 不处理 Follow 演奏模式；这次任务只讨论 Timeline 的**最终评分**。

## 2. 证据格式（示意）

```json
{
  "schemaVersion": 1,
  "shadowVersion": "alignment-shadow-v1",
  "authority": "diagnostic-only",
  "status": "compared",
  "takeId": "take-example",
  "input": {
    "scoreCount": 8,
    "performedCount": 8,
    "scoringInputSha256": "<SHA256>",
    "timeDomain": "session-ms-after-admission-and-pause-adjustment"
  },
  "summary": {
    "changedTargetCount": 1,
    "recoveredTargetCount": 1,
    "lostTargetCount": 0,
    "baselineMissed": 1,
    "candidateMissed": 0,
    "baselineExtra": 1,
    "candidateExtra": 0,
    "truncatedDiffDetails": false
  },
  "differences": [
    {
      "scoreEventId": "s4",
      "baseline": null,
      "candidate": {"performedNoteId": "p4", "pitchMatched": true, "onsetErrorMs": 400}
    }
  ],
  "provenance": {
    "traceId": "trace-example",
    "planFingerprint": "<fingerprint>",
    "scoreFingerprint": "<fingerprint>",
    "officialScoreStatus": "AVAILABLE",
    "inputHealth": "healthy",
    "clockMappingStatus": "ok"
  }
}
```

示意中 ID、摘要、状态不是本机实验的真实结果。完整分歧可能截断，`totalDiffDetails` 保留真实数目。Sidecar 不保存全量原始 MIDI，必须通过原 Take/Trace 和输入哈希追溯。

## 3. 验证命令（必须在本地仓库执行）

先按项目既有流程构建当前分支的 Rust N-API addon：

```bash
cd rhythm-trainer-core-v0.2/bindings/node
npm install
npm run build:debug
cd ../../..
cd rhythm-trainer-frontend
npm install
npx vitest run server/alignment-shadow.test.mjs server/alignment-shadow.protocol.test.mjs server/take-finalization.test.mjs server/take-persistence.test.mjs
```

从仓库根目录运行现有基线与候选回归：

```bash
node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs
node audit-r1/benchmarks/alignment-v1/run-benchmark.mjs --candidate
```

运行 5000/10000 音独立性能门禁（每种规模含 clean 和 +300ms phase）：

```bash
node audit-r1/benchmarks/alignment-v2/run-performance.mjs
```

输出到 `audit-r1/benchmarks/alignment-v2/out/performance-local.json`，脚本对每个子进程设 120s 硬超时，记录 official/candidate 耗时、RSS、配对正确性。必须保留实际失败和超时，不得改阈值或 mock 为通过。建议记录 CPU/系统/Node/Rust 版本，重复三轮排除启动/热身干扰。

### Sidecar 手工端到端

1. `RHYTHM_ALIGNMENT_SHADOW=1` 启动引擎；使用 Timeline 乐谱与 SP-A500 MIDI 完成一段演奏。
2. 核验 `takes/<takeId>.json` 和 `alignment-shadow/<takeId>.json`；以 `scoreEventId` 对照旧新配对，抽查原始 onset error 不受 warp/窗口影响。
3. 同一 Trace 在不开启 Shadow 的进程里重放，核对官方 `scoreV1`、P08、评分、profile 写入与开启时完全一致（排除非确定性字段）。
4. 注入候选崩溃或 Shadow 目录不可写；Take 保存仍成功、Mastery 只更新一次，日志存在而 Sidecar 可以缺失。
5. 测试写盘失败、persist-retry、重复 finish、断连结算；不得产生覆盖、重复 Take 或虚假 Sidecar 成功宣称。

## 4. Gate 状态

| Gate | 状态 | 证据/阻塞 |
|---|---|---|
| B — 合成候选算法 | 既有报告 PASS | 30 case、hard F1 +12.1pp；本阶段**未重新执行** |
| C — Take 只读 Shadow 接入 | 代码已提交，验证未完成 | 需运行 Vitest/协议测试、对比开启/关闭的权威报告 |
| D — 5000 / 10000 音性能 | 脚本已提交，**NOT RUN** | 需真实执行并存性能 JSON 和机器配置 |
| E — Shadow opt-in / 回滚 | 功能开关已实现，验证未完成 | 需禁用开关回归、真实 trace、失败注入 |
| A — 真实设备证据 | **BLOCKED** | 未提供经核验 SP-A500 实际 MIDI Trace |

## 5. 五组建议真机片段（Gate A）

每组保留原始 Note On/Off、session 时间戳、原始 Take、谱面指纹、演奏者人工标注的对应 `scoreEventId ↔ performedNoteId`；不得让算法输出充当标签：

1. 正常匀速跟练，作为干净基线。
2. 单个音晚约 300–400ms，随后恢复原始拍点。
3. 从一个音开始晚约 300ms，后续保持正确的相对间隔。
4. 从一个音开始晚约 500–600ms，后续保持正确的相对间隔（可因真实误差浮动）。
5. 混合漏音、错音、快速重复音和双手同音/和弦，重点记录歧义。

## 6. 仍需处理的风险

- Shadow 是附加观测，不是评分：当前候选只修改配对，不能让新版评分自动生效。
- 当前 Sidecar 是 Take 成功后一次性 best-effort 写入；Take 保存后进程立即退出、Sidecar 目录不可写、写入失败等可能导致**有 Take 无 Sidecar**。此时保持权威数据正确，不得把 Sidecar 缺失记为演奏异常。若产品要求零丢失 shadow，需要下一版的可恢复待写队列/后台重建机制。
- `alignment-shadow/<takeId>.json` 暂按 takeId 命名发现；没有单独的报告 UI 或聚合 API。保存/清理策略需要与 Trace 的保留策略协调。
- 5000/10000 音可能暴露当前评分/候选复杂度问题，性能结果决定资源上限，而非凭假设设定上线 SLA。
- 本阶段没有在真实硬件环境上执行命令；不能宣称 Gate A/C/D/E PASS。
