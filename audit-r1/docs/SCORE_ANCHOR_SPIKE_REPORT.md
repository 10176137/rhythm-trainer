# SCORE ANCHOR SPIKE 报告（R1 交付物 2/5）

**日期：** 2026-10-23
**OSMD 版本：** **2.2.1**（`frontend/package.json` 精确锁定 `"opensheetmusicdisplay": "2.2.1"`，`package-lock.json` 解析到同一版本）
**验证环境：** 真实浏览器（Chromium 146 / Electron 41.0.3，UA 见附录 A），非 jsdom、非截图目测
**原始数据：** `D:\123\audit-r1\spike\out\osmd-anchor-spike.json`（10 个 case 的完整结构化结果）
**Harness：** `D:\123\audit-r1\spike\{index.html,spike.mjs,serve.mjs}`（独立静态服务 + OSMD UMD build，未改动前端仓库任何文件）

---

## 0. 结论（先看这里）

| 问题 | 实测答案 |
|---|---|
| OSMD 2.2.1 是否保留 MusicXML `note@id`？ | **完全不保留。** 10 个 case（含 6 个带 id 的 fixture）在内部 `Note`、`GraphicalNote`、`SourceMeasure` 及渲染 DOM 中的命中数全部为 **0** |
| 是否有可查询的稳定 DOM 属性？ | **没有业务 ID。** DOM 只有 `osmdCanvasPage1`、`osmdSvgPage1`、`Piano0-1`、打印小节号（`"1"`、`"2"`）、VexFlow 自增 id（`vf-autoNNNN`）与 `autoNNNN` |
| 当前仓库 adapter 的复合键可靠吗？ | **不可靠。** `measure:staff:voice:pitch` 在"同小节重复同音"时碰撞（G2、G8 各 1 个碰撞桶），而 adapter 的自检**仍然报告 PASS** |
| 加上 onset 后可靠吗？ | **在本次全部 10 个 case 中零碰撞、全量映射。** 但它是**推导身份**，不是源身份；同 onset 同音高（真 unison / grace+主音同音）仍会碰撞，必须 fail-closed |
| 和弦的 glyph 是 1:1 吗？ | **不是。** 三音和弦 = 1 个 `vf-stavenote`、3 个 notehead **共用同一个 SVG id**；对一个音调用 `setColor` 会**同时染红 3 个 notehead + 共用符干** |
| 休止符能区分吗？ | 能，但**必须用 `note.isRest()`**：OSMD 给休止符的 `halfTone` 是 **12**，按音高判断会把休止符当成音 |
| tie continuation 能区分吗？ | 能。跨小节 tie 的两个 Note 都有 `NoteTie`，且只有第一个满足 `NoteTie.StartNote === note` |
| 隐藏音 / grace / cue 能定位吗？ | `printObject=false`、`IsGraceNote=true`、`isCueNote` 均可在 Note 对象上读到；**但 grace 的 `Timestamp` 与其后主音相同** |

**一句话：OSMD 2.2.1 不能提供源 ID；能提供"结构身份"（measure/staff/voice/精确 onset/pitch/ordinal），足够做 fallback，但必须自带碰撞检测与 fail-closed，不能像现在这样只报 mapped/duplicates。**

---

## 1. 方法与"非截图"证据

### 1.1 为什么必须用真实浏览器

`opensheetmusicdisplay` 只有浏览器 UMD build（`build/opensheetmusicdisplay.min.js`，1.42 MB），依赖真实 DOM/SVG。仓库内没有 jsdom/happy-dom/playwright 依赖，因此本次使用：

1. 一个独立静态服务（`audit-r1/spike/serve.mjs`，127.0.0.1:8799）同时提供 harness 页面与 **frontend `node_modules` 里实际安装的 OSMD build**；
2. 真实 Chromium 页面加载 OSMD，`await osmd.load(xml); osmd.render();`
3. 在页面内**遍历 OSMD 公共对象模型**并输出结构化 JSON（不是截图），通过 `POST /result` 落盘。

**没有使用**：SVG 类名猜测、几何坐标、`outerHTML` 文本包含、"看起来对"的截图判断。

### 1.2 测量项

对每个 fixture 记录：

