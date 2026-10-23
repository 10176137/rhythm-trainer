# Changelog

## Unreleased — B2.1 真机修复（部分验收）

- **完整乐谱启动崩溃**：`start` 的全量 scoreEvents 超过旧 WebSocket 256KB 上限，`ws` 错误未处理导致 Node 引擎退出，表现为 `/api/scores` 500 和设备断开。`maxPayload` 调整为 8MB，并为每个连接增加 error handler；300KB 非法消息回归后服务仍存活。
- **实体 MIDI 绿色光标**：Node MIDI Note On 现在也推进 timeline guide 光标，不再只入引擎而 UI 不跟随。
- **暂停 tick**：暂停时停止客户端 tick、恢复时重启；服务端忽略暂停期迟到 tick，修复 `operation 'advance' is not valid in state 'paused'`。
- **单/循环谱面显示**：单右手时非目标手音符淡化到 22%；loop 模式非循环小节覆盖半透明绿色遮罩，不拦截点击。
- **模式整合**：侧栏仅保留节奏训练、乐谱跟练、自由弹奏；分手练习由“练习手”选择，循环由“只练所选小节（loop）”开关控制。启动时映射到既有 score/hands/loop 引擎模式，保留评分配置与历史语义；P09 复练继续使用 score+loop 配置。
- **中断 Take 持久化**：换设备/刷新导致 WebSocket 断开时，若仍有活动 Take，服务端先按 `interrupted` 结算并保存 Trace/Journal/报告；记录标记中断、不可信、输入 disconnected，历史显示“中断”，不进入掌握度。跨设备继续同一个活动 Take 仍未实现。
- **保存 Take 模板 CRUD**：新增 `/api/take-templates` 列表/创建/读取/更新/删除；设置面板可保存当前配置为 Take、应用、重命名、删除。开始练习会创建新的 Session/Take 并写入 `takeTemplateId/takeTemplateName`，历史显示 Take 关联；模板不被演奏覆盖。换设备可选择已保存模板开始新 Take，但不是续接同一条活动 Take。
- **多浏览器活动 Take 租约**：服务端只允许一个连接持有活动 Take；其他浏览器可查看共享历史/Take 模板，但不能同时 start。Take 结束或断连结算后释放租约，避免全局 MIDI sink 被多个浏览器抢占。
- **取消自动结束**：固定时间 Take 在最后一个目标后不再自动结算；必须由用户点击“结束”，或断连后按 interrupted 规则保存。避免用户尚未开始演奏就被生成全 Miss 报告。
- **按首音倒计时 + 3 秒预备**：`started` 新增后端权威的 `firstTargetAtMs`（预备段 + 谱面前休止）和 `countInMs`。预备段默认固定 3 秒，并按当前 BPM 换算成拍数（40 BPM = 2 拍、80 BPM = 4 拍、120 BPM = 6 拍）；固定时间练习立即启动引擎并按该首音时刻倒数，覆盖层数字归零即第一个音。跟手/自由模式仍保留独立的 3 秒准备。暂停发生在首音前时，首音时刻随后端顺延同步更新。
- **P09 准备态启动**：从历史报告点“确认创建复练任务”不再立即启动引擎，而是载入复练配置并返回练习室，等待用户点“开始练习”。避免用户从历史页切换时错过 3 秒倒数；`sourceReportId/sourceTakeId/prescriptionId` 等来源引用在真正开始时写入新的 Session/Take。
- **Take 模板深链接**：`/workbench?takeTemplate=<id>` 在页面加载后自动应用共享模板，并在应用后移除查询参数；用于平板不想手动切换 BPM/手别/loop/判定时的一次性入口。
- 真机补充证据：`s-1792769578764-7` 为 4/4（2 Perfect + 2 Good）、0 Miss/Extra、Overall 83.97、onset MAE 46.1ms、`AVAILABLE` 的干净基线；`s-1792767914539-5` 为 4/4、Overall 66.9、onset MAE 128.5ms，并生成 `LOCAL_ONSET_V1` P09 处方。P09 复练已正确写入来源引用并在复练非 `AVAILABLE` 时阻断比较（`s-1792770190158-9`），但成功的前后比较仍未取得。
- 验证：vitest 175、selftest 155、tsc/build 通过；平板 LAN 访问、模板深链接和 P09 准备态已实测。受控错误 Take、实体断连/旧 epoch 边界和成功的 P09 比较仍未完成，详见 `B2_1_HARDWARE_ACCEPTANCE_REPORT.md`。

## Unreleased — B2 教学处方与针对性复练

