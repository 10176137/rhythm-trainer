# A2 设备就绪、练习设置与练习室交互 — 实施报告

- 日期：2026-10-22
- 范围：A2 only；未开始 B1、B2、C2、C3。
- 结论：设备检查页、设置可理解性与限制说明、uncalibrated 标记、练习室摘要、应用内导航/浏览器后退离开守卫、beforeunload 警告和报告持久化门禁已实现。现有 Session/Take、Reference Playback、MIDI Adapter、Rust Core 未重写；A1 曲谱库/阅读功能保持。

---

## 1. 实施前审计

| 项 | 实际状态 | A2 处理 |
|---|---|---|
| MIDI 设备 | 全局 `DeviceBridge` 已连接 Node Adapter；有状态/设备列表/最近事件；事件列表只保留 8 条；没有“当前按下键”和 Note Off 超时提示 | 新增 `/device` 设备检查页；App 维护当前按下键；3 秒未松键提示；不创建 Session |
| 设备切换 | 服务端有 adapter generation / sourceSeq / 队列；UI 只更新状态 | 连接/断开时清空监视事件与 held notes；不新建第二套设备系统 |
| Session / Take | `usePracticeSession` 管理 countdown/running/paused/processing/completed；服务端 Take/Coordinator 已有 | 不重写；只增加报告 `persisted` 状态和离开等待逻辑 |
| 设置 | 已有设置面板、`settingsDraft`、`settingsLocked`；`mode-config.mjs` 是服务端权威 | 保留面板作为 P06；补配置摘要/限制说明；未保存草稿阻止开始；预备/连接中锁定设置 |
| 参考播放 | `ReferencePlaybackController` 已接 Session 生命周期；暂停/停止/恢复已有 | 不改；练习室继续复用 |
| 绿色目标 | 由 `FollowSession`/未判定目标驱动，不是播放光标 | 保持语义，不改成 Snapshot 光标 |
| 摘要 | `EngineReport.stats` + 独立 durations + analysis + captureDiagnostics；没有 pitch/overall/每小节 | 只展示这些真实字段；加 uncalibrated、无报告/持久化失败状态 |
| 路由 | A0/A1 已有 `/workbench`、`/scores`、`/reader`、`/history`、`/profile`；无离开守卫 | 启用 `/device`；导航统一经 `requestNavigation`；`useAppRoute` 增加浏览器后退 guard |
| 离开行为 | 旧实现直接隐藏工作台，Session/音频可在后台继续 | 新增确认、结算等待、持久化门禁、beforeunload |
| 报告持久化 | 服务端生成报告后保存失败只 `console.error`，前端不知情 | 服务端增加 `persisted`/`persistenceError`；前端阻止假成功导航 |

---

## 2. 改动文件

### 新增

| 文件 | 作用 |
|---|---|
| `src/components/DevicePage.tsx` | `/device` 设备检查页：连接状态、设备选择、刷新/连接/断开、当前按下键、Note On/Off 最近事件、3 秒 Note Off 提示、输入健康；不创建练习。 |
| `src/components/LeaveGuardDialog.tsx` | 两选项离开确认：留在练习室 / 结束本轮并离开；处理中显示等待报告；错误显示在对话框。 |
| `src/styles.css` 相关样式 | 设备页、离开对话框、settings summary/constraints、uncalibrated 提示。 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | 接入 DevicePage；`heldDeviceNotes`；设备连接/断开清理；`/device` 渲染；`requestNavigation` + 离开对话框状态机；`finishPractice` 后等待报告；beforeunload；路由 guard；设置摘要/限制；未保存设置禁止开始；`uncalibrated` 标记；报告持久化/无报告提示；设备未连接/健康降级提示。 |
| `src/app/routes.ts` | 启用 `/device`（主导航，`⌨`）；其余后续页面仍占位。 |
| `src/app/routes.test.ts` | 主导航包含 device；后续 disabled 路由断言保留。 |
| `src/app/useAppRoute.ts` | 增加可选 `canLeave`：浏览器 popstate 被拒绝时恢复当前 URL，交给离开对话框处理。 |
| `src/features/practice/usePracticeSession.ts` | 增加 `reportPersisted` / `reportPersistenceError` 状态，透传 report 消息。 |
| `src/types/engine.ts` | `EngineReportMessage.persisted` / `persistenceError`。 |
| `server/engine-server.mjs` | 会话记录写入成功/失败标记，report 消息返回 `persisted` / `persistenceError`。 |
| `src/components/ReportPanel.tsx` | 底部明确显示音频输出延迟未校准（uncalibrated）。 |
| `README.md` / `CHANGELOG.md` | A2 能力与限制记录。 |

未新增依赖；未修改 Rust Core、评分、NAPI、TargetSchedule、Session/Take 或 Reference Playback 实现。

---

## 3. P05 设备就绪

