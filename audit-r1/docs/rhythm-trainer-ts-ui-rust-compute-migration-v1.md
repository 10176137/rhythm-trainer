# Rhythm Trainer

# TypeScript 界面化、Rust 全计算化迁移报告

**版本：** V1.0  
**文档性质：** 目标架构与迁移实施方案（待评审，不代表已经实施）  
**项目范围：** React + TypeScript 前端、Node.js 服务层、Rust/N-API 核心引擎  
**核心决策：** 浏览器 TypeScript 只负责界面交互和展示；所有影响业务结果的数据解析、规划、匹配、评分、分析与学习数据计算统一由 Rust 负责。

---

## 1. 执行摘要

本次迁移不应理解为“把现有 TS 文件逐个翻译成 Rust”，而应当是一次**业务计算权归属重构**：所有影响乐谱语义、演奏目标、实时判分、Take 结果和学习档案的计算，统一迁移到 Rust；前端只消费 Rust/服务端给出的结果，并将它们可视化。

目标责任边界：

- **React + TypeScript：** UI、交互、纯展示、界面状态、布局、动画、API 调用与结果呈现。
- **Rust Core：** 所有业务数据计算的唯一权威实现，包括 MusicXML 语义解析与规范化、ScoreDocument 生成、演奏计划、演奏运行时、MIDI 事件解释、匹配、评分、报告分析、Take 最终结果和学习档案计算。
- **Node.js Server：** 基础设施适配层，包括 HTTP/WebSocket API、文件/设备 I/O、N-API 调用、请求路由、持久化、历史查询、日志与进程管理。Node 不复制业务算法。

**目标并不是消灭所有 JavaScript。** Node 仍可用 JavaScript 处理网络、文件、设备和进程边界；禁止的是 Node/TS 再实现一套影响业务结果的计算逻辑。

本轮最终要消除四类分叉：

1. 前端规划器与 Rust 规划器并存并竞争权威性。
2. Timeline、Follow、Free Play 的实时状态/判分流程不一致。
3. 不同模式走不同的 Take 完成和保存路径。
4. 学习档案、报告和统计结果在 TS/Node/Rust 中重复计算。

## 2. 目标架构

**调用链：** React + TypeScript（界面交互与展示） → Node.js Server（API、设备/文件 I/O、N-API、持久化） → Rust Core（MusicXML 语义解析、ScoreDocument、演奏计划、Runtime、事件匹配、评分、报告分析与学习数据计算）。Node 负责连接系统组件，不复制业务算法。

### 2.1 一条核心规则

**凡是改变“应该弹什么、实际弹了什么、弹得如何、这次练习得到什么结论”的代码，都属于 Rust 领域计算。**

如果某段 TS 代码计算了目标起始时间、音符持续时间、目标音高、手部/声部归属、匹配容差、错音/漏音、得分、技能进度或报告统计，这段代码就不再属于前端职责。

### 2.2 允许存在于 TS 的计算

只允许与展示和交互直接相关、不会成为业务事实来源的计算，例如：

- DOM/CSS 布局、乐谱视口滚动、自动跟随的滚动位置。
- 组件状态、弹窗开关、选中状态、加载状态和动画进度。
- 将服务端返回的数据格式化为文本、颜色、标签与图形。
- 将鼠标/键盘/触控操作转换为 API 命令。
- 根据已返回的事件 ID 找到对应显示节点并做高亮（仅 UI 映射，不改变事件语义或评分）。

这些结果只影响“如何显示”，不得反向影响权威计划、匹配、评分或 Take 结果。

## 3. 模块职责矩阵

| 模块 | 必须负责 | 明确禁止 |
|---|---|---|
| React/TypeScript UI | 交互、组件状态、显示、乐谱视图、API 请求、结果展示 | 权威解析、规划、匹配、评分、报告计算、技能指标计算、最终 Take 判定 |
| MusicXML 语义解析器（迁入 Rust） | 解析 MusicXML、规范化节拍/声部/小节/音符关系，输出 SD | 把解析语义留在 TS 并让 Rust 只接收 TS 计算好的计划 |
| Rust Plan Builder | SD + 练习配置 → 唯一权威 Playback Plan | 依赖前端生成的目标时间线 |
| Rust Runtime | Take 状态、时钟语义、暂停区间、事件顺序、模式执行规则 | 让 Timeline/Follow 各自维护权威状态机 |
| Rust Matcher / Scoring | 输入事件匹配、实时反馈、最终评分与汇总 | 让前端或 Node 重算分数 |
| Rust Analysis / Learner Model | Take 诊断、统计、技能证据与长期进度计算 | 把 `modeId` 直接冒充技能维度，或把未评估结果硬编码为真实结论 |
| Node.js Server | API、WebSocket、文件与设备 I/O、N-API、持久化、历史查询、ID、日志 | 复制规划/匹配/判分/学习算法，或修改 Rust 计算结果 |
| 数据存储 | 保存规范化结果、原始/关键事件证据、配置快照和版本元数据 | 自行计算业务结果 |