- **可解释处方模型**：新增 `TeachingPrescription` / `PrescriptionEvidence` / `PrescriptionAnalysis`，字段包含 `sourceReportId/sourceTakeId/ruleId/problemType/evidence/confidenceStatus/measureRange/recommendedBpm/recommendedHand/recommendedMode/reason/action/status`；规则引擎 `teachingPrescription.ts` 只读取 Rust `scoreV1`、event results、MeasureReport、practice ranges 和 duration 报告，不重新计算任何评分。
- **证据门禁**：自动处方仅对 `AVAILABLE`、足够 confidence 且具有明确小节证据的报告生成；`DEGRADED` / `INSUFFICIENT_DATA` 不自动生成，`UNAVAILABLE` / `INVALID` 无按钮；全局 offset/jitter/drift 没有小节定位时显示不可执行；`EXTRA` 无 measure、`AMBIGUOUS`、缺失 Note Off/未知时值都不被转成确定结论。局部起音规则要求小节自身误差且与全曲中位数有差异；漏音/错音/时值分别使用事件级和有效 duration 证据。
- **P09 交互**：P08 报告内新增 `TargetedPracticePanel`：展示规则、范围、证据、推荐 BPM/手别/模式；允许修改 BPM/手别；明确“loop 一次练习所选范围”；无证据时只显示原因，不显示确认按钮；提供显式标记的“用户手动选择小节”，与系统诊断处方区分。
- **真实复练任务**：确认后走现有 `launchPractice` 链路，以 loop + 处方范围 + 新 BPM/手别创建新的 PracticeSession/Take；原报告不修改。start 消息和 session JSON 保存 `sourceReportId/sourceTakeId/prescriptionId/prescription`；服务端校验来源报告/Take、曲谱指纹、范围、处方 BPM/手别，并拒绝重复活动 Take 和初始化失败；历史行标记“复练”。
- **前后比较**：服务端在复练完成时生成 `retryComparison`，只比较两份均为 `AVAILABLE`、曲谱指纹和评分版本一致的真实数值指标；BPM/手别/模式/范围差异列为限制；任一份不可评分时只显示原因，不生成进步百分比。比较结果持久化并在 P08 重读。
- 工程验证：vitest 29 文件/170 项、engine selftest 152 项、tsc/build 通过；浏览器用 synthetic raw MIDI 验证 P09 证据、新复练任务、来源关联、历史“复练”标记和比较表。后续已连接实体 `MEDELI SP-A500`，Node Adapter 收到 76 个真实 Note On/Off 事件（healthy、无队列丢弃），但尚未完成实体键盘 Take/评分验收。未开始 C2/C3。

## Unreleased — B1 完整评分链与 P08 报告

- **同一目标计划**：新增 `buildEngineScoreEvents`，从手别过滤后的 `PlaybackPlan.occurrences` 生成 per-note `EngineScoreEvent`（onset、逐 occurrence 时值、小节、拍位、part）；与 atoms、参考播放共用同一计划，不另建时间线。`scoreEvents` 随 `start` 送入引擎，记录在 Take 元数据和会话 JSON。
- **Rust 权威评分**：新增 NAPI `scorePerformance(scoreEvents, performedNotes)`，直接调用已有 `rhythm_core::score_performance` / `scoring_v1`，未在 TypeScript 重写评分。报告含 event results、pitch/onset/rhythm/duration/continuity、measure rollup、overall、confidence、diagnostics、practice ranges，并返回 algorithm/config version。
- **完成后的评分链路**：Take 结束后从 Rust key-lifecycle observations 构造 performed notes（映射 session time；缺 Note Off 保留为 missing-release、不猜测时值），过滤预备拍输入，按暂停区间平移目标 onset，再调用 NAPI。8 个匹配样本的合成 raw-MIDI 场景得到 8 MATCH + 1 EXTRA、pitch 8/8、duration 8 graded、confidence high；暂停后 2 音仍匹配。
- **和弦对齐修复**：`align_performances` 在单调贪心前先按同一 target onset 分组，按音高匹配和弦音，避免“G→C→E”这类同和弦不同到达顺序被误判为错音/漏音/额外音；新增验收 p–u（包含额外/漏音不级联、错音与额外音区分、重复音、和弦 spread、缺 Note Off）。Rust 全部 110 项通过。
- **数据质量状态**：明确 `AVAILABLE` / `DEGRADED` / `INSUFFICIENT_DATA` / `UNAVAILABLE` / `INVALID`。有目标但零输入为 `INSUFFICIENT_DATA`（不是 0 分）；低置信度不再标成“设备降级”；只有输入健康/时钟映射/数据降级才为 `DEGRADED`；无 `scoreEvents`（free/旧记录）为 `UNAVAILABLE`，`scoreV1=null`。综合分在降级、数据不足或重归一化时隐藏。
- **P08 报告与历史**：新增 `FullScoreReport`，在实时报告和历史详情中展示状态、confidence、分项与权重、原始指标、小节表、事件级结果、诊断与版本；不展示伪造的 0/占位综合分。历史记录持久化 `scoreV1/scoreStatus/scoringConfig/versions/input counts/pauseAdjusted`。补充报告样式和 4 项 SSR 渲染测试。
- 工程验证：Rust 110 项、engine selftest 126 项、vitest 26 文件/155 项、tsc/build 通过；浏览器用合成 raw MIDI 会话验证完整报告/历史以及 AVAILABLE、DEGRADED、INSUFFICIENT_DATA、UNAVAILABLE 展示。B1 实现时没有可用实体 MIDI 设备；后续已连接 `MEDELI SP-A500` 并验证 Node Adapter 收到真实 Note On/Off，但尚未完成实体键盘 Take/评分验收。音频输出延迟仍未校准。**未开始 B2/C，未实现 P09、独立试听、Snapshot 光标或 `.mxl`。**

