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

## 4. 测试结果（全部实跑）

| 命令 | 结果 |
|---|---|
| `npx vitest run`（未设 RHYTHM_REAL_SCORE_PATH） | **43 files / 360 passed / 2 skipped**（跳过 = 真实谱门禁 2 项：契约 113 小节回归 + R2-2 parity 结构不变量；**SKIP 不计 PASS**） |
| `RHYTHM_REAL_SCORE_PATH=… npx vitest run src/score-engine/contract-v1` | **61/61**（113 小节真实谱回归实际执行） |
| `RHYTHM_REAL_SCORE_PATH=… vitest real-score-parity.test.ts` | **2/2**：113 小节结构不变量 PASS——113 小节、1579 occurrence（ID 全唯一）、1018 group、1018 atom、capabilities 恰 `chords/multi_staff/multi_voice/ties/tuplets` 五值、门禁指纹两次重跑逐字节稳定 |
| `node parity-runner.bundle.mjs --mode=full` | **15/15 case PASS**（0 semantic-defect、0 unclassified、0 time-rounding 未解释项）+ 6/6 fault 捕获，**exit=0**；报告落盘 `audit-r1/reports/r2-2/`（16 份） |
| `npm run build`（tsc -b && vite build） | 通过 5.01s |
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

**R2-2 关闭申请**：10/11 验收清单满足（§10 报告项由本文件+reports/r2-2 承载）；未写 Rust、未切权威、未改 wire。申请复审。
