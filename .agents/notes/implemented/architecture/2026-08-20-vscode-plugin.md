仓库目前**没有**现成的 VSCode 插件，也没有专门为编辑器场景设计的集成层，但架构上已经预留了足够清晰的分层，使"移植到 VSCode 插件"成为一个可行的集成任务而非底层重构。核心事实：

## 关键架构事实

1. **"Client 永不直接依赖 Host 运行时"是硬性纪律**——client 侧包只吃 `/api`、`/client` 两个浏览器安全子路径，协议层是 `dsh-host-apiproxy` 里的零 Node 依赖 TS/zod 定义,可在 Node 和浏览器中同构使用。

2. **接入新应用有明确操作清单**:选一种 fetch 伪装方式(浏览器同源 HTTP / 进程内 `host.handler.fetch` 注入 / 自定义传输切面子类,官方文档点名了"未来 Electron 用 IPC"这个先例)、在 `apps/` 下写一个装配模块、只有需要 HTTP 载体时才 import `dsh-host-webserver` 。这段话原文明确写了"未来的 Electron 应用经由 IPC fetch 载体复用同一套 web client 包"  ——VSCode Webview 与此高度同构:同样是"宿主提供一个自定义传输(而非 HTTP),前端 Web Client 包原样复用"。

3. **`dsh-host-webserver` 明确"只服务浏览器",Electron 不复用它,只有 file:// + IPC**  ——这意味着 VSCode 插件同样不该复用 webserver,而应采用 Electron 那条路径:VSCode 扩展进程直接 `ctx.plugin` 挂载 Host(runtime + apiproxy),Webview 面板走 `postMessage` 承载 RPC,不开真实端口。