## Unreleased — A2 设备就绪、练习设置与离开守卫

- **设备检查 `/device`**：复用 Node MIDI Adapter，展示连接状态、设备选择、输入健康、最近 Note On/Off、当前按下音与 3 秒未松键提示；设备页不创建 Session/Take，不生成报告。连接/断开/切换时清空旧监视事件。
- **练习设置**：保留现有设置面板作为 P06；增加本次配置摘要、固定 4 拍预备拍说明、循环只练一次说明、配置快照/Continue 语义说明、系统伴弹固定时间说明，以及“音频输出延迟未校准（uncalibrated）”。未保存草稿时禁止开始；预备/连接阶段锁定设置。
- **离开守卫**：在 prep/starting/Take running/paused/processing 时，应用内导航、设备/曲谱库等页面切换先弹出“留在练习室 / 结束本轮并离开”；只有现有停止/结算完成且报告 `persisted !== false` 才导航。结算/持久化失败留在工作台并显示错误；已结束 Take 正常导航。
- **浏览器离开**：活跃练习注册 `beforeunload` 警告；浏览器后退经路由守卫恢复当前 URL 并弹出确认。
- **练习室摘要**：继续使用现有 `EngineReport.stats`、durations、analysis、captureDiagnostics；加入 uncalibrated 提示、无报告/持久化失败状态，不新增 pitch/overall/小节诊断。
- **报告持久化**：engine server 的 report 增加 `persisted`/`persistenceError`，前端离开守卫据此阻止假成功导航。
- 工程验证：tsc、vitest 24 文件/148 项、build、selftest 通过；未修改 Rust Core。

## Unreleased — A1 曲谱库、MusicXML 导入与乐谱阅读

- **独立曲谱库 `/scores`**：列表、搜索、状态、当前谱面标记、打开阅读、重命名、删除、刷新；空/错误/文件缺失/坏元数据提示。状态来自持久化 ImportReport 摘要，不把 OSMD 渲染成功当成可评分。
- **导入预览**：`.musicxml` only（明确拒绝 `.mxl`）、10 MiB 上限、错误/警告/提示分组、受影响小节、保存到库；失败不保存，同名冲突不覆盖。A1 不支持 PDF/图片 OMR/MIDI 记谱。
- **解析状态持久化**：score meta 新增 `importStatus` / `importReportSummary`（最多 20 条 issue）/ `parserVersion` / `importedAtIso`；旧记录显示“待校验”，打开时回填；parser 版本变化显示“需重新校验”；XML 替换无新摘要时清空旧状态。`/api/scores` 增加 `fileMissing` / `invalidCount`。
- **阅读页 `/reader`**：OSMD/Bravura display-only；默认 100% 适应阅读宽度（无横向滚动）、−/＋/重置阅读缩放、返回、加载/渲染失败/受限状态、曲谱切换清理。未实现小节/系统跳转。
- **练习接入**：可达标曲谱从阅读页进入现有工作台练习设置；受限/谱表不支持时禁用开始练习。复用现有 Session/Take/Reference Playback，不创建新评分链路。
- 新增 scoreStatus / score-library 状态与路由测试；vitest 24 文件、148 项通过；build/selftest 通过。未改 Rust Core。

## Unreleased — Reference Playback P0

