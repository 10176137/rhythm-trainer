# R1 收尾实施报告（v1.0）

**日期：** 2026-10-23
**范围：** 仅 R1 收尾（golden 测试、重复 XML ID、OSMD 锚点、hand/multipart 契约）。**未开始 R2。**
**基线：** `main` @ `2a2d014`（审计基线 `7c565a2` 的 amend 前对象仍在本地）
**执行前工作树：** clean，无用户未提交修改

---

## 0. 结论摘要

1. **G1–G5 已落成自动化测试**：5 个手推 `expected` 文件 + 51 条断言（含 plan/occurrence/group/atom/ID/legacy 差分）。真值来自 `audit-r1/docs/GOLDEN_FIXTURES.md` 的手工推导，**不是**从实现 dump 的。
2. **重复 `note@id` 已 fail-closed**：新增稳定机器码 `duplicate_xml_id`，`blocksStrict=true`，导入状态降为 `DISPLAY_ONLY`；缺 ID 的谱面完全不受影响；真实 113 小节谱（0 个 note@id）行为不变。
3. **OSMD 锚点已从"复合键 + shift"改为"结构键 + 冲突 fail-closed"**：在真实 OSMD 2.2.1 上，g2（重复同音）与 g8 从"碰撞但仍 PASS"变为 `COMPLETE`（4/4、3/3，0 冲突）；g9（grace 与主音同音同 onset）产生 2 个冲突、`UNAVAILABLE`、高亮被拒绝。
4. **hand/multipart 只提交契约，不落实现**：`HAND_AND_MULTIPART_CONTRACT.md` 明确了"手别不得从谱号推断用于 strict""多 part 必须显式选 part"的规则与 D1–D5 验收样例；实现列为 R1 下一子任务（原因见 §4.3）。
5. **测试全绿**：前端 33 文件 / **237** 项（+62）、selftest **155** 条、Rust **110** 项（GNU target）、`tsc -b && vite build` 通过。
6. **R2 未开始**：未新增 Rust planner、未改 importer 语义（只加了 ID 校验）、未改 `scoring_v1`、未做实时 matcher、未改 UI 布局。

---

## 1. 改动摘要与文件清单

### 1.1 生产代码（4 个文件）

| 文件 | 改动 | 原因 |
|---|---|---|
| `frontend/src/score-engine/domain/types.ts` | `ImportIssueCode` 增加 `duplicate_xml_id` | B：稳定机器码 |
| `frontend/src/score-engine/import/musicxml-importer.ts` | ① `note@id` 读取时 trim；② 文档级重复 ID 扫描并 `blocksStrict` | B：fail-closed |
| `frontend/src/score-engine/view/score-view-adapter.ts` | 重写映射：结构键（measure+staff+voice+精确 onset+MIDI）、rest 过滤、`conflicts`/`anchorStatus`/`mappingVersion`、冲突不入 `byEventId`、`mappingSummary.ok` 要求 0 冲突、chord 高亮精度标注 | C：消除静默错映射 |
| `frontend/src/components/OsmdScoreView.tsx` | 新增 3 个只读 dataset 诊断属性（`osmdConflicts`/`osmdAnchorStatus`/`osmdMappingVersion`） | C：让降级状态可观测；不改布局 |

### 1.2 测试（3 新 + 1 改）

| 文件 | 内容 |
|---|---|
| `frontend/src/score-engine/test/golden.fixtures.test.ts` | **新**；51 条：G1–G5 逐字段真值、G2 和弦/重复音、G3 tie、G4 tick fail-closed、G5 3/4 与差异分类、legacy 差分 |
| `frontend/src/score-engine/test/xml-id.test.ts` | **新**；4 条：无 ID / 唯一 ID / 重复 ID fail-closed / 空白 ID 视为缺失 |
| `frontend/src/score-engine/test/anchor-mapping.test.ts` | **新**；7 条：重复音不同 onset、chord 精度、grace 同音冲突、rest 不入桶、tie、缺音降级、无 onset 不猜 |
| `frontend/src/score-engine/test/view-mapping.test.ts` | 改：fake OSMD 增加 `VoiceEntry.Timestamp`；断言 `conflicts/anchorStatus/ok/mappingVersion` 与新返回值 |

