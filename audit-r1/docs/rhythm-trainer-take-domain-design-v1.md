# Rhythm Trainer：以 Take 为核心的领域模型与结算架构设计书

**版本：** V1.0  
**状态：** 设计基线，待按阶段实施  
**目标分支：** `r2-3-rust-planner`  
**现有实现参考基线：** R2-3i planner provenance 实现 `87f4a8ac9821326a78e0bf44979b1db7190da77e`  
**核心决策：** 每次实际演奏最终只形成一条权威 Take 记录；不新增包含 `takes` 数组的持久化 `PracticeSession` 聚合文件。运行时可以保留内部协调对象，但不得与 Take 形成重复的业务身份与持久化生命周期。

---

## 0. 设计结论

本设计不是要求整个项目只能有一个 Rust `struct`，也不是要删除所有名字里带 `Session` 的代码。它要解决的是：**业务层只维护一个代表单次演奏结果的权威记录——Take；其他结构必须能说明自己是曲谱资料、派生画像、运行时机制，还是结果附件。**

核心规则如下：

1. **一轮演奏最终对应一条 Take。** Timeline、Follow 等演奏模式可以使用不同运行逻辑与评分方式，但结束结果进入同一条 Take finalization（结算）流程。
2. **Take 以独立记录存储。** 不创建 `practice-sessions/<id>.json`，不在父对象中维护一个不断增长的 `takes` 数组。
3. **运行时状态是临时状态。** 活跃演奏所需的计时、暂停、MIDI 输入、计划、状态机、命令幂等等继续由引擎内部管理，不要求成为持久化业务实体。
4. **Learner Profile 是跨 Take 的派生画像。** 原始依据是历史 Take；`profile.json` 可以作为可重建的缓存/快照，但不是比 Take 更权威的数据源。
5. **Score 与历史演奏事实分离。** Take 需要记录演奏时的曲谱身份和内容指纹；如果曲谱可能被覆盖，还必须保留可还原的内容快照或不可变版本引用。
6. **不以重命名代替重构。** 先统一结算与历史读取，再迁移 API；不先全仓机械改名，不为追求“没有 Session 这个词”而冒险删除运行时协调器。
7. **保留冻结边界。** 不改变 planner/parity 冻结资产、`EngineScoreEvent` wire protocol、生产 `build_schedule`、matcher 或 `scoring_v1` 评分语义；不切换生产 Rust planner 默认值，不合并 `main`。

## 1. 背景与当前问题

当前代码里有多个名称相似、但不处于同一层次的对象：

- 服务端 `sessions/<sessionId>.json`：通常是一条已经结束的演奏结果。
- API `/api/sessions`：前端历史功能读取的也是单条演奏结果，不是一个包含多个演奏的父级聚合。
- Rust `PracticeSession`：由 `NativeTakeCoordinator` 等结构使用的运行时协调上下文。
- Rust `PerformanceTake`：负责单轮演奏的内部生命周期状态、采集边界和结算前状态。
- 客户端 Follow 状态：当前存在单独路径，结果没有完整进入服务端历史持久化闭环。
- `TakeJournal`、Trace、暂停区间、实时报告：是过程证据和分析资料，不应自动变成新的业务聚合实体。
- `StudentModel` / `profile.json`：聚合长期学习信息，与单次演奏的生命周期不同。

主要问题不是名字不统一，而是业务边界尚未统一：当前持久化记录叫 `session`，内部另有 `takeId`，而内部 `takeId` 可能只在各自协调器内递增；Follow 的结果路径又不同。因此，名字相近的标识并不必然代表同一业务身份。

另一个问题是 Profile 当前按 `record.modeId` 作为 `skillId` 更新，属于按模式汇总的粗粒度证据，并不等价于对节奏、音高、左右手、具体小节等钢琴技能做精细诊断；`transferTest` 和 `delayedRetest` 等字段若由固定值填充，也不能被视为已经实现的教学能力。

本次设计聚焦在领域模型、结束结算、持久化和画像输入的正确性。不重写评分算法，不推倒现有 Rust engine，不以抽象层数量衡量架构质量。

## 2. 目标与非目标

### 2.1 目标

- 建立唯一的单次演奏权威记录：Take。
- 让 Take 在运行时对象销毁后仍能独立支持历史展示、单次诊断和回放。
- 让 Timeline 与 Follow 使用一致的结算/持久化入口，同时保留各自真实的评分语义。
- 正确保留暂停、继续、输入准入、计时和规划器来源等影响结果的证据。
- 使 Learner Profile 基于可信的历史 Take 汇总，并可从 Take 重建。
- 兼容当前 `sessions/*.json` 和 `/api/sessions`，避免一开始就要求全量历史迁移。
- 确保一次运行最多产生一条最终 Take，并使重复结束、断连竞态不会制造重复历史记录。

