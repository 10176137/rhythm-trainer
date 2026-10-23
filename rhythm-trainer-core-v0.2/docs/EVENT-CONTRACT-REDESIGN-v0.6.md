# Rhythm Trainer v0.6：核心事件契约重构规格

- 文档类型：架构决策 + 实施规格 + 验收标准
- 目标读者：Zcode / Codex、前端开发者、Rust Core 开发者
- 状态：待代码审查与实施；本文件是目标设计，不代表代码已经实现或编译通过
- 适用项目：React + TypeScript + Vite 前端、Node.js 本地服务、Rust Core（napi-rs）
- 参考设备：MEDELI SP-A500；仅作为首台符合性测试设备，不允许硬编码进评分核心

## 0. v0.6 的明确决策

**v0.6 正式重建权威事件契约。旧 `MidiPerformanceEvent` 不再是评分、事件配对或重放的权威输入。** 它最多在迁移期作为 UI 兼容 DTO，最终应从评分路径中移除。

这里的“推翻”范围是核心输入数据模型与事件管线，不是推翻整个应用。保留已有的 React 练习工作台、模式注册、Rust Core 模块化方向和教学产品设计；重构事件进入引擎的契约及其下游消费路径。

v0.6 对 v0.5 的变更：

1. Adapter 只捕获原始 MIDI 包，不在 TypeScript 中解码并产出可直接评分的简化事件。
2. Raw MIDI Packet 成为设备边界的规范输入；解码、按键生命周期配对、按键时长、事件质量与评分由 Rust Core 的同一权威路径处理。
3. 虚拟键盘/模拟器也必须生成 Raw MIDI Packet，通过同一 decoder 与 tracker，不允许模拟输入绕过核心事件管线。
4. 每条原始包保留来源、序号、时钟域、捕获时间、原始字节和传输类型，支持诊断与确定性重放。
5. 起音偏差、相邻起音间隔、按键时长作为三个独立指标；按键时长训练以 Note On/Off 配对结果为核心，不能把起音间隔当成按键时长。
6. 不根据品牌/型号硬编码评分行为；设备能力通过实测 profile 声明。

## 1. 现在的基线和问题

现有前端快照中的主要文件：

- `src/types/practice.ts`：`MidiPerformanceEvent` 只有 `type / midiNote / velocity / timestampMs / source`。
- `src/features/midi/midiAdapter.ts`：遍历所有输入端口；解析 Note On/Off；用 `performance.now()` 打时间戳；不保留原始 bytes、来源端口 ID、通道、来源序号和时钟域；忽略 Control Change 等消息。
- `src/App.tsx`：把简化事件放入 React 状态，并基于 note-on 执行演示评分逻辑。

因此当前只是可演示的前端事件模型，不能据此认为下列能力已经实现：原始事件可重放、稳定 Note On/Off 配对、按键时长评分、完整的音符/踏板语义、Rust Core 正式接入或实机兼容性。

Zcode 必须先检查实际仓库，不可只凭此快照推断当前 HEAD 的代码状态。审查报告应逐项提供文件路径和代码证据。

## 2. 架构目标

```text
不同标准 MIDI 键盘 / 虚拟键盘 / 测试回放
        │
        ▼
Transport Adapter（Web MIDI / Node MIDI / Mock）
只捕获原始消息和源时钟元数据，不评分、不做 Note On/Off 配对
        │ RawMidiPacket
        ▼
Ingress + Clock Mapping
保留源捕获时间，产生 session 时间映射；绝不使用 WebSocket 到达时间替代捕获时间
        │ IngestMidiPacket
        ▼
Rust Core：Raw MIDI Decoder
解码 Note On / Note Off / CC / Pitch Bend / 其他消息
        │ DecodedMidiEvent
        ▼
Rust Core：Key Lifecycle Tracker
配对按下与释放、计算时长、标记缺失/孤立/歧义/断连
        │ KeyPressObservation + Diagnostic
        ▼
Rust Core：Score Alignment / Judgment / Coaching
起音、时值、音高、声部/双手分析以及可解释反馈
        │
        ▼
UI DTO → React 工作台 / 练习报告
```

### 2.1 不同层的责任