- **参考播放控制器**：新增 `ReferencePlaybackController` / `ReferencePlaybackScheduler` / `PlaybackClock` / `WebAudioEngineAdapter`。播放运行有独立 `playbackRunId`，状态覆盖准备、预备拍、播放、暂停、完成、停止和失败；快照包含播放位置、小节、当前 occurrence、调度进度、时钟质量与健康状态。
- **共享目标计划**：严格练习先从 `PlaybackPlan` 生成手别过滤后的 `ReferencePlaybackPlan`，同一份 groups 同时生成 Rust atoms、参考音频和 expected notes；启动时校验参考计划与引擎 target 的数量/时间/小节，不一致会进入 `FAILED` 并给出诊断，不再比两份隐式时间线。
- **逐音时值**：每个 occurrence 使用自己的目标时长调度 Note Off；修复旧系统伴弹把同起音短低音按整组最长时值持续的问题（第 23 小节 B♭/E♭ 低音与长和弦的听感问题属于这一类）。和弦同刻起音，重复同音使用独立 voiceId。
- **调度与诊断**：Web Audio 前瞻窗口调度；欠载时记录 `reference_playback.scheduler_underrun` 并降级，不静默丢音；暂停/停止/完成执行 all-notes-off；AudioContext 挂起时暂停播放并通知 Take 一起暂停；准备/启动/暂停/继续/停止/完成/音色失败/时钟降级均输出结构化诊断。
- **音频层**：节拍器、参考播放、跟手提示共用同一个 AudioContext；新增本地合成的钢琴音色（无远程采样、无额外许可证），按目标时值起止。
- **修复节拍器**：session-relative click 时间现在显式加 session origin 再映射到 AudioContext（旧代码把相对时间当绝对时间，点击会被当成已过去）；`metronomeOn` 真正接入；BPM 用请求值而不是前两个 target 间隔；重音按谱面拍号而不是硬编码 4/4。
- **手别**：`filterPlaybackPlanByHand` 在 atoms/音频之前过滤，右手练习不再仍要求左手音符；跨手同起音只保留所选手的 occurrence。音频层单独“只手静音”仍未实现，属于 P1。
- **时钟质量**：Node 输入映射为 `unstable/unknown` 且存在已映射事件时，报告 `trustworthy=false` 并写入 `captureDiagnostics.clockMapping`，不再把不可靠时间当成精确成绩。
- 新增 vitest：playback plan/controller/scheduler/synth voice/metronome 共 15 项；当前 22 个测试文件、136 项通过。仍未实现：repeat/ending 展开、运行中变速、独立试听、音频只手静音、采样钢琴、跟手模式统一 Take 时钟。

## Unreleased — 设置保存、iPad 触控与 MusicXML 乐谱库

- **练习设置改为草稿式保存**：速度/手别/判定档位/时值策略/反馈时机/推进方式/循环范围/节拍器先在草稿中修改，点「保存设置」才应用并写入 `rhythm-trainer.practice-settings.v1`；「取消」或关闭面板丢弃未保存修改，状态行明确显示「有未保存的修改 / 已保存」。刷新页面后恢复上次保存的参数；模式不会随偏好恢复，仍从乐谱跟练开始。
- **修复 72 BPM 被滑杆吸附到 70**：练习速度滑杆步长从 5 改为 1，默认 72 BPM 与显示值一致。
- **iPad / 平板布局**：设置面板在 ≤1200px 改为两列、≤560px 单列；触控设备控件提升到 44–46px、表单字号 16px（避免 iOS 聚焦缩放）、滑杆轨道/滑块加大；保存/取消按钮在窄屏堆叠。
- **侧栏与触控目标**：平板宽度下保留模式短标题而不是纯图标，导航/模式按钮补充可访问名称；谱面音符增加不可见的 34×34 命中区，便于手指点选。
- **MusicXML 乐谱库 CRUD**：新增 `server/score-library.mjs`，每份乐谱保存为 `%APPDATA%/rhythm-trainer-frontend/scores/<id>.musicxml` + `<id>.meta.json`；REST `GET/POST /api/scores`、`GET/PUT/DELETE /api/scores/:id`，名称唯一（大小写/空白归一化）、10 MiB 上限、原子写入、路径安全校验。导入 MusicXML 成功后按文件名自动入库；设置面板新增「乐谱库」按名称选择并载入，支持重命名、替换 XML（当前谱面会自动重载）和删除。iPad 与桌面共用同一引擎时看到同一份库。
- **按谱号逐谱表继承**：同一小节只改变一个谱表的谱号时，不再清空另一个谱表已继承的谱号；跨手/换谱号的钢琴谱（如 OMR 结果）不会把整段音符误判到错误谱表或超出加线范围。新增 1 项导入测试。
- **记住上次载入的乐谱**：从乐谱库载入/导入/替换成功后把条目 ID 写入 `rhythm-trainer.active-score.v1`；刷新页面会自动从 `/api/scores/:id` 重新解析并恢复该谱，不再回到内置默认谱。条目已删除（404）时清空记录并提示回到默认谱；恢复默认谱/示例谱会清除记录。
- **开始前 3 秒准备**：点击「开始练习」先显示 3→2→1 准备倒计时，期间不计时、不启动 target；3 秒后才进入跟手/倒数流程。准备阶段可点「重置」取消。
- **系统伴弹（默认开启）**：谱面工具栏「系统伴弹」开关，持久化于 `rhythm-trainer.system-duet.v1`。系统按引擎的 target 时间表**连续演奏整段**（Web Audio，不进入评分），红色随系统实际演奏逐音出现。系统伴弹需要固定时钟，开启时会自动切到「固定时间」（跟手模式会等待用户，无法连续演奏）；关闭后停止系统声音并清除红色。新增独立的「系统音乐 开/关」：只控制系统声音，关闭后系统红色声部仍按时间推进，方便静音跟谱。SystemDuetPlayer 保留全部已调度振荡器，暂停/重置/关闭/重渲染时 stopAll 会真正停掉整段，修复 StrictMode 双执行和暂停后“多个系统同时演奏”的重叠。
- **三色语义**：红 = 系统弹过、蓝 = 用户弹对（engine perfect/good 或跟手 correct/complete）、绿 = 当前应弹目标（固定时间下也由独立 FollowSession 驱动，只在你弹对后前进，不因 miss/时间流逝自动走）；绿最后绘制保证始终可见，蓝覆盖红表示“这一音是我弹的”。用户输入仍由引擎独立判定。
- **专业谱面渲染（OSMD 2.2.1 / Bravura）**：原始 MusicXML 默认交给 OSMD 制谱引擎渲染，使用 Bravura 记谱字体、专业符头/符干/符杠/休止符/连线/加线排版，不再依赖手绘 SVG。`OsmdScoreViewAdapter` 将 1610 个领域音符事件映射到 OSMD 图形对象（本曲 1610/1610、0 duplicates），当前目标实时高亮、点击音符可查看详情。**自研 SVG 谱面已移除，OSMD 是唯一谱面渲染**。跟随改为信号驱动：只有弹对当前目标（或手动重新开启跟随）才滚动，时间推进、漏拍和手动往下查看都不会把页面拉回。OSMD 作为独立懒加载 chunk（约 1.4 MB）加载。
- **整谱多系统排版 + 纵向跟随**：按 MusicXML 每小节的 `startBeat`/`durationBeat`/拍号布局，默认每行 4 小节（与 PDF 演示一致）；每行重复谱号/调号/拍号，系统起始显示真实小节号，拍号变化在小节处标注；第一系统显示 Piano 与 ♩=BPM，空谱表补全小节休止符，字体与坐标逐行一致。谱面每小节 320px、整行自然宽度约 1510px、**不压缩**；容器较窄时出现横向滑动条（也可直接左右滑动），窗口放大到足够宽后滑动条自动消失并居中显示。全部系统纵向堆叠，练习时自动滚动到当前系统；顶部有「跟随」开关。字体/谱号/拍号/小节号在每行固定坐标对齐；谱线与终止线按每系统实际末小节绘制（修复加宽后音符落在空白区的问题）。
- 新增 `practiceSettings.ts`、`scoreLibrary.ts`、`server/score-library.mjs` 及 21 项测试；vitest 121 项、`npm run build`、`npm run selftest` 通过。