- 复用现有 `DeviceBridge` 和 Node MIDI Adapter，没有第二套设备管理。
- `/device` 展示：
  - 连接状态（未连接/连接中/已连接/失败）和设备名；
  - 可用输入设备列表、选择、刷新、连接、断开；
  - 输入健康；
  - 当前按下的键（音名、力度）；
  - 最近 Note On / Note Off / CC 事件（sourceSeq、通道）；
  - 超过 3 秒没有 Note Off 的键提示（明确“可能只是持续按键，不直接判定设备故障”）；
  - 没有设备时的连接建议。
- 设备页不调用 Session/Take；浏览器实测进入 `/device` 前后会话数不变（47 → 47）。
- 连接/断开时清空 held notes 和 UI 事件列表；服务端 generation/sourceSeq 继续负责拒绝旧设备迟到事件。
- 连接、按键测试不产生评分或历史记录。

---

## 4. P06 练习设置

保留现有设置面板（P06 允许页面或面板），不新建配置系统。

新增可理解性：

- **配置摘要**：模式、BPM、手别、推进方式、节拍器。
- **固定预备拍说明**：当前固定 4 拍，A2 不展示伪配置。
- **uncalibrated**：音频输出延迟尚未校准；时间偏差用于练习反馈，不代表采样级物理精度。
- **循环限制**：当前 loop 只练所选范围一次，不跨轮重复。
- **配置快照/Continue**：开始后配置冻结；保存后开始或“再练一次”会用当前配置新开一轮，不恢复旧 Take。
- **系统伴弹**：开启时固定时间推进，推进方式选择被禁用并显示为固定时间。
- **未保存草稿**：存在未保存修改时开始按钮禁用；`startPractice` 也会再次拒绝并提示保存。浏览器实测关闭/取消后按钮恢复。
- **锁定范围**：`settingsLocked` 现在包含预备/连接中/运行/暂停，避免预备阶段修改配置。
- 现有 `mode-config.mjs` 未被复制或改写；配置仍走现有快照/引擎链路。
- BPM 运行中不可修改；需要改变时结束当前轮，符合现有契约。

Continue：当前没有“恢复旧 Take”的按钮或逻辑。上次曲谱 + `loadPracticeSettings` 恢复配置后，点击开始/再练一次创建新 Session/Take；A2 在设置面板中明确这一点。

---

## 5. P07 练习室

- 继续复用现有工作台、Session/Take、Reference Playback。
- 顶部/侧栏显示：模式、BPM、手别、参考播放状态、设备输入健康、判定档位。
- 绿色目标保持原语义：由用户节奏目标驱动，不冒充 Snapshot 播放光标。
- 设备未连接时开始练习会明确提示只能使用虚拟/模拟输入；输入健康非 healthy 也会提示本轮可能降级。
- 练习摘要仍来自现有真实数据：
  - `EngineReport.stats`：Perfect/Good/Miss/Extra、命中率、时间偏差；
  - `durations`：独立按键时长；
  - `analysis`：规则诊断/处方；
  - `captureDiagnostics`：输入/时钟健康。
- 不展示 pitch/overall/confidence/每小节/事件级 pitch 诊断；不补 0、不伪造综合分。
- 增加：
  - `uncalibrated` 提示（练习室、设置、报告）；
  - 报告 `persisted=false` 时明确“报告已生成但未能保存”；
  - 时间线模式完成但没有报告时明确“本轮没有可评分报告”；
  - 设备/时钟问题与用户弹错分开表达。
- 重复点击结束：processing 状态禁用按钮/守卫；不会重复结算。

---

## 6. 离开策略

### 6.1 状态定义

`practiceInProgress` 包含：

- 3 秒准备倒计时；
- `starting`（Session 启动请求在途）；
- `session.active`（countdown/running/paused/processing）；
- 跟手跟练 running/paused；
- 自由弹奏 running。

### 6.2 应用内导航

所有侧栏导航统一走 `requestNavigation`：

- 没有活跃练习：直接导航。
- 有活跃练习：不改变 URL，弹出 `LeaveGuardDialog`。
  - **留在练习室**：关闭对话框，Session/音频/状态不变；
  - **结束本轮并离开**：调用现有 `finishPractice`，等待引擎 completed 和报告持久化后才导航。
- 3 秒准备阶段离开：取消 prep，不启动 Session。
- `starting` 阶段离开：等到引擎真正进入 countdown/running 后调用现有结束流程，避免后台偷偷启动。
- `processing` 阶段点击离开：对话框显示“等待报告并离开”，报告完成后按持久化结果决定。

### 6.3 浏览器后退

`useAppRoute` 增加 `canLeave` 守卫：

- 活跃练习时浏览器后退被拒绝；
- URL 恢复当前 `/workbench`；
- 弹出同一个离开对话框。
- 浏览器实测：练习中 `back()` 后 URL 仍为 `/workbench`，确认对话框出现。

### 6.4 刷新/关闭页面