- `osmd.Sheet.SourceMeasures[i].VerticalSourceStaffEntryContainers[j].StaffEntries[k].VoiceEntries[l].Notes[m]` 全量遍历；
- 每个 Note：`measureIndex`、`MeasureNumber`、`stackIndex`（StaffEntries 下标）、`ParentStaff.Id`、`ParentVoice.VoiceId`、`ParentVoiceEntry.Timestamp`（Fraction）、`getAbsoluteTimestamp()`、`halfTone`、`Pitch.ToStringShort()`、`isRest()`、`NoteTypeXml`、`IsGraceNote`、`isCueNote`、`printObject`；
- `osmd.rules.GNote(note)` 的返回对象（GraphicalNote）：类名、`getSVGId` 是否存在、`vfnote[0].attrs.id`、`getAttribute('id')`；
- **ID 可达性扫描**：以每个 Note 及其直接父对象（`voiceEntry`/`parentStaffEntry`/`sourceMeasure`，深度 3）为根，递归扫描所有自有属性名与字符串值，查找 fixture 里写入的 `note@id` 字面量；同时扫描每个 `SourceMeasure`；
- DOM：`container.querySelectorAll('[id]')` 的**精确属性值**（不是 `innerHTML.includes`——早期版本用字符串包含曾把 `<h2>` 标签名误判为 `id="h2"` 命中，已修正）。

---

## 2. Fixtures