4. **ACP(Agent Client Protocol)提供了另一条更轻量的路径**:一个纯自动化、stdio JSON-RPC 的服务器,`initialize`/`session/new`/`session/prompt`/`session/cancel`/`session/update`/`session/request_permission` 六个方法覆盖了驱动一个 agent 所需的全部动作 [6](#13-5) 。但这条路径的代价是**没有任何交互式渲染**:不支持图片、多工作区、实时进度、reasoning、plan、标题,只吐最终已提交的文本 [7](#13-6) ,如果你想要"完整 Web UI 搬进 VSCode"的体验(侧栏、对话流、工具卡片、trajectory 视图),这条路径不够用。

5. **`dsh --profile headless` 证明了 Host/HTTP/浏览器层可以被完全砍掉**,只留核心 Agent/Session ,这是构建 VSCode 扩展进程(Node.js 侧,直接跑在 Extension Host 里)时的最小内核参考。

6. **Profile + Bundle 组合体系**允许把"VSCode 扩展"做成一个新的 `dsh.bundle`,像 `@deepseek-ai/dsh-web-app`一样声明自己的 `cordis.patch.yml`,而不需要碰仓库现有的 `base`/`web-app`/`headless` 三个组合包 。

## 可选方案(需要你确认取向)

- **方案 (完整 Web UI 内嵌,推荐,工作量大)**:在 VSCode Webview 里跑现有的 `dsh-client-*` cordis 插件树 + React UI,VSCode 扩展进程跑 Host(runtime + apiproxy),两者之间用 `vscode.Webview.postMessage`/`onDidReceiveMessage` 实现一个新的传输子类(继承 `AbstractApiClient`,只替换 `doFetch`),完整复用侧栏、对话、工具卡片等现成组件。

下面给出方案 A 的落地计划(功能对等优先);如果你更想要方案 B,请告知,我会替换成对应的轻量计划。
在仓库中新增一个 VSCode 扩展应用,复用现有的 `packages/client/*` cordis 插件树和 `packages/host/*` Host 能力,通过 VSCode Webview 的 postMessage 桥接替代浏览器 HTTP/WebSocket 传输,不新增底层协议或重写 UI 组件。

## 背景(供实现者理解现有架构,避免破坏既有分层纪律)

- 仓库的分层规则记录在 `.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md`:`packages/host/*` 只提供 Host 侧能力(Node.js 插件树 + 协议定义),`packages/client/*` 只提供浏览器侧能力,`apps/*` 是应用装配层。Client 侧包永远不能直接 import Host 侧包的运行时,只能通过 `dsh-host-apiproxy` 暴露的 `/api`(协议类型)和各 client 插件包的 `/client` 子路径消费。新扩展必须遵守这条纪律,不要在 Webview 代码里直接 import 任何 `packages/host/*` 的运行时代码。
- 该笔记明确列出了"接入一个新应用"的操作清单:1) 选一种 fetch 伪装方式(本任务选:VSCode postMessage IPC);2) 在 `apps/` 下写一个装配模块(`startHost()` + 客户端传输子类 + 应用私有的信号/退出语义);3) 只有需要真实 HTTP 端口时才 import `dsh-host-webserver`——本任务不需要,因为 Webview 走 postMessage,不需要监听端口。该笔记也明确提到"未来 Electron 应用经由 IPC fetch 载体复用同一套 web client 包",这是本任务最接近的先例,VSCode Webview 与 Electron 渲染进程的处境几乎一致。
- 协议层数据结构位于 `packages/host/apiproxy/src/api/`(TS/zod 定义,零 Node 依赖)。客户端统一继承 `packages/host/apiproxy` 导出的 `AbstractApiClient` 基类——协议不变量(rpcId 铸造、envelope 包装/解包、zod 校验、超时、SSE 帧解码等)全部在基类里,平台差异只是子类实现的 `doFetch` 传输切面,见 `packages/host/apiproxy/README.md`"Carrier layer"一节提到的 `InProcessApiClient` 范例(它是"不经过网络、直接走 `toFetchHandler(api)`"的同构范例,是本任务最值得参考的现有子类)。
- Web 客户端架构(浏览器侧 cordis 插件树、slot 体系、React-free 对象层)记录在 `.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md`。浏览器启动时读取宿主注入的 `window.__DSH_BOOT__` manifest 来决定加载哪些 `dsh.client` 插件包;Host 侧则由 `dsh-host-runtime` 负责挂载 8 个 client 插件包对应的内存 Loader 树。新增的 VSCode Webview 入口需要复刻这套 boot 握手(向 Webview 注入等价的 boot manifest),而不是从零实现 UI。
- `dsh-host-webserver`(`packages/host/webserver`)明确"只服务浏览器 HTTP 访问,Electron 不复用它——Electron 加载已构建文件走 `file://`、fetch 走 IPC 桥",见 `docs/subsystems/web-server.md` 与 `packages/host/webserver/README.md`。VSCode 插件应该走与 Electron 相同的路径:不引入 `dsh-host-webserver`,不开真实端口。
- Profile/Bundle 组合体系记录在 `.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md`:一个 bundle 是声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包。可参考 `packages/bundle/web-app`(浏览器 Host 行 + Web 运行时胶水插件,见 `packages/bundle/web-app/src/index.ts`)和 `packages/bundle/headless`(直接核心 Agent/Session 一次性 runner,零 Host/HTTP/浏览器层,见 `packages/bundle/headless/src/index.ts`)这两个现有 bundle 的写法,作为新 bundle 的结构范本。

## 需要创建的内容

1. **新应用目录 `apps/vscode`**(参考 `apps/cli`、`apps/web` 的组织方式):
   - VSCode 扩展清单 `package.json`(`engines.vscode`、`activationEvents`、`contributes.commands`/`contributes.viewsContainers`/`contributes.views` 声明一个侧边栏面板)。
   - 扩展入口 `src/extension.ts`:在 `activate()` 中挂载 Host 侧组合(参考 `packages/bundle/headless/src/index.ts` 里"直接创建 core Agent/Session,无 Host/HTTP"的做法,但本任务需要保留 `dsh-host-runtime` + `dsh-host-apiproxy`,因为要给 Webview 提供完整的 RPC 面,而不只是单轮 prompt)。持久化根目录(`DSH_HOME` 等价物)应指向 VSCode 的 `context.globalStorageUri`/`context.globalStoragePath`,工作区 cwd 应绑定到 `vscode.workspace.workspaceFolders[0]`。
   - Webview 面板管理代码(`src/panel.ts`):创建 `vscode.WebviewPanel`(或 `WebviewViewProvider` 挂进侧边栏),把已构建的 `dsh-web-frontend` dist 资源通过 `webview.asWebviewUri` 加载进去,注入等价于浏览器端 `window.__DSH_BOOT__` 的握手数据(通过 `webview.html` 内联脚本或 `postMessage` 首帧完成)。