- 活跃练习（含暂停、准备、启动中）注册 `beforeunload` 警告，不依赖异步落盘。
- 浏览器测试通过 dispatch `beforeunload`：`defaultPrevented === true`。
- 已结束 Take 不注册该警告。

### 6.5 结算/持久化失败

- 服务端 report 增加 `persisted` / `persistenceError`。
- 只有报告 succeeded 且 `persisted !== false` 才自动导航。
- 报告缺失、持久化失败或结束错误：
  - 不导航；
  - 保留工作台/练习状态；
  - 显示明确错误和下一步建议。
- 持久化失败后 `reportUnsaved` 会阻止应用内导航和浏览器后退，并保留 beforeunload 警告。
- 已结束且保存成功的 Take 正常导航，不会重复结算。

### 6.6 生命周期

- `DeviceBridge`、`usePracticeSession`、Reference Playback 仍在 App 顶层，路由切换不重挂载。
- 工作台仍常驻挂载；离开守卫取代“直接隐藏工作台继续运行”。
- 会话数验证：一次开始 → 导航确认 → 结束并离开只新增 1 条；设备页前后会话数不变。

---

## 7. 自动化与真实运行验证

### 7.1 命令

```text
cd D:\123\rhythm-trainer-frontend
npx tsc -b
# PASS

npx vitest run
# 24 files, 148 tests passed

npm run build
# PASS（仅原有 OSMD 1.44 MB chunk 警告）

npm run selftest
# 全部自测通过
```

A2 未修改 Rust Core，因此未运行 Rust 测试；此前基线 104 项通过。

### 7.2 浏览器验收

1. `/device`：无可用 MIDI 设备时显示真实空状态，连接按钮禁用；进入前后会话数不变（47 → 47）。
2. 设置面板：显示“模式/72 BPM/双手/固定时间/节拍器开”摘要，以及固定 4 拍预备拍、uncalibrated、循环只练一次、配置快照/Continue 说明。
3. 未保存设置：切换节拍器后 `有未保存的修改`，开始按钮禁用；取消后恢复可用。
4. 练习中点击“练习记录”：URL 保持 `/workbench`，弹出“结束当前练习？”，选择“留在练习室”后对话框关闭，参考播放继续。
5. 再次点击导航并选择“结束本轮并离开”：等待结算，URL 变为 `/history`，会话记录只新增 1 条。
6. 浏览器后退：练习中 `back()` 后 URL 仍为 `/workbench`，离开对话框出现。
7. beforeunload：练习中 dispatch 事件得到 `defaultPrevented=true`。
8. 新引擎服务（带 `persisted` 字段）下再次走结束并离开，正常导航且会话落盘。
9. 现有 Reference Playback 在练习中仍为 `播放中`；设置/报告/历史页面未回归。

---

## 8. 已知限制 / 阻塞

- **真实 MIDI 设备验证受限**：当前环境没有可用 MIDI 输入设备（服务端返回无设备）。设备页空状态、连接禁用、不创建 Session已验证；真实 Note On/Off、设备切换、练习中断连和旧 generation 事件仍需在实体键盘上手工验证。
- **报告持久化失败路径未实际诱发**：代码已加 `persisted` 门禁；没有人为制造只读数据目录/磁盘失败来做真实故障注入。
- **浏览器 beforeunload 实际关闭对话框未自动截图**：通过事件 `defaultPrevented` 验证监听器存在；真实浏览器关闭/刷新提示需人工确认。
- **uncalibrated**：音频输出延迟仍未校准；C2 才接入校准。
- **设置面板不是独立 `/settings` 路由**：P06 允许页面或面板；当前使用现有面板。`/settings` 仍保留为后续占位，避免出现第二套配置系统。
- **loop** 仍只练所选范围一次，不跨轮循环；已在设置中明确说明。
- **预备拍** 固定 4 拍，无配置项。
- **Continue** 没有独立“恢复旧 Take”入口；开始/再练一次使用上次曲谱和配置新开一轮，符合锁定决策。
- 仍不提供 pitch/overall/confidence/每小节/事件级诊断；B1 边界。
- 仍不提供独立试听、Snapshot 光标、MXL、运行中 BPM 调整、音频延迟校准；C3/C2 边界。
- 设备页/设置面板没有新的单元测试文件；本轮通过 tsc、全量 148 项测试、浏览器验收覆盖，真实设备仍是环境阻塞。

---

## 9. 与后续阶段边界

- **B1**：完整 P08（pitch/overall/confidence/每小节/事件级）；A2 只展示现有真实节奏/时长摘要。
- **B2**：P09 针对性复练；A2 不创建复练任务。
- **C2**：音频输出延迟校准、诊断包/存储管理；A2 只标记 uncalibrated。
- **C3**：独立试听、PlaybackSnapshot 光标、MXL、repeat/tempo、采样钢琴、只手静音；A2 未实现。
- A2 完成，等待下一阶段指令；不自动开始 B1。