全部为手写极简 MusicXML，位于 `D:\123\audit-r1\fixtures\`。

| # | 文件 | 内容 | 用途 |
|---|---|---|---|
| G1 | `g1_single_voice.musicxml` | 4/4，C4 D4 E4 F4 四分 + G4 二分 + 二分休止 | 基础序列 + 休止 |
| G1i | `g1_single_voice.ids.musicxml` | 同上，`id="n1".."n6"` | id 可达性 A/B |
| G2 | `g2_chord.musicxml` | C4+E4+G4 同 onset 和弦，随后**重复 C4**，再二分休止 | chord + 重复同音 |
| G2i | `g2_chord.ids.musicxml` | 同上，`id="n1".."n5"` | id 可达性 |
| G3 | `g3_tie_across_bar.musicxml` | 2/4 × 2，跨小节 tie | tie continuation |
| G3i | `g3_tie_across_bar.ids.musicxml` | 同上，`id="n1".."n2"` | id 可达性 |
| G4 | `g4_triplet.musicxml` | divisions=3，三连音 C4 D4 E4 + 四分 G4 + 二分休止 | 非整数拍位 |
| G6 | `g6_unison_two_staves.musicxml` | 双谱表，两行同时 C4（backup） | 跨 staff 同音 |
| G7 | `g7_hidden_grace.musicxml` | `print-object="no"` 的 D4 + grace E4，`id="h1".."h5"` | 隐藏音 / grace |
| G8 | `g8_key_alter.musicxml` | G 大调；F4 无 alter、F4 alter=1、F4 natural | 调号 vs 显式 alter |

id 变体由 `fixtures/make-id-variants.mjs` 按文档顺序确定性生成（`<note>` → `<note id="nN">`）。

---

## 3. 结果 A：XML `note@id` 是否可达

| Case | 写入的 id | 对象图命中 | DOM 精确 id 命中 | DOM 里的 id 样本 |
|---|---|---|---|---|
| g1-ids | n1…n6 | **0** | **[]** | osmdCanvasPage1, osmdSvgPage1, Piano0-1, "1", vf-auto1084, vf-auto1084-stem, … |
| g2-ids | n1…n5 | **0** | **[]** | … Piano0-1, "1", vf-auto1201, vf-auto1209, cursorImg-3 |
| g3-ids | n1…n2 | **0** | **[]** | … "1", "2", vf-auto1293, vf-auto1293-tie |
| g7 | h1…h5 | **0** | **[]** | … vf-auto1447, vf-auto1451, vf-auto1455, vf-auto1460 |
| g8 | k1…k4 | **0** | **[]** | … vf-auto1509, vf-auto1515, vf-auto1521, vf-auto1527 |

**扫描到的 ID 类属性只有内部标识**（`Object.getOwnPropertyNames(note).filter(/id/i)`）：
`playbackInstrumentId`、`NoteToGraphicalNoteObjectId`（number）、`AccidentalParenthesesXml`、`AccidentalBracketXml`。
`Note` 上**没有** `getSVGId`（`typeof note.getSVGId === 'function'` → false）；`GraphicalNote` 上有。

**A/B 对照结论**：带 id 与不带 id 的同一 fixture，在所有测量维度（note 数、时间戳、DOM id 集合、碰撞统计）上**行为完全相同**。OSMD 2.2.1 读取 `<note>` 时丢弃 `id` 属性。

**失败边界**：G7 的 `id="h2"`（隐藏音）曾在一个早期版本里被 `innerHTML.includes("h2")` 误判为命中——原因是 `<h2>` 标签名。改为精确 `[id="..."]` 查询后为 0。这条记录在此是为了说明：**字符串包含不是 ID 证据**。

---

## 4. 结果 B：OSMD 实际提供什么身份

| 维度 | 可用性 | 实测细节 |
|---|---|---|
| 小节 | ✅ | `measureIndex`（数组下标）+ `SourceMeasure.MeasureNumber`（打印号）。两者需分开，**不能假定连续** |
| staff | ✅ | `VerticalSourceStaffEntryContainer.StaffEntries` 下标 + `ParentStaff.Id`（如 `Piano0-1`、`Piano0-2`） |
| voice | ✅ | `VoiceEntry.ParentVoice.VoiceId`（number） |
| **精确拍位** | ✅ | `VoiceEntry.Timestamp`（Fraction，**小节相对，单位 = 全音符**）：`×4` 得到四分音符拍，实测 `0,1,2,3`（G1 m1）、`0,2`（G1 m2）、`0,1/3,2/3,1,2`（G4）——**精确有理数，无浮点漂移** |
| 绝对拍位 | ✅ | `note.getAbsoluteTimestamp()`（Fraction，全音符单位）：G1 第 2 小节的 G4 = 4、G3 第 2 小节 = 2 |
| 音高 | ✅ | `halfTone`，**比 MIDI 低 12**（C4 → 48），`+12` 即 MIDI（与仓库 adapter 现有注释一致） |
| 是否休止 | ✅ 但**必须用 `isRest()`** | **陷阱**：休止符的 `halfTone` = **12**，不是 null/undefined。按 `Number.isFinite(halfTone)` 过滤会把休止符当音（本次 harness 第一版就踩了） |
| 和弦归组 | ✅ | 同 `VoiceEntry` 的多个 Note 即同 onset 和弦；`VoiceEntry.Notes[]` 顺序 = XML 顺序 |
| tie | ✅ | `note.NoteTie` 存在；`NoteTie.StartNote === note` 判定 tie start，否则为 continuation。G3：m1 `{parentTie:true, tieStart:true}`，m2 `{parentTie:true, tieStart:false}` |
| grace | ✅ | `IsGraceNote=true`；**注意** `Timestamp` 与其后主音**相同**（G7：grace E4 tsQ=2，主音 F4 tsQ=2） |
| 隐藏音 | ✅（对象层） | `printObject=false`（G7 的 D4）。DOM 是否真的不画，本次未用 `visibility` 断言 → **未验证** |
| cue | ✅ | `isCueNote` 字段可读 |
| SVG 元素 | ⚠️ 只在 GraphicalNote 上 | `osmd.rules.GNote(note)` → GraphicalNote，有 `getSVGId`；其 `vfnote[0].attrs.id` = `autoNNNN` |
| **源 ID** | ❌ | 见 §3 |

---

## 5. 结果 C：三种候选键的碰撞与映射质量

定义（`m = measureIndex, s = staffIndex, v = voiceId, o = 小节内 onset 四分拍, p = MIDI`）：

- **K_adapter** = `m:s:v:p` —— 仓库当前 `score-view-adapter.ts:100` 使用的键
- **K_onset** = `m:s:v:o:p` —— 加精确 onset
- **K_ordinal** = `m:s:v:文档序号` —— 完全不用音高/时间，仅顺序

统计口径：只统计**有音高的 Note**（休止单独处理）；"碰撞桶"= 桶内 >1 个 Note；"映射"= 用手推期望序列逐条取桶内未消费项。

| Case | pitched | K_adapter 桶/碰撞 | K_onset 桶/碰撞 | K_ordinal 桶/碰撞 | K_adapter 映射 | K_onset 映射 |
|---|---|---|---|---|---|---|
| g1-no-ids | 5 | 5 / 0 | 5 / 0 | 5 / 0 | 5/5 | 5/5 |
| g1-ids | 5 | 5 / 0 | 5 / 0 | 5 / 0 | 5/5 | 5/5 |
| **g2-no-ids** | 4 | **3 / 1（maxBucket 2）** | 4 / 0 | 4 / 0 | 4/4（**orderAssumed [0,3]**） | 4/4 |
| **g2-ids** | 4 | **3 / 1（maxBucket 2）** | 4 / 0 | 4 / 0 | 4/4（**orderAssumed [0,3]**） | 4/4 |
| g3-no-ids | 2 | 2 / 0 | 2 / 0 | 2 / 0 | 2/2 | 2/2 |
| g3-ids | 2 | 2 / 0 | 2 / 0 | 2 / 0 | 2/2 | 2/2 |
| g4-triplet | 4 | 4 / 0 | 4 / 0 | 4 / 0 | 4/4 | 4/4 |
| g6-unison | 2 | 2 / 0（staff 区分） | 2 / 0 | 2 / 0 | 2/2 | 2/2 |
| g7-hidden-grace | 5 | 5 / 0 | 5 / 0 | 5 / 0 | 5/5 | 5/5 |
| **g8-key-alter** | 3 | **2 / 1（maxBucket 2）** | 3 / 0 | 3 / 0 | 3/3（**orderAssumed [0,2]**） | 3/3 |

### 5.1 最重要的两行

**g2（C4 在 0 拍与 1 拍各一次）**
- `K_adapter` 把两个 C4 放进**同一个桶**（`0:0:1:60`），碰撞数 1。
- adapter 用 `bucket.shift()` 按 OSMD 遍历顺序消费 → 第一个期望 C4 拿到遍历中的第一个，第二个拿到下一个。
- **这在本 fixture 里"碰巧"是对的**（OSMD 遍历顺序 = XML 顺序），但这是**顺序假设**，不是身份。只要 OSMD 的遍历顺序与域模型顺序不同（多 voice、跨 staff 交错、chord 内部重排），高亮就会落到**另一个音的图形上**，而且 `unmapped=0`、`duplicates=0`。

**g8（F4 在 0 拍与 2 拍各一次）** 是同类问题：重复音在小节内出现两次是**常见记谱**，不是极端边界。

### 5.2 为什么当前 adapter 的自检抓不到

`score-view-adapter.ts` 的 `mappingSummary` 通过条件是：
```ts
mappedEventCount === noteEventCount && duplicates === 0
```
`duplicates` 由 `usedGraphical.has(graphical)` 计算。由于映射用 `bucket.shift()` **取走**了源 Note，且一个源 Note 只对应一个 GraphicalNote，**重复几乎不可能发生**。于是：
> g2 / g8 的 `shippedCheckPasses = true`，同时 `identityUnambiguous = false`。

这正是 v1.1 §2.3/§2.5 要求"断言数量、冲突、遗漏"的原因：**只断言 mapped/duplicates 不够**。

### 5.3 K_onset 的残余风险（必须 fail-closed 的部分）

`K_onset = m:s:v:o:p` 在本次 10 个 case 中零碰撞，但它在下列情况仍会碰撞（本次未构造 fixture，属**理论边界**，必须由 contract test 覆盖）：

1. 同一 staff+voice 内**真正同 onset 同音高**的两个 Note（unison 双声部写在同一 voice、或 grace 与其主音同音高且同 onset——G7 已证明 grace 的 Timestamp 等于主音）。
2. OSMD 对某些记号（tremolo、arpeggio、反复音）复用同一个 `VoiceEntry`。
3. `.mxl`/压缩谱、part-wise 结构之外的结构。

因此 `K_onset` 只能作为 **fallback anchor**，且：
- 必须检测桶大小 > 1 并输出 `CONFLICT`；
- 冲突时该 note 的 `anchorStatus` 必须是 `PARTIAL`/`UNAVAILABLE`，不得高亮；
- 不得把 `m+s+v+o+p` 声明为"唯一 ID"（v1.1 §2.1 明确禁止）。

---

## 6. 结果 D：glyph 粒度（和弦与高亮）

### 6.1 一个和弦 = 一个 VexFlow StaveNote

G2 的三音和弦：
- DOM：`.vf-stavenote` 计数 = **3**（对应 3 个"time slot"：和弦、重复 C4、休止），但 `.vf-notehead` = **5**。
- 三个和弦音的 `GraphicalNote.vfnote[0].attrs.id` **完全相同**（`auto1201`）；重复 C4 是 `auto1209`，休止是 `auto1213`。
- 即：**一个源 `<note>` 对应多个 glyph（notehead/stem/ledger/tie）**，而**一个 chord 的多个源 Note 共享同一 SVG 元素 id**。

### 6.2 高亮粒度：染一个音 = 染整个和弦（实测）

对 G2 的第一个和弦音（C4，onset 0）调用：
```js
osmd.rules.GNote(note).setColor('#ff0000', { applyToNoteheads:true, applyToStem:true, applyToBeams:true, applyToTies:true, applyToLedgerLines:true });
```
结果（DOM 统计 `.vf-notehead path` 的 `fill`）：

| 指标 | 值 |
|---|---|
| `.vf-notehead path` 总数 | 5 |
| `fill="#ff0000"` 的 notehead | **3**（= 整个和弦） |
| `stroke="#ff0000"` 的符干 | **1**（共用符干） |
| 仍为 `#000000` 的 | 2（重复 C4、休止） |