## 4. 需要迁入 Rust 的计算范围

### 4.1 乐谱语义与导入

**迁移目标：** MusicXML 的权威解析与规范化在 Rust 完成，生成 `ScoreDocumentV1`。前端不得再生成权威 SD。

覆盖范围至少包括：

- MusicXML 读取与格式错误诊断。
- divisions、拍号、调号、谱号、声部/谱表、小节边界等语义。
- 音符、休止符、和弦、节拍位置、时值、附点、连音与延音关系。
- 声部/手部映射所依赖的乐谱语义。
- tempo marks、重复/跳转标记，以及当前 support profile 明确支持的特性。
- 原始文件指纹、`scoreRevisionId`、能力标记与不支持特性诊断。

当前仓库已有 `ScoreDocumentV1` 契约，路径为 `audit-r1/contracts/score-document-v1.schema.json`。本次默认将它当作既有跨语言边界：**迁移 parser 的实现，不随意改 schema 或既有字段语义。** 如果 Rust parser 发现契约缺陷，先提交单独的 schema 变更提案与兼容证据，不把它混进 parser 迁移。

### 4.2 练习规划

由 Rust 根据 `ScoreDocument + PracticeConfig + Planner Version` 生成唯一权威 `PlaybackPlan`，包括：

- 目标事件/音符及稳定 ID。
- 目标起始时间、时值、节拍位置与必要的 MIDI 音高表达。
- 模式、范围、左右手/声部过滤和循环策略的实际生效结果。
- 目标事件与原始乐谱事件的可追踪关联。
- 计划版本、来源 score revision、配置摘要、能力警告和服务端生成的 `planFingerprint`。

前端只接收计划的展示投影，用于目标高亮、跟谱与界面状态。Rust 生成失败或版本不兼容时必须明确失败关闭，不能静默使用 TS planner 补位。

### 4.3 实时演奏与事件解释

Rust 负责所有会影响判分的数据解释：

- 把原始 MIDI note-on/note-off、设备时间戳和事件顺序转换为引擎事件。
- 时间基准、事件排序、去重、迟到/过期事件处理。
- 开始/暂停/继续/停止/完成的领域状态转换。
- 暂停区间、有效演奏时长、当前目标和进度状态。
- Timeline 的时间驱动、Follow 的输入驱动以及 Free Play 的采集/分析规则。

Node 可以读取设备并附加原始单调时钟时间戳；但时间戳校正、业务事件解释和是否计分由 Rust 决定。前端不得通过自己的计时器维护另一份权威进度。

### 4.4 Matcher、Scoring 与报告

全部收敛到 Rust：

- 目标音符与 MIDI 输入匹配。
- 错音、漏音、多弹、重复事件、过早/过晚、音符时值与持续时间评估。
- 实时反馈事件、分项得分、总分与置信/可评分状态。
- Take 报告、节奏稳定性、时间偏差、分段评估与诊断。
- 回放/复算所需的规范化结果。

既有 `scoring_v1`、Matcher、`EngineScoreEvent` 和黄金样例应作为行为基线。迁移的第一目标是把权威实现放到 Rust 并通过等价验证，不是在同一阶段顺便改变评分定义。

### 4.5 Take 最终化与 Learner Model

Rust 负责生成权威的最终结果摘要和学习数据计算，包括：

- Take 完成状态、分数、诊断、评估范围与结果有效性。
- 是否达到可评分/可比较条件。
- 多次 Take 的聚合指标和有证据支持的技能进度。
- 迁移/保持/延迟复测等学习指标（仅在实际实现并有有效证据时计算）。

Node 负责为记录分配持久化 ID、组装存储 envelope、原子写入和提供查询 API。Node 不得修改 Rust 返回的分数或重新计算技能进度。Learner Profile 可以物化存储，但应能从已完成 Takes 重建。

## 5. MusicXML、ScoreDocument 与乐谱显示如何分工

这里必须区分**语义解析**与**视觉排版**：

