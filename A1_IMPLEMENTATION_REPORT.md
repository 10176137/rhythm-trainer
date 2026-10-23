# A1 曲谱管理、MusicXML 导入与乐谱阅读 — 实施报告

- 日期：2026-10-22
- 范围：A1 only；未开始 A2、B1、B2、C。
- 结论：曲谱库独立页面、`.musicxml` 导入预览/保存、解析状态持久化、OSMD 阅读页、缩放/适应宽度、从阅读页进入现有练习设置均已实现并通过浏览器验证。原有曲谱与练习历史保留，未改 Rust Core、评分、NAPI、Session/Take 或 TargetSchedule。

---

## 1. 实施前审计与差异

| 项 | 审计结果 | A1 处理 |
|---|---|---|
| 曲谱库 | `server/score-library.mjs` 有 CRUD；设置弹窗内使用；meta 只有 name/fileName/size/时间 | 新增独立 `/scores` 页面；meta 增加受限的 ImportReport 摘要；保留原设置入口 |
| 状态字段 | 旧 meta 没有 `importStatus`/`parserVersion` | 新记录写入；旧记录标为 `UNVERIFIED`，打开时重新校验并回填 |
| 导入器状态 | `ImportReport.status` 为 `READY / READY_WITH_WARNINGS / DISPLAY_ONLY / REJECTED` | 映射为 UI 的 READY / WARNINGS / RESTRICTED / FAILED，不另建解析状态机 |
| `.mxl` | 当前导入器只接受文本 MusicXML，没有容器解压 | A1 页面明确拒绝 `.mxl`；保留 C3 |
| OSMD | 练习工作台固定 1510px、`Zoom=1.0`，由 `OsmdScoreView` 渲染 | 新增 display-only `ScoreReader`：100% 适应宽度 + 阅读缩放；练习工作台保持原布局 |
| 练习接线 | `App.tsx` 已有 `applyScoreDocument`、`activeLibraryId`、Session/Reference Playback | 阅读页复用 `applyScoreDocument`，不新建 Session/Take；开始练习只跳回工作台并打开设置 |
| 路由 | A0 已建立 `/workbench`、`/history`、`/profile`；`/scores`、`/reader` 为占位 | A1 启用 `/scores` 与 `/reader`；导入流程放在 `/scores`，`/import` 仍保留占位 |
| 数据 | 现有两份曲谱，无状态摘要 | 保留；打开时按真实 ImportReport 回填 |

---

## 2. 修改文件

### 新增

| 文件 | 作用 |
|---|---|
| `src/features/score/scoreImport.ts` | 一次解析结果：`doc + ImportReport + xml + fileName`；语义导入仍由现有 importer 负责。 |
| `src/features/score/scoreStatus.ts` | ImportReport → 可持久化摘要（最多 20 条 issue）；READY/WARNINGS/RESTRICTED/FAILED + UNVERIFIED/STALE/MISSING；练习可用性判断。 |
| `src/features/score/scoreStatus.test.ts` | READY/RESTRICTED/REJECTED 映射、摘要边界、旧/过期/缺失记录状态、练习可用性。 |
| `src/components/ScoreLibraryPage.tsx` | 独立曲谱库：列表、搜索、状态、打开阅读、重命名、删除、刷新、导入预览、错误/空状态。 |
| `src/components/ScoreReader.tsx` | display-only OSMD 阅读器；自动适应容器、CSS 阅读缩放、XML 切换清理、渲染错误状态。 |
| `src/components/ReaderPage.tsx` | 阅读页：元信息、导入警告/受限原因、适应宽度/缩放/返回、练习入口。 |
| `src/components/ReaderPage` 相关样式 | 在 `src/styles.css` 增加曲谱库/阅读页/导入预览样式。 |

### 修改

