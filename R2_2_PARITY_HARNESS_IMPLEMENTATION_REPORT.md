# R2-2 实施报告：Parity Harness 与固定用例落地（TS 侧）

**日期：** 2026-10-25
**基线：** `main` @ `b03cdd5`（R2-1 Accepted/Frozen 终版之后）
**任务卡：** R2-2 工程任务卡（Parity Harness 与固定用例，TS 侧先行）
**提交拆分：** ①`3084afb` 比较器+Schema+runner → ②`f43431a` case bundle+手工真值+V6 向量 → ③`09e30ab` A/B/C/V 验收测试 → ④本提交（真实谱门禁+证据报告）
**状态声明：** `R2-1 Design Frozen / Accepted`；`R2-2 TS-side parity harness + frozen cases implemented and tested`；**`R2-3 Rust planner not started`**。所有报告 `rustSide: "not-implemented / not-run"`；**未发生 TS↔Rust parity 通过、迁移验收或权威切换**。

---

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `rhythm-trainer-frontend/src/score-engine/parity/parity-diff.ts` | 纯函数比较器（R2-1 §3.1–3.4 逐字段）：locator+pass 对齐 occurrence、pass+beat 对齐 group、tick 对齐 atom；BigInt 有理精确比较；canonical µs **零容差**；legacy ms→µs ≤1 µs 归因 `time-rounding`（>1 µs semantic-defect）；atom.beat serialization-only；运行时 ID 结构规则（唯一性+`:p{pass}:` 段）；封闭键检查（未知字段 → `unclassified` fail-closed） |
| `.../parity/parity-candidate.ts` | 现行管线（importer→planner→hand filter→atoms/scoreEvents）投影 canonical 候选；BigInt canonical µs（`CountInUs + roundHalfUp` 冻结公式）；强制门禁 `planFingerprintV1`（公共冻结 plannerVersion `parity-harness-1`）；P1-3 不变量离线复算（精确 µs，无 0.5 ms 容差） |
| `.../parity/case-bundle.ts` | bundle 加载（fixture sha256 冻结校验 + AJV schema-first）；golden `g*.expected.json` → canonical 期望**确定性转换器**（跳过 tie 续接/装饰音，locator 从冻结事件序推导；**不复制第二份真值**）；spelling→pitch 解析（含 midi 交叉校验） |
| `.../parity/normative-codes.ts` | C 类规范码 + 四个冻结服务端消息锚点；纯函数镜像服务端校验；**映射只认冻结锚点，其余一律 null（不 reinterpret）** |
| `.../parity/parity-runner.ts` | full/case/fault 三模式；`ParityDiffReportV1` 装配（rustSide 恒定声明）；六个冻结 B 类故障注入；确定性报告落盘；退出码语义 |
| `audit-r1/contracts/parity-case-bundle-v1.schema.json` | case bundle 契约（draft 2020-12：sha256 冻结 fixture、显式配置、`clef-heuristic` 拒绝、loop≤32、非负整数 CountInUs、必填公共 plannerVersion） |
| `audit-r1/contracts/parity-diff-report-v1.schema.json` | 报告契约（`generatedAt` 仅 meta、差异按 path 排序、rustSide 常量） |
| `audit-r1/fixtures/parity-cases/index.json` | **15 个冻结 case**（每个 fixture sha256 固定；字节变更即新 case） |
| `audit-r1/fixtures/parity-cases/*.musicxml` ×2 | 新最小 fixture：`a4_multivoice`（A4）、`a9_same_onset_diff_duration`（A9），各配手工推导 expected |
| `audit-r1/fixtures/parity-cases/expected/*.json` ×11 | 手工推导 canonical 真值（含 derivation 字段）；G1–G4 复用已提交 golden（转换器），**未复制第二份真值** |
| `audit-r1/spike/parity-runner.entry.mjs` | 离线 CLI 入口（esbuild 打包，无新依赖） |
| `audit-r1/reports/r2-2/*.json` ×16 | 全量实跑 JSON 差分报告（15 case + fault-injection） |
| 4 个验收测试文件 | `acceptance-a/b/c/v.test.ts`（详见 §3） |
| `real-score-parity.test.ts` | 113 小节真实谱结构不变量（env 门禁，PASS/SKIP 严格区分） |

## 2. 冻结的 15 个 case