### 1.3 测试夹具与证据（新增）

```
audit-r1/fixtures/golden/g1..g5.expected.json     ← 手推真值 + derivation
audit-r1/fixtures/golden/legacy-reference.json    ← 生成物，含 generatedBy/gitSha/generatedAtIso
audit-r1/fixtures/negative/duplicate-note-id.musicxml
audit-r1/fixtures/negative/septuplet-1-7.musicxml
audit-r1/fixtures/g9_grace_same_pitch.musicxml
audit-r1/spike/generate-legacy-reference.mjs
audit-r1/spike/out/anchor-contract.json           ← 真实 OSMD 2.2.1 的 8 个 case 结果
frontend/osmd-anchor-contract.html
frontend/src/score-engine/dev/osmdAnchorContract.ts
```

### 1.4 文档

- **新** `audit-r1/docs/HAND_AND_MULTIPART_CONTRACT.md`
- **改** `audit-r1/docs/GOLDEN_FIXTURES.md`（G5 双重舍入勘误，见 §9）
- **改** `audit-r1/spike/serve.mjs`（CORS + 文件名参数，供 anchor contract 上报）

**没有**修改：`scoring_v1`、`server/engine-server.mjs`、`scorePerformance` NAPI、任何 UI 布局、任何历史报告。

---

## 2. G1–G5 真值校验结果

真值文件：`audit-r1/fixtures/golden/gN.expected.json`（每个都含 `derivation` 说明）。
真值规则：rational 用 `{n}/{d}`；时间真值用**整数 µs**；tick 用整数且必须整除 960。

| Case | fixture | import | measures | events | plan | scoreEvents | atoms | legacy 差分 |
|---|---|---|---|---|---|---|---|---|
| G1 | g1_single_voice | READY / strict ✅ | 0/1+4/1, 4/1+4/1 | 5 note + 1 rest | occ 5 / grp 5 | 3000000,3750000,4500000,5250000,6000000 µs | 0,960,1920,2880,3840 | 0 |
| G2 | g2_chord | READY / strict ✅ | 0/1+4/1 | 4 note（3 chord）+ 1 rest | **occ 4 / grp 2 / atoms 2 / scoreEvents 4** | 2400000×3 + 3000000 µs | 0, 960 | 0 |
| G3 | g3_tie | READY / strict ✅ | 0/1+2/1, 2/1+2/1 | 2 note（tie start/stop） | **occ 1 / grp 1** | 2000000 µs，duration 2000000 µs | 0 / 3840 | 0 |
| G4 | g4_triplet | READY / strict ✅ | 0/1+4/1 | 3×1/3 + 1 + rest | occ 4 / grp 4 | 4000000,4333333,4666667,5000000 µs | 0,320,640,960 | 0 |
| G5 | g5_three_four | READY / strict ✅ | **0/1+3/1, 3/1+3/1** | 6 note | occ 6 / grp 6 | 2666667,3333333,4000000,4666667,5333333,6000000 µs | bar 1×3 → 2×3 | 0 |

### 2.1 关键断言（全部通过）

