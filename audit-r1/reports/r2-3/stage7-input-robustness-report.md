# Stage 7 MIDI 输入、暂停与故障鲁棒性报告

- 报告日期：2026-10-26
- 分支：`r2-3-rust-planner`
- 实现提交：`8914d73`（仅新增 empty Follow 生命周期测试；生产代码仍为 `753238b`）
- 性质：**本地验证，无 CI**；mock MIDI，不是真实硬件。
- 依据：`RHYTHM_TRAINER_ALGORITHM_UPGRADE_AND_ENGINEERING_DESIGN_V1_1.md` §10

## 1. 范围

本阶段不引入外部算法，只验证输入/暂停/故障边界。没有真实 MIDI 设备参与；所有设备路径均为 `RHYTHM_MIDI_BACKEND=mock` 或纯单元测试。

## 2. 必测场景与证据

| 场景 | 证据 | 结果 |
|---|---|---|
| Note On / Note Off 正常生命周期 | `midi.rs` 单元测试；`server/midi/adapter.test.mjs` | 通过 |
| Note On velocity=0 归一化为 Note Off（SP-A500 9nH,V=0） | `src/features/midi/midiDecoder.test.ts`；`adapter.test.mjs` | 通过 |
| 孤立 Note Off / 缺失 Note Off | `midi.rs` lifecycle 测试；benchmark `tl-missing-note-off`（duration 不可评估，不虚构 0ms） | 通过 |
| 同音快速重复 / 重复包 | `midi.rs` 重复音测试；benchmark `tl-fast-repeated-note`、`tl-duplicate-packet` | 通过（输入退化被标记） |
| 非法/迟到/乱序/同 timestamp | `midiDecoder.test.ts` 截断消息；`adapter.test.mjs` timestamp regression；`clock-map.test.mjs` | 通过；乱序不会被静默重写 |
| 时钟映射质量差 | `clock-map.test.mjs`（缺输入返回 null）；服务端 `clockMapping.status`；selftest 时钟场景 | 通过；不可计时标为 unscorable |
| 暂停期间输入排除 | `follow-protocol.test.mjs` 暂停拒绝 note；selftest pause/admission 场景 | 通过 |
| 恢复后的首个间隔 | `follow-protocol.test.mjs` `invalidateNextInterval`；Rust `follow.rs` 单测 | 通过 |
| 未结算目标只平移一次 | `usePracticeSession` resume 单次 shift + selftest pause 场景 | 通过 |
| 设备断连 | `adapter.test.mjs` 设备消失；`follow-protocol.test.mjs` 断连结算 interrupted Take | 通过 |
| 重新连接 | `adapter.test.mjs` close/reopen 不重复 listener；新连接可继续 | 通过 |
| 输入队列溢出 | `adapter.test.mjs` queue overflow 可见且 input health 降级 | 通过 |
| 事件上限（FOLLOW_INPUT_LIMIT=20000） | 代码路径存在并标记 `followInputsTruncated`；**没有 20k 输入的集成测试** | **未覆盖（已知缺口）** |
| 空输入 | 新增 `follow-protocol.test.mjs` empty Follow（0 completed，仍持久化、不伪造）；selftest 空乐谱；benchmark `tl-empty-input` | 通过 |
| 中途中止 | 断连 interrupted Take；`follow-abandon` | 通过 |
| 不完整证据 | `captureDiagnostics`、`inputQuality`、benchmark unassessable 标签 | 通过（标记而非猜测） |
| 写盘失败 | Stage 1 `take-finalization.test.mjs`、`take-persistence.test.mjs` | 通过 |
| 重试 / 重复 finish | Stage 1 persist-retry、重复 finish 不新增 Take | 通过 |
| 相同输入与版本 replay | `follow-protocol.test.mjs` 用 Take 内 `followGroups`+`followInputs` 重放；确定性基准 | 通过 |

## 3. 实测结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run`（全量） | 1 | 550 passed / 1 failed / 5 skipped（556） |
| `npm run selftest` | 0 | 251 项 `ok` |
| `cargo test --workspace` | 0 | 179 passed（Stage 3 后未改 Rust） |

- 唯一失败仍是 E5 真实谱 fixture 缺失（环境阻塞），不是输入鲁棒性回归。
- 5 个 skip 仍是真实谱/生成器门禁。
- Stage 7 新增 1 个 empty Follow 测试；完整 Vitest 仍会重写证据 JSON，已还原。

## 4. 语义确认

- 输入丢失 ≠ 用户漏弹：`unassessableScoreEventIds` / `inputQuality=degraded|unscorable` 显式标记；benchmark 与 Take 状态一致。
- 缺失 Note Off：保留起音证据，时值不默认为 0ms；benchmark 标记 `assessable=["pitch","onset"]`。
- 不静默去重/排序：同音重复由 Rust Follow 语义决定并留 duplicate 计数；adapter timestamp regression 会报告而不是改写。
- 暂停期间输入被拒绝；resume 只平移未来目标一次。

## 5. 已知缺口

1. **没有真实 MIDI 硬件验收**：本阶段全部 mock/单元；G0 真机证据仍属于既有阶段，不能替代。
2. **FOLLOW_INPUT_LIMIT 截断没有 20k 输入的端到端测试**：代码路径与 `followInputsTruncated` 字段存在，但没有实际触发；留待有性能预算时补。
3. **没有设备重连后自动恢复 Follow 的测试**：当前产品语义是断连即 interrupted Take，不承诺跨连接恢复。
4. **Pause 目标平移只覆盖 display/核心路径**：没有真实音频时钟下的长期漂移测试。
5. 事件上限/队列溢出只验证“可见降级”，没有验证 UI 的全部呈现路径。

## 6. 结论

在 mock/单元/协议范围内，Stage 7 必测的输入、暂停、断连、写盘失败与 replay 场景均有证据；未覆盖项已明确列出。**不声称真实硬件通过**，也不把 mock 写成硬件证据。
