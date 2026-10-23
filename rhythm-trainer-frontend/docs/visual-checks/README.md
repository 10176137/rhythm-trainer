# Score reading visual checks

Date: 2026-10-21  
Page: `http://127.0.0.1:5173` (Vite dev server, engine service on `127.0.0.1:8788`)  
Viewport: 1600 × 1400  
Capture: the full-width `.score-card` region (wide cards stitched from two clips; see Notes)

## Files

| File | State | What to check |
| --- | --- | --- |
| `score-clean-view.png` | 默认纯净谱面，音名/线间提示关 | 4 小节 C 大调练习曲；绿色当前拍胶囊；当前音黑色、后续音浅灰；小节号、花括号、左右手旋律/伴奏说明、阅读提示和展示目标脚注 |
| `score-active-note.png` | 默认纯净谱面，第一小节特写 | 当前音绿色胶囊、后续音浅灰、无默认音名标签；与参考图的 active-note 效果一致 |
| `score-note-names-on.png` | 音名提示开 / 线间提示开 | 四小节谱面上的音名与线/间文字；当前音仍有绿色胶囊 |
| `score-note-names-off.png` | 音名提示关 / 线间提示关 | 默认纯净谱面；没有音名/位置标签，点击音符仍可查看详情 |
| `score-ledger-demo.png` | 单谱表谱表外示例 | C4/A3/F3 下方 1–3 条加线；G5/A5/C6/E6/B5 上方间/加线；当前音绿色胶囊 |
| `osmd-mapping-spike.png` | OSMD 2.2.1 mapping spike | 实际 OSMD 渲染结果与 fixture 映射 PASS 标签；机器可读结果见 `docs/osmd-mapping-spike.json` |

## Reproduce

1. Start the engine service and Vite:
   ```bash
   npm run server
   npm run dev -- --host 127.0.0.1
   ```
2. Open `http://127.0.0.1:5173`.
3. `练习设置 → 识谱辅助` controls 音名提示 / 线间提示. Both are off by default for the clean presentation.
4. `练习设置 → 乐谱来源` has `导入 MusicXML`, `谱表外示例`, and `恢复默认乐谱`.
5. Click the speaker icon in the score header to preview the current target note.
6. For the MIDI-match check: click 开始练习, wait for the count-in, click 模拟按键, and confirm the active note gets the green MIDI halo and the inspector shows `MIDI 匹配`.

## Notes

- These are visual inspection records, not automated pixel regression baselines. Programmatic checks live in
  `src/features/score/staffMapping.test.ts`, `scoreLayout.test.ts`, and `musicXmlParser.test.ts`.
- The wide card screenshots are stitched from two viewport clips because the in-app browser's screenshot
  backend tiles very wide clips; the UI itself is a single card.
- The practice/import path now goes through `src/score-engine/` (semantic importer + PlaybackPlanner); the custom SVG remains the production React view while OSMD is a mapping spike. The default practice score is the parsed 4-bar `c-major-practice.musicxml`; the original 2-bar
  `rhythm-trainer-score-reading-example-v2.musicxml` remains the fixture-contract/import example. The
  MusicXML importer is a limited browser-side subset, not a full parser. See `docs/score-reading-assist.md`.