## 0.6.0 — MusicXML / Score Engine v1.0 语义管线

- **独立 `src/score-engine/`**：新增精确 `RationalBeat`、`ScoreDocument/ScorePart/ScoreMeasure/ScoreEvent/Pitch/ScoreSourceRef/TieSpan/ImportReport`；导入边界限制扩展名与 10 MiB，拒绝实体/内部 DTD/XInclude，SHA-256 fingerprint + 稳定内部 event ID。
- **MusicXML partwise 语义**：divisions 归一化、time/key/clef/staves、note/rest、chord 同起点、backup/forward cursor、`<tie>` 与 `<tied>` 分离、休止符、附点、time-modification/triplet、变音；grace/cue、微音、repeat/ending 与 tempo curve 产生能力标记并阻断 strict。
- **PlaybackPlanner/TempoMap**：A–B range、range-loop pass、唯一 occurrenceId、onset group + 完整 pitch set、tie continuation 不新建起音、固定 BPM session-relative beat→ms/tick 映射；BPM 改变只重建时间，不重解析。
- **App 接入**：开始练习改为 semantic ScoreDocument → PlaybackPlan → `EngineAtom` → 原 Node/Rust Core；ImportReport.strictAllowed 或 PlaybackPlan 阻断时不允许开始严格练习。旧的 `musicXmlParser.ts` 保留为 legacy view-model 兼容层。start/report 协议新增 `scoreFingerprint`、`playbackPlanId`、`scoreImportStatus`（仅追溯，不改变评分）。
- **Golden fixtures/tests**：新增 single melody、piano two-staff、triad chord、multi-voice backup/forward、rests、dotted/triplet、跨小节 tie、time/key change、pickup、unsupported repeat/tempo、malformed/missing divisions/invalid chord/duration overflow；人工审核 expected JSON + 80 BPM timeline。Vitest 100 项全过；Rust core tests、selftest、build 通过。
- **跟手等待练习**：新增 `FollowSession`，光标只在当前目标完整 pitch set 被弹对后推进，不自动走；错误音/额外音/重复音与逐目标相对间隔（相邻正确起音 vs 谱面时值）记录为“标准/有偏差”。固定时间 strict 时间线仍可切换，跟手结果明确标注不是 strict 成绩。
- **OSMD 2.2.1**：实际安装并完成 real mapping spike（单音/和弦/多声部/跨小节 tie/4 小节/跨系统），mapping 100%，duplicates 0；新增 `ScoreViewAdapter`（public `SourceMeasures → Voices → Notes` + `rules.GNote`）。**但生产 React 仍使用现有 SVG，OSMD UI 集成、音名/线间/手别/error overlay 尚未完成**，不得宣称完整 OSMD 集成。
- 仍非完整 MusicXML：复杂 repeat/ending 展开、多 part hand mapping、复杂 tuplets/tie 排版、transpose、微分音、.mxl、server-side import API 未实现；start/report 已透传 fingerprint/planId/import status。详见 `docs/MUSICXML_SCORE_ENGINE_IMPLEMENTATION.md`。