**Transport Adapter（TypeScript）**
- 枚举、选择、连接和断开一个指定 MIDI 输入端口。
- 每收到一条 MIDI message，记录源序号、源设备会话 ID、源时钟域、捕获时间、原始字节、transport。
- 对权限拒绝、浏览器不支持、设备热插拔提供状态事件。
- 不解析音符类别以供评分，不计算按键时长，不推断左右手，不产生 Judgment。

**Ingress / Clock Mapping（Node 或明确的桥接层）**
- 将源采集时间映射到统一的练习 Session 时间域。
- 保存映射快照、映射版本、误差/不确定度和质量状态。
- 不覆盖原始捕获时间，不使用服务端收到 WebSocket 消息的时刻作为演奏发生时间。
- 事件时钟域或映射不可用时，可保留原始输入与同源时长观测；但不能输出声称可信的对谱起音判定。

**Rust Core（唯一评分真源）**
- 对原始 bytes 解码；维护事件完整性；处理按键生命周期。
- 计算 key-down duration，执行乐谱对齐、评分、统计和教学诊断。
- 确定性重放相同的 raw packet 序列与同一配置必须产生相同结果。
- 不打开 USB 设备、不访问 DOM、不依赖浏览器 API、不读取系统当前时间、不直接写文件或网络。

**React UI**
- 展示设备状态、收到的事件摘要、乐谱、运行反馈和报告。
- 可以显示诊断日志，但不能重新实现一套评分/配对/教学规则。
- 过渡中的旧事件仅可用于 UI 可视化，不能进入正式评分或重放路径。

## 3. 规范事件契约

以下是契约示例；最终字段名允许在实现时调整，但语义、必需信息与验收条件不得删减。

### 3.1 Transport 边界的 RawMidiPacket

```ts
export type MidiTransport = 'web-midi' | 'node-midi' | 'mock' | 'recording';

export interface RawMidiPacket {
  /** 当前应用运行期间生成的来源 ID；不是跨设备/跨机器永久 ID。 */
  sourceId: string;
  /** 同一 sourceId 内严格递增，包含成功接收的每条 MIDI message。 */
  sourceSeq: number;
  /** 时间戳来自哪个单调时钟域，例如 web-page-<session-id>。 */
  clockDomainId: string;
  /** MIDI 输入事件的源捕获/事件时间，单位 ms；不是 Node 收包时间。 */
  capturedAtMs: number;
  /** 可选：JS handler 实际执行时间，供估算调度延迟；不作为主要演奏时间。 */
  handlerAtMs?: number;
  /** 原始 MIDI message bytes，按原顺序保留。 */
  rawBytes: number[];
  transport: MidiTransport;
  /** 仅供展示/日志；不得参与评分分支。 */
  sourceLabel?: string;
}
```

约束：

- `sourceId` 在一次连接实例中必须唯一；可由 adapter 生成 session-local ID，并另外保留系统端口 ID 供排障。
- `sourceSeq` 对收到的每个包递增，不得只对音符消息递增，否则无法发现中间丢失的控制消息。
- `capturedAtMs` 必须和 `clockDomainId` 一起解释；不同 clock domain 的时间值不能直接相减。
- `rawBytes` 必须是对收到的消息的原样拷贝，避免后续 buffer 被重用或修改。
- 如 API 没有可靠源捕获时间，adapter 必须把这一点写进 `timeQuality` / adapter capability，不可把 handler 时间冒充精确的硬件采样时间。
- 不要将 MIDI 厂商名称或设备名称用作事件语义或评分逻辑。

### 3.2 进入 Rust Core 的 IngestMidiPacket

浏览器中的 `WebMidiAdapter` 无法直接调用 Node-API 原生模块。若保持“浏览器前端 + Node 服务 + napi-rs”结构，前端应把原始包发送给本地服务；服务端时钟桥接后再调用 NativeSessionEngine。

```ts
export type ClockQuality = 'good' | 'estimated' | 'unstable' | 'unknown';

export interface IngestMidiPacket {
  packet: RawMidiPacket;
  /** 从 packet 的 source clock 映射到本次 session 的时间；单位 ms。 */
  sessionTimeMs: number | null;
  clockMappingId: string | null;
  clockUncertaintyMs: number | null;
  clockQuality: ClockQuality;
}
```

