# iPad React Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将现有 React 打包为 iPad App，通过局域网使用电脑后端。

**Architecture:** Capacitor 打包本地 Vite 构建资源，连接页管理电脑服务地址。统一 REST/WS 地址解析，普通网页保留同源访问。电脑继续负责 MIDI、生成、评分和持久化。

**Tech Stack:** React 19、Vite 6、TypeScript、Capacitor iOS、现有 Node/Rust。

**Spec:** `docs/ipad-shell-design.md`

## Global Constraints

- 电脑必须保持运行，设备需局域网互通。
- 原生层不接入 MIDI，也不迁移生成器、评分和数据库。
- 普通网页继续沿用同源访问。
- 首版采用手动填写电脑地址，不增加账号系统、云服务或设备自动发现。
- 不盲目重放开始、结束等操作，不承诺自动续接尚无恢复协议的会话。

## Review Focus

- 错误协议、路径、凭据、不可达地址：保存前校验并提供明确重试。
- 部分接口遗漏：训练、设备、评分、曲库、历史与报告使用同一地址。
- HTTPS 网页：对应使用 WSS，普通网页不受 App 配置影响。
- 断线或后台返回：不自动重放练习操作，不展示未经核对的连接成功。
- iPad 竖屏与安全区域：按钮可触摸，谱面不被容器遮挡，不修改评分语义。

---

### Task 1: 后端连接地址与接入页

**Files:**
- Create: `rhythm-trainer-frontend/src/services/backendEndpoint.ts`
- Create: `rhythm-trainer-frontend/src/services/backendEndpoint.test.ts`
- Create: `rhythm-trainer-frontend/src/components/BackendConnectionGate.tsx`
- Modify: `rhythm-trainer-frontend/src/main.tsx`
- Modify: `rhythm-trainer-frontend/src/services/*Repository.ts`
- Modify: `rhythm-trainer-frontend/src/features/score/scoreLibrary.ts`
- Modify: `rhythm-trainer-frontend/src/services/engineBridge.ts`
- Modify: `rhythm-trainer-frontend/src/services/deviceBridge.ts`

**Interfaces:**
- Produces: `normalizeBackendOrigin(input: string): string`、`backendUrl(path: string): string`、`backendWebSocketUrl(): string`。
- 地址只接受 HTTP/HTTPS origin，不接受凭据、查询串、片段或业务路径。App 地址持久化；网页默认同源。

- [x] 编写地址测试：HTTP/HTTPS、尾斜线、非法协议和凭据、网页同源、WS/WSS 对应关系；运行并确认失败。
- [x] 实现地址模块，在所有业务 fetch 与两条 WebSocket 入口使用；检索 `fetch(` 和 `WebSocket` 核对遗漏。
- [x] App 启动时先展示连接页，健康检查超时或取消时忽略过期响应；连接成功后挂载现有 App。提供修改地址入口并明确中断当前会话。
- [x] 增加连接检查测试，覆盖失败重试和旧请求返回后不能进入旧服务器。
- [x] 运行相关 repository、engineBridge 与新增测试；检查网页同源请求不变。

### Task 2: iOS 容器与电脑局域网访问

**Files:**
- Modify: `rhythm-trainer-frontend/package.json`、`package-lock.json`
- Create: `rhythm-trainer-frontend/capacitor.config.ts`
- Create: `rhythm-trainer-frontend/ios/`（Capacitor 生成并检查后的工程）
- Create: `rhythm-trainer-frontend/server/lan-origin.mjs` 及对应测试
- Modify: `rhythm-trainer-frontend/server/engine-server.mjs`

**Interfaces:**
- Consumes: Task 1 的地址模块与连接页。
- Produces: 本地资源打包的 iOS 工程、`ios:sync`/`ios:open` 脚本、电脑局域网启动说明。

- [x] 先检查官方 Capacitor 版本要求与本机 Node/Xcode；锁定兼容版本，再安装 core/cli/ios 依赖。
- [x] 测试允许容器来源的 CORS/OPTIONS；默认普通网页同源访问保持原样，不反射任意来源。
- [x] 实现可审查的容器 origin 白名单与预检响应；检查所有 REST 返回路径均包含必要响应头。
- [x] 配置 `webDir: dist`，生成 iOS 工程；添加局域网用途说明和本地传输配置，限制任意外部导航。
- [x] 构建 React 后运行 Capacitor sync，检查资源确实进入工程；不得用开发服务器 URL 代替打包。
- [x] 若无完整 Xcode，明确记录不能执行原生构建；提供安装 Xcode、选择签名及实体设备运行步骤，不声称已安装成功。

### Task 3: 必要的平板适配、验证与交付

**Files:**
- Modify: `rhythm-trainer-frontend/index.html`
- Modify: `rhythm-trainer-frontend/src/styles.css`
- Modify: `rhythm-trainer-frontend/src/components/BackendConnectionGate.tsx`
- Create: `rhythm-trainer-frontend/docs/ipad-app.md`

**Interfaces:**
- Consumes: Task 1 连接页与 Task 2 iOS 工程。
- Produces: 可触摸、适配横竖屏与安全区域的 App，准确的部署和验证说明。

- [x] 配置 viewport-fit、安全区域、动态视口高度与触摸按钮尺寸；保留浏览器缩放和现有谱面跟随逻辑，不扩大为练习页面重设计。
- [x] 检查连接页横竖屏、键盘弹出、失败提示与设置入口；前后台切换时重新检查连接，不重放业务操作。
- [x] 运行新增测试、相关连接和边界测试、`npm test`、`npm run test:teaching`、`npm run build`；区分既有环境缺失导致的失败与新增回归。
- [x] 检查 diff、生成资源与 Git 状态，排除测试产生的 audit 噪声；文档列明未进行的真实 iPad/MIDI 验证。
- [x] 交付电脑启动、填写地址、同步 iOS 工程和 Xcode 安装运行步骤，说明断网与电脑休眠时的预期行为。

## 实施结果

2026-10-30：三个任务已实施。Xcode/iOS SDK 27.2 可用，网页构建、Capacitor sync、未签名 iOS 与模拟器编译通过；iPad Air 5 模拟器已安装启动。
完整回归 990 通过、5 跳过，既有 E5 外部真实乐谱缺失导致 1 失败，修改前同样失败；teaching 32 通过，自测全部通过。未连接实体 iPad，签名安装及真实琴延迟验证留待设备接入。
审核修复：中断时卸载业务树、取消未完成的 WS 连接、后台时丢弃健康检查、切换电脑时重新加载文档并隔离服务器相关本地记录。