## 0.5.0 — 识谱辅助 v2：准确的线/间位置、谱表外音符与简单 MusicXML 导入

- **谱面数据模型改为书写音高**：`ScoreNote` 保存 `step/alter/octave`、谱表、声部、小节与拍点，
  不再保存屏幕坐标。默认练习改为 4 小节 C 大调钢琴练习曲（右手 16 个四分音符、左手 8 个二分音符，
  72 BPM），由 `c-major-practice.musicxml` 经浏览器端解析器生成；原始两小节
  `rhythm-trainer-score-reading-example-v2.musicxml` 保留为 fixture 一致性测试与导入示例。
- **纯净谱面展示**：默认关闭标签，当前目标列显示绿色胶囊高亮，其余音符为浅灰；新增标题/副标题、
  拍号/调号/双手标签、♩=BPM、扬声器试听、花括号、小节编号、左右手旋律/伴奏说明、阅读提示与
  展示目标脚注。乐谱卡片改为全宽，反馈/输入卡片移到下方两列。
- **新增 `musicXmlParser.ts`（简单子集导入）**：支持 `score-partwise` 单 part、单/双谱表、
  G2/F4 谱号、divisions、拍号、调号、音符/休止符/和弦/`backup`/`forward`、显式变音记号，
  以及八分/十六分音符。非 G/F 谱号、复杂连音/连音线、多 part 等会提示或拒绝，不静默画错。
  练习设置 → 乐谱来源新增「导入 MusicXML」「谱表外示例」「恢复默认乐谱」。
- **新增识谱渲染层**：`staffMapping.ts` 按高/低音谱号的相对底线映射音高、线上/间上、加线；
  `scoreLayout.ts` 纯函数计算音符/小节/标签几何；`practicePlan.ts` 单独生成引擎目标组，
  不接收任何显示参数。C4 记为「加线下」、D4「谱表下」、E4/G4/B4「线上」、F4/A4/C5「间上」；
  左手 C3「间上」、G2「线上」；谱表外空间用「加线间上/下」与「谱表上/下」区分。
- **谱表外音符**：新增内置 `ledger-lines-demo.musicxml`，覆盖 C4/A3/F3（下方 1–3 条加线）与
  G5/A5/C6/E6/B5（上方间/加线）。谱表下方标签贴近音符，上方标签放在音符上方并避开符干；
  高音谱表有高音时自动增加顶部留白，没有高音时不增加空白。单谱表使用自适应 viewBox。
- **`ScoreViewer` 重写**：谱线延伸到谱号左侧，拍号、双谱表小节线垂直对齐，全音符无符干，
  C4 加线、上下谱表共用小节线；当前目标组（如 C4+C3）共享绿色当前拍胶囊；变音记号与八分/十六分符尾可绘制。
- **音名/线间提示改为设置项**：默认关闭以保持纯净谱面；在练习设置中开启后显示谱面音名、
  线/间文字与颜色。标准模式下点击音符仍可查看详情；严格判定且音名关闭时锁定详情，避免泄露答案。
  偏好持久化到 `rhythm-trainer.score-hints.v3`，设置面板可恢复默认。
- **线/间提示**：设置中开启后以深/浅蓝区分线上/间上，同时提供文字徽标与 `aria-label`，
  不依赖颜色单独传递信息；开关不改变任何音符坐标/音高/时值/小节。
- **选中音符详情**：显示音名、音区、谱表、线/间、虚拟键盘键位（C2–B5 迷你键盘高亮对应键）、
  时值、小节/拍；MIDI 输入与当前目标或选中音匹配时显示绿色光环与 `MIDI 匹配` 徽标。
- **超范围保护**：超过双升/双降、音名/MIDI 不一致、超过 3 条加线或小节越界的音符会被
  `getUnsupportedNotes` 拒绝绘制并显示警告；`startPractice` 阻止启动，避免静默画错后继续判分。
- 测试：新增谱表映射、布局、提示默认、MusicXML 解析/导入、fixture 一致性、目标计划共 32 项；
  vitest 总计 67 项全过，`npm run build` 与 `npm run selftest` 通过。视觉检查截图见
  `docs/visual-checks/score-clean-view.png`、`score-active-note.png`、
  `score-note-names-on.png`、`score-note-names-off.png` 与 `score-ledger-demo.png`。

