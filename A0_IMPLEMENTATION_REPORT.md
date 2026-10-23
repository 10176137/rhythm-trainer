# A0 应用外壳与导航基础建设 — 实施报告

- 日期：2026-10-22
- 范围：只做 A0；未开始 A1/A2/B1，未修改 Rust Core、评分算法、NAPI、TargetSchedule、Session/Take、设备管理或报告业务。
- 结论：A0 完成并通过浏览器验证。现有练习工作台、练习记录、能力画像、设备连接、设置和报告仍可用；未开放页面只显示明确占位，不展示伪造数据。

---

## 1. 实施前审计

| 项目 | 审计结果 |
|---|---|
| 当前视图切换 | `src/App.tsx` 使用 `const [view, setView] = useState<'workbench' \| 'history' \| 'profile'>('workbench')`；侧栏按钮 `setView(...)`；工作台用 `display:none` 隐藏，历史/画像条件挂载。 |
| 路由依赖 | `package.json` 没有 react-router 等路由库；没有 URL 路由。 |
| 最小改造方案 | 使用浏览器 History API + 一个自定义 `useAppRoute` hook；不引入新依赖；URL pathname 作为唯一路由状态，`popstate` 处理前进/后退。 |
| 现有页面 | `App.tsx` 工作台（练习/设备/设置/参考播放/报告）、`HistoryView`、`ProfileView`；`ScoreViewer`/`OsmdScoreView`、`ReportPanel`、`FollowReportPanel`。 |
| 现有服务/状态 | `usePracticeSession`、`DeviceBridge`、`ReferencePlaybackController`、`ReferencePlaybackController` effect、练习设置草稿、曲谱库；这些都在 `App` 顶层，不能因路由拆分重复挂载。 |
| 静态服务 | `server/engine-server.mjs` 已有 SPA fallback（未知非资源路径回到 `dist/index.html`）；Vite dev 也有 SPA fallback。 |
| 基线测试 | `npx tsc -b` 通过；`npx vitest run` 22 文件 / 136 项通过。 |

关键保留原则：**工作台继续常驻挂载**，切到历史/画像时只隐藏，不卸载；这样不会重建 `usePracticeSession`、Reference Playback、DeviceBridge 或 MIDI 监听器。

---

## 2. 改动文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `src/app/routes.ts` | 单一路由注册表：`APP_ROUTES`、默认 `/workbench`、`NAV_ROUTES`、`normalizePath`、`matchAppRoute`；未来页面以 `enabled:false` 登记。 |
| `src/app/useAppRoute.ts` | History API 路由 hook：初始 `/`/`index.html` 规范化为 `/workbench`；`navigate` pushState；`popstate` 同步；自定义 route-change 事件。 |
| `src/app/routes.test.ts` | 路由规范化、默认入口、导航页、未来禁用页、未知路径测试（5 项）。 |
| `src/components/AppShell.tsx` | 统一应用外壳：sidebar、topbar、全局 notice、children；不承载业务逻辑。 |
| `src/components/RoutePlaceholder.tsx` | 未开放/未知页面的诚实占位；不显示任何业务数据。 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | 移除 `view`/`setView` 状态，改为 `useAppRoute`；导航由 `NAV_ROUTES` 生成；接 `AppShell`；面包屑/标题使用 route；工作台仍常驻隐藏；全局 `session.error` 移到 AppShell notice；新增未知/未开放路由占位；`document.title` 随页面更新；从历史/画像点击侧栏设置或练习模式时导航回工作台，避免打开不可见的面板/只改隐藏页面配置。 |
| `src/styles.css` | 增加 `.main-nav`、`.app-global-notice`、`.route-placeholder` 及窄屏规则；沿用现有设计变量和卡片/按钮体系。 |

未新增依赖。未修改 `src/features/*` 业务模块、`server/*`、`crates/*`、`bindings/*`。

---

## 3. 实际实现方式

### 3.1 路由

路径：

- `/workbench`：练习工作台（默认）
- `/history`：练习记录
- `/profile`：能力画像
- `/scores`、`/import`、`/reader`、`/device`、`/settings`、`/report`：已在注册表登记，`enabled:false`，直接访问显示“尚未开放”占位。

行为：

- `/` 或 `/index.html` 通过 `history.replaceState` 规范化为 `/workbench`。
- 点击导航使用 `pushState`，不刷新页面。
- 浏览器前进/后退通过 `popstate` 更新。
- 刷新任意已实现路径（如 `/profile`）仍进入对应页面。
- 未知路径显示“页面不存在”，不伪造页面。
- 没有第二套 `view` 状态；URL 是唯一页面状态。

### 3.2 应用外壳

`AppShell` 接收：

- `sidebar`：现有侧栏（品牌、主导航、练习模式、教师提示、练习者/设置）。
- `topbar`：现有顶栏（面包屑、MIDI 状态、端口选择、导出日志、连接键盘）。
- `notice`：全局状态区域，目前承载 `session.error`；错误在历史/画像页面也可见。
- `children`：当前页面内容。

现有 `.app-shell`、`.sidebar`、`.main-area`、`.topbar`、`.page-content` 设计系统保留；没有引入 UI 框架或新的视觉体系。

### 3.3 页面保持与业务状态