### 2.2 非目标

- 不创建一个持久化 `PracticeSession` 文件来聚合多个 Take。
- 不在本次把所有运行时结构合并为一个 Rust 结构体。
- 不修改 frozen parity gate、golden/expected fixtures、case index、Schema 或 `EngineScoreEvent` wire protocol。
- 不修改生产 `build_schedule`、matcher 或 `scoring_v1` 的计分行为。
- 不改变 planner 生产默认选择，不宣布已完成的本地浏览器验证等同于 CI/E2E。
- 默认不实现进程崩溃后恢复尚未结束的弹奏；如果未来确实需要，需要单独设计 checkpoint 与恢复协议。
- 不在没有产品需求的前提下新增延迟复测、技能掌握度迁移、跨曲目能力迁移等“看起来完整”的教学对象。

## 3. 模型边界

### 3.1 领域模型分类表

| 概念 | 本设计中的定位 | 是否是一次演奏的权威持久化记录 | 规则 |
|---|---|---:|---|
| `Take` | 单次演奏的最终业务记录 | 是 | 一个演奏尝试最终最多产生一条 |
| `Score` | 曲谱资料/内容身份 | 否 | 可供多个 Take 复用 |
| Score revision / content snapshot | 确定某次演奏使用的曲谱内容 | 否，通常是版本标识或被引用的不可变资料 | 不强制新增独立实体；必须保证历史内容可追溯 |
| `Learner Profile` | 跨 Take 派生出的长期画像 | 否 | 可缓存、可重建；不得成为单次演奏事实的唯一来源 |
| `TakeTemplate` | 可复用的练习预设 | 否 | 仅在现有模板产品功能需要时保留；不代表演奏已发生 |
| `PracticeSession` | 可选的 Rust 内部运行时协调器 | 否 | 不作为持久化业务父对象，不维护持久化 `takes[]` |
| `PerformanceTake` / `ActiveTakeRuntime` | 单轮演奏运行时状态机 | 否 | 管理演奏过程；结束后生成 Take 记录 |
| Trace / Journal / capture diagnostics | 演奏过程证据 | 否 | 可内嵌小型摘要，也可作为独立附件存储并由 Take 引用 |
| `PlannerOutput` / plan snapshot | 计划与可复现证据 | 否 | 是 Take 的上下文/附件，不是另一种演奏结果 |
| `SessionReport` / `DiagnosisReport` | 单次结果报告或诊断产物 | 否 | 由 Take 的事实生成或与 Take 一同保存，不取代 Take |

### 3.2 为什么不新增 PracticeSession 聚合文件

不采用如下持久化结构：

```text
practice-sessions/<practiceSessionId>.json
  ├── session metadata
  ├── takes[0]
  ├── takes[1]
  └── takes[n]
```

这样做意味着每次完成一个 Take，都需要更新同一个父文件。随着练习次数增加，父文件持续增大；写入过程还需要处理父文件更新的原子性、并发修改、重复结束，以及父子结构变更时的历史兼容。若父文件只用于把多个 Take 放在一起，而系统并不需要对整组 Take 实施事务或整体生命周期管理，那么这种复杂度没有明确收益。

目标存储形态为：

```text
takes/<takeId>.json                # 一次演奏的权威记录
traces/<traceId>.*                  # 可选：大体量输入轨迹
journals/<journalId>.*              # 可选：过程日志/命令边界
profile.json                        # 可重建的画像缓存/快照
sessions/<legacySessionId>.json     # 历史兼容数据，按渐进策略读取
```

Trace / Journal 是否拆分文件由体量和现有实现决定，不要为了“模型统一”强迫把大体量原始事件放进同一个 JSON。Take 只需包含足够的摘要和稳定引用，保证其来源明确、可找到。

### 3.3 Score 与版本的最小策略

不要求一开始建立独立的 `ScoreRevision` 业务对象，但历史 Take 必须可解释“当时弹的是哪一份曲谱内容”。仅保存可变的 `scoreId` 不足以保证这一点，因为同一个曲谱条目可能被替换。

每条 Take 至少保存：

- `scoreId`：曲谱库标识，若可确定；
- `scoreFingerprint`：演奏时内容的指纹；
- `scoreSnapshotRef` 或等价不可变版本引用：当系统可能覆盖原内容时，用于恢复历史曲谱内容。若现有曲谱仓库已经保证通过 fingerprint 能访问不可变内容，则可以复用现有机制。