`sessionTimeMs` 是对谱起音判断所用的统一时间；`packet.capturedAtMs` 原样保留，用于同源持续时长测量、诊断和重放。映射的 anchors、斜率/偏移、采样数据和不确定度要进入 session snapshot。任何 replay 不得重新读取当前时钟或重新猜测历史映射。

如果一个版本选择在浏览器中运行 Rust WASM，则仍须遵守同一 DTO 和同一 Rust 语义；禁止因为宿主不同而复制一套评分算法。首选方案仍是当前项目既定的 Node-API Rust Core，WebMIDI 到 Node 的传输细节要在集成测试中验证。

### 3.3 Rust 内部 DecodedMidiEvent

这是对 RawMidiPacket 的派生结果，不是 Adapter 的输入。

```rust
pub struct DecodedMidiEvent {
    pub event_id: String,            // 可由 sourceId + sourceSeq 确定性生成
    pub source_id: String,
    pub source_seq: u64,
    pub channel: Option<u8>,         // channel voice 使用内部 0..=15
    pub source_time_ms: f64,
    pub session_time_ms: Option<f64>,
    pub kind: MidiEventKind,
    pub raw_packet_ref: String,
}

pub enum MidiEventKind {
    NoteOn { note_number: u8, velocity: u8 },
    NoteOff { note_number: u8, release_velocity: Option<u8> },
    ControlChange { controller: u8, value: u8 },
    PolyphonicKeyPressure { note_number: u8, pressure: u8 },
    ChannelPressure { pressure: u8 },
    ProgramChange { program: u8 },
    PitchBend { value_14bit: u16 },
    Other { status: u8, data: Vec<u8> },
}
```

以上为语义示意，napi-rs 导出 DTO 可以用 JSON-compatible enum/tag representation，但需定义稳定的序列化形状和 schemaVersion。

### 3.4 RawMidiPacket 不能被 `MidiPerformanceEvent` 替代

旧结构：

```ts
interface MidiPerformanceEvent {
  type: 'note-on' | 'note-off';
  midiNote: number;
  velocity: number;
  timestampMs: number;
  source: 'device' | 'simulator';
}
```

问题：丢失原始 bytes、MIDI 通道、端口实例、来源序号、时钟域、CC/踏板消息以及事件完整性证据。v0.6 禁止其成为评分核心入口。迁移期如 UI 仍需要，重命名为 `LegacyPreviewEvent` 或相当名称，并用清晰注释标记 `@deprecated`；不可从它恢复“原本没有保存”的元数据。

## 4. MIDI decoder 规则

必须由 Rust Core 的统一 decoder 执行（可有薄 adapter 做消息长度校验，但不能有另一套语义 decoder）。

- `0x8n`：Note Off。
- `0x9n` 且 velocity `1..127`：Note On。
- `0x9n` 且 velocity `0`：按 Note Off 处理；保留原始 bytes，decoded kind 统一为 NoteOff，同时诊断原始编码形式可供调试。
- `0xBn`：Control Change，必须保留 controller 与 value；CC64/66/67 绝不是 Note Off。
- `0xAn`：Polyphonic Key Pressure。
- `0xCn`：Program Change（消息长度与其他 3-byte 消息不同，不能错误读取不存在的第三字节）。
- `0xDn`：Channel Pressure。
- `0xEn`：Pitch Bend，合并成标准 14-bit 值；首版不据此给出演奏音高分，但保留。
- 未知、系统消息或不支持的消息必须进入 `Other`/诊断路径且保留原始 packet，不得伪造成音符，也不得静默丢弃。
- MIDI channel status 的低 4 bit 统一为内部 0–15；UI 展示时才转成 1–16。

## 5. 按键生命周期与时值

### 5.1 KeyPressObservation

```ts
export type KeyPressStatus =
  | 'complete'
  | 'missing-note-off'
  | 'interrupted-by-disconnect'
  | 'ambiguous-pairing'
  | 'invalid-time';

export interface KeyPressObservation {
  pressId: string;                 // 由 Note On 的 eventId 确定性生成
  sourceId: string;
  channel: number;                 // 0..15
  noteNumber: number;              // 0..127
  velocityOn: number;
  noteOnEventId: string;
  noteOffEventId?: string;
  startSourceTimeMs: number;
  endSourceTimeMs?: number;
  startSessionTimeMs?: number;
  endSessionTimeMs?: number;
  keyDownDurationMs?: number;
  status: KeyPressStatus;
  qualityReasons: string[];
}
```

