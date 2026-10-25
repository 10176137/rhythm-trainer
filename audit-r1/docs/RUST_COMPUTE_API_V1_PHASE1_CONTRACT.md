# Rust Compute API V1 — Phase 1 接口与职责定稿

**状态：** Phase 1 设计定稿（评审通过 Phase 0 后进入）
**基线：** `a938f36`（Phase 0 报告）；当前代码基线 `dc18da6`
**依据：** `audit-r1/docs/rhythm-trainer-ts-ui-rust-compute-migration-v1.md`、`audit-r1/docs/rhythm-trainer-take-domain-design-v1.md`、`R2_3_RUST_PLANNER_TASK_CARD.md`、`TS_RUST_PARITY_GATE_V1.md`
**约束：** 本阶段只定义接口、DTO、职责与验证框架；不实现 parser/runtime 迁移，不改变评分、冻结契约、生产默认值或现有 API 行为。

## 1. 职责边界

| 层 | 负责 | 禁止 |
|---|---|---|
| React/TS UI | 交互、组件状态、渲染、乐谱视图、API 调用、结果展示、纯 UI 映射 | 权威 MusicXML 解析、Plan 生成、匹配、评分、报告/Profile 计算、最终 Take 判定 |
| Node Server | HTTP/WS、设备/文件 I/O、N-API 调用、ID/时间戳 envelope、持久化、历史查询、日志、进程管理 | 复制 planner/matcher/scoring/analysis/Profile 算法；修改 Rust 结果；客户端声称作为权威 |
| Rust Core | MusicXML 语义解析、ScoreDocument、Plan、Runtime、MIDI 解释、Matcher、Scoring、Analysis、Take 结果、Learner 计算 | 依赖前端生成的目标时间线；把 UI 展示数据当业务事实 |
| 存储 | 保存规范化 Take、证据引用、配置快照、版本元数据 | 自行计算业务结果 |

**一条规则：** 凡改变“应该弹什么、实际弹了什么、弹得如何、得到什么结论”的计算，只允许在 Rust。

## 2. 顺序决策

新迁移计划与既有 R2/R3 路线的顺序冲突，按独立决策记录处理：

`audit-r1/docs/RUST_COMPUTE_MIGRATION_ORDER_DECISION.md`

摘要：

1. 保留 R2-3 冻结契约与 Parity Gate；不借新计划改写 Schema/指纹向量/golden/`EngineScoreEvent`/`scoring_v1`。
2. 先按既有七项证据完成 Rust Planner 的验收与切换就绪评审；这不等于批准切换生产默认值。
3. Phase 1（本文件）可立即进行接口/职责定稿，不改变生产行为。
4. 之后推进 Rust MusicXML parser；再收敛 Follow、分析/处方、Profile；最后清理前端生产计算。
5. 生产默认切换仍需单独评审与授权；默认保持 `rts`。

## 3. API / DTO 目录（V1）

所有新 DTO 使用显式版本后缀 `V1`；字段新增只能做向后兼容的加法。现有 `ScoreDocumentV1`、`EngineScoreEvent`、`PlanRequestConfig`、`PlannerOutput`、`TakeRecordV1` 沿用，不重复发明同义 DTO。

### 3.1 `ParseScoreV1`

```ts
interface ParseScoreRequestV1 {
  schemaVersion: 1;
  xmlText: string;
  fileName: string;
  importOptions?: { maxBytes?: number };
}

interface ParseScoreResultV1 {
  schemaVersion: 1;
  scoreDocument: ScoreDocumentV1;      // 现有冻结 schema
  importReport: ImportReport;          // 现有报告形状
  scoreRevisionId: string;             // 由 Rust parser 生成
  displayProjection: {
    events: Array<{
      eventId: string;
      partId: string;
      measureOrdinal: number;
      staffNumber: number;
      voiceId: string | null;
      xmlId: string | null;
    }>;
    measures: Array<{ ordinal: number; printedNumber: string | null; implicit: boolean }>;
  };
}
```

- `displayProjection` 只服务 UI 映射；不得反推 plan/score。
- 错误：`PARSE_*` 命名空间；`REJECTED` 报告不是成功结果。
- 当前 TS parser 能力矩阵见 Phase 0 报告；Rust parser 必须对齐或显式 fail-closed。

