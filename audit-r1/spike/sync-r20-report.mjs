import { readFileSync, writeFileSync } from 'node:fs';

const path = 'D:/123/R2_0_CONTRACT_FREEZE_REPORT.md';
let text = readFileSync(path, 'utf8');

// 1) Sync the stale §5 item (AJV wiring completed by §8.1).
const stale = '5. ajv 或等价 validator 对两份 Schema 的自动校验接线（当前为手写闭合检查 + Schema 文档）。';
const synced = '5. ~~ajv 或等价 validator 对两份 Schema 的自动校验接线~~ **已由 §8.1 完成**：`plan-fingerprint.ts` 直接编译两份已提交 Schema（AJV Draft 2020-12），并有 schema_violation 负例。仍未独立交付的只剩 ImportReport 的完整 V1 schema（本卡只冻结了职责边界与 capabilities 枚举）。';
if (!text.includes(stale)) throw new Error('stale §5 item not found');
text = text.replace(stale, synced);

// 2) §3 header: state the final numbers (superseding the intermediate 241).
const old3 = '| `npm run selftest` | 通过（251 条，引擎侧未变） |';
const new3 = '| `npm run selftest` | 通过（251 条断言，最终态；中间数字见 §6/§7） |';
if (!text.includes(old3)) throw new Error('selftest row not found');
text = text.replace(old3, new3);

// 3) Record the formal P6/P7 decision from the review.
const decision = `

---

## 11. 审查结论记录（R2-0 正式验收）

依据对 d7d4472 的复审，项目状态正式记为：

| 项 | 状态 |
|---|---|
| **P6** ScoreDocumentV1 Schema 与版本策略 | **CLOSED** |
| **P7 Contract** planFingerprint 定义（payload/JCS/SHA-256/输入清单/plannerVersion） | **CLOSED** |
| **R2 Golden Semantic Differential / TS↔Rust Parity Gate** | **OPEN**（下一张卡 R2-1：先冻结验收规则，不直接写 Rust planner） |

要点：P7 指纹契约的关闭不等于 Rust 迁移验收通过；golden 语义差分门槛保持开放。113 小节真实谱继续进入回归矩阵以验证大谱面兼容性，但 TS 与 Rust 互相一致不能作为正确性证明（可能共享同一语义错误），正确性仍以 G1–G5 手工推导真值为独立基准。
`;
if (!text.includes('## 11. 审查结论记录')) throw new Error('decision section already present');
text = text.trimEnd() + '\n' + decision;

writeFileSync(path, text);
console.log('report synced: §5 item + §3 row + §11 decision recorded');