`orphan-note-off` 是独立诊断事件，因为它无法对应一条起始按键记录；不要构造伪造的 KeyPress 来隐藏该异常。

### 5.2 配对语义

- 配对主键至少是 `sourceId + channel + noteNumber`；不能只按音高配对。
- Note On 创建一条 active press，pressId 由 Note On eventId 确定性生成。
- Note Off 找到唯一 active press 时配对并计算时长。
- 如果没有 active press：产生 `ORPHAN_NOTE_OFF`，记录原始事件，不输出时长分数。
- 如果同一 `sourceId + channel + noteNumber` 已经有 active press，又收到同音 Note On：标记该键位的重叠记录为 `ambiguous-pairing`。由于 MIDI Note Off 没有独立 press ID，不能假装知道释放的是哪次按下。
- 为保证可重放，歧义情况下可以使用确定性 FIFO 关闭一个 active entry，但被影响的所有记录不得用于严格 duration grading，且报告必须留下 `AMBIGUOUS_SAME_KEY_OVERLAP` 诊断。
- 会话结束时仍处于按下状态：输出 `missing-note-off`；设备断连时：输出 `interrupted-by-disconnect`。不可按固定时长伪造 release。
- 同时间戳事件用 `sourceSeq` 稳定排序；不同 source 的事件不能按时间值直接比较，除非都有有效的 session mapping。
- 会话暂停期间收到的消息仍可以进原始日志，但需明确标注为 paused/out-of-session，不应悄悄混入计分窗口。

### 5.3 时长的正确含义

- `keyDownDurationMs = off.sourceTimeMs - on.sourceTimeMs`，前提是两个包属于相同 `sourceId` 和 `clockDomainId`，时间合法、递增、且配对状态为 `complete`。
- 对谱起音比较使用映射后的 `sessionTimeMs`；按键时长优先根据同源捕获时间差计算，以避免 WebSocket 到达抖动直接污染时长。
- 记录 `clockUncertaintyMs` / `timestampQuality`。捕获时间仍包含 MIDI 设备、驱动、浏览器或系统调度的误差，不等同于琴键机械传感器时间的绝对真值。
- 不要删除相邻起音间隔。三个指标定义不同：
  1. **起音偏差**：实际起音相对目标拍位早/晚多少。
  2. **相邻起音间隔**：连续起音之间的时间差，用于节奏网格、速度稳定性等分析。
  3. **按键时长**：Note On 到 Note Off 的持续时间，用于时值训练与 articulation 观察。
- 四分/八分音符书写时值来自乐谱目标，不靠实际间隔猜音符类型。严格时值训练可检验 key-down duration；普通乐谱跟练必须有 duration policy，以避免把断奏/连奏/连线/延音踏板情景一概当作“按住时间必须等于书写时值”。
- CC64 延音踏板状态不延长 keyDownDuration；声音的实际衰减时长不在纯 MIDI Note On/Off 层推断。

## 6. 设备能力与乐器无关性

设备 profile 是实测能力的记录，而不是型号规则表。

```ts
export type CapabilityEvidence =
  | 'verified'
  | 'not-tested'
  | 'not-observed'
  | 'unsupported'
  | 'failed';

export interface InstrumentCapabilityProfile {
  schemaVersion: 1;
  sourceId: string;
  displayName?: string;
  transport: MidiTransport;
  noteOnOff: CapabilityEvidence;
  velocity: CapabilityEvidence;
  channelData: CapabilityEvidence;
  sustainPedalCC64: CapabilityEvidence;
  timing: 'good' | 'estimated' | 'unstable' | 'unknown';
  testedAt?: string;
}
```

注意：未观察到 CC64 不等于不支持踏板；未出现独立通道不等于无法双手演奏。双手归属应优先根据 MusicXML 谱表/声部和匹配结果判定；信息不足时由用户选择或降低置信度，不能把 MIDI channel 1 硬编码成右手。

首次接入设备的诊断向导至少测试：单音按下、松开、轻弹/重弹、可选踏板、断开重连；输出原始包下载。SP-A500 是第一台硬件符合性设备；只有实际连接测试完成才能标记 `verified`。