- Rust 负责权威解析，输出 `ScoreDocumentV1` 和必要的 `ScoreDisplayProjection`（例如稳定事件 ID、事件与小节/声部的对应关系、能力提示）。
- 前端负责将乐谱实际绘制到屏幕，包括 OSMD/视口渲染、缩放、滚动、当前事件高亮和自动跟随。
- 如果 OSMD 内部会解析 MusicXML 或计算排版坐标，这属于视觉渲染实现；其内部结果不能被拿来生成权威 Playback Plan 或分数。
- 当前 UI 渲染器与 Rust 语义事件之间必须有可验证的 ID/来源映射。若无法可靠映射，先补映射层和测试，不要用“按音符顺序猜索引”的脆弱方式联动。

这意味着：**TS 可以算一个音符在屏幕上的位置，但不能决定这个音符在业务上何时应被弹奏，也不能决定弹对与否。**

## 6. Node.js 的边界：保留基础设施，不保留业务计算

Node.js Server 不必一并迁入 Rust，因为 HTTP、WebSocket、文件系统、设备 I/O、进程管理和存储适配属于基础设施边界。但它应被收敛为薄适配层。

### 允许

- 接收上传的原始 MusicXML 文件或字节流，调用 Rust parser。
- 接收练习配置，做传输格式和大小限制检查，再由 Rust 做权威领域校验。
- 调用 N-API：解析乐谱、生成计划、启动 runtime、传递 MIDI 事件、执行状态转换、结束 Take、生成分析结果。
- 设备输入/输出、API 路由、请求身份、取消、资源释放、日志、持久化和历史读取。
- 为存档分配记录 ID、记录创建时间、原子写文件以及管理兼容旧 JSON。

### 禁止

- JavaScript 版 planner、matcher、scoring、score analyzer 或 skill progression。
- Timeline/Follow 各自实现最终完成和保存算法。
- 在 Rust 返回错误时自动用 TS/Node 计算代替，导致同一次练习采用不同权威。
- 信任前端自报的 `plannerAuthority`、分数或 `planFingerprint`；权威字段应来自服务端实际持有的 Rust 计划与结果。
- 在 Node 中对 Rust 分数进行二次修正，除非是明确的存储格式转换而不改变数值语义。

## 7. 核心 API 建议

具体路由可适配现有 API，不要求为统一命名而一次性大改。概念接口如下：

| 操作 | 输入 | 权威执行者 | 返回 |
|---|---|---|---|
| `parse_score` | 原始 MusicXML + 导入选项 | Rust | `ScoreDocumentV1`、display projection、能力/错误信息 |
| `build_plan` | SD + `PracticeConfig` | Rust | `PlaybackPlan`、版本、fingerprint、警告 |
| `create_runtime` | 权威计划 + Take 配置 | Rust | runtime/Take handle、初始状态 |
| `command_runtime` | start/pause/resume/stop | Rust | 状态转换结果、拒绝原因 |
| `push_midi_event` | 原始 MIDI 事件 + 时间戳 | Rust | 匹配结果、实时反馈事件、状态更新 |
| `finish_take` | runtime handle | Rust | 权威 Take summary、评分、诊断、可回放证据摘要 |
| `analyze_profile` | 已完成 Take 的规范化证据 | Rust | Profile 更新或重建结果 |
| History CRUD | ID/分页/筛选 | Node + 存储 | 持久化记录，不重新计算分数 |

`EngineScoreEvent` 和现有 wire protocol 应继续作为版本化契约使用，除非另行批准变更。N-API 的 DTO 必须显式版本化，避免 TS、Node 与 Rust 各自猜字段含义。

## 8. 分阶段迁移路线

### Phase 0 — 现状盘点与基线冻结（不改业务行为）

**工作：** 逐条追踪现有 MusicXML 导入、ScoreDocument、TS/RTS planner、Rust planner、Timeline、Follow、Free Play、Matcher、scoring_v1、Take 保存、Profile 更新与历史回放的实际调用链。

**交付：** 模块职责表、生产代码/测试 oracle 清单、数据流图、现有 API 和契约清单、旧历史样例清单、测试命令与基线 SHA。

**验收：** 明确哪些 TS 函数仍在生产路径中计算业务结果；所有冻结契约、黄金样例与行为边界可识别；真实 MIDI 测试和模拟测试区分清楚。

### Phase 1 — Rust API 与契约定稿

**工作：** 明确 ScoreDocument、PracticeConfig、PlaybackPlan、Runtime Event、Take Result、Profile 的 DTO 及版本；定义错误、状态转换、时间戳与指纹规范。