| case | fixture | 权威 | 验证点 |
|---|---|---|---|
| G1/G2/G3/G4-base | g1–g4 | **已提交 golden（转换器）** | 四层全字段 exact；count-in 恰为整数 µs，两协议无歧义 |
| G5-base | g5 | 手工推导（冻结偏移公式） | **记录在案的差异**：golden 按"总值单次舍入"推 3,333,333/5,333,333；冻结 R2-1 §3.5 按"偏移单次舍入"+CountInUs 2,666,667 推 3,333,334/5,333,334——beat 1/4 上 +1 µs 的**协议间量化差**，parity 真值遵冻结协议（详见 index notes 与两份 derivation） |
| G1-A5-range-m2 | g1 | 手工推导 | range 重定基（playbackBeat 0/1、bar 不变）、atom 0/1920 |
| G1-A10-loop-x2 / x3 | g1 | 手工推导 | passIndex、+8/+16 拍偏移、bar/beatInMeasure 不平移、occurrence 每 pass 唯一、同音符跨 pass 合法重复 |
| G3-range-m2 | g3 | 手工推导（冻结正向语义） | tie 起点在 range 外 → 0 occurrence、不重定锚；阻断链：`no_playable_notes`（blocksStrict）→ 门禁 `PAYLOAD_VALIDATION_FAILED`（底层 issue `empty_plan`，plan-fingerprint.ts:1061/:1158） |
| G6-A3-base / hand-right / hand-left | g6 | 手工推导 | backup 双谱表同 onset 一组两成员一 atom；hand 过滤组缩减；**hand-left playbackIndex 保持 1**（过滤不重编号，R2-1 §10③ 现行为基准） |
| A4-multivoice | 新 fixture | 手工推导 | 同 onset 同 staff 异 voice → 一组（键不含 voice）、voiceIds 排序 |
| A9-mixed-duration | 新 fixture | 手工推导 | 组时值=最长 4 拍（atom 3840），成员保留各自 1/4 拍 |
| G1-rational-bpm | g1 | 手工推导 | BPM 175/2：CountInBeats=35/8 精确约分进 payload；偏移 0/685714/1371429/2057143/2742857（half-up）；时值 685714×4+1371429 |

## 3. A/B/C/V 验收测试（vitest，54 项 parity 测试）

- **A 类**（`acceptance-a.test.ts`）：复用映射锚定既有契约测试（N-PITCH-S1、N-FP-S1×2、N-FP-S2——运行时校验锚存在，防腐烂）；补真缺口 **N-PITCH-S2**（C4→B#3 同 midi 改 spelling → 指纹必变）。
- **B 类**（`acceptance-b.test.ts`）：六项冻结故障经真实比较器——须在**冻结路径前缀**捕获、归类 `semantic-defect`、报告 FAIL（meta-proof：比较器若忽略该字段，此断言即失败）；fault 批模式 exit 0 = 全部被捕获；尾随干净全跑证明 golden 未被自升格。
- **C 类**（`acceptance-c.test.ts`）：harness 层四规范码（`duplicate_target_id`/`invalid_target_pitch`/`measure_coverage_mismatch`/`target_outside_prescription_range`）+ 锚点映射只认冻结文本（无关错误返回 null）；契约层按**冻结入口**断言：投影 `DUPLICATE_XML_ID`（大写）与同口 `DUPLICATE_EVENT_ID`、payload 构建 `DUPLICATE_OCCURRENCE_ID`、planner 输入 `invalid_range`/`invalid_repeat_count`（0/33）、空计划门禁链、importer 上游 `unrepresentable_pitch`（blocksStrict）；C3a/C3b/N-FP-C1..C3 复用映射锚定。
- **V 类**（`acceptance-v.test.ts`）：6 向量双路径逐字节（参考实现 + 独立 canonicalize+node sha256 + 提交 canonical bytes round-trip）；V6 冻结 175/2 与 35/8；half-up 手推表断言；**`RUST_V_CLASS_STATUS = DEFERRED_TO_R2-3`** 显式声明。

## 4. 测试结果（最终状态：两轮复审全部修复后的复跑；历史递进见 §9/§10）