- **G2**：`occurrences=4`、`groups=2`、`atoms=2`、`scoreEvents=4` 分别断言；两个 C4 的 `event.id` 与 `occurrenceId` 均不同；三个和弦音 `playbackBeat` 都是 `0/1`；`group[0].scoreEventIds` 长度为 3。
- **G3**：`occurrences=1`、`durationBeat=4/1`、`isTieOnset=true`、`atoms[0].durationTicks=3840`；m2 的 tie stop 事件存在但不产生起音。
- **G4**：`1/3` 与 `2/3` 为精确有理数；`atoms` 为 320/320/320/960 整数；另用 `septuplet-1-7.musicxml` 断言 1/7 拍**不可**在 960 网格表示：`atoms` 只剩可表示的 1 个，产生 **7 条** `tick_grid_rounding` 且全部 `blocksStrict`。
- **G5**：`measures[1].startBeat=3/1`、两小节 `durationBeat=3/1`；atoms 的 bar 分界在 `1:0,1:960,1:1920,2:2880,2:3840,2:4800`。
- **ID 语义**：`event.id = ${fp16}:${partId}:m${measure}:e${sourceOrdinal}`；`planId = plan:${fp16}:m1-${N}:once:playback-planner-1.0.0`；`occurrenceId = ${planId}:p${pass}:${scoreEventId}`；全部唯一。
- **legacyReference**：`generatedBy`/`generatorVersion`/`gitSha`/`generatedAtIso` 齐备；只作为差分对象，测试对比的是"legacy vs 手推真值"，不参与断言真值。
- **没有使用 `toBeCloseTo`** 判定任何 golden 时间真值（只对 `Math.round(ms*1000)` 的整数 µs 做 `toBe`）。

---

## 3. Anchor 冲突处理前后对比

### 3.1 修复前（R1 审计 spike，旧 adapter）

| Case | OSMD 音符 | 旧键 `m:s:v:pitch` | 映射结果 | 自检 |
|---|---|---|---|---|
| g2 重复同音 | 5（含 rest） | 3 个键，**1 个碰撞桶（2 个音）** | 4/4（依赖 shift 顺序，`orderAssumed=[0,3]`） | **PASS**（`duplicates=0`） |
| g8 重复 F4 | 4（含 rest） | 2 个键，**1 个碰撞桶** | 3/3（顺序假设） | **PASS** |
| rest | halfTone=12 | 旧实现按"有音高"处理 | 可能产生幽灵桶 | 未检查 |

### 3.2 修复后（真实 OSMD 2.2.1，`anchor-contract.json`）

| Case | OSMD 音符 | note events | mapped | conflicts | anchorStatus | ok | chord 精度 |
|---|---|---|---|---|---|---|---|
| g1 single | 6 | 5 | **5** | 0 | COMPLETE | true | 0 |
| g2 chord+repeat | 5 | 4 | **4** | **0** | COMPLETE | true | **3** |
| g3 tie | 2 | 2 | 2 | 0 | COMPLETE | true | 0 |
| g4 triplet | 5 | 4 | 4 | 0 | COMPLETE | true | 0 |
| g6 unison 双谱表 | 2 | 2 | 2 | 0 | COMPLETE | true | 0 |
| g7 hidden+grace | 5 | 5 | 5 | 0 | COMPLETE | true | 0 |
| g8 key/alter | 4 | 3 | **3** | **0** | COMPLETE | true | 0 |
| **g9 grace 同音同 onset** | 2 | 2 | **0** | **2** | **UNAVAILABLE** | **false** | 0 |

- **8/8** case 的 `anchorStatus` 与预期一致；冲突 case 的 `highlightScoreEvent` 返回 `false`，没有任何颜色写入。
- `mappingSummary.ok` 现在要求 `mapped===total && unmapped===0 && conflicts===0 && duplicates===0`，**只检查 mapped/duplicates 已不再是合格条件**。
- rest：真实 OSMD 的 rest `halfTone=12`，新实现用 `isRest()` 过滤；g1 的 5/5 映射不产生"未使用锚点"告警。

### 3.3 契约语义

- 键 = `measureIndex:staffIndex:voiceId:<measure-relative rational beat>:midi`，其中 onset 由 OSMD `VoiceEntry.Timestamp`（whole-note Fraction）**精确换算**，不是浮点。
- 该键是**推导锚点**，不是源 ID；`mappingVersion = 'osmd-structural-2'`。
- 冲突原因：`duplicate-osmd-note` / `duplicate-score-event` / `missing-onset` / `missing-pitch`。
- **不使用** DOM 顺序、VexFlow 自增 SVG id、几何位置作为 fallback。
- chord：`highlightPrecision='chord'`（一个 StaveNote 多个 notehead，OSMD 会整组着色），不承诺单音像素级精确；g2 的 3 个和弦音均标记为 `chord`。

---

## 4. 规则

### 4.1 重复 / 非法 XML `note@id`