**交付：** N-API/API 接口、错误码、版本兼容策略、跨语言黄金测试框架。

**验收：** 每个字段都有生产者/消费者；不出现 TS、Node、Rust 三端同时解释同一字段的情况。既有 schema 和 wire protocol 不未经批准而改变。

### Phase 2 — MusicXML 语义解析迁入 Rust

**工作：** Rust parser 直接消费原始 MusicXML 并生成符合既有 `ScoreDocumentV1` 的结果；覆盖能力按清单逐步补齐。

**策略：** 旧 TS parser 在迁移窗口内只做离线 oracle/对照测试，不参与生产业务结果。针对 ties、tuplets、grace notes、chords、repeat、声部与手部映射等复杂点逐项增加语义测试。

**验收：** 固定 MusicXML 样例的关键语义与既有基线一致；未支持特性明确报告，不静默生成错误 SD；不修改黄金样例以掩盖差异。

### Phase 3 — Rust 成为唯一权威 Planner

**工作：** Rust 从 SD 和配置生成完整目标计划；前端仅请求并呈现计划投影；停止生产路径调用 TS/RTS planner。

**验收：** 对相同 SD 与配置输出规范化稳定计划；服务端生成并校验 provenance/fingerprint；失败时显式终止练习，不回退到 TS 算法。

### Phase 4 — 实时运行、Matcher 与评分全部收敛 Rust

**工作：** Timeline、Follow、Free Play 输入统一进入 Rust runtime 和匹配/评分核心。模式之间允许不同的驱动策略，但不能各自实现权威评分。

**验收：** 固定计划 + 固定 MIDI 事件序列产生可复现结果；暂停区间、note-off、重复/迟到输入、过期 Take 事件均有测试；TS 不再推进权威目标或修改判分状态。

### Phase 5 — Take Finalization、分析与 Profile 计算收敛 Rust

**工作：** 所有模式统一调用完成服务；Rust 生成最终摘要、报告/分析与学习指标；Node 只负责 ID、存储和查询。补齐 Follow 完成后也能持久化完整 Take 的链路。

**验收：** 每次成功完成恰好产生一条权威 Take；重复完成不产生重复记录；失败不伪装成完成；旧历史记录可读、回放与重建 Profile。

### Phase 6 — 前端瘦身

**工作：** 清理生产前端中所有权威计算路径；保留 UI state、渲染、组件布局、交互和 API 适配。旧 TS 算法仅按需要留在测试目录作为 oracle，生产 bundle 不依赖这些模块。

**验收：** 前端不计算 SD、Playback Plan、匹配、分数或技能指标；代码依赖扫描/审查能证明业务计算函数未被 UI 调用；页面行为基于服务端/Rust 返回值。

### Phase 7 — 端到端验收与生产切换

**工作：** 执行真实 MusicXML + 真实 MIDI 设备测试；评估输入延迟、时钟一致性、设备断连、长曲、复杂乐谱、持久化与回放；提交独立验证报告。

**验收：** 测试报告记录精确代码 SHA、实际命令、环境、通过/失败/跳过数量、是否真实设备；生产默认切换经单独审批，并有可执行的整版回滚方案。

## 9. 冻结资产与迁移规则

1. `ScoreDocumentV1` schema、`EngineScoreEvent` wire contract、`scoring_v1` 语义、parity gate、case index 和 golden fixtures 作为行为基线保护。
2. 旧 TS parser/planner/matcher 如果需要保留，只能作为离线测试 oracle；不得与 Rust 同时影响生产结果。
3. 若某个冻结文件确需变更，单独提交变更理由、兼容性影响、迁移测试和审批；不得把契约升级夹带进代码迁移。
4. 每阶段独立提交、独立验证；不要将大规模重命名、算法改动和迁移混在一个提交。
5. 每个临时适配器必须有删除条件。未证明替代路径有效前，不删除旧历史兼容与回放能力。
6. 运行时不能在 Rust 失败后悄悄切换 TS 算法。回滚应回退整个已发布版本，而不是让同一次练习在两个计算权威之间漂移。
7. 验证报告必须绑定 `verifiedCodeSha`；报告提交与被验证实现分离。

## 10. 测试矩阵