### 3.2 `BuildPlanV1`

```ts
interface BuildPlanRequestV1 {
  schemaVersion: 1;
  scoreDocument: ScoreDocumentV1;
  importReport: ImportReport;
  config: PlanRequestConfig;           // 现有冻结配置
  mode: 'timeline' | 'follow';         // 显式，禁止推断
}

interface BuildPlanResultV1 {
  schemaVersion: 1;
  plannerAuthority: 'rust';
  plannerVersion: string;
  planFingerprint: string;             // plan-v1:sha256:...
  planRunId: string;                   // 计划运行 ID
  strictAllowed: boolean;
  planIssues: Array<{ code: string; blocksStrict?: boolean }>;
  scopeCodes: string[];
  missingEventIds: string[];
  atomIssueCodes: string[];
  plan: PlannerOutput;                 // 现有 frozen PlannerOutput
}
```

- 生产 Plan 只能来自 Rust；失败必须 coded rejection，不回退 TS。
- 指纹/Fingerprint 只由 Rust 生成；客户端不得自报权威。

### 3.3 `CreateRuntimeV1`

```ts
interface CreateRuntimeRequestV1 {
  schemaVersion: 1;
  takeId: string;                      // Node 分配的持久化业务 ID
  modeId: string;
  planRunId: string;
  planFingerprint: string;
  scoreFingerprint: string;
  practiceConfigSnapshot: object;      // 实际生效配置，不随后续 UI 变化
  startedAtIso: string;
}

interface CreateRuntimeResultV1 {
  schemaVersion: 1;
  runtimeId: string;                   // Rust 运行时 ID
  engineTakeId: string;                // Rust Take 标识
  practiceSessionId: string | null;    // 内部诊断，不作业务主键
  captureEpoch: number;
  state: string;
  stateVersion: number;
}
```

- `takeId` 由 Node/存储层分配；Rust 不生成持久化业务主键。
- `runtimeId`/`engineTakeId` 只在 Rust 运行时有效；不替代 `takeId`。

### 3.4 `CommandRuntimeV1`

```ts
interface CommandRuntimeRequestV1 {
  schemaVersion: 1;
  runtimeId: string;
  commandId: string;                   // 幂等键
  expectedStateVersion: number;
  command: 'pause' | 'resume' | 'stop' | 'abort' | 'fail';
  atSessionMs?: number;
  reason?: string;
}

interface CommandRuntimeResultV1 {
  schemaVersion: 1;
  state: string;
  stateVersion: number;
  duplicate: boolean;
  effects: string[];
  rejection?: { code: string; message: string };
}
```

- 所有状态转换由 Rust 决定；Node/TS 只能发送命令和展示结果。
- 重复 `commandId` 返回 receipt，不重复副作用。

### 3.5 `PushMidiEventV1`

```ts
interface PushMidiEventRequestV1 {
  schemaVersion: 1;
  runtimeId: string;
  eventId: string;
  sourceId: string;
  sourceSequence: number;
  capturedAtMonotonicMs: number;       // 设备/Node 采集单调时间
  handlerAtMs: number;                 // 接收边界时间
  clockDomainId: string;
  captureEpoch: number;
  rawBytes: number[];
}

interface PushMidiEventResultV1 {
  schemaVersion: 1;
  accepted: boolean;
  kind: string;                        // accepted / quarantined_*
  takeId: string | null;
  sessionTimeMs?: number;              // Rust 计算后返回，仅作证据/展示
  judgment?: object;                   // 实时反馈（由 Rust 产生）
  state?: { state: string; stateVersion: number };
}
```

**目标：** 原始 MIDI 时间戳进入 Rust，由 Rust 处理时钟映射、排序、暂停、准入、是否计分。**当前差距：** Node 的 clock-map/admission 已先把 `sessionTimeMs` 送给 Rust；Phase 4 前不得把本 DTO 当作已实现。Phase 1 只锁定字段和职责，不改变现有 wire。

### 3.6 `FinishTakeV1`