## 0.4.0 — v0.6 事件契约：前端只发 RawMidiPacket

- **旧 `MidiPerformanceEvent` 退出评分路径**：`midiAdapter` 现在只产生
  `RawMidiPacket`（sourceId/sourceSeq/clockDomainId/capturedAtMs/handlerAtMs/
  rawBytes/transport）并经 `session.ingestPacket()` 以 `raw-midi` WS 事件送入
  引擎服务；Note On/Off 解码改由 Rust 核心 `decodeMidiPackets` 权威执行，
  浏览器不再解码供评分（`midiDecoder.ts` 仅余审计日志 UI 标签用途，待 G 阶段删除）。
- **虚拟键/模拟输入走同一管道**：mock packets 带真实 bytes（0x90/0x80），与硬件
  adapter 同一 decoder/tracker，不允许注入已评分命中。
- 引擎服务：新增 `raw-midi` WS 事件；finish 时 `trackKeyLifecycles` +
  `assessKeyPresses` 产出权威时值（仅 complete 配对严格评分）；会话 JSON 保存
  原始 ingests 与 keyLifecycles。旧 note-on/off 路径保留作兼容。
- **时钟语义**：hook 以 `capturedAtMs − sessionOrigin` 产生 sessionTimeMs
  （Chromium 同一 performance 时间线，clockQuality=good），范围外回退 handler 时间
  并如实标记；WS 到达时间永不替代捕获时间。
- selftest 新增 raw-midi 场景（mock bytes → Rust 解码 → 命中 → 时值 → 持久化），
  共 59 项断言全过；golden fixtures 7 案例 + 确定性重放全过。

## 0.3.1 — MIDI 采集层修复（SP-A500 整合计划 M1 前置，审查项 5）

按《SP_A500_INTEGRATION_PLAN_FOR_ZCODE_v0.4.md》审查结论，修复 `midiAdapter.ts` 的五项硬伤：

- **单端口监听**：`connectMidi({portId})` 只绑定用户明确选择的一个输入端口，不再遍历监听
  所有端口（规格 D10）。顶栏新增端口下拉（`listMidiInputs` + `statechange` 热插拔刷新）。
- **时间戳**：事件时间改用 `MIDIMessageEvent.timeStamp`（Chromium 与 performance.now() 同一
  时间线），同时记录 handler 进入时的 `performance.now()` 与派发延迟 `dispatchDelayMs`——
  仅作诊断，不作抢拍补偿。hook（`toSessionMs`）优先用覆盖值换算 `atSessionMs`，范围外
  回退 handler 时间（防 WebKit 类 epoch 时间戳）。
- **原始事件日志**：新增 `midiEventLog.ts`——每条消息分配 `sourceSeq`，保存原始字节、
  command/channel/kind 与两种时间戳，可导出 JSON 回放（规格 §12 导出项）。
- **解码器**：新增 `midiDecoder.ts` 纯函数——Note On / Note Off（含 9nH,V=0 正规化）/
  CC（含 CC64/66/67 命名）/ Pitch Bend / Program Change（两字节，不读不存在的 data2）/
  截断消息标 `complete:false` 只入日志不猜测。9 个 vitest 纯函数测试。
- **断线事件**：端口 `statechange` 上报，拔线时停止计入会话并提示（未闭合音符的
  `OpenNoteInterrupted` 标记由核心配对器在回放时产生）。
- 明确未做（属 M0/M2 后续）：独立诊断页路由、CC 事件上送引擎（现仅入日志）、
  Rust `RawMidiNoteEvent` 尚无 channel/sourceId 字段（配对按 pitch；升级属 M2）。
- **设备实测：本机无 SP-A500，规格 §9-M0 的八项实机手测全部未验证**，不得标记硬件整合通过。

## 0.3.0 — 按键时值评估（v0.3 需求 M1+M2 接入）

- 输入链：Web MIDI 适配器本就发出 note-off（velocity=0 已正规化），现转发至引擎服务；
  虚拟琴键改为**按住／松开**（pointerdown=Note On，pointerup/leave=Note Off）；
  「模拟按键」模拟 90% 名义时值的保持（容差内，不制造假阳性）。
- 引擎服务：新增 `note-on`/`note-off` WS 事件（只记录，不即时评分）；finish 时调用核心
  `assessDurations` 做回放式时值评估，结果随报告返回并写入会话 JSON。策略与容差为
  版本化服务端配置（policyVersion 1，50ms / 15%，取较宽者）。