这里的 revision 可以是字段、指纹或现有版本引用，并不要求为了概念整洁而额外创建一张表/一个文件。

## 4. Take 的业务定义

### 4.1 定义

**Take 是一次演奏尝试完成结算后生成的权威记录。** 它回答：用户在什么曲谱内容、什么练习模式和实际配置下，在什么时间进行了一次演奏；引擎接收了哪些有效事实；最终形成了什么评分、诊断和可信度结论。

Take 不是“所有运行时对象的容器”。它不要求把实时 MIDI 队列、时钟对象、Rust 状态机或全部中间命令复制进最终 JSON。它保存或引用解释最终结果所需的事实与证据。

### 4.2 标识规则

- 新 Take 的 `takeId` 必须在整个应用存储范围内全局唯一，推荐 UUID、ULID 或等价可靠唯一 ID。
- `takeId` 代表最终业务记录，不能直接复用当前可能在每个 `PracticeSession` 中从 `take-1` 递增的内部标识。
- 引擎内部可继续使用 `runtimeId`、`engineTakeId`、`captureEpoch` 等 ID；它们不替代 `takeId`。
- 新 Take 的 ID 可以在运行时创建时预分配，但正式 Take 文件只在结算成功提交时创建。预分配 ID 不等于已经持久化一条完成记录。
- 旧记录可以通过原 `sessionId` 做稳定映射，例如 `legacy-<sessionId>`；不要用可能重复的旧内部 `takeId` 作为迁移后主键。

### 4.3 结束状态与成绩状态必须分离

不要把“生命周期结束了”和“成绩可信”合并成同一个状态。

建议业务层表达以下结束原因：

- `completed`：正常完成或用户主动结束，已有数据按实际证据评估。
- `interrupted`：浏览器、连接或输入设备中断，保存可用的部分证据，并明确标记为不完整。
- `failed`：运行时或结算发生故障；若已具备可恢复的完整结果则保存，否则记录诊断失败并保证不伪造可信成绩。

同时独立记录评分状态，例如现有 `scoreStatus` / `trustworthy` 的语义。异常终止的 Take 可以有部分有效诊断，但不能被伪装为一次可信的完整成绩。具体枚举应复用项目已有定义，只有当现有定义无法表达这些语义时才添加新值。

## 5. 推荐的 TakeRecord 逻辑结构

下面是目标字段分组，不是要求把所有内容一次性照抄进代码。实施时优先复用现有 DTO、报告类型和 wire 类型；字段命名最终以仓库已有命名风格为准。

```ts
interface TakeRecordV1 {
  schemaVersion: 1;
  takeId: string;                    // 全局唯一业务 ID

  score: {
    scoreId: string | null;
    scoreFingerprint: string | null;
    scoreSnapshotRef: string | null;  // 或现有不可变版本引用
  };

  lifecycle: {
    startedAtIso: string;
    finishedAtIso: string;
    endReason: 'completed' | 'interrupted' | 'failed';
    modeId: string;
  };

  context: {
    practiceConfigSnapshot: object;   // 本次真正生效的配置快照
    plannerAuthority: 'rts' | 'rust' | null;
    plannerVersion: string | null;
    planFingerprint: string | null;
    planSnapshotRef: string | null;   // 如需要还原计划
  };

  evidence: {
    traceRef: string | null;
    journalRef: string | null;
    pauseIntervals: Array<{
      startMs: number;
      endMs: number | null;
    }>;
    captureDiagnostics: object | null;
  };

  assessment: {
    trustworthy: boolean;
    scoreStatus: string;
    timelineReport?: object;
    followReport?: object;
    timingAnalysis?: object;
    durationAnalysis?: object;
  };

  legacy?: {
    source: 'sessions-json';
    sessionId: string;
    engineTakeId?: string | null;
    practiceSessionId?: string | null;
  };
}
```

说明：

1. `object` 是逻辑占位符，不是建议使用无类型的对象；落地时应采用项目中已存在的具体类型。
2. `timelineReport` 与 `followReport` 是示例分支。也可以沿用现有带 `modeId` 的判别联合类型，但必须明确区分模式专属报告，不得伪造一种通用报告。
3. `legacy` 只服务历史适配，不应成为新 Take 的必要字段。
4. `practiceSessionId`、`takeIndex` 不属于新 Take 必需字段。如果运行时诊断确实需要它们，可以放在 `engineDiagnostics` 一类的非权威调试元数据中，而不能成为查询 Take 的必要前置条件。
5. 大体量的 trace 和 journal 可以独立存储。Take 必须保存稳定引用、版本/格式信息与足以查询的摘要。
6. 如果现有记录的 `scoreFingerprint`、planner provenance 或诊断字段有更准确的类型，应复用原类型，避免重复发明同义 DTO。