| 文件 | 改动 |
|---|---|
| `server/score-library.mjs` | meta 增加 `importStatus`、`importReportSummary`、`parserVersion`、`importedAtIso`；摘要校验/截断；`list()` 增加 `fileMissing`；`invalidCount()`；XML 替换无新摘要时清空旧状态。 |
| `server/engine-server.mjs` | `/api/scores` 列表返回 `invalidCount`。 |
| `server/score-library.test.mjs` | 新增摘要持久化、替换清空、旧记录、缺失 XML、坏 meta 诊断测试。 |
| `src/features/score/scoreLibrary.ts` | meta 类型；`Create/Update` 支持 `importSummary`；`listScoreLibraryDetailed()` 返回 entries + invalidCount。 |
| `src/app/routes.ts` | 启用 `/scores`（主导航）与 `/reader`；保留其他后续页面占位。 |
| `src/app/routes.test.ts` | 更新导航与启用状态断言。 |
| `src/App.tsx` | 接入 ScoreLibraryPage/ReaderPage；活动曲谱与阅读页共享状态；异步恢复增加版本 guard；打开/删除/开始练习回调；现有设置导入/替换/载入写入或回填摘要。 |

未新增依赖。未修改 `crates/`、NAPI、Rust Core、Session/Take、参考播放、评分算法。

---

## 3. 曲谱库实现

### 3.1 列表与状态

- 数据源：`GET /api/scores`，返回原记录 + `importStatus` / `importReportSummary` / `parserVersion` / `importedAtIso` / `fileMissing` + `invalidCount`。
- 列表卡展示：名称、来源文件名、更新时间、大小、真实解析状态、音符/小节/警告数、当前谱面标记。
- 搜索：按 `name` 或 `fileName`，大小写不敏感。
- 状态：
  - `READY` → **可练习**
  - `READY_WITH_WARNINGS` → **可练习 · 有警告**
  - `DISPLAY_ONLY` → **可阅读 · 练习受限**
  - `REJECTED` → **导入失败**
  - 旧记录无摘要 → **待校验**
  - `parserVersion` 与当前 `SCORE_ENGINE_VERSION` 不同 → **需重新校验**
  - XML 文件缺失 → **文件缺失**
- 空列表、加载失败、元数据损坏（`invalidCount`）、文件缺失、旧记录、受限/警告均有明确 UI。

### 3.2 重命名/删除/刷新

- 重命名/删除复用现有 REST 和强制确认；新页面与设置面板使用同一文件存储，没有第二套库。
- 删除当前活动曲谱时：
  - 有活动练习：保留内存中的曲谱让本轮继续，清除 active score 记录并提示；
  - 无活动练习：回到默认乐谱并提示。
- 刷新只重新读取列表，不重新解析所有 XML。

### 3.3 练习可用性

- 列表状态只表示导入能力；阅读页打开后会再次以完整 `ImportReport` + 当前谱表/音高支持检查决定是否启用“开始练习”。
- `strictAllowed=false` 或存在 `getUnsupportedNotes` 的目标，按钮禁用并显示原因。
- 不把“OSMD 渲染成功”当成“可完整评分”。

---

## 4. 导入流程

1. 用户选择 `.musicxml`（A1 不 accepts `.xml`/`.mxl`；`accept=".musicxml"`）。
2. 文件大小上限 10 MiB（与服务端一致）；扩展名/大小错误直接提示，不解析。
3. `file.text()` → 现有 `importMusicXml` → `toLegacyScoreDocument`（通过 `importScoreText`）。
4. 展示真实 ImportReport：
   - 状态、音符/小节/警告/错误数、`strictAllowed`；
   - 按 error/warning/info 分组；
   - 有 `measureOrdinal` 时显示“第 N 小节”，没有则显示“位置未提供”；
   - 不虚构声部/元素位置。
5. `REJECTED`：显示失败原因，不提供保存按钮；可关闭结果。
6. 非失败：可编辑名称并保存；保存使用现有 `POST /api/scores`。
7. 同名冲突由服务端拒绝；页面显示错误，旧记录不变，不自动覆盖。
8. 保存成功后刷新列表并显示成功消息；取消/关闭不写库。

现有设置面板的导入/替换路径也已更新：

- 导入：先解析，`REJECTED` 不保存；成功保存带摘要。
- 替换：先解析新 XML；失败不调用 update，旧 XML/摘要保持不变；成功后同时写 XML 和新摘要。
- 载入：若旧记录无摘要，载入成功后尽力回填；失败不阻塞阅读。

---

## 5. 解析状态持久化

### 5.1 存储字段

`<id>.meta.json` 新增：