```ts
interface FinishTakeRequestV1 {
  schemaVersion: 1;
  runtimeId: string;
  endReason?: 'completed' | 'interrupted' | 'failed';
}

interface FinishTakeResultV1 {
  schemaVersion: 1;
  engineTakeId: string;
  endReason: 'completed' | 'interrupted' | 'failed';
  trustworthy: boolean;
  scoreStatus: string;
  timelineReport?: object;             // 仅 Timeline
  followReport?: object;               // 仅 Follow，不伪装 Timeline
  freeReport?: object;                 // 如产品决定 Free Play 产生 Take
  analysis?: object;
  durations?: object;
  evidenceSummary: object;
  algorithmVersions: { scoring: string; analysis?: string; plan?: string };
}
```

- Rust 生成权威结果；Node 只组装 `TakeRecordV1` envelope、分配 ID、原子写入。
- 一次完成恰好一条 Take；重复完成幂等；失败不得伪装完成。
- Follow/Free 没有测量项时明确 unavailable，不补造 Timeline 分数。

### 3.7 `AnalyzeProfileV1`

```ts
interface AnalyzeProfileRequestV1 {
  schemaVersion: 1;
  takes: Array<{
    takeId: string;
    endReason: string;
    trustworthy: boolean;
    scoreStatus: string;
    evidence: object;                  // Take 的规范化摘要/引用
  }>;
  profileAlgorithmVersion: string;
}

interface AnalyzeProfileResultV1 {
  schemaVersion: 1;
  profile: object;                     // 可物化缓存，不是权威
  algorithmVersion: string;
  processedThrough: string;            // watermark/takeId
  unmeasured: string[];                // 未实现/证据不足的维度
}
```

- Profile 必须可从 Takes 重建；`modeId` 不能直接冒充细粒度技能。
- 未实现能力标 unknown/unmeasured，不硬编码掌握结论。

### 3.8 History CRUD

历史列表、详情、分页、筛选、文件读取、旧 JSON 兼容由 Node 负责；Node 不得重算分数/Profile。Take 是历史入口，legacy session 只读适配。

## 4. 字段所有权矩阵

| 字段 | 生产者 | 消费者 | 权威层 | 备注 |
|---|---|---|---|---|
| `xmlText` / `fileName` | UI 上传 | Rust parser | 输入 | Node 只做大小/格式边界 |
| `ScoreDocumentV1` / `scoreRevisionId` | Rust parser | Rust plan/runtime；Node 存储 | Rust | TS 不再生产 |
| `ImportReport` 能力/错误 | Rust parser | Rust plan、UI 展示 | Rust | UI 只展示 |
| `planFingerprint` / `plannerVersion` / `planRunId` | Rust planner | Node 记录、UI 展示、历史 | Rust | 客户端自报只做一致性校验 |
| `plannerAuthority` | 服务端启动解析 | UI/历史 | Node（服务端配置） | 不信任客户端 |
| `takeId` | Node/存储层 | API/历史 | Node | 全局唯一；不是 engine ID |
| `runtimeId` / `engineTakeId` / `captureEpoch` | Rust runtime | Node envelope/诊断 | Rust | 诊断用，不替代 `takeId` |
| `practiceConfigSnapshot` | UI 实际配置 → Node envelope | 历史/诊断 | 记录事实 | Rust plan 使用同一配置 |
| `practiceSessionId` / `takeIndex` | Rust runtime | 诊断 | Rust 内部 | 非业务主键 |
| `report` / `scoreV1` / `analysis` / `durations` | Rust | Node 存储、UI 展示 | Rust | Node 不改数值 |
| `traceRef` / `journalRef` | Node/存储 | UI/回放 | 证据引用 | 不重算 |
| `Profile` | Rust | Node 缓存/UI | Rust 派生 | 可从 Takes 重建 |

禁止同一字段在 TS/Node/Rust 三端各自解释；已知需要保留的兼容映射（如旧 `sessions/*.json`）必须写明只读、不可用于新计算。

## 5. 错误、状态、时间与指纹规则

### 5.1 错误码

- 现有冻结码保持不变：`SCHEMA_VIOLATION`、`INVALID_RANGE`、`DOCUMENT_REPORT_MISMATCH`、`INVALID_REQUEST`、`INVALID_PLANNER_VERSION`、`TIMELINE_SEMANTICS_REJECTED`、`FOLLOW_CROSSREF_REJECTED` 等。
- 新命名空间：`PARSE_*`、`RUNTIME_*`、`TAKE_*`、`PROFILE_*`；同一码不得在不同语义复用。
- 所有失败必须可诊断、可编码；禁止空计划/默认计划伪装成功；禁止在同一练习内回退到另一套计算权威。