| 命令 | 结果 |
|---|---|
| `npx vitest run`（未设 RHYTHM_REAL_SCORE_PATH） | **42 files（41 passed + 1 skipped）/ 368 passed + 3 skipped tests**（跳过 = 真实谱门禁 3 项：契约 113 小节回归 1 + R2-2 parity 结构不变量 2；**SKIP 不计 PASS**。历史递进：首提交 360/3 → 首轮复审修复 366/3 → 二轮复审修复 367/3 → 三轮复审修复 368/3） |
| `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/parity src/score-engine/contract-v1` | **125/125**（113 小节真实谱回归与 parity 结构不变量实际执行；历史：首提交 61/61 契约 + 后补 parity 2/2 → 首轮复审修复 117/117 → 二轮复审修复 124/124 → 三轮复审修复 125/125） |
| `node parity-runner.bundle.mjs --mode=full` | **15/15 case PASS**（0 semantic-defect、0 unclassified、0 time-rounding 未解释项）+ 6/6 fault 捕获，**exit=0**；报告落盘 `audit-r1/reports/r2-2/`（16 份，两轮复审后重新生成） |
| `node parity-runner.bundle.mjs --mode=fault` 三路退出码 | 未知 `faultId` → **exit 1**（抛错）；全 fault 批 → exit 0（只产出 fault 报告，reports=0）；full → exit 0 |
| `npm run build`（tsc -b && vite build） | 通过 4.02s |
| `npm run selftest` | **251 条断言全部通过**（本轮零生产代码改动，按卡要求照跑） |
| Rust | **零改动**（本卡不涉及；按边界未触碰） |

## 5. 过程中发现并修正的实现缺口（均非生产缺陷）

1. runner 曾给 fileName 追加 caseId 装饰 → 触发 importer 扩展名门禁（`unsupported_extension`）——去掉装饰；
2. golden 转换器最初未跳过 tie 续接（G3 事件 2 / occurrence 1）——按 planner 同款过滤修正；
3. 阻断 case 的指纹错误码：手推期望写了 issue 层 `EMPTY_PLAN`，实测门禁层是 `PAYLOAD_VALIDATION_FAILED`（内含 `empty_plan`）——以代码为准修正期望并写明两层码链；
4. 运行时 ID 前缀检查过严：hand 过滤会改写 planId（`:hand=…` 后缀）但保留成员 occurrenceId——放宽为 `:p{pass}:` 段检查并注明现行为基准；
5. G2 哈希在 index 中抄录缺一字符——被 sha256 冻结校验当场拦截（冻结机制自身的正向证明）。

## 6. 已知边界与未完成项（诚实清单）

- **Rust 侧全部缺位**：L1 的 TS↔Rust 相等、N-FP-V1 Rust 复现、C 类 Rust 码——均 **R2-3**；
- legacy ms 侧 ≤1 µs 归因项在 G1–G5 上实测为 **0 条**（现行 float 链在整数 µs 恰好整除的 case 上无舍入差）；该通道的容差机器只在出现差异时生效；
- 服务端四类拒绝的机器码化（结构化错误携带 code）仍为可选生产改进，不属本卡；
- 真实谱 parity 结构回归是**结构不变量**（计数/能力集/指纹稳定 + 既有 golden 全字段），不构成"TS 自身正确"的证明——权威仍是手工真值（R2-1 §7/§10）。

## 7. 复现命令

```bash
cd rhythm-trainer-frontend
npm test                                   # 全量 vitest（真实谱默认 SKIP）
RHYTHM_REAL_SCORE_PATH=<path> npx vitest run src/score-engine/contract-v1 src/score-engine/parity
./node_modules/.bin/esbuild ../audit-r1/spike/parity-runner.entry.mjs --bundle --platform=node \
  --format=esm --outfile=../audit-r1/spike/out/parity-runner.bundle.mjs
node ../audit-r1/spike/out/parity-runner.bundle.mjs --mode=full --reportDir=../audit-r1/reports/r2-2
node ../audit-r1/spike/out/parity-runner.bundle.mjs --mode=fault          # 仅 6 项故障注入
node ../audit-r1/spike/out/parity-runner.bundle.mjs --mode=case --caseId=G1-base
npm run build && npm run selftest
```

## 9. 复审修复（2026-10-25，R2-2 首轮复审四项阻断全处理）

首轮复审（基线 604101f，静态）结论：substantially complete 但暂不关闭。逐项处理：

