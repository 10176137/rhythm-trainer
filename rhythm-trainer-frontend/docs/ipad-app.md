# iPad App（电脑后端）

iPad App 内置现有 React 界面。电子琴继续通过 USB 连接电脑；Node/Rust 在电脑采集 MIDI、生成练习、评分和保存记录。电脑保持运行，iPad 和电脑应处于互通的局域网。

## 电脑启动

在 `rhythm-trainer-frontend` 目录运行：

```sh
npm install
npm run build
npm run server:lan
```

首次运行仍需按项目原有说明构建 Rust Node 绑定。启动终端会打印 `http://电脑局域网IP:8788`。允许系统防火墙中的 Node 入站连接。不要把终端显示的 `0.0.0.0` 或 iPad 自己的 `localhost` 填入 App。

`server:lan` 主动将服务监听到局域网；原有 `npm run server` 仍默认仅监听本机。该服务沿用现有无账号的本地使用方式，不要向互联网做端口转发。

## 安装到自己的 iPad

在上述目录运行：

```sh
npm run ios:sync
npm run ios:open
```

完整 Xcode 首次启动需完成许可确认和必要组件安装。工程采用 Swift Package Manager 获取锁定版本的 Capacitor，不需要 CocoaPods。`ios:sync` 会重新构建网页并将资源复制到原生工程；网页更新后也运行此命令。

在 Xcode 的 App target → Signing & Capabilities 中选择自己的 Team，必要时将 Bundle Identifier 改为唯一值。将 iPad 用数据线连接 Mac，完成设备信任，并按 Xcode 提示开启开发者模式。选择该 iPad 后点击 Run。个人设备调试可使用个人 Apple 账户；签名有效期与安装限制由 Apple 管理。

实体设备运行不需要下载 iOS Simulator。这里只提供本地调试安装工程，没有发布到 App Store 或 TestFlight。

## 连接与使用

首次打开 App，填写电脑启动时打印的完整地址，点击“连接并开始”。接受 iPad 的本地网络访问提示。成功的地址会保存在本机；下一次打开无需重新输入。正常网页访问仍使用原来的同源服务，不读取 App 的电脑地址设置。

App 支持横竖屏，保留现有谱面跟随，预留安全区域，并扩大触摸按钮。准备状态左下角“连接设置”可更换电脑；练习专注界面隐藏此按钮。更换电脑会退出当前练习并重新加载 App，取消旧页面的异步操作；待保存识谱记录和电脑分配的对象 ID 按电脑地址隔离，已保存记录仍位于原电脑。

连接中断或 App 从后台返回时，会要求重新连接并退出原练习。不会自动重放开始、结束或演奏事件，也不承诺续接中断的会话。尚未成功保存在电脑的结果不视为已保存。

若连接失败，依次检查电脑服务、地址、同一网络、防火墙及 iPad 设置中的本地网络权限。健康检查约 7 秒超时。原生配置仅为本地网络和私有 IP 段提供 HTTP 例外，互联网域名使用 HTTPS；没有关闭全局 ATS，也没有跳过证书校验。

评分以电脑 MIDI 采集时间与 Rust 内核为准。iPad 显示存在网络延迟；真实设备的音画同步与演奏延迟仍需实际测量，不能由构建成功推定。

## 构建验证

```sh
npm test
npm run test:teaching
npm run build
npm run ios:sync
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

最后一条验证未签名 iOS 工程编译，产物不能直接安装到实体 iPad。实体安装必须完成自己的签名和设备调试流程。

## 本次验证记录（2026-10-30）

- Xcode 27.2 / iOS SDK 27.2，Capacitor 8.6.0。
- 网页构建和 Capacitor sync 通过；未签名真机架构、模拟器架构构建均成功。
- iPad Air 5 模拟器已安装并启动 App；连接页与横屏练习入口另在浏览器按 820×1180、1180×820 检查。
- `npm test`：990 通过、5 跳过、1 个既有失败。失败为 `src/score-engine/parity/r2-3d-evidence.test.ts:758`，缺少 `RHYTHM_REAL_SCORE_PATH` 指定的外部真实乐谱；修改前同一测试亦失败。
- `npm run test:teaching`：32 通过；`npm run selftest`：全部通过。
- 实际 HTTP/CORS 健康检查和预检通过。模拟器测试使用隔离数据和 Mock MIDI，不代表真实琴已验证。
- 尚未连接实体 iPad，未进行设备签名安装、真实琴演奏及端到端音画延迟测量。