## 6. 运行时模型与 Rust 结构的处置规则

本次目标是收敛业务含义，不是清空 Rust 内部模型。各结构按职责处理：

| Rust/引擎结构 | 处理建议 | 边界 |
|---|---|---|
| `PracticeSession` / `NativeTakeCoordinator` | 可保留为内部协调器 | 负责运行中的资源/多个状态对象协调；不产生持久化父文件、不作为 Take 查询前提 |
| `PerformanceTake` / `TakeState` | 保留为运行时状态机；若命名长期造成混淆，可改名为 `ActiveTakeRuntime`，但不是首要任务 | 管理 Created/Preparing/Recording/Paused/Finalizing 等运行状态；最终转换为 TakeRecord |
| `CaptureRouter` / `CaptureEpoch` | 保留 | 保障输入事件归属，隔离过期或不匹配的 MIDI 输入 |
| `CommandEnvelope` / `TransitionReceipt` / `TakeEffect` | 保留必要部分 | 内部命令、幂等性和状态转换机制，不作为业务实体持久化 |
| `PlaybackCursor` | 保留为运行时数据 | 表示当前位置/播放游标，不是最终 Take |
| `SessionEngine` / matcher / `scoring_v1` | 保留 | 计分与测量引擎，不应因名字含 Session 而被删除或混作业务模型 |
| `SessionReport` / `DiagnosisReport` / `TimingFeatures` | 保留有实际消费者的结果类型 | 是报告/分析产物；由 Take 引用、嵌入或重建，不替代 Take |
| `StudentModel` / `SkillProgress` | 保留并重新明确输入来源 | 长期画像只吸收已结算、符合策略的 Take 证据；其粒度应诚实反映实际实现能力 |

### 6.1 运行时生命周期与业务生命周期

内部 `PerformanceTake` 可以经历 `Created → Preparing → Ready → Countdown → Recording → Paused → Finalizing → Completed` 等状态。最终业务 Take 不必继承整个运行时状态机；它只表达已经结算的生命周期结果及证据。

建议概念转换为：

```text
ActiveTakeRuntime
  ├── current mode / config / plan context
  ├── capture router / epoch / event admission
  ├── pause-resume state and journal
  └── scoring and analysis working state
                 │
                 ▼ finalize once
           TakeRecord
                 │
        ┌────────┴────────┐
        ▼                 ▼
   History/Replay    Learner Profile
```

### 6.2 暂停和继续

暂停与继续不是新业务实体，但其时间边界对计时和分析是事实，必须保存到最终 Take 的证据中。

运行时至少需要维护：

- 当前是否暂停和当前暂停开始时间；
- 已完成的暂停区间；
- 当前时钟锚点与播放位置；
- 暂停期间事件的准入/排除决定；
- pause/resume journal 边界。

最终结算需要覆盖多次暂停、暂停中结束、暂停前按下/暂停后松开、迟到 MIDI、断连与 finish 并发等情况。被准入策略排除的事件，不得在最终重算时重新进入评分。

默认不支持崩溃恢复活动演奏。运行时只保存在内存的状态因进程崩溃而丢失，是本版本的明确限制；已提交的 Take 与关联证据必须保持可读。

## 7. 统一结算：Timeline 与 Follow

### 7.1 设计目标

Timeline 和 Follow 的执行、反馈与评分算法不必相同，但它们必须共享结果出口：

```text
启动某种模式
    ↓
创建 ActiveTakeRuntime / 模式运行上下文
    ↓
采集输入与模式特定反馈
    ↓
结束边界（finish / interruption）
    ↓
停止输入、固定证据边界
    ↓
运行当前模式的结算与诊断
    ↓
构造 TakeRecord
    ↓
幂等、原子地提交 Take
    ↓
刷新可重建的 Learner Profile 派生数据
    ↓
返回最终 Take 摘要并刷新历史 UI
```

### 7.2 Take Finalizer 的职责

建议提取清晰的 `finalizeTake`（或等价命名）应用服务。它应负责流程编排，而不是重新发明计分逻辑。