## 7. 与乐谱和模式的契约

Rust scorer 不接收 UI 的“命中/评分”结论，只接收：

- 已验证或带明确限制的 `ScoreModel` / `TargetSchedule`；
- `KeyPressObservation` / 解码音符事件；
- 明确的 session clock 与质量状态；
- 当前模式的评分 profile 和 duration policy。

Score Note DTO 至少表达 `scoreNoteId`、MIDI pitch、`startTick`、`durationTicks`、measure、part/staff/voice、tie/articulation hints。MusicXML parser 可由独立模块实现，但不得把 OSMD 仅渲染用的内部 DOM 当作正式评分模型。

- 和弦按多个音符生命周期保存，但起音评分可按 score chord group 聚合，避免一个和弦被多次判成 EXTRA。
- hand selection 可为 `both/right/left`；手的语义来自谱表/声部，或用户显式选择，不从硬件品牌推断。
- `score-follow`、`strict-duration`、`rhythm-only` 的评分维度应分开；不支持的乐谱语义或低质量输入应抑制严格结论。

## 8. Rust Core API 轮廓

仅作契约示意，具体命名可调整，语义不可改变：

```ts
export interface NativeSessionEngine {
  ingestPacket(input: IngestMidiPacket): IngestResult;
  advance(nowSessionMs: number): readonly EngineOutput[];
  onSourceDisconnected(sourceId: string, atSessionMs: number): readonly EngineOutput[];
  finish(nowSessionMs: number): SessionReport;
  snapshot(): SessionSnapshot;
}

export function replaySession(snapshot: SessionSnapshot): SessionReport;
```

规则：

- `ingestPacket` 在同一调用链中进行 raw bytes decode、事件完整性更新和按键 tracker 更新；结果是诊断/观测值，而不是 UI 自己算分。
- `advance` 使用调用方传入的时间；Rust Core 不读取当前系统时间。
- `finish` 关闭会话并输出所有未闭合按键的异常记录。
- `snapshot` 至少保存 schema version、算法版本、session config、原始 packet 序列、时钟映射快照、score model hash、诊断和配置阈值。
- `replaySession` 只基于快照数据运行，不访问设备、文件或当前时间；相同 snapshot 和算法版本应确定性复现结果。
- Rust Core 不负责将报告写进文件。Node 服务负责持久化。

## 9. 从当前代码迁移的具体步骤

### E0 — 代码现状盘点

逐文件确认当前 HEAD，至少检查：`src/types/practice.ts`、`src/features/midi/midiAdapter.ts`、`src/App.tsx`、`packages/native-addon`、`crates/rhythm-core` 和 Node ingress/WebSocket（如果实际存在）。输出 `implemented / partial / absent / unknown` 表格，每项带文件证据和现有测试。不得把设计文档当作实现证据。

### E1 — 先建立统一契约与测试向量

新增或整理 `RawMidiPacket`、`IngestMidiPacket`、schemaVersion、Golden fixtures。Mock Adapter 必须发原始 MIDI bytes（例如 `[0x90, 60, 90]`），通过相同 decoder；禁止 Mock 直接发一个“正确音符”绕过核心。

### E2 — 替换 Adapter 输出

- `WebMidiInputAdapter` 只捕获原始消息，不遍历并无差别混合所有端口；由用户选定单一输入，或明确允许多源但为每个 source 分隔序列和时钟域。
- 记录 `event.data` 的原始 bytes、端口 ID、sourceSeq、clockDomainId、capturedAtMs、handlerAtMs。
- 热插拔、权限拒绝、无输入端口、输入断开必须输出状态诊断。
- `MockMidiInputAdapter` 使用同一 raw contract。

### E3 — Rust Core 重建事件路径

- 在现有 `rhythm-core` 中实现/替换 decoder、tracker、diagnostics、snapshot/replay 契约。
- Node-API DTO 仅负责桥接，不新增第二套 TS 评分实现。
- `MidiPerformanceEvent` 从正式评分输入路径移除；若短期需要 UI 兼容，限定为只读派生 view model，之后删除。

### E4 — 让 UI 只消费 EngineOutput

