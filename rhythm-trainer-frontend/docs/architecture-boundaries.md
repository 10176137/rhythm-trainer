# 交互在前端，业务计算在后端

| 层 | 职责 | 代码入口 |
| --- | --- | --- |
| React | 选择参数、请求状态、取消旧请求、预览与交互、显示服务端结果 | `SkillTrainingPage`、`useSkillDrill`、`trainingRepository` |
| Node | 训练编排、识谱出题、参考指法/调性/音区、参数校验、复习选择、最终识谱报告与升级建议、持久化 | `server/training-service.mjs`、`server/training/`、`server/reading-attempts.mjs` |
| Rust，经 Node 调用 | 权威计时计划、节奏/音高/时值评分、重放与诊断 | 既有 planner-service / Rust addon / Take 链路 |
| shared | DTO、音名/音域等基础定义，及实时交互与后端重放共用的自由识谱状态机 | `shared/` |

专项训练使用 `GET /api/training/catalog` 获取目录和选项，`POST /api/training/drills` 提交项目、级别、速度、调性和手别。Node 返回 MusicXML、真实起点、谱表映射、预备时间及生成器版本。浏览器不编排音型，也不决定实际音区；预览和开始使用同一份结果。

识谱使用 `POST /api/training/reading`。自由模式返回题目，节奏模式返回谱面及统计；随机生成与题目覆盖规则仅存在于后端。错误题复习只提交已保存记录的 ID，Node 读取重放后的证据选择复习题，不接受客户端传来的薄弱项数组。

自由识谱的按键命中提示属于即时交互；结束后的正确率、错题、薄弱音和升级建议以 `ReadingAttemptStore` 重放结果为准。保存失败时显示待校验/重试，不把本地快照显示为最终成绩。老记录在后端读取时补上同一套升级建议，前端不复制阈值。

谱面导入用于显示及既有协议投影，四小节对齐、补空、缩放和滚动均属于前端排版，不回传为评分目标。既有 Rust 默认规划与评分权威不变，历史 RTS 兼容路径仍按现有服务端权威选择协议处理。

接口始终在后端再次校验参数。前端的选项限制只改善交互，不能替代后端校验；服务失败时不静默切回浏览器生成器。`training-boundary.test.mjs` 防止后端模块进入浏览器依赖图，`training-api.test.mjs` 验证真实 HTTP 链路与证据来源。