1. 识别并关闭该轮运行的输入边界。
2. 完成当前模式已有的评分/分析流程。
3. 对结果设置明确的 `endReason`、可信度和失败信息。
4. 从服务端/可信运行时上下文构造 score/config/planner provenance。
5. 组装一条 TakeRecord，并验证必需字段与关联附件。
6. 以幂等方式持久化这一条记录。
7. 更新或标记 Learner Profile 缓存失效。
8. 返回最终 Take ID 和结果摘要。

Finalizer 不负责：更改 `scoring_v1` 语义、重新规划 Timeline、把 Follow 伪装成 Timeline，或依赖某个持久化 PracticeSession 聚合文件来决定结果是否完整。

### 7.3 Timeline

Timeline 继续使用当前服务端结算/评分链路。现有 matcher、`scoring_v1`、报告类型、事件 wire protocol 不在本次重构范围内。Timeline 完成后，把其真实报告和 evidence 输入统一 Finalizer。

### 7.4 Follow

Follow 当前有客户端 `FollowSession` 路径，且没有经过 `session.begin` 的既有服务端流程，因此可能只显示结果而不落入历史。需要为 Follow 增加一个明确的结束提交路径，把本模式真实采集到的事实、进度和 `FollowReport`（按现有产品能力）交给统一 Finalizer。

Follow 的结果不应为了外层统一而伪造 Timeline matcher 报告。若 Follow 的证据不足以计算某个字段，明确标记为 unavailable / not assessed，而不是生成假值。

### 7.5 幂等与原子写入

一轮演奏只允许有一个 finalization 结果。至少应处理：重复点击 finish、客户端重发请求、设备断开与 finish 同时发生、旧 async 回调迟到、结算失败后重试。

推荐最小机制：

- 每轮运行创建时固定 `takeId` 和 `runtimeId`；
- 同一 `runtimeId` 的 Finalizer 调用共享一个正在执行/已完成的结果；
- finalization 状态单向推进，不允许 Completed 再次进入新的结算；
- Take 写入采用临时文件 + 原子替换/提交策略，并在重试时检查该 `takeId` 是否已经存在；
- 如果记录已存在，应返回已有结果或报告冲突，不得静默覆盖成第二个不同结果；
- 如果将来允许多进程并发写同一存储，再引入跨进程锁/数据库事务；当前不要为了一个单进程本地 JSON 存储预先建造庞大的锁系统。

原子性目标是确保单条 Take 不出现半写入。由于不写共享的父级 PracticeSession 数组，不需要每次结束时重写所有历史 Take 的聚合 JSON。

## 8. Planner provenance 与配置可信度

Take 的 plan metadata 必须描述实际生效的规划来源，而不是客户端声称使用了什么规划器。

已存在的 R2-3i 把 `plannerAuthority`、`plannerVersion` 和 `planFingerprint` 接入记录，这是必要的字段层基础；但**字段形状合法不等于这些值已经与服务端签发的实际计划绑定**。

目标规则：

1. 服务端在生成计划响应时保留可识别的计划上下文（可以是内存运行时上下文、不可伪造的短期 token，或现有计划存储机制；本次不要求创建 PracticeSession 聚合文件）。
2. 演奏启动时，将本轮 `takeId` / launch token 与已签发的计划上下文绑定。
3. Finalizer 从服务端保存的运行时上下文取 provenance，并校验 fingerprint 与实际计划一致；不把客户端随意提交的 `plannerAuthority` 当作事实来源。
4. RTS 路径继续明确记录 `rts` 与实际版本信息；未使用 planner 的路径按现有约定记录 null/明确的无计划状态，不填造 Rust 来源。
5. 历史旧记录缺字段时仍可读取；未知 provenance 应标为 unknown，而不是推断为当前默认 planner。

本设计不要求立即引入加密签名系统。对于当前服务端运行时，可优先通过服务端持有的 plan context 与固定 launch token 建立关联；若未来跨进程、离线或跨服务验证需要更强不可伪造性，再评估签名方案。

同理，Take 应保存本次**实际生效**的练习配置快照，不应在历史展示时拿用户当前配置反推过去。

## 9. 持久化布局与 API 迁移

### 9.1 新写入

新完成的演奏写入 `takes/<takeId>.json`，每个文件只承载一条 Take。Trace/Journal 若单独存储，文件引用必须稳定并经过路径/版本校验。

`profile.json` 可以继续保存画像快照，但其作用是派生缓存。历史 Take 是画像的事实依据。不要保留一个永远只从 `sessions/*.json` 计数、却忽略新 Take 的双轨 profile 逻辑。

### 9.2 读取和兼容

