# 多设备练习接管

电脑与 iPad 共用一份后端实时练习槽位。遇到占用时，页面显示“接管练习”；
点击后结束原来的 Timeline/Follow Take，按中断结算并走现有持久化与保存失败重试流程，
当前页面重新生成计划并开始一轮，不跨设备续接旧 Take。

租约与 MIDI sink 归 `SessionOwnership` 所有；页面只展示后端冲突快照。
错误帧 `SESSION_BUSY` 携带随机 `leaseId`、模式及是否本连接占用，避免依赖提示文案。
`session-control` 的 `status` 查询当前快照，`takeover` 必须携带期望的 `expectedLeaseId`
（空槽位为 null）。后端同步比较并结算；租约变化则拒绝，返回新快照让用户重新确认。
同连接重复 requestId 返回已缓存结果，不会结束之后新开的 Take。

旧连接先收到 `session-revoked`，再收到中断报告。后端拒绝该连接后续自动 start/follow-start，
前端停止计时与伴奏、阻止自动开练；手动点击接管成功后才能再开始。关闭旧连接不能
释放新连接的租约或 MIDI sink。跟手与固定时间均通过相同的桥接、冲突面板和接管流程。

前端状态在 `useSessionControl`，协议请求在 `EngineBridge`，`App.tsx` 仅组装接管面板与
已有重置/开练命令。接口回归测试为 `server/session-control.api.test.mjs`，覆盖跨模式接管、
同连接残留轮次、旧页面自动抢回、过期点击、重复点击和中断记录落盘。