`setColor` 本身不抛错、返回 void。**这意味着当前"逐音高亮"在产品语义上实际是"逐和弦高亮"**，而代码与 UI 文案都没有说明这一点。

### 6.3 对 anchor 契约的要求

- `sourceNoteId -> glyph set` 必须是 **1 : N**，且 N 个 Note 可能共享同一 SVG id。
- `anchorId` 若要用于高亮，必须定义**高亮单位**：note / chord / voice-entry。
- 若产品要求"只亮和弦里的某个音"，OSMD 2.2.1 的公开 API 做不到（需要 patch VexFlow 层或改用自定义 overlay）。这是**能力边界**，不是实现细节。

---

## 7. 结果 E：其他实测到的行为

1. **休止符 `halfTone = 12`**：G1/G2/G4 的 rest Note 均为 `{isRest:true, halfTone:12}`。任何以"有 halfTone"判断音高的代码都会错。
2. **`Pitch.ToStringShort()` 在 rest 上抛异常**（`Cannot read properties of undefined (reading 'accidental')`）——必须先判 `isRest`/`pitch` 存在。
3. **grace 的 Timestamp = 后一个主音的 onset**（G7：两者都是 2 拍）。`getAbsoluteTimestamp()` 同样相同。因此"grace 在拍点上"这一语义在 OSMD 里**不能靠时间区分**，只能靠 `IsGraceNote`。
4. **隐藏音仍在对象模型里**（`printObject=false`），也能拿到 GraphicalNote 与 SVG id（`auto1451`）。DOM 层面的可见性本次未断言。
5. **调号不改变 `halfTone`**：G8 无 `<alter>` 的 F4 → 65（自然），与 importer 完全一致（见审计报告 F11）。
6. **DOM id 前缀**：`osmdCanvasPage1`、`osmdSvgPage1` 是页面级；`Piano0-1`/`Piano0-2` 是 staff 级；小节号 `"1"`/`"2"` 也作为元素 id 出现（**与业务 id 空间重叠，风险**）；其余为 VexFlow 自增。
7. **VexFlow id 每次渲染递增**：同一个 fixture 重新 render，`vf-autoNNNN` 会变（本次多次重载中编号从 1006 递增到 1527）。**不能跨渲染持久化**。

