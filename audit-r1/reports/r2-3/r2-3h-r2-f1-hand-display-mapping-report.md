# R2-3h-R2-F1 修复报告：显示手别再按谱号推断

**verifiedCodeSha：** `514d008677c66afedb1bfcfeb0900ee6ead1462e`（`514d008`）
**报告提交：** 单独提交（与被测 SHA 分开）。
**来源：** R2-3h-R2 验收后的真实浏览器反馈——右手练习时，下谱表部分音符仍是黑色（未淡化）。

## 1. 缺陷

旧版显示桥 `src/score-engine/legacy-bridge.ts` 用**谱号**推断 `ScoreNote.hand`：

```ts
hand: staff === 'bass' ? 'left' : 'right'
```

真实曲谱《晓之车》从第 9 小节起，左手所在的第 2 谱表改用**高音谱号**。按 XML 统计，第 2 谱表约有 **145 个音符**处在高音谱号下，被标成 `hand: 'right'`。

显示淡化逻辑（`ScoreViewer` 的 `mutedNoteIds = score - visibleTargetNotes`，其中 `App.visibleTargetNotes` 按 `note.hand` 过滤）因此认为这些左手音符是右手目标，不淡化它们。实测（修复前，hand=right，映射 1→右/2→左）：

- 第 1–7 小节下谱表：`muted 2/2`；
- 第 9–13 小节下谱表：`muted 0/7、0/6、0/8、0/6、0/3`；
- 阅读提示计数为谱号口径：右手 1210 / 左手 400。

**这不是练习目标错误**：严格练习 / Rust 计划走的是显式 `handByScoreEventIdFromMapping`，目标本身正确；错误只在显示层的淡化、手别标签和计数。

## 2. 修复

1. **显示默认改为按谱表**（`legacy-bridge.ts`）：谱表 1→右手，谱表 2+→左手；谱号只决定 `staff`（高/低音谱表的记谱位置），不再决定手别。
2. **显式映射优先**：新增 `applyHandMappingToLegacyNotes(notes, engine, handMapping)`，把用户确认的 `staff→hand` 映射重新应用到 legacy notes。`App.tsx` 在 `handMappings` 或 `scoreDoc.engine` 变化时调用；helper 在无变化时返回同一数组，避免 setState 循环。这样 `visibleTargetNotes`、淡化、右手/左手计数、音符手别标签、`practicePlan` 与 `scoreLayout` 全部使用同一来源。
3. **提示文案**：由“高音谱表=右手、低音谱表=左手”改为“上方谱表通常对应右手、下方谱表通常对应左手，实际以你确认的「谱表→手别映射」为准”。

## 3. 回归测试

`src/score-engine/test/importer.test.ts` 新增 2 项（clef-carry fixture：第 2 谱表在第 2 小节切到高音谱号）：

1. 默认情况下 `staff='treble'` 但 `hand='left'`（谱号不再决定手别）；
2. 显式映射把谱表 2 映射成右手时，helper 将对应音符改为 `right`，且不修改原 `doc.notes`。

## 4. 真实浏览器验证

修复后重载页面（内存中的映射先丢失，验证默认路径），再选择右手：

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 第 9–13 小节下谱表淡化 | 0/7、0/6、0/8、0/6、0/3 | **7/7、6/6、8/8、6/6、3/3** |
| 阅读提示计数 | 右手 1210 / 左手 400（谱号口径） | **右手 1099 / 左手 511**（谱表口径） |
| 显式映射覆盖 | 未验证 | 临时把谱表 2→右手并确认：计数 1610/0，下谱表全部不淡化；恢复 2→左手后回到 1099/511 且全部淡化 |

浏览器为 ZCode IAB，手工/脚本化操作，非 CI E2E。

## 5. 运行结果

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | exit 0 |
| `npx vitest run src/score-engine/test/importer.test.ts` | 30 passed（含 2 项新增） |
| `npx vitest run`（全量） | **500 passed / 4 skipped**（48 文件通过 / 2 跳过） |
| `cargo test --target x86_64-pc-windows-gnu --offline` | **173 passed / 0 failed** |
| `npm run selftest` | **251/251** |

## 6. 边界与遗留

- **手别映射仍不跨刷新持久化**：`handMappings` 不写入 `localStorage`；刷新后需重新确认映射。本次修复使默认映射（谱表 1→右、2→左）在刷新后仍能正确显示，但用户自定义映射（如谱表 2→右）刷新后会回到按谱表默认，直到重新确认。该持久化问题未在本轮修改。
- `suggestClefHeuristicMapping` 仍用谱号生成“初始建议”，这是显示建议，必须由用户确认；它不再参与淡化/计数/练习目标。
- 无 CI、无独立浏览器 E2E；生产默认规划权威仍为 `rts`，未合并 `main`。