| 输入 | 行为 |
|---|---|
| 无 `note@id` | 正常导入（READY），`source.xmlId` 为 `undefined` |
| 唯一 ID | 正常导入，ID 原样保留在 `source.xmlId` |
| 空白/仅空格 ID | 视为缺失（trim 后为空），不报错 |
| 重复非空 ID | `ImportIssue{code:'duplicate_xml_id', severity:'warning', blocksStrict:true}`；状态 `DISPLAY_ONLY`；`strictAllowed=false`；issue 携带 `xmlId`、`measureOrdinal`、`eventId`，message 含首次/再次出现位置 |
| 重复 ID 跨 part | 同样检测（文档级扫描） |

未做（明确边界）：不校验 `xs:ID` 的 NCName 语法；只处理"重复"与"空值"。

### 4.2 hand / multipart

- 契约文件：`audit-r1/docs/HAND_AND_MULTIPART_CONTRACT.md`。
- 规则：手别只能来自用户显式映射 / 乐谱元数据；`clef-heuristic` 不得用于 strict；strict 要求范围内每个目标都能映射；多 part 必须显式选 part；禁止 `hand='right'`、`range=parts[0]` 等静默默认。
- 验收样例 D1–D5：双高音谱表、标准双谱号钢琴、多 part、单手谱面、过滤后为空。

### 4.3 为什么本次没有落实现

1. 手别来源需要 UI 控件（谱表→手别映射），任务明确"不改 UI 布局"；
2. 若直接把 `clef-heuristic` 判为拒绝，会让**现有所有 strict 练习无法启动**（当前没有任何显式映射入口），属于破坏性变更；
3. 多 part 拒绝需要 `App.launchPractice` 与 `engine-server.start` 同步接线并配文案，属于下一子任务。

**结论**：本次只交契约与测试计划，列为 **R1 下一子任务（R2 前置）**，不在报告里假装已实现。

---

## 5. 测试命令与真实结果

| 命令 | 结果 | 证据 |
|---|---|---|
| `cd rhythm-trainer-frontend && npm test` | **PASS** — 33 files / **237 tests**（+3 文件 / +62 测试） | 本次实跑 |
| `cd rhythm-trainer-frontend && npm run build`（`tsc -b && vite build`） | **PASS** — 4.50s；`index-*.js` 517.16 kB（>500 kB 警告为既有） | 本次实跑 |
| `cd rhythm-trainer-frontend && npm run selftest` | **PASS** — "全部自测通过"，**155** 条 `ok` | 本次实跑 |
| `cd rhythm-trainer-core-v0.2 && cargo test --target x86_64-pc-windows-gnu`（`CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=$HOME/dev-tools/w64devkit/bin/gcc.exe`） | **PASS** — **110**（82 unit + 1 benchmark + 1 e2e + 5 property + 21 scoring） | 本次实跑 |
| OSMD anchor contract（Vite 5173 + audit 8799，真实 Chromium） | **PASS** — 8/8 case 状态符合预期，结果落盘 `audit-r1/spike/out/anchor-contract.json` | 本次实跑 |

**环境注意：**

- 默认 `cargo test`（MSVC）在本机仍失败（无 MSVC/SDK），这是环境限制，不是代码失败；必须用上面的 GNU target 命令。
- selftest 与审计静态服务都使用 8799 端口；本轮先停止临时服务再跑 selftest，否则会 `EADDRINUSE`（已记录，供复现时参考）。
- 复现 anchor contract：`npm run dev` + `node audit-r1/spike/serve.mjs`，打开 `http://127.0.0.1:5173/osmd-anchor-contract.html`。

---

## 6. 仍未验证事项