---

## 8. 可行的 anchor 方案（按 v1.1 §2.4 的优先级）

### 方案 1（首选）：在 OSMD 读谱路径上携带 `sourceNoteId`（最小 patch / 轻量 fork）

**实测依据**：`Note` 没有 XML 节点引用；`Note` 的构造点是 `new Note(voiceEntry, parentStaffEntry, length, pitch, sourceMeasure, isRest)`（`node_modules/opensheetmusicdisplay/build/dist/src/MusicalScore/VoiceData/Note.d.ts:21`）。
读取链路是 `MusicSheetReader` → `InstrumentReader.readNextXmlMeasure(...)`（`InstrumentReader.d.ts:58`，持有 `xmlMeasureList: IXmlElement[]`）→ `VoiceGenerator`（`VoiceGenerator.d.ts`，从 `<note>` 构造 Note 并写入 VoiceEntry）。

**patch 形状（约 20–40 行）**：
1. 在 `VoiceGenerator` 读到单个 `<note>` 的 `IXmlElement` 时，把 `xmlNode.attribute('id')`（或规范化后的 `sourceNoteId`）写到新建 Note 的一个新字段 `SourceNoteId`。
2. 同时记录 `SourceOrdinal`（该 measure 内 `<note>` 的文档序号），用于 ID 缺失时生成确定性 ID。
3. 在 `MusicSheetReader` 暴露 `mappingVersion = 'osmd-note-id-1'`。

