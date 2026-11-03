# P2 模块级计划：练习会话的资源所有权

> 上级计划：[2026-11-03-practice-refactoring.md](2026-11-03-practice-refactoring.md) §5 P2、§7 P2。本文件只覆盖 P2 的第一批可执行切分；P2 其余内容（会话编排整体提取、结束原因分类、Follow 模式适配器）仍按上级计划另行拆分，不能把本批当作 P2 完成。

**日期：** 2026-11-03

**目标：** 让「同一时刻只允许一个练习轮次占用 MIDI 输入与 Take 租约」的规则只有一个所有者。开始前的冲突判断、结束/断连时的释放、Node MIDI sink 的挂载与摘除，不再分散在 `engine-server.mjs` 的连接闭包里各自读写。

## 1. 现状

`server/engine-server.mjs` 在模块作用域保存三个跨连接资源：

```js
let activeNodeSink = null;
let activeTakeLease = null;   // { socket, takeId, practiceSessionId }
let activeFollowLease = null; // { socket, takeId }
```

读写点分散在：

| 位置 | 行为 |
| --- | --- |
| `start` 分支 | 检查其他连接的 timeline／follow 租约、本连接 follow 运行态、`native`，必要时丢弃已断连的 timeline 租约 |
| `follow-start` 分支 | 检查其他连接的 follow 租约、任意 timeline 持有、本连接 follow 运行态 |
| `releaseTimelineResources` | 摘 sink、释放本连接 timeline 租约 |
| `releaseFollowResources` | 摘 sink、释放本连接 follow 租约 |
| `socket close` | 摘 sink、释放两类租约 |
| `finalizeTimelineSession` 末尾 | 释放本连接 timeline 租约 |

问题不是当前实现有已知缺陷，而是：判断顺序、错误文案和释放条件各自维护，修改任一开始路径时容易漏掉另一条；sink 与租约在概念上属于同一个占用关系，却分成三份可变状态。

## 2. 本批范围

新增 `server/practice/session-ownership.mjs`，导出 `SessionOwnership`：

- 唯一持有 `timelineLease`、`followLease`、`nodeSink`。
- `assertTimelineStartAllowed({ socket, hasNative, hasFollowRuntime })`：保持现有检查顺序与错误文案；其他连接已断连的 timeline 租约被丢弃，不阻塞下一次开始。
- `assertFollowStartAllowed({ socket, hasNative, hasActiveTake, hasFollowRuntime })`：保持现有检查顺序与错误文案。
- `claimTimeline(lease)`、`claimFollow(lease)`：仅在无冲突时写入；已有其他连接持有时抛错，防止未来调整顺序后静默抢占。
- `releaseTimeline(socket)`、`releaseFollow(socket)`：只释放本连接持有的租约，重复调用无副作用。
- `attachSink(sink)`、`detachSink(sink)`：按函数身份摘除，避免旧连接的清理摘掉新连接的 sink。
- `dispatch(event)`：仅当存在 sink 时转发 Node MIDI 事件。
- `isTimelineHeldBy(socket)`、`isFollowHeldBy(socket)`：只读查询，供后续阶段使用。

不改变：协议字段、错误文案、开始/结束顺序、Rust 评分、保存格式、Follow 推进策略。

## 3. 接入方式

`engine-server.mjs` 用单个 `const ownership = new SessionOwnership()` 替换三个 `let`，所有读写改为调用上表 API：

- `midiAdapter.onEvent` 的 sink 转发改为 `ownership.dispatch(event)`。
- 两个 `start` 分支的冲突检查改为 `assert*StartAllowed`。
- `release*Resources`、`socket close`、`finalizeTimelineSession` 末尾改为 `release*`。
- 资源发布点（`activeTakeLease = ...`、`activeFollowLease = ...`、`activeNodeSink = ...`）改为 `claim*`／`attachSink`。

`native`、`activeTake`、`followRuntime` 仍由连接闭包持有：它们是连接内的运行态，不是跨连接租约。本批不把它们搬进模块，也不改变其生命周期。

## 4. 测试

单元测试 `server/practice/session-ownership.test.mjs`：

- 两个连接竞争 timeline 租约：第二个被拒绝，文案为现有「另一个设备…」。
- 持有 timeline 的连接已关闭（`readyState !== 1`）时，新连接可以开始并取得租约。
- Follow 连接存在时，timeline 开始被拒绝；timeline 连接存在时，Follow 开始被拒绝。
- 本连接已有 follow 运行态时，timeline 开始被拒绝。
- 释放只影响持有者：另一端调用 `releaseTimeline` 不会清掉当前租约。
- sink 按身份摘除：旧连接 detach 不会摘掉新连接已挂载的 sink。

协议级回归沿用现有 `selftest.mjs` 的双浏览器租约场景、断连结算场景与 `armed-start.api.test.mjs` 的多次开始场景；本批不新增生产环境故障注入接口。

## 5. 验证命令

在 `rhythm-trainer-frontend/` 执行：

```sh
npx vitest run server/practice/session-ownership.test.mjs server/practice/take-lifecycle.test.mjs server/practice/take-cleanup.test.mjs
npm run typecheck:server
npm run selftest
npm test
npm run build
git diff --check
```

全量测试会重写三个已跟踪审计 JSON，运行后还原，不纳入提交。

## 6. 退出标准与后续

退出标准：单元测试覆盖冲突、断连接管、按身份释放；`selftest` 的双连接与断连场景通过；无协议或评分差异。

后续：

- P2.3 统一用户结束、自然完成、资源上限、断连的重叠边界，明确结束原因分类，不改变已持久化的历史字段（仍未开始）。
- Follow 的模式适配与资源编排共用本模块，不强迫 Follow 复用 timeline 评分模型（仍未开始）。

## 7. 实施记录：P2.2 启动资源分配收拢（2026-11-03）

新增 `server/practice/take-resources.mjs` 的 `allocateTakeResources(steps, { onFailure })`：

- 按声明顺序执行工厂，后一步通过上下文读取前一步的产物（`journal` 记录 `take_started`）。
- 任一步抛错时，`onFailure` 只收到已创建的资源；原始错误始终向上抛出，回滚自身抛错不会覆盖它。
- 模块不自行释放资源。timeline 的释放仍由既有 `failActiveTake` 完成（封存 journal/trace、摘 sink、释放租约），避免出现第二套清理路径。
- `engine-server.mjs` 的 `start` 分支把 trace、journal、`take_started`、live feedback、sink 五项收进一次 `allocateTakeResources` 调用；失败时先回填部分资源再调用既有失败路径，外层 catch 用一次性守卫避免重复清理。
- 行为不变：分配顺序、`started` 消息字段、`take_started` 内容、失败错误文案与清理证据均保持原样。

验证：`server/practice/take-resources.test.mjs` 4 项通过（顺序、部分资源回滚、回滚失败不掩盖原始错误、无回调仅重抛）；`take-resources` + `armed-start.api` + `follow-protocol` + `take-persistence` 共 41 项通过；`npm run typecheck:server` 通过；`npm run selftest` 251 项通过；全量 1161 项中 1155 通过、5 skip、1 失败仍是既有 E5 缺真实谱环境阻塞。