### 5.2 状态与幂等

- Runtime 状态机由 Rust 持有；`commandId` + `expectedStateVersion` 保证幂等/顺序。
- 重复 finish 返回已有结果或明确冲突，不生成第二条 Take。
- Node 只能传递/记录状态，不能自行推进权威状态。

### 5.3 时间

- 设备/Node 只提供原始单调时间与来源；Rust 负责 session time、排序、暂停区间、是否计分。
- UI 动画/滚动时钟不得成为评分时钟。
- `EngineScoreEvent` 沿用现有 ms 协议；Rust 计划内部 µs→ms 仍遵守现有单一除法规则。

### 5.4 指纹/版本

- source fingerprint（sha256）、`scoreRevisionId`、`planFingerprint`、`scoring_v1` 算法版本、Profile 算法版本都由权威层生成。
- 客户端不得生成/改写权威指纹；历史 Take 记录引用，不重算。
- Frozen Schema/Gate/golden 不因新迁移变更；确需变更另案提案。

## 6. 版本与兼容策略

- 新 DTO 以 `V1` 后缀显式版本化；新增字段必须向后兼容；删除/改义需 V2 + 迁移。
- N-API DTO 显式版本；Node 只做传输映射，不做字段语义推断。
- 旧 `sessions/*.json` 继续只读；`TakeRecordV1` 可演进但保留 legacy 适配。
- 每个阶段独立提交/验证；临时适配器必须有删除条件；不删旧历史兼容直到替代路径验证。

## 7. 跨语言黄金测试框架

现有 `audit-r1/contracts/test-vectors/` 与 parity harness 继续作为 Plan/fingerprint 基线。新 API 的黄金向量拟放：

```text
audit-r1/contracts/rust-compute-v1/
  parse-score/*.json
  build-plan/*.json
  runtime/*.json
  finish-take/*.json
  analyze-profile/*.json
```

每个向量：

```json
{
  "schemaVersion": 1,
  "caseId": "parse-g1-base",
  "dtoVersion": "ParseScoreV1",
  "input": {},
  "expected": {},
  "expectedSha256": "<canonical bytes sha256>",
  "owner": "rust",
  "notes": "producer/consumer and frozen references"
}
```

执行矩阵：

| 层 | 读取同一向量 | 断言 |
|---|---|---|
| Rust unit/integration | 是 | 输出字节/语义/错误码 |
| N-API | 是 | DTO 映射/生命周期/错误传播 |
| Node protocol | 是 | 传输 envelope/无重算 |
| TS/Vitest | 是 | 仅消费/展示契约；不接受 TS 计算作为 oracle |
| selftest | 关键路径 | 启动/停止/Take/API |

规则：向量 additive；旧向量不改；fail-closed 错误也必须有向量；本地跳过必须标注，不能写成通过；每个生产 API 在进入生产前至少有一个固定向量。

## 8. Phase 1 验收清单

- [x] 每类 DTO 字段有唯一生产者/消费者（本文件矩阵）。
- [x] 现有 `ScoreDocumentV1`/`EngineScoreEvent`/Plan/fingerprint 不改。
- [x] 错误码命名空间与 fail-closed 规则明确。
- [x] 时间、指纹、ID、状态版本规则明确。
- [x] 跨语言黄金框架格式与执行矩阵明确。
- [x] 迁移顺序决策单独落档，不绕过 R2-3 七项证据。
- [x] 本阶段无生产代码/默认值/评分语义变更。
- [ ] Phase 2 起为每个 API 建实际向量并实现 Rust parser（待 Phase 1 评审关闭后）。

## 9. 明确不在 Phase 1 范围

- 不实现 Rust MusicXML parser。
- 不切换生产 Planner 默认值。
- 不迁移 Follow/Free Play runtime。
- 不改 TakeRecord 字段的既有语义。
- 不改评分算法、matcher、build_schedule、golden、Schema、wire protocol。