**优点**：真正的源身份；tie/chord/grace 都不需要猜；渲染后无需几何/顺序推断。
**缺点**：需要 fork 或 patch-package；升级 OSMD 必须重跑 contract test；`ReaderPluginManager`（`ReaderPluginManager.d.ts`）的 `IVoiceMeasureReadPlugin` 只给 `VoiceEntry[]`，**拿不到 XML 节点**，所以插件机制**不足以**实现该方案（这点很重要，避免误以为可以"零 patch 插件化"）。

**实测支持**：本次验证了 `<note>` 的 `id` 属性在 XML 中确实被解析（importer 能读到 `n1..n5`），只是 OSMD 丢弃；patch 点在读 XML 的那一层是唯一能拿到它的地方。

### 方案 2（次选，零 patch）：结构身份 + 碰撞检测 + fail-closed

用 `K_onset`（`measureIndex + staffIndex + voiceId + onsetQuarter + midi`）作为 `anchorKey`，并额外用 `K_ordinal` 或 XML 文档顺序做**桶内消歧**，但必须：
- 输出 `mappingVersion`、`sourceFingerprint`、`osmdVersion`、`unmapped[]`、`conflicts[]`；
- **桶大小 > 1 一律记 CONFLICT**，不静默 shift；
- 冲突音符 `anchorStatus = PARTIAL`，UI 只做小节/系统级反馈；
- 升级 OSMD 必须重跑同一套 anchor fixtures。

**优点**：今天就能做，不需要 fork。
**缺点**：不是源身份；重复同音、unison、grace 同音、tremolo 等场景需要显式降级；`onset` 依赖 `Timestamp` 的语义（本次已实测为精确小节相对全音符，但属 OSMD 内部约定，跨版本需再验）。

### 方案 3（不推荐）：渲染后按 SVG 顺序/几何位置映射

v1.1 §2.4 已排除：单个 DOM 顺序、几何位置、复合指纹都不合格。本次数据也证明 SVG id 是 VexFlow 自增（跨渲染变化）且和弦共享，无法承担身份。

### 8.1 建议的落地顺序

1. R2 之前：实施方案 2，并把 `mappingSummary` 的通过条件改为 `mapped === total && conflicts === 0 && unmapped === 0`（当前会误报 PASS）。
2. R2/R3 期间：评估方案 1 的 patch 成本（需锁 OSMD 版本 + CI 里跑 anchor contract test）。
3. 任何情况下都**不要**在 R1 之后继续用 `m+s+v+p`（现有实现）。

---

## 9. 失败边界（必须写进契约）

| 场景 | 现状 | 要求 |
|---|---|---|
| 同小节重复同音 | `K_adapter` 碰撞，静默按顺序配对，仍报 PASS | 必须 CONFLICT 或改用 K_onset |
| 同 onset 同音高（真 unison / grace+主音） | `K_onset` 也会碰撞 | fail-closed，`anchorStatus=PARTIAL` |
| 和弦 | 1 个 StaveNote / N 个 Note / 1 个 SVG id；高亮影响整组 | 定义高亮单位；`anchorId -> glyph set` 允许 1:N |
| 休止符 | 有 `halfTone=12` | 只用 `isRest()` 判休止 |
| tie continuation | 可识别（`NoteTie.StartNote !== note`） | anchor 与 sounding occurrence 的关系需显式建表 |
| grace | `Timestamp` = 主音 onset | 必须靠 `IsGraceNote`，不能靠时间 |
| 隐藏音 | `printObject=false`，对象仍存在 | 若产品要"跳过隐藏音"，需在 manifest 里标记 |
| 多 part | 本次未测（fixture 均为单 part） | **未验证**；OSMD 的 staff 索引需跨 part 累加，与现有 adapter 的 `partStaffOffset` 假设一致但未实测 |
| `.mxl` | 未测 | 当前 importer 明确拒绝 |
| 跨版本升级 | VexFlow id 每次渲染变化；`Timestamp` 语义未公开承诺 | 锁版本 + contract test |