```json
{
  "importStatus": "READY_WITH_WARNINGS",
  "parserVersion": "1.0.0",
  "importedAtIso": "2026-10-22T...",
  "importReportSummary": {
    "status": "READY_WITH_WARNINGS",
    "strictAllowed": true,
    "parserVersion": "1.0.0",
    "supportProfileVersion": "musicxml-v1.0",
    "fingerprint": "…",
    "counts": { "noteCount": 12, "measureCount": 2, "partCount": 1, "warningCount": 1, "errorCount": 0 },
    "topIssues": [{ "code": "…", "severity": "warning", "message": "…", "measureOrdinal": 2 }],
    "importedAtIso": "…"
  }
}
```

- 只存摘要，不复制 notes/parts/完整乐谱。
- `topIssues` 最多 20 条；服务端校验状态、severity、字符串长度和计数。
- 旧 meta 没有这些字段仍然可读；列表显示“待校验”，打开时解析并按需 PUT 回填。
- 替换 XML 但没有新 ImportReport 时，服务端清空旧状态，避免把旧报告套到新 XML。
- `parserVersion` 变化 → 列表显示“需重新校验”；打开后重算并回填。

---

## 6. 阅读页实现

- 路由：`/reader`，从曲谱库“打开阅读”进入；不把 XML 放进 URL。
- 渲染：新的 `ScoreReader` 使用现有 OSMD/Bravura，`autoResize: true`，`disableCursor: true`，没有 ScoreViewAdapter/评分高亮；语义解析与视觉渲染保持分离。
- 清理：`xml` 变化/卸载时 `osmd.clear()`、清空 host、断开动态加载；不会残留上一首曲谱。
- 适应宽度：默认显示；SVG 以 100% 宽度适配阅读容器；实测 995px 阅读窗 `scrollWidth=995`，无横向滚动。
- 缩放：`−` / `＋` 用 CSS transform 阅读缩放（不重新制谱）；110% 实测 SVG 1054.9px，出现水平滚动；`适应宽度` 恢复 100% 且消除横向滚动。
- 元信息：曲名、作曲者、拍号、小节数、谱表类型、parser 版本。
- 受限/警告：显示状态和导入问题；练习按钮在 `strictAllowed=false` 或谱表/音高不支持时禁用。
- 无原始 MusicXML、无活动曲谱、恢复中、渲染失败都有独立状态。
- 不实现小节/系统跳转；当前 OSMD 版本没有验证过的稳定“按小节跳转”API，A1 只提供连续阅读和缩放，报告中明确记录。

---

## 7. 练习接入

- 打开曲谱：`ScoreLibraryPage` → 现有 `applyScoreDocument` → `rememberActiveScore(entry.id)` → `/reader`。
- 阅读页“开始练习”：在 `strictAllowed` 且谱表支持时可用；点击后回到 `/workbench` 并打开现有练习设置面板。
- 不新增 Session/Take；实际评分仍由现有 `launchPractice` 构建 `PlaybackPlan`/atoms，受现有严格检查。
- 受限曲谱：`开始练习` 禁用，显示阻断原因；不能创建伪造评分任务。
- 活动曲谱在刷新 `/reader` 时通过现有 active-score 恢复；异步恢复增加选择版本 guard，避免旧的恢复结果覆盖用户刚打开的另一份曲谱。
- A2 才处理练习室离开/暂停/销毁策略；A1 没有新增监听器或练习实例。

---

## 8. 当前解析器仍不支持的 MusicXML 特性

以下状态会通过 ImportReport 显示为警告/受限，不会静默当作完整评分：

- repeat/ending、D.C./D.S./Coda/Fine；
- tempo curve / 文字速度（TempoMap 仍固定 BPM）；
- `.mxl` 容器（A1 明确拒绝）、PDF/图片 OMR、MIDI→精确记谱；
- 复杂多 part 手别映射、移调乐器、微分音、复杂 tuplets、装饰音语义；
- 完整 articulation/pedal 语义、逐音力度表现；
- 精确小节/系统跳转（阅读页只做连续滚动）。

---

## 9. 工程与浏览器验证

### 9.1 真实命令与结果

```text
cd D:\123\rhythm-trainer-frontend
npx tsc -b
# PASS

npx vitest run
# 24 test files, 148 tests passed
# 新增：scoreStatus 3、score-library server 4（含摘要/替换/缺失/坏 meta）、路由更新

npm run build
# PASS：tsc -b + vite build
# 警告：opensheetmusicdisplay chunk 1,436.11 kB (gzip 382.93 kB)，非 A1 引入

npm run selftest
# 全部自测通过
```