| 测试层 | 必须验证 |
|---|---|
| Parser 语义测试 | 原始 MusicXML → SD；小节、拍位、音高、时值、tie、tuplet、休止符、声部/谱表等 |
| Plan 黄金测试 | 固定 SD + 配置 → Playback Plan、目标时间、ID 与 fingerprint |
| Matcher/Scoring 测试 | 固定计划 + 固定 MIDI 事件 → 匹配状态、分数、实时事件和最终报告 |
| Runtime 状态机 | 开始/暂停/继续/停止/完成、非法转换、重复命令、迟到事件、暂停区间 |
| N-API 集成 | DTO 版本、内存/句柄生命周期、错误传播、边界值与性能 |
| Take 持久化 | 一次完成一条记录、重复完成幂等、历史读取、旧数据兼容、回放 |
| Profile 测试 | 从 Take 证据聚合/重建；未评估指标保持 unknown/unmeasured |
| UI 集成 | UI 仅显示返回状态；请求失败、过期响应、断连、空计划时正确 fail-closed |
| 真实端到端 | 真实键盘 note-on/off、时值、延迟、设备断连、真实乐谱和历史回放 |

## 11. 主要风险与控制措施

### MusicXML 语义迁移风险

MusicXML 的连音、反复段落、装饰音、和弦、跨谱表/声部等情况容易让解析器出现静默差异。控制方式是按能力清单逐项迁移、保留黄金基线、对不支持能力 fail-closed，而不是一次性把 parser 写完就切流量。

### 显示与语义事件映射风险

OSMD 的视觉元素与 Rust 事件 ID 未必天然一一对应。需要定义稳定 source reference/event ID 与展示投影，并针对高亮、跟谱和左右手显示测试映射。不能用屏幕坐标作为业务标识。

### 实时性能与时钟风险

Node、USB MIDI、Rust runtime 和浏览器渲染可能使用不同时间来源。输入采集可以保留在设备 I/O 层，但必须定义单调时钟、单位、延迟与暂停语义，并在 Rust 侧统一计算；前端动画时钟不得成为评分时钟。

### N-API 与序列化风险

整首乐谱只在导入/建计划时批量传递；实时 MIDI 输入可走高频轻量事件接口。必须测量内存复制、事件延迟和句柄释放，不能仅以单元测试通过证明实时性能。

### 迁移范围过大风险

Parser、Planner、Matcher、Scoring、Profile 同时重写很容易失控。采用分阶段迁移，每阶段保持外部契约，先验证语义再切换生产路径。

## 12. 完成定义（Definition of Done）

- [ ] 前端 TS 的生产依赖树中不再包含权威 ScoreDocument parser、planner、matcher、scoring 或 learner-data calculation。
- [ ] Rust 读取原始 MusicXML 并生成符合契约的 SD。
- [ ] Rust 是唯一生产 Playback Plan 生成器。
- [ ] Rust 是所有练习模式的唯一权威 runtime/matcher/scoring 实现。
- [ ] Take 最终结果、报告分析和学习指标由 Rust 计算。
- [ ] Node 只做 I/O、API、调用 Rust、持久化、历史查询与基础设施管理。
- [ ] Timeline、Follow、Free Play 都走统一的 Take 完成与持久化服务。
- [ ] 既有契约/黄金样例未被悄悄改写，所有批准的变更有独立记录。
- [ ] 旧历史记录兼容，Profile 可由有效 Take 证据重建。
- [ ] 真实 MIDI 端到端验收完成，且与模拟/手工测试明确区分。
- [ ] 所有测试报告绑定精确代码 SHA；生产切换经批准且有整版回滚路径。

## 13. 给开发代理的执行指令

执行本计划时，**第一步只做 Phase 0，不要立即改代码**。先提交一份盘点报告，至少列明：

1. 所有前端 TS 中仍影响业务结果的计算函数及调用方。
2. 当前 TS parser、TS/RTS planner、Rust planner、Matcher、`scoring_v1` 的实际生产/测试调用关系。
3. Timeline、Follow、Free Play 的状态路径和最终落库路径。
4. 每个冻结契约和黄金样例的位置，以及哪些可以保持、哪些需要单独申请变更。
5. Parser 迁移所需覆盖的 MusicXML 能力矩阵和当前缺口。
6. 按阶段建议的文件改动范围、测试命令、风险、回滚方式。

Phase 0 经评审后才进入 Phase 1。不得一次性重写整个项目，不得改生产默认值，不得提交业务语义变更，也不得把未执行的测试写成通过。

---

**最终原则：** TypeScript 决定界面如何呈现和用户如何操作；Rust 决定乐谱在业务上代表什么、练习目标是什么、输入意味着什么、表现如何以及结果是什么；Node 负责把设备、接口、Rust 和存储连接起来。每一种权威计算只能有一个负责人。