- 新增或调整 `/api/takes` 与 `/api/takes/:takeId`，让业务语义清晰地指向一次演奏。
- 旧的 `sessions/*.json` 暂时作为 legacy record 读取来源，使用原 `sessionId` 稳定映射到 legacy Take ID。
- 过渡期 `/api/takes` 可以聚合读取新 Take 和旧记录的只读适配结果；需要有确定的排序、去重和错误策略。
- `/api/sessions` 暂时保留为兼容路由。可把新 Take 映射成旧 API 形状，或按项目现有消费者的要求进行兼容，避免新旧历史同时显示成两条。
- 不要求第一阶段把所有旧 JSON 迁移到新目录。只有当兼容适配稳定、备份与回滚方式明确后，才评估一次性迁移；即使不迁移，旧记录也必须可查。
- Profile 的历史数量与统计不能继续把 `sessions/*.json` 当成永久唯一数据源。

### 9.3 ID 兼容

旧服务端 `sessionId` 是当前每条持久化记录的唯一 ID。迁移时可建立确定且稳定的历史 Take ID 映射；旧内部 `takeId`、`practiceSessionId` 和 `takeIndex` 仅保留为 legacy/diagnostic metadata。

必须避免：

- 把 `take-1` 等内部 ID 直接当全局主键；
- 同一旧记录在新旧 API 合并时出现双份；
- 历史 URL、回放功能或报告读取依赖一个将被立即删除的字段；
- 把 `takeId` 的迁移误做成修改计分证据或演奏历史。

## 10. Learner Profile：画像保留，但成为派生模型

### 10.1 职责

Take 回答“一次具体演奏怎么样”；Learner Profile 回答“跨多次演奏，用户长期表现出什么能力特征”。两者是不同分析尺度，不需要中间的 PracticeSession 聚合层。

画像可以从多个 Take 提炼：

- 节奏稳定性和速度控制；
- 音符/节拍命中情况（仅在对应模式确实测量时）；
- 左右手或声部相关表现（需有可靠的谱面/声部映射证据）；
- 具体小节、节奏型或曲目范围内的重复问题；
- 随时间的变化趋势和最近一次证据的时间；
- 证据数量、置信度、数据来源模式与适用范围。

上述是目标能力维度，不代表当前所有维度都已经实现。第一版应只输出当前确实有证据支撑的维度。

### 10.2 更新规则

- Take 提交成功后再更新画像；不要从未结束的运行时状态直接写入已掌握技能。
- 对 `interrupted`、`failed`、不可信成绩和证据不足的 Take，按明确策略排除、降权或只纳入过程统计，并记录原因。
- 画像更新应可重放/重建：从 Take 存储重新计算后，结果应符合当前算法版本。
- `profile.json` 可以作为派生快照；必要时增加 `profileAlgorithmVersion`、更新时间和已处理 Take watermark，以便知道快照是否过时。
- 不必每次画像查询都完整扫描所有大体量 trace。可先从 Take 的规范摘要重建；如果摘要不足以回答某个新问题，再读取关联证据或执行版本化的重算。

### 10.3 现有实现的现实限制

目前 `StudentModel` 按 `modeId` 作为 `skillId` 更新，表示的是模式级证据，而不是细粒度钢琴技能画像。`transferTest:false`、`delayedRetest:false` 若由固定值设置，只说明这些字段存在，不说明迁移测试/延迟复测已被实现。

因此迁移期间应：

1. 先确保所有新 Take 都进入同一权威历史源；
2. 画像统计以 Take 为输入；
3. 明确标注模式级画像与精细技能画像的差异；
4. 只有出现可靠的谱面定位、节奏/音符特征与跨次关联证据后，再扩展细粒度能力；
5. 不为填满 UI 字段而虚构掌握度或迁移结果。

## 11. 前端与产品层影响

- 历史页面的主列表项是 Take；名称可显示曲目、日期、模式、结果可信度与必要摘要。
- 点击一条记录时，通过 `takeId` 获取详情；无需先查询某个 PracticeSession。
- 回放、诊断、比较历史成绩均从 Take 及其证据引用进入。
- 练习进行中的页面只读当前 runtime 状态，不需要把尚未结束的演奏展示成一条已经完成的历史 Take。
- Follow 和 Timeline 在过程 UI 上可以不同，但结束后历史/详情遵循统一的 Take 结构。
- Learner Profile 独立于某一次活动 Take；即使没有活动演奏，也能从历史 Take 加载/重建。
- `TakeTemplate` 若继续存在，UI 应把它表达为“可复用练习设置”，而不是“已完成演奏记录”。

## 12. 分阶段实施计划