- 设置面板新增「时值评估」：严格按键时长 / 只记录不评分（自由弹奏永远只记录）。
- 报告新增时值分区：合格/偏短/偏长比例、平均按键时长、平均时值误差、无法评分与异常
  事件计数（孤立 Off、未闭合 On），以及逐音表（目标时值/实际按键/误差/结果/**起音间隔**）——
  按键时长与起音间隔并排呈现，呼应规格「两者不得混淆」。
- 起音判定完全不受时值评估影响（selftest 断言：全短按的会话仍是 8 Perfect）。
- selftest 扩至 45 项断言（新增专项场景：too_short/within/unknown、孤立与未闭合事件、
  IOI 分离、时值报告持久化）。浏览器端到端验证：短按→偏短 −450ms、90% 保持→合格。

## 0.2.1 — 练习记录 + 能力画像 + 白屏修复

- **修白屏**：全 Miss 场景（开始后即刻结束，或全部漏拍）下，Rust 核心的 Option 统计字段经 N-API 序列化为 `undefined`，报告组件以 `=== null` 判空失效，`toFixed` 抛 TypeError 令整棵 React 树崩塌（白屏）。修复：判空改 `== null`；另加根级 `ErrorBoundary`，以后任何渲染错误只显示可恢复的错误卡，不再白屏。
- **练习记录**：引擎服务将每次完成的会话以 JSON 原子写入本机数据目录（`%APPDATA%/rhythm-trainer-frontend/`），新增 REST API（`/api/health`、`/api/sessions`、`/api/sessions/:id`（id 白名单校验防路径穿越）、`/api/profile`）。前端新增「练习记录」页：列表 + 展开完整报告（重用 ReportPanel）。
- **能力画像**：引擎服务维护 Rust `StudentModel`（启动时由 profile.json 恢复，每次 finish 后按达标规则更新：可信 + 无 Miss/Extra + MAE ≤ 30ms 算一次 pass；少于 8 目标或不可信的会话不计入证据）。前端新增「能力画像」页：每项技能的掌握状态（发展中/初步掌握…）、连续达标、近 10 次 MAE 趋势柱状图；状态标明为暂定学习决策，不是能力认证。
- 侧边栏三个导航（练习工作台/练习记录/能力画像）变成真实 view 切换；工作台保持挂载（切换不中断进行中的会话）。
- start 协议新增 `assisted` 字段（反馈模式），写入历史记录。
- selftest 扩充至 34 项断言：selftest 现在自带独立服务实例（scratch 埠 + 临时数据目录，不碰用户数据），覆盖 REST 持久化、掌握状态升级（3 次连胜 → provisional）、fail 打断连胜、路径穿越 404 等。
- 浏览器验证：白屏重现流程（开始→即刻结束）不再崩溃；练习记录/能力画像两页正常渲染。

## 0.2.0 — Rust 引擎桥接（本地服务架构）

按 `docs/DESIGN.md` §12 的开发顺序完成第 1、2、3、5 步:

- **本地引擎服务**(`server/engine-server.mjs`):Node + ws + Rust 核心 N-API 原生模块。负责目标时间表生成、会话评分、确定性重放报告与规则教学分析;只监听 loopback,并在生产模式下托管 `dist/` 前端构建产物。原生平模块目录可通过 `RHYTHM_CORE_ADDON_DIR` 覆盖,默认指向 `../rhythm-trainer-core-v0.2/bindings/node`。
- **事件契约**(`src/types/engine.ts`):与引擎服务共享的 WS 协议 DTO(started/judgments/paused/resumed/report/error)。
- **引擎桥接**(`src/services/engineBridge.ts`):浏览器侧 WebSocket 客户端;页面不再自己评分。
- **会话状态机**(`src/features/practice/usePracticeSession.ts`):集中式状态机 idle → countdown → running ↔ paused → processing → completed;暂停/恢复把剩余目标整体顺延(与内核 `shift_remaining` 语义一致),暂停时长不会变成偏差。
- **绝对时间线节拍器**(`src/features/practice/metronome.ts`):AudioContext 绝对时刻调度,倒数 4 拍 + 每拍 click;暂停时全部撤销、恢复时按顺延后的时间表重排,不用累加 setTimeout。
- **React 演示评分逻辑退役**:节奏判定只来自引擎(Perfect/Good/Miss/Extra);音高对比保留为独立提示维度,不计入节奏成绩(符合 PRD 的维度分离)。
- **练习报告**(`src/components/ReportPanel.tsx`):引擎重放统计(命中率/平均偏差/MAE/标准差)、可信度徽章、可解释诊断与处方(来自核心 `analyzeTiming`)。
- 乐谱高亮改为跟随引擎目标组(同拍和弦共享一个目标);新增判定档位(严格/标准/宽松)与乐句循环小节范围设置。
- 服务端自测(`npm run selftest`):19 项断言覆盖全准击打、混合结果、暂停/恢复平移、非法输入与错误恢复,全部通过;浏览器自动化完整练习闭环验证通过。

## 0.1.0 — 工作台原型

- 练习模式注册表(节奏训练/乐谱跟练/分手练习/乐句循环/自由弹奏)。
- 共享练习工作台、示例乐谱、SVG 谱面、Web MIDI 适配器、模拟键盘。
- 演示级评分逻辑(已在本版本中移除,由 Rust 引擎取代)。