### 9.1 P1-1 退出码未执行 L1/L3 门禁 → 已修

`runCase()` 的 case 通过判定从"仅差分汇总干净"改为**四层门禁各自判定后取合取**：`reportPasses(categories) ∧ L1 status pass ∧ stableAcrossRuns ∧ 全部 P1-3 不变量绿 ∧ wire ≠ fail`。stableAcrossRuns 现在计算一次并写入 l1 与判定（此前算两次且不参与判定）。`runParity()` 退出码消费同一综合判定。预期拒绝 case 的通过规则不变（L1 按 fingerprintErrorCode 对比），但现在若其 P1-3/稳定性失败同样无法逃逸。

### 9.2 P1-2 configFingerprint 白名单缺陷 → 已修

原 `JSON.stringify(config, Object.keys(config).sort())` 的数组 replacer 是**全层级**属性白名单，嵌套的 range/bpm 字段被静默丢弃，不同配置可能同哈希。改为 `stableSerialize()`：每个对象层级递归排序键的完整序列化。新增 4 项负测：range end、bpm 分子、loop count、handMapping hand 任一改动 → 哈希必变（加原有键序稳定性测试）。

### 9.3 P1-3 Map 对齐折叠重复语义键 → 已修

`diffCandidates()` 在四层对齐**之前**对两侧分别做语义键重复检查（occurrence=locator+pass、group=pass+beat、atom=startTick、scoreEvent=locator+pass），重复即 `semantic-defect`（path 形如 `candidate.occurrences[<key>].duplicate`）。新增 4 项负测（四层各一）+ expected 侧重复同样被抓的断言。此前 `runtimeIds` 唯一性检查是 ID 层，不覆盖语义键层，现两层并存。

### 9.4 G5 时间真值裁决 → 已裁决并执行（最终批准权在复审人）

**裁决：时值权威 = R2-1 §3.5 冻结协议**（`TargetOnsetUs = CountInUs + roundHalfUp(offset)`，CountInUs 为整数 µs 输入）。依据：① GOLDEN_FIXTURES 自身 §1.1 定义表与 §1.3 产品规则（整数 µs 输入）；② 原 §6.2 公式 `round((4+beat)×…)` 隐含 count-in 为精确有理数、消掉了 count-in 量化，与 §1.1/§1.3 冲突——属 2026-10-23 勘误的残留错误；③ R2-1 冻结规范经四轮复审通过（RF-01 逐字对齐 `beatToMicroseconds()`）。

同步执行：
- `g5.expected.json` 修订（beats 1/4：3333333→3333334、5333333→5333334；derivation 记录修订原因/日期/规则版本）；五个 golden 全部补 `countInUs` 字段（G1–G4 数值不变）；
- `GOLDEN_FIXTURES.md` §6.2 增加正式裁决记录（§6.3）；
- `golden.fixtures.test.ts` 推导函数改为冻结协议（BigInt half-up）；实现 ms 对照放宽为显式 ≤1 µs legacy 容差；G5 legacy 差异显式分类 `time-rounding`（−1 µs ×2），G1–G4 保持全 exact 断言；
- **G5-base case 改回复用修订后 golden**（删除独立手工副本 `expected/G5-base.json`）——"G1–G5 全部复用既有真值"恢复成立；
- runner 重跑 15/15 PASS、6/6 fault、exit=0；golden 测试 51/51。

**此裁决已按真值修订纪律记录（原因/日期/规则版本/影响面），并在提交信息与两份文档中显著标注"最终批准权在复审人；否决则整体 revert"。**

### 9.5 其他复审意见落实

- `reportPasses()` 不再无条件放行 `unsupported-behavior`：任何此类差异现在都判 fail（当前无 case 声明预期放行；将来需要时须在 bundle 显式声明，另立判定）；+1 负测。
- 数字口径统一（当时口径 360/3；二轮复审修复后最终为 367/3，见 §10.4——§4 表为最终状态）：全量 vitest 为 42 files（41 passed + 1 skipped file），跳过 = 真实谱门禁 3 项；§4 与提交信息使用同一口径。
- 首版报告的"10/11"保守自评已由本节替代：复审四项阻断处理后，§10 清单 11/11 逐项有据（见 §7 复现命令可全部复跑）。

**R2-2 关闭申请（更新）**：见 §10 二次复审修复。