- 工作台 `page-content` 在非工作台路由下 `display:none`，但组件子树保持挂载。
- 历史/画像仍按路由条件挂载，行为与改造前一致。
- `DeviceBridge`、`usePracticeSession`、Reference Playback、设置草稿、曲谱库状态都在 `App` 顶层，不随页面切换重建。
- 练习中切换页面不会重复创建 Session；实测一次练习开始→暂停→打开历史→返回→继续→结束，只新增 1 条会话记录（42 → 43）。
- 现有绿色目标/参考播放/红色系统音语义未修改。

---

## 4. 已接入的既有功能

- 练习工作台：开始/倒数/暂停/继续/结束/重置。
- Reference Playback：播放、暂停、继续、停止、快照状态显示。
- MIDI 设备：连接/刷新/断开、状态、输入监视器、虚拟键盘。
- 练习设置弹窗：模式/BPM/手别/判定/推进/循环/节拍器/乐谱库/导入。
- 练习记录：列表、加载中/空状态、展开报告。
- 能力画像：技能状态、趋势、空状态。
- 报告：`ReportPanel` 仍显示现有真实节奏/时长/诊断数据。
- 设置按钮：打开/关闭面板实测正常。
- 页面标题：随路由/当前练习模式更新。

---

## 5. 实际验证

### 5.1 命令结果

```text
cd D:\123\rhythm-trainer-frontend
npx tsc -b
# PASS（无输出，exit 0）

npx vitest run
# 23 test files passed, 141 tests passed
# 新增 5 项路由测试；基线为 22 文件 / 136 项

npm run build
# PASS：tsc -b + vite build
# 警告：opensheetmusicdisplay chunk 1,436.11 kB (gzip 382.93 kB)，与 A0 无关

npm run selftest
# 全部自测通过
```

A0 未修改 Rust Core，因此未重复运行 Rust 测试；此前基线为 104 项通过。

### 5.2 浏览器验证（in-app browser，`http://127.0.0.1:5173/`）

1. 打开 `/` → URL 自动变为 `/workbench`，标题 `乐谱跟练 · Rhythm Trainer`。
2. 点击“练习记录” → `/history`，标题 `练习记录 · Rhythm Trainer`，页面显示历史列表。
3. 点击“能力画像” → `/profile`，标题 `能力画像 · Rhythm Trainer`，页面显示画像。
4. 浏览器后退 → `/history`；前进 → `/profile`。
5. 在 `/profile` 刷新 → 仍为 `/profile`，导航选中“能力画像”。
6. 直接访问 `/scores` → 显示“曲谱库 / A0 尚未开放 / 不会显示伪造数据”，有“返回练习工作台”。
7. 直接访问 `/not-a-page` → 显示“页面不存在”，不显示业务数据。
8. 练习中（暂停状态）切到“练习记录”再返回 → 状态仍为“已暂停”，参考播放仍为“已暂停 · 第 1 小节”。
9. 继续 → 结束 → 报告出现；设置弹窗打开/关闭正常。
10. 在 `/history` 点击侧栏设置齿轮 → 自动回到 `/workbench` 并打开练习设置面板；关闭正常。
11. 会话记录数从 42 → 43，只新增一轮，未因路由切换重复创建 Session。

---

## 6. 遗留问题

1. **没有路由级离开确认**：练习进行中切换到历史/画像不会停止或暂停练习，工作台会在后台保持运行（与改造前 `view` 隐藏行为一致）。A2 应决定“切换即暂停/离开确认”策略；A0 不改变现有行为。
2. **未来页面只有占位**：`/scores`、`/import`、`/reader`、`/device`、`/settings`、`/report` 是注册表边界，不是 A1/A2 页面；没有伪造数据。
3. **路由依赖静态服务器 fallback**：开发 Vite 和当前引擎服务都有 SPA fallback；如果以后换纯静态服务器，需要配置 `/* -> /index.html`。
4. **工作台保持挂载**：页面切换快且不丢练习状态，但隐藏页面仍会运行音频/会话；这是有意保留的现状，不是 A0 新引入的重复订阅。
5. **没有路由级代码分割**：A0 保持现有单 bundle；未来页面增多时再做按页 lazy load。
6. **没有把设置/设备拆成独立页面**：A0 只接入口和扩展边界；P05/P06 页面化在 A2。
7. **没有改报告语义**：A2 仍只能展示现有节奏/时长摘要；Pitch/Overall/Confidence/每小节/事件级字段仍 unavailable，B1 才能完整交付。
8. **未做 Playwright 自动化**：浏览器验证是手工/脚本化 in-app browser 记录；后续可为路由补 E2E 自动化。

---

## 7. 下一阶段状态

- **A1 可以开始**：P01 首页、P02 曲谱库、P03 导入、P04 阅读。前置：补曲谱库 import status 持久化；A1 只支持 `.musicxml`，`.mxl` 仍 C3。
- **A2 可以开始（在 A1/A0 基础上）**：P05 设备、P06 设置、P07 练习室。A2 只显示真实节奏/时长摘要；独立试听、Snapshot 光标仍 C3。
- **B0 可并行做设计**：`scorePerformance` NAPI、ScoreEvent/PerformedNote、target pitch/voice/逐音时值契约。**B1 完整 P08 报告阻塞于 B0**；**P09 阻塞于 B1**。
- **C1/C2**：历史详情/学习进度/诊断导出/音频延迟校准，按后续批次。
- **C3**：独立试听、PlaybackSnapshot 光标、MXL、repeat/tempo、采样钢琴、只手静音，均未在 A0 启动。

A0 完成，等待下一阶段指令。未开始 A1/A2/B1 或任何引擎重构。