实施顺序以低风险和尽早验证为原则。不要同时进行大规模改名、存储迁移和计分算法改造。

### 阶段 A：冻结边界并确定最终记录契约

1. 盘点当前 `finishSession()`、Timeline 结束路径和 Follow 结束路径。
2. 确定 `TakeRecordV1` 的字段来源、必填条件、legacy mapping 与评分可信度语义。
3. 明确哪些数据直接放 Take、哪些是证据引用；不得先把所有东西复制成一份巨型 JSON。
4. 写测试固定“一轮运行对应一个 takeId、最多一次正式提交”的契约。

**完成标准：** 设计字段都能指向真实数据来源；没有把客户端声称的 provenance 当作服务器事实；不更改冻结评分契约。

### 阶段 B：建立统一 Finalizer 与独立写入

1. 抽取统一结算入口，但继续调用现有 mode-specific scorer/report builder。
2. 为每轮运行建立稳定的业务 `takeId`，与引擎内部 ID 分开。
3. 实现同一运行的结束幂等与单条记录原子写入。
4. 写入失败时明确返回错误，不提前显示“已保存”；重试不能产生第二条 Take。
5. 保存必要的暂停、trace/journal 引用、配置快照和 planner provenance。

**完成标准：** 正常结束、暂停中结束、断连、重复 finish 和结算失败均有明确结果；单条 Take 可独立回读。

### 阶段 C：让 Timeline 与 Follow 共用结算出口

1. Timeline 接入统一 Finalizer，保持既有评分语义。
2. Follow 提供可信的结束 payload/证据并接入同一 Finalizer。
3. 为 Follow 的未测量字段明确标注 unavailable，而非补造 Timeline 评分。
4. 覆盖重复请求、过期请求和客户端状态已销毁等测试。

**完成标准：** 两种模式结束后都能获得同一 Take 业务入口，结果详情仍保留模式差异。

### 阶段 D：历史 API 兼容与迁移

1. 实现 `/api/takes` 与详情接口。
2. 读取新 `takes/*.json` 和旧 `sessions/*.json`，使用稳定映射与去重。
3. 保留 `/api/sessions` 兼容旧消费者。
4. 将历史页逐步切换到 Take 语义；保持回放链接和旧报告可读。
5. 画像计数和统计改为从 Take repository 获取，不直接依赖旧目录。

**完成标准：** 新旧历史无重复、无丢失；旧 API 行为在过渡期保持可用；新的 Take 不需要 PracticeSession 父文件就能查询。

### 阶段 E：画像改为 Take 派生与可重建

1. 确定哪些 `endReason`、`scoreStatus` 与 `trustworthy` 组合可纳入画像。
2. 将新 Take 提交事件作为画像更新触发点。
3. 明确 profile snapshot 的算法版本和重建入口。
4. 保持现有按 mode 聚合能力的真实语义，不把它展示成细粒度技能熟练度。
5. 将无实现依据的 transfer/delayed retest 状态标为 unsupported/not assessed 或保留为明确未启用功能。

**完成标准：** 画像数据来源唯一、能重建、不会被未完成演奏错误污染，统计不再漏掉新 Take。

### 阶段 F：收敛内部命名与冗余字段

只在以上功能测试通过后，按引用证据决定是否将 `PerformanceTake` 改名为 `ActiveTakeRuntime`、缩小 `PracticeSession` 的公开可见性，或移除无消费者的字段。

**完成标准：** 业务 API 和持久化不再依赖 PracticeSession 聚合；内部 Rust 结构仍按真实技术职责保留；没有为了改名引发大范围无收益差异。

## 13. 验收与回归矩阵

### 13.1 数据与身份

- [ ] 同时创建多个运行时对象时，业务 `takeId` 仍全局唯一。
- [ ] 结束同一运行多次，不新增第二条记录。
- [ ] 文件写入中断不会留下被历史 API 误识别的半条 Take。
- [ ] Take 文件可以在 runtime/coordinator 被销毁后独立读取。
- [ ] 旧 `sessionId` 映射稳定；旧内部 `takeId` 不被错误当成全局唯一主键。
- [ ] 新旧 API 合并时同一记录只出现一次。

### 13.2 运行状态与时间证据

- [ ] 普通弹奏后结束。
- [ ] 多次 pause/resume 后结束。
- [ ] 暂停中直接结束。
- [ ] 暂停前 Note-On、继续后 Note-Off。
- [ ] 暂停期间收到或延迟送达 MIDI。
- [ ] finish 与 socket close / device disconnect 并发。
- [ ] async plan / launch 响应过期，不会把旧计划关联到新 Take。
- [ ] 被 capture admission 排除的事件不会在最终重算中重新计分。