1. **多 part 的 anchor 映射**：本次全部 fixture 为单 part；多 part 仍按"全局 staff 索引"假设，未通过 contract 验证（适配器会给出警告）。
2. **其他浏览器**：anchor contract 只在 ZCode 内嵌 Chromium（Electron 41 / Chrome 146）跑过；用户独立安装的 Chrome/Edge 未验证。
3. **真实 OSMD 的 unmapped 路径**：缺少"OSMD 少渲染一个音"的真实 fixture；该路径只有 fake renderer 单测覆盖。
4. **暂停期间 Node MIDI 输入**：clock 契约里的不一致仍未修（本任务范围外）。
5. **真机**：本轮没有任何 SP-A500 演奏（见 §7）。
6. **手别/多 part 规则**：仅有契约，未实现、未接线、未测。
7. **`xs:ID` 语法**：未校验（只校验重复/空值）。

---

## 7. G0 真机收尾清单（本任务不能代替）

依据 `G0_HARDWARE_CLOSEOUT_CHECKLIST_v1.0.md`，本轮**全部 NOT RUN**：

| 项 | 状态 | 原因 |
|---|---|---|
| G0-A 受控单一错音 Take | **NOT RUN** | 需要实体 SP-A500 与人工演奏；本会话无设备访问 |
| G0-B 成功的 P09 前后比较 | **NOT RUN** | 同上；需要一次达到 `AVAILABLE` 的真实复练 |
| G0-C 暂停期间输入边界（Node MIDI） | **NOT RUN** | 需要真机暂停中按键 |
| G0-D 断连/重连与旧 generation 边界 | **NOT RUN** | 需要可控的物理断连 |
| 保存 sessionId/takeId/traceId/journal | **NOT RUN** | 无新 Take |

**自动化测试通过（237/155/110）不能替代以上任何一项。** G0 仍是 PARTIAL。

---

## 8. R2 状态与进入前的剩余门槛

**R2 尚未开始。** 本轮没有：迁移 Rust planner、替换 TS importer、修改 `scoring_v1`、实现实时 matcher、改动参考播放或 UI 布局。

进入 R2 前仍需：

1. **G0 完成**：G0-A（受控错音）、G0-B（成功 P09 比较）、G0-C/D（暂停与断连边界）有真实证据；
2. **hand/multipart 落地**：`assessPracticeScope` + UI 映射 + 启动校验 + D1–D5 测试（本次只交契约）；
3. **`ScoreDocumentV1` 冻结**：语言无关 schema、rational `{n,d}`、版本化 source identity；
4. **`planFingerprint` 定义**：规范化内容 + plannerVersion + range/hand/BPM + 时间规则；
5. **目标校验加固**：服务端校验 ID 唯一性、pitch/数量/measure 覆盖、planFingerprint 与 config 绑定（当前只校验 onset ±0.5 ms）。

以上 1–2 属 R1 剩余，3–5 属 R2 设计冻结。

---

## 9. 文档失效点（本次发现并处理）

| 文档/结论 | 状态 | 处理 |
|---|---|---|
| `GOLDEN_FIXTURES.md` §6.2/§6.5：G5 存在 2 × 1 µs 差异 | **错误**（文档自身双重舍入） | 已勘误：按 §1.2 单次舍入，G5 六项与实现完全一致；`expected` 用 `3333333/5333333` |
| 审计 F12："`source.xmlId` 重复未校验" | **已修复** | 本次新增 `duplicate_xml_id` |
| 审计 F13："adapter 用 `m:s:v:pitch`，G2/G8 静默错映射" | **已修复** | 新键含精确 onset；真实 OSMD 8/8 通过 |
| 审计 §8："`view-mapping.test.ts` 只有 1 个测试且不验证正确性" | **已扩展** | 新增 `anchor-mapping.test.ts`（7 条）+ 真实 contract harness |
| 审计 §3.3 `OsmdScoreViewAdapter` 的旧行为描述 | **已过时** | 以本次源码为准；`mappingVersion='osmd-structural-2'` |
| README 的审计索引 | 未变 | 可后续追加本报告链接 |

---

## 10. 提交

- 分支：`main`
- 提交信息：`fix(r1): close out golden fixtures, xml id, and anchor mapping`（含本文档与全部测试）
- 未推送前请以本地 `git log` 为准；推送后远端 `main` 应包含 `audit-r1/fixtures/golden/` 与 `R1_CLOSEOUT_IMPLEMENTATION_REPORT.md`。