A1 未修改 Rust Core，未重复运行 Rust 测试；此前基线 104 项通过。

### 9.2 浏览器手工验收（in-app browser）

1. `/scores` 显示现有 2 份曲谱；晓之车状态从旧记录“待校验”打开后回填为“可练习 · 有警告”，服务端 meta 已持久化 `parserVersion=1.0.0`、1610 音符/113 小节/1 警告。
2. 搜索“晓”只剩 1 张卡；打开阅读页 URL `/reader`，标题为曲名，OSMD SVG 存在。
3. 适应宽度：阅读窗 995px，`canvasScrollWidth=995`，无横向滚动；放大到 110% 后 SVG 1054.9px，出现水平滚动；恢复适应宽度后消除。
4. 通过界面注入有效 `piano-two-staff-basic.musicxml`：预览状态“可练习”，保存成功，列表变为 3 份；持久化由 score-library 单测覆盖，测试记录随后已清理。
5. 无效 XML：预览“导入失败”，没有保存按钮，显示解析失败说明；不影响已有记录。
6. 受限 `unsupported-repeat-tempo-curve.musicxml`：预览“可阅读 · 练习受限”，保存成功；阅读页状态受限，“开始练习”禁用并显示阻断原因。
7. 同名导入冲突：保存名与已有记录相同，显示“乐谱库中已有名为…”，旧记录保持。
8. 重命名/删除测试记录：重命名成功、删除后列表消失；测试记录已清理，原两份曲谱保留。
9. `.mxl` 文件：明确提示“A1 目前只支持 .musicxml”，不进入预览。
10. 从晓之车阅读页点击“开始练习” → `/workbench` + 练习设置面板；开始练习后参考播放 `播放中 · 第 1 小节`，结束后出现现有 `ReportPanel`，练习流程未回归。
11. 在受限阅读页刷新：恢复同一受限曲谱，状态和渲染仍在。
12. 从受限曲谱切换到达标曲谱，阅读标题/内容更新，无上一首残留。

---

## 10. 未完成 / 已知限制

- 新曲谱库页面没有“替换 XML”按钮；替换仍在现有练习设置乐谱库面板中。A1 要求的新增/重命名/删除/刷新已覆盖。
- 旧记录/parser 版本变化时，状态在“打开”时回填，不会在列表加载时全量重解析。
- 元数据损坏只统计 `invalidCount`，没有逐条修复 UI；需要用户检查数据目录或删除坏文件。
- 阅读页没有小节/系统跳转；OSMD 当前版本没有验证过的稳定跳转 API。
- 阅读缩放是 CSS 视觉缩放，不是重新制谱排版；放大时横向滚动是预期行为。
- 阅读页练习按钮只做 `strictAllowed` + 谱表支持预检；PlaybackPlan/atoms 的最终构建仍由现有 `launchPractice` 校验，若计划失败会在工作台提示。
- 没有 `.mxl`、PDF/OMR、完整 P08 报告、P09 复练、独立试听、Snapshot 光标、音频延迟校准。
- 现有设置面板乐谱库列表仍只显示名称，没有状态列；独立曲谱库页面是 A1 的状态展示入口。
- App 仍是单 bundle；A1 没有做路由级 code splitting。
- 没有真实文件选择器自动化（IAB 限制）；浏览器测试通过同一 `<input type="file">` 的 `change` 路径注入 File，等价于 UI 选择文件后的处理链。

---

## 11. 阶段边界

- **A2**：设备中心、练习设置页/练习室页面化、离开/暂停策略、A2 节奏/时长摘要；本 A1 仍复用现有工作台和设置弹窗。
- **B1**：完整 P08（pitch/overall/confidence/每小节/事件级）；A1 只展示真实 ImportReport 与现有阅读能力，不生成完整评分。
- **B2**：P09 针对性复练；A1 没有实现从报告创建复练。
- **C2/C3**：音频输出延迟校准、独立试听、Snapshot 光标、`.mxl`、repeat/tempo、采样钢琴；均未在 A1 启动。

A1 完成，等待下一阶段指令。未开始 A2。