---

## 10. 未验证事项（诚实清单）

1. **多 part / 多谱表（>2）** 的 staff 索引映射：本次 G6 只覆盖单 part 双谱表。
2. **隐藏音在 DOM 上是否真的不可见**：只验证了 `printObject=false` 存在于对象模型。
3. **`Timestamp` 单位在 OSMD 文档中的官方约定**：本次是从 10 个 fixture 反推（×4 = 四分拍，数值为精确 Fraction）。升级版本必须重测。
4. **不同浏览器**：只在 ZCode 内嵌 Chromium（Electron 41 / Chrome 146）验证；用户生产环境（Chrome/Edge 独立安装）未跑。OSMD 是纯 JS，预期一致，但**未验证**。
5. **方案 1 的 patch 未实际实施**：只定位到真实文件/类/构造点，未写一行 patch 代码。
6. **高亮之外的交互**（滚动到音符、光标跟随）未测。
7. **性能**：113 小节真实谱的映射耗时未测（本次 fixture 均 ≤6 个音）。

---

## 11. 复现方法

```bash
# 1. 启动独立静态服务（提供 harness + frontend node_modules 内的 OSMD 2.2.1）
cd D:/123/audit-r1 && node spike/serve.mjs      # http://127.0.0.1:8799/

# 2. 打开页面（浏览器或自动化），等待 body[data-spike="complete"]
#    页面会把结果 POST 到 /result，落盘为 spike/out/osmd-anchor-spike.json

# 3. 重新生成 TS 流水线对照数据
cd D:/123/rhythm-trainer-frontend
./node_modules/.bin/esbuild D:/123/audit-r1/spike/importer-dump.mjs \
  --bundle --platform=node --format=esm \
  --outfile=D:/123/audit-r1/spike/out/importer-dump.bundle.mjs
node D:/123/audit-r1/spike/out/importer-dump.bundle.mjs > D:/123/audit-r1/spike/out/importer-dump.json
```

本次使用的浏览器 UA 与关键版本：
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
ZCode/3.16.3 Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36
OSMD 2.2.1（package.json 精确锁定；页面从 node_modules 直接加载 UMD build）
```

---

## 12. 附录：逐 case 的 DOM 与样本（节选）

### g2-ids（和弦 + 重复音）

```
samples (m, staff, tsQ, midi, rest, vfSvgId)
(0, 0, 0, 60, false, auto1201)   ← C4 和弦音 1
(0, 0, 0, 64, false, auto1201)   ← E4 和弦音 2（同一 SVG id）
(0, 0, 0, 67, false, auto1201)   ← G4 和弦音 3（同一 SVG id）
(0, 0, 1, 60, false, auto1209)   ← 重复 C4
(0, 0, 2, 12, true,  auto1213)   ← 休止（halfTone=12）
```

### g3-ids（跨小节 tie）

```
(0, 0, 0, 60, false, auto1293)  NoteTie=true, StartNote===note   → tie start
(1, 0, 0, 60, false, auto1298)  NoteTie=true, StartNote!==note   → continuation
DOM: vf-auto1293-tie 存在（tie 图元挂在起点音上）
```

### g7（隐藏音 + grace）

```
(0,0,1,62,false,auto1451) printObject=false   ← 隐藏音，对象仍存在
(0,0,2,64,false,auto1460) IsGraceNote=true    ← grace，Timestamp 与其后主音相同
(0,0,2,65,false,auto1455)                     ← 主音 F4
```

`elementIdSample` 中 `"1"`、`"2"` 是小节号元素 id —— 与未来的业务 ID 空间重叠，**契约里必须规定 anchor 不得使用裸小节号作为 id**。