## 10. 二次复审修复（2026-10-25，G5 裁决方向已批准；两项收尾全处理）

二次复审（基线 e6ee4a6）批准 G5 裁决方向与配置哈希、重复键两项修复；指出 runner 隔离/分层状态与 G5 文档同步两类收尾。逐项处理：

### 10.1 fault 模式隔离与失败路径 → 已修（含连带发现的 CLI 解析 bug）

- `runParity()` 的 fault 模式现在**只跑请求的故障注入**（cases=[]），不再顺带执行全部普通 case；
- **未知 `faultId` 抛错**（`faultId not found`）——之前空数组 `every()` 空真可能 exit 0；另加空 fault 批保护（`faultsAllCaught` 要求 `length > 0`）；
- **连带发现并修复 CLI 参数解析 bug**：`flag('mode')` 用 `indexOf('--mode')` 精确匹配，`--mode=fault` 连等号形式解析不到、静默回落默认 `full`——该 bug 自 entry 创建以来潜伏（此前 CLI 只跑过 full 恰好没暴露；B 类验收走 vitest 不经此路径）。改为同时支持 `--name=value` 与 `--name value`；
- 实测三种退出码：`--mode=fault --faultId=N-DOES-NOT-EXIST` → **exit 1**（抛错）；`--mode=fault`（6 项全捕获）→ exit 0 且**只产出 fault 报告（reports=0）**；`--mode=full` → exit 0（15 case + 6 fault）。
- 新增 2 项验收测试：fault 模式 `reports` 长度为 0；未知 `faultId` 必须 `toThrow(/faultId not found/)`。

### 10.2 分层状态各自真实 → 已修

`l1.status` = 指纹存在/预期错误码匹配 **∧** 跨运行稳定（稳定性本就是 L1 属性）；`l2.status` = 差分分类干净（含 expected-outcome 一致性）——不再借用综合结果；`l3.status` = P1-3 不变量全绿 ∧ wire 兼容——不再 `&& pass`。综合 `summary.pass` = 三层各自状态的合取。这样 L1 失败时干净的 L2/L3 仍如实报告 `pass`，分层证据不失真，而总门禁不变。

### 10.3 GOLDEN_FIXTURES G5 文档同步 → 已完成

- §6.2 主文本：手推改为冻结协议（CountInUs 2 666 667 + 偏移表 0/666 667/1 333 333/2 000 000/2 666 667/3 333 333 → TargetOnsetUs `2 666 667, 3 333 334, 4 000 000, 4 666 667, 5 333 334, 6 000 000`），旧公式不再出现在正文；
- §6.3 期望输出：`targetOnsetUs` 更新为裁决后值（+`targetDurationUs` 666 667×6），标注裁决来源；
- §6.5：表格更新——四项 exact，beats 1/4 差 **−1 µs** 显式分类 **time-rounding**，删除"无差异"声明；测试断言口径（G1–G4 全 exact、G5 两处 rounding）已写明；
- `g5.expected.json` 的 `derivation` 重写：冻结协议为唯一正文，旧值仅作为"已被取代"记录并指向 §6.5；
- 全文扫查：3333333/5333333 残留仅存在于裁决表"旧 dump 值"列（应保留的历史对照）。

### 10.4 证据重跑（三轮复审修复后最终实跑；§4 为同一最终状态）

| 命令 | 结果 |
|---|---|
| `npx vitest run`（未设 env） | **42 files（41+1 skipped）/ 368 passed + 3 skipped**（+1 分层独立性负测） |
| `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/parity src/score-engine/contract-v1` | **125/125** |
| runner full（报告重新生成至 `audit-r1/reports/r2-2/`） | 15/15 case PASS + 6/6 fault 捕获，exit=0 |
| runner fault 三路退出码 | unknown faultId=1 / 全 fault 批=0 / full=0 |
| `npm run build` / `npm run selftest` | 通过 4.02s / 251 条 |

**R2-2 关闭申请（二次更新）**：两项收尾（runner 隔离+分层状态、G5 文档同步）全处理，G5 裁决方向已获批准并完成文档同步。状态：`R2-2 TS-side parity harness implemented and tested`、`R2-3 Rust planner not started`、无权威切换、无 Rust 代码。**申请三次复审确认后关闭 R2-2。**