2. **新的传输子类**(建议放在 `packages/client/connection` 或新建一个小包 `packages/client/connection-vscode`,视现有 `AbstractApiClient` 子类扩展点而定,需先阅读 `packages/host/apiproxy/src/fetch/` 目录确认基类真实签名):
   - 继承 `AbstractApiClient`,只实现 `doFetch` 语义:Webview 侧收到调用后用 `vscode.postMessage` 把请求发给扩展进程,扩展进程侧用 `panel.webview.onDidReceiveMessage` 接收、调用 Host 的 `toFetchHandler(api)`(参照 `InProcessApiClient` 的用法,见 `packages/host/apiproxy/README.md` "Carrier layer" 一节)得到响应,再 `panel.webview.postMessage` 回传。
   - Server-initiated 帧(`ServerRequest`,如审批/提问请求、session/event 推送)原本走 WebSocket 下行,这里改为扩展进程主动 `panel.webview.postMessage` 推送,Webview 侧监听 `window.addEventListener('message', ...)` 分发,不需要真实 WebSocket。

3. **新 Bundle 包 `packages/bundle/vscode-app`**(仿照 `packages/bundle/web-app` 结构):
   - `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
   - `cordis.patch.yml`:叠加在 `@deepseek-ai/dsh-base` 之上,挂载 `dsh-host-runtime`、`dsh-host-apiproxy`,但**不挂载** `dsh-host-webserver`/`dsh-host-frontend-static`(因为没有真实 HTTP 服务器)。
   - `src/index.ts`:提供 VSCode 场景下的运行时胶水(等价于 `packages/bundle/web-app/src/index.ts` 里的 `webStartup` 服务、trust 逻辑等价物,但因为是本地 IPC、没有网络暴露面,可以大幅简化或省略 `trustedHosts`/LAN 相关逻辑)。

4. **前端构建适配**:
   - 检查 `apps/web`(vite 应用)构建产物是否可以原样复用为 Webview 的 dist(资源路径需要改造为相对路径或通过 `webview.asWebviewUri` 重写,因为 Webview 有自己的 CSP 和 URI scheme 限制,不能直接用 `http://` 绝对路径)。
   - 按 VSCode Webview 的 CSP 要求调整 `apps/web` 的构建配置(可能需要新增一个单独的 vite 构建目标 `apps/web` 或复用同一套产物加一层路径改写脚本,视 Webview CSP 与现有产物的兼容程度决定)。

5. **文档**:新增 `docs/user/develop/basic/vscode-extension.md`,说明架构选型(为何走 postMessage IPC 而非 webserver)、如何构建和加载扩展(`vsce package`/`F5` 调试)、已知限制(初版建议先不做多工作区、不做原生文件系统对话框,复用 VSCode 自己的能力)。完成后运行 `pnpm run verify-translation-pairing --write <该文档路径>` 更新翻译配对记录。

## 需要提前调研确认的技术细节(实现前必须先读源码确认,以下只是推测方向)

- 精确阅读 `packages/host/apiproxy/src/fetch/` 目录下 `AbstractApiClient` 与 `toFetchHandler` 的真实签名,确认 Webview 传输子类需要实现的确切接口面(方法名、SSE 帧解码钩子等),不要凭本计划的描述直接猜测实现。
- 确认 `dsh-client-modules` 包(`packages/client/modules`)的 boot manifest 注入协议(`__DSH_BOOT__` 的确切 wire 形状),Webview 场景下如何在没有 `tapIndex`/HTML 转换 taps 机制的情况下等价注入这份 manifest。
- 确认 VSCode Webview 的 CSP 默认策略是否允许现有前端产物中的内联脚本/eval 等(Vite 产物通常需要额外的 nonce 或 `webview.cspSource` 配置)。

## 验证

- 扩展在 VSCode 的扩展开发主机(Extension Development Host,`F5`)中能正常激活,侧边栏/面板能渲染出完整对话 UI(输入框、消息流、工具卡片)。
- 能完成一次真实的模型对话往返(需要配置一个有效的 `DEEPSEEK_API_KEY`),验证 Webview ↔ 扩展进程的 postMessage 桥接正确承载了 RPC 请求/响应及 session 事件推送。
- 验证扩展关闭/重新打开面板后,持久化在 `context.globalStorageUri` 下的会话历史可以正确恢复(等价于 Web 版的会话列表)。
- 如果仓库有 `pnpm run hygiene`/lint/`pnpm run doc-sync` 等门禁,对新增包和文档跑一遍确认通过。