# R2-3h-R2-F1b 修复报告：透明淡化补齐符干/符杠/符尾等

**verifiedCodeSha：** `97c4530cf055e67eac86f6dff7ecd8348a161230`（`97c4530`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**前置：** R2-3h-R2-F1（`514d008`）已修正显示手别来源；本报告处理用户反馈的“透明不完整”。

## 1. 缺陷

`OsmdScoreView` 的淡化逻辑只对 `vf-stavenote` 组设置 `opacity: 0.22`。OSMD/VexFlow 把**符干、符杠、符尾、加线、连音线、修饰符**渲染成该组的**同级 SVG 组**，不在 `vf-stavenote` 内部，因此它们保持 `opacity: 1`。

修复前 DOM 实测：

- `vf-stavenote`：部分为 `0.22`；
- `vf-beam`：**420 个全部 `opacity: 1`**；
- `vf-stem`：全部无 opacity；
- `vf-flag`：68 个全部无 opacity，其中 34 个在几何上紧邻已淡化的左手音符；
- `vf-notehead`：511 个因父组 `vf-stavenote` 继承而变淡。

视觉结果就是：符头变淡、符杠/符干/符尾仍然黑，正是“透明不完整”。

## 2. 修复

`score-view-adapter.ts` 新增 `setScoreEventOpacity(scoreEventId, opacity)`。不再依赖 DOM id 前缀猜测，而是使用 OSMD `VexFlowGraphicalNote` 文档化的 SVG getter：

- `getSVGGElement()`
- `getNoteheadSVGs()`
- `getStemSVG()`
- `getBeamSVGs()`
- `getLedgerLineSVGs()`
- `getTieSVGs()`
- `getSlurSVGs()`
- `getGlissandoSVGs()`
- `getFlagSVG()`
- `getModifierSVGs()`

`OsmdScoreView` 在设置和清除淡化时都调用该方法（清除时传空字符串），因此离开范围/切换手别后所有关联图形都会恢复。`getFlagSVG` 等 getter 不在 `GraphicalNote` 基类类型里，用局部 `VexFlowNoteSvgApi` 类型收窄，并对调用做容错，避免 OSMD 版本差异打崩页面。

## 3. 真实浏览器验证

重载页面并选择右手后（默认谱表 1→右、2→左；映射状态可在确认后覆盖）：

| 类 | 被淡化覆盖的对象数（组本身或组内 path） |
|---|---:|
| `vf-stavenote` | 443（组本身） |
| `vf-notehead` | 511（组本身） |
| `vf-stem` | 441（组内 stem path） |
| `vf-beam` | 83（组本身） |
| `vf-flag` | **34 / 34**（组本身） |
| `vf-stavetie` | 16（组本身） |
| `vf-ledgers` | 142（组内加线 path） |
| `vf-modifiers` | 443（组本身） |

> 说明：`getStemSVG()` 和 `getLedgerLineSVGs()` 返回的是 path，不是外层 `g.vf-stem`/`g.vf-ledgers` 组；因此这两类的 opacity 设在子 path 上（441 个 stem 组、142 个 ledgers 组各含被设为 0.22 的 path），其余类直接设在组上。最终合计 632 个 `path` 被设为 0.22。

- 符尾按几何邻近判断：34 个邻近已淡化音符的 flag **全部**被淡化，`nearMutedButUnmuted = 0`。
- 上谱表右手音符及其符杠/符尾保持正常黑色（未被计入淡化）。
- 修复前的“420 个 beam 全部不透明、68 个 flag 全部不透明”已消除。

浏览器为 ZCode IAB，手工/脚本化操作，非 CI E2E。

## 4. 运行结果

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run`（全量） | **500 passed / 4 skipped**（48 文件通过 / 2 跳过） |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed**（本轮未改 Rust，沿用同会话结果） |
| `npm run selftest` | **251/251**（本轮未改服务端，沿用同会话结果） |

## 5. 边界

- 无 CI、无独立浏览器 E2E；以上为真实浏览器 + 本地测试结果。
- 该修复只改变显示 opacity，不改变目标、评分、计划或 Rust 权威。
- 手别映射仍不跨刷新持久化（既有问题）；默认谱表映射在刷新后仍能正确淡化。
- 生产默认规划权威仍为 `rts`，未合并 `main`。