### 13.3 Timeline / Follow

- [ ] Timeline 最终报告与目前既有评分结果语义一致。
- [ ] Follow 正常结束产生 Take。
- [ ] Follow 报告保留自身结果语义，不被伪装为 Timeline。
- [ ] 两种模式均能从历史 Take 重新加载结果摘要。
- [ ] 未测量字段为明确缺失状态，不虚构分数。

### 13.4 Planner provenance 与曲谱版本

- [ ] planner authority/version/fingerprint 取自可信的实际计划上下文。
- [ ] 客户端伪造 provenance 不会改变服务端记录的事实。
- [ ] 老记录缺少 provenance 时仍可显示。
- [ ] 同一 `scoreId` 在曲谱内容变化后，旧 Take 仍能定位演奏时的版本或快照。

### 13.5 Learner Profile

- [ ] profile 只在 Take 提交后更新。
- [ ] 重建 profile 时使用同一批有效 Take 得到一致的统计。
- [ ] 旧 sessions 与新 takes 的兼容读取不会造成重复画像证据。
- [ ] 失败、不可信与中断记录按显式策略处理。
- [ ] 当前模式级画像不会被误称为细粒度钢琴技能掌握度。

### 13.6 交付验证纪律

- [ ] 按仓库现有要求执行 TypeScript、Vitest、Rust 和 selftest。
- [ ] 报告写明实际测试命令、结果与是否为本地运行；不得将本地测试表述为 GitHub CI 验证。
- [ ] 每份验证报告中的 `verifiedCodeSha` 匹配被测实现的准确 SHA。
- [ ] 浏览器验证、模拟 MIDI、实体 MIDI 验证分别陈述，不互相替代。
- [ ] 冻结文件、golden/expected fixtures、wire protocol 和计分路径未发生未经批准的修改。

## 14. 风险与决策记录

### 决策 ADR-01：不建立持久化 PracticeSession 聚合文件

**决定：** 每个 Take 独立存储；运行时 PracticeSession 可以保留为内部协调结构。  
**理由：** 当前没有足够强的整组事务或父级生命周期需求来抵消原子更新、并发锁、大文件和历史兼容成本。  
**重新评估条件：** 未来出现需要对一组 Take 整体提交/回滚、共享权限/删除、可恢复课程编排或跨 Take 事务的明确业务要求。

### 决策 ADR-02：Take 是单次演奏唯一权威记录

**决定：** 历史、回放、单次分析与画像证据均以 Take 为入口；不要同时把一个 `sessionId` 记录和一个 `takeId` 记录当成两条业务事实。  
**理由：** 单次演奏只有一个最终事实来源，才能可靠去重与重建画像。

### 决策 ADR-03：运行时模型与持久化 Take 分开

**决定：** 保留真正用于计时、采集、状态转换和幂等的内部结构；最终结算时输出 TakeRecord。  
**理由：** 内存状态机与历史记录具有不同的生命周期；强行混为同一个对象会让运行时字段泄漏到持久化契约，也使模式之间难以共享结算流程。

### 决策 ADR-04：Profile 是可重建派生数据

**决定：** Take 是历史证据，profile snapshot 只是缓存/投影。  
**理由：** 避免画像成为不可解释的第二事实源；也让新 Take 存储布局可以逐步迁移，不需要一次性全量重算和破坏旧数据。

## 15. 实施时的硬性保护边界

未获得明确授权前：

- 不合并 `main`，不更改生产 Rust planner 默认选择。
- 不修改 `TS_RUST_PARITY_GATE_V1.md`、golden/expected files、case index、schema/wire protocol、`EngineScoreEvent`。
- 不更改生产 `build_schedule`、matcher、`scoring_v1` 的算法行为。
- 不删除 `audit-r1/spike/sync-r20-report.mjs` 等明确需要保留的历史 untracked 文件。
- 不把本地报告声明说成 CI 已验证；报告 SHA 必须准确对应被测实现。
- 不顺手进行全仓 `session` → `take` 机械改名；优先建立映射与兼容边界。

---

## 最终一句话

**业务上，以 Score 内容身份为输入，以 Take 作为一次演奏唯一的权威历史记录，以 Learner Profile 作为跨 Take 的可重建派生画像；运行时的 PracticeSession、PerformanceTake、CaptureRouter 等只在确实承担引擎职责时保留，不建立包含 `takes[]` 的 PracticeSession 聚合文件。**