UI 通过 bridge 收到 `DecodedMidiEventView`、`KeyPressObservation`、`DiagnosticEvent`、`JudgmentResult`。键盘动画/反馈是展示，不得修改核心状态。

### E5 — 时值和评分

接入 MusicXML ScoreModel；将起音、间隔、时长分开出结果；明确 duration policy。输入或对齐质量不达标时，不输出精确或肯定的诊断。

### E6 — 硬件符合性验证

先用 Mock trace 跑自动化测试，再通过 SP-A500 实机确认 Note On/Off、velocity、CC64、断连重连和时间戳行为。之后用第二台不同品牌标准 MIDI 设备执行同样测试。不能在没有硬件证据时声明兼容。

## 10. 必需测试矩阵

### Decoder

- `90 3C 5A` → channel 0 Note On note 60 velocity 90。
- `80 3C 28` → Note Off note 60 release velocity 40。
- `90 3C 00` → Note Off，不是力度为 0 的 Note On。
- 通道 0 和 15 边界正确；UI 通道显示 1 和 16。
- CC64/66/67 保留为 Control Change，不关闭按键。
- Program Change / Channel Pressure 两字节 payload 不越界读取。
- unknown/truncated raw message 保留并诊断，不伪造音符。

### Lifecycle

- Note On at 1000 ms，Note Off at 1375 ms，同源同 clock → keyDownDuration 375 ms。
- 同音不同 source、不同 channel 不交叉配对。
- 同一音符正常松开后再弹可形成两个 complete lifecycle。
- 同一 channel 同音未松开前再 Note On → ambiguous pairing，受影响时长不用于严格评分。
- 无 active press 的 Note Off → ORPHAN_NOTE_OFF。
- finish 时未释放 → missing-note-off；disconnect → interrupted-by-disconnect。
- 时间戳倒退、clock domain 不同、sequence gap/duplicate 各自产生诊断。
- CC64 踏板消息不改变 keyDownDuration。

### Replay / Integration

- 同一份原始 packet snapshot + 同一算法版本，多次 replay 的事件、时长、诊断和 report 一致。
- Mock 与 Web MIDI Adapter 经过真实 ingress 后走同一 Rust decoder/tracker。
- 浏览器采集时间与 Node session clock 通过映射关联；WebSocket 到达延迟不会改变事件的 `capturedAtMs`。
- React build 与 Rust tests 均通过；未运行的测试必须明确标记为未运行。

## 11. 完成定义（Definition of Done）

只有同时满足以下条件才能把事件层标为完成：

1. 旧 `MidiPerformanceEvent` 不再是正式评分输入。
2. Device、mock、recording adapters 输出相同 `RawMidiPacket` 语义。
3. Rust Core 是 MIDI decode 后的音符生命周期、时长和评分的唯一权威路径。
4. 原始 packets 和 clock mapping 可用于确定性重放。
5. decoder、lifecycle、异常输入、disconnect、CC64 与 replay 测试覆盖上述矩阵。
6. 前端可显示输入源状态和数据质量；低质量时抑制严格判断。
7. SP-A500 实机测试有原始 JSON 证据；第二台设备测试另行记录，不虚报覆盖范围。
8. Windows build 和测试结果如实记录；没有可用 Rust toolchain 时不得声称 Rust 编译通过。

## 12. 不做的事情

- 不为 SP-A500、Yamaha、Casio 等品牌分别写评分核心。
- 不在 TypeScript 与 Rust 中各写一套 Note On/Off 配对和时长算法。
- 不把起音间隔删掉：时值、起音偏差和间隔是不同测量维度。
- 不把每个物理/设备事件的时间戳小数位数等同于物理测量精度。
- 不用声学发声时长替代键盘按住时长。
- 不在本任务中顺手重写整个 UI、增加微服务、引入云服务或扩展所有厂商专有 SysEx。

---

## 参考与实现注意事项

- Web MIDI API：<https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API>
- requestMIDIAccess：<https://developer.mozilla.org/en-US/docs/Web/API/Navigator/requestMIDIAccess>
- MIDI 1.0 信息表（状态字节 / channel voice messages）：<https://www.midi.org/specifications-old/item/table-1-summary-of-midi-message>

本规格为产品工程设计，不表示所有设备已经测试通过。设备兼容能力以实际 packet trace 和符合性测试结果为准。
