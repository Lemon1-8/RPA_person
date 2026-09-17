# 浏览器执行边界

`src/index.ts` 导出 `BrowserSession`，每个实例启动一个本机浏览器进程，通过独立的本地 CDP 调试端口连接其持久化上下文。默认优先已安装的 Google Chrome，再选择 Microsoft Edge；浏览器使用独立的流程配置目录，保留该目录中的登录状态。可视化步骤和 Python／JS／TS 脚本通过同一个 `call(method, params)` 入口顺序使用会话；原生 Page 和 Locator 不传出执行进程。

## 接口

```ts
const browser = new BrowserSession({
  profileDir: 'C:/RPA/profiles/account-a',
  downloadDir: 'C:/RPA/downloads',
  runId: 'run-001',
  headless: false,
  browserChannel: 'auto', // auto / chrome / msedge / chromium
  debugPort: 0, // 0 由浏览器自动分配；也可指定 1024–65535 的端口
  popupPolicy: 'smart', // smart / strict / off，默认 smart
});
await browser.start();
console.log(browser.getInfo()); // { pageId: 'main', browserChannel: 'chrome', debugPort: ... }
await browser.call('browser.open', { url: 'http://127.0.0.1:3000' });
await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
await browser.close();
```

初始当前网页为 `main`。省略、留空或使用 `$current` 的 `pageId` 指向流程当前网页；显式 `pageId` 优先于元素的 `pageRef`，否则使用 `pageRef` 或当前网页。元素动作支持直接传入 `selector`，或传入 `element: { pageRef, framePath, selector, expectedCount }`，其中 `framePath` 逐层描述 iframe 选择器。交互动作要求目标唯一。`timeoutMs` 默认 15000 毫秒，必须大于零。

| 方法 | 主要参数 | 输出 |
| --- | --- | --- |
| `browser.open` | `url`, `pageId?`, `openMode?: reuse / new` | `{ pageId, url }` |
| `browser.switchPage` | `pageId?` | `{ pageId, url }` |
| `browser.closePage` | `pageId?` | `{ ok: true, pageId }` |
| `browser.listPages` / `listPages()` | 无；不会启动浏览器 | `[{ pageId, title, url, current, openerPageId? }]` |
| `browser.popupGuard` | `mode`: `off` / `smart` / `strict` | `{ mode }` |
| `browser.click` | 元素参数 | `{ ok: true }` |
| `browser.fill` | 元素参数、`value` | `{ ok: true }` |
| `browser.text` | 元素参数 | 文本 |
| `browser.table` | 表格元素参数 | `{ headers, rows }` |
| `browser.wait` | 元素参数 | `{ ok: true }`；等待元素可见 |
| `browser.select` | 原生 select 元素参数、`value` | `{ ok: true, values }` |
| `browser.assertText` | 元素参数、`text` | `{ ok: true, text }`；等待包含期望文本 |
| `browser.response` | 触发元素参数、`urlIncludes`, `method?`, `requestIncludes?` | `{ url, status, method, requestBody, headers, body }` |
| `browser.download` | 触发元素参数、`directory?`, `filename?` | `{ path, name, size, sourceUrl }` |
| `browser.evaluate` | `expression`, `pageId?` | JSON 可表达的值 |
| `browser.show` / `browser.hide` | `pageId?` | `{ state, headless }` |

## 运行约束

- 默认启动有界面浏览器并最小化；显示／最小化操作使用 Chromium CDP，同一浏览器和页面继续存在。此操作不保证 Windows 前台焦点，不实现键鼠空闲检测和前台仲裁。
- 浏览器退出后，按本会话自动下载的 GUID 和临时路径精确移除已复制到产物目录的临时下载记录，避免 Chromium 恢复这些记录后再次下载时崩溃。真实产物、手动下载记录、登录和浏览历史保留。该兼容处理使用 Node.js 22.13+ 的内置 SQLite。
- 旧版本已经留下的临时下载记录无法可靠区分自动下载与手动下载，因此不会批量删除旧记录。若旧配置目录已受此浏览器问题影响，可改用新的流程配置目录，或由用户在浏览器下载列表中移除已失效的临时记录；实际导出文件不受影响。
- 「打开网页」合并启动配置，执行器将 `browserChannel` 和 `debugPort` 传给首次建立的会话。底层 `BrowserSession` 的启动参数仍由构造函数传入。旧 `browser.start` 继续兼容执行；已启动的会话不会因再次打开网页而被替换，配置冲突时明确报错。
- 界面高级设置将端口分为「自动分配」与「手动指定」，默认自动。手动端口保存为数字 `debugPort`（1024–65535）；切回自动会移除该参数，兼容已有 `debugPort: 0`。缺省和 `0` 均由原生浏览器自动分配端口，流程 JSON 版本不变。
- 每次新建会话的自动端口互不冲突，调试服务只监听 `127.0.0.1`。显式端口被占用时会报错，不会连接其它程序。连接地址中的 WebSocket 标识从本次浏览器子进程读取，防止误接另一个浏览器。
- `auto` 有界面模式找不到 Chrome/Edge 时给出安装提示，显式选择未安装的浏览器也会报错；`headless: true` 的 `auto` 使用项目安装的 Chromium，以保持自动测试环境可复现。可显式选择 Chrome/Edge 进行无头运行。show／hide 在无头模式只返回状态说明，不切换浏览器运行模式。
- 「保留浏览器」继续保留同一原生进程和端口；手动关闭最后一个窗口会释放流程会话。关闭或取消流程时，执行器关闭自己启动的进程；启动失败、端口错误和启动取消也会回收进程、释放配置目录租约。
- 配置目录内 `.rpa-profile.lock` 使用独占创建。Windows 本地目录遇到旧租约时，会核查原执行器及使用该真实目录的 Chrome／Edge／Chromium 进程；两者均已退出才自动回收并继续启动。执行器已退出但浏览器仍开着时保持原锁，不会关闭或接管该浏览器。
- 回收通过 Windows 系统命名互斥锁串行执行；重读原租约、删除、独占发布新租约均在持锁进程内完成。并发任务只能有一个取得所有权，失败或取消实例仅清理自己令牌对应的租约。旧版本租约格式兼容，无需删除登录资料。
- 锁内容损坏、查询失败、权限不足、进程信息无法确认、网络目录及非 Windows 平台均不会自动回收。PID 被其他活进程复用时也保守视为占用；错误会明确说明未清理的原因。正常停止、启动失败和取消仍释放本任务拥有的租约。
- `browser.response` 在点击前监听，只接受监听建立之后发出的匹配请求，避免把已经在途的旧响应当成本次操作结果。
- 下载在点击前监听。最终文件使用独占名称预留，同名追加 `(1)`、`(2)`；完成保存并读取实际文件信息后返回成功。浏览器关闭前已保存的文件会保留。
- `browser.evaluate` 面向用户自己的本地脚本，不构成运行不可信脚本的安全沙箱。任意页面表达式超时后关闭并废弃整个会话，以阻止晚到的脚本继续影响后续步骤。

## 标签页与别名

监听浏览器上下文的新页事件，启动时登记已有页面，首个为 `main`，其余自动分配不重复的 `page-N`。页面导航、标题变化与前台焦点变化不会更换别名；列表每次读取实时标题和网址，关闭页面立即移除。自动编号不在同一会话中复用，避免旧目标误指向另一网页。

`openMode: reuse` 在指定网页导航；显式别名尚不存在时创建并绑定该别名。`openMode: new` 始终创建新页，活页别名碰撞会在创建前报错。打开成功会更新流程当前目标；元素操作即使指定其他别名也不会改变当前目标。旧流程或脚本调用 `browser.switchPage` 时仍可更改当前目标。

点击元素始终在当前或明确指定的目标网页执行，返回 `{ ok: true }`。点击产生的新标签页会自动登记为 `page-N`，但不改变流程的当前网页；后续可在动作的“目标网页”中选择该网页，或通过 `browser.listPages` 查询后把名称填入动作的 `pageId`。每条动作都独立使用所选目标，不改变后续动作的当前网页。`browser.switchPage` 仅保留旧流程与脚本兼容，工作台不再提供新增指令入口。旧流程中的 `waitForNewPage` 和 `newPageId` 在加载、保存和运行时清除，不再解析变量、等待新页或切换目标。关闭当前目标后，隐式网页操作会报错，需为动作选择有效目标或新建网页；指定已关闭的别名操作同样报错。

`DesktopApi.listBrowserPages(runId)` → manager → worker → engine → `BrowserSession.listPages()` 只读查询现有会话，通过独立请求编号匹配应答，10 秒超时，进程退出或运行器关闭时清理等待。浏览器原生对象不经 IPC 传递，列表只包含 JSON 数据。页面标题、网址是展示信息，不作为隐式定位依据。

## 受控样本

`tests/fixtures/pages-server.ts` 提供多页、延迟弹出、慢加载和同页导航样本。`tests/browser-pages.test.ts`、`tests/browser-pages-manager.integration.test.ts` 与 `scripts/smoke-browser-pages.mjs` 分别覆盖会话层、真实执行进程和桌面编辑／操作闭环。

`tests/fixtures/server.ts` 导出 `startFixtureServer()`。它提供订单查询、状态筛选、延迟响应、延迟 CSV 导出和跨域嵌套 iframe。主页面使用 `127.0.0.1`，第一层 iframe 使用 `localhost`。输入 Alice 或 Bob 查询固定订单；输入其他客户名会生成一条标注 `ORD-DEMO` 的示例记录，用于核对跨语言传值和下载内容。

测试入口：`npx vitest run tests/browser.test.ts tests/browser-native.test.ts tests/browser-retention.test.ts tests/profile-recovery.test.ts tests/profile-processes.test.ts`。有界面测试使用本机 Chrome/Edge，需要用户桌面会话；其余浏览器操作默认使用无头 Chromium。覆盖独立端口、端口占用、未安装浏览器、启动失败、取消启动、窗口关闭、浏览器保留、失效租约恢复、真实孤儿浏览器及两个独立进程争抢配置目录。原有红绿过程记录在 [TDD.md](./TDD.md)。

## 官方 API 依据

- [Playwright CDP 连接](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Chrome 调试端口与独立用户数据目录要求](https://developer.chrome.com/blog/remote-debugging-port)
- [Playwright 响应事件](https://playwright.dev/docs/api/class-page#page-wait-for-response)
- [Chromium Browser.setWindowBounds](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds)

## 浏览器弹窗屏蔽

`BrowserSessionOptions.popupPolicy` 默认是 `smart`，可设置为 `off`、`smart` 或 `strict`。调用 `browser.call('browser.popupGuard', { mode: 'smart' })` 可在运行中切换，返回 `{ mode: 'smart' }`。设置对这个浏览器会话的已有和后续标签页、iframe 生效，不跨浏览器共享。

- `smart`：取消原生 `alert`、`confirm`、`prompt`、`beforeunload`；阻止未由近期真实点击或键盘操作触发的 `window.open`、脚本触发的新窗链接，以及已识别的广告网址；隐藏带广告、营销、订阅、Cookie 等特征的浮层及空白遮罩。普通链接或按钮主动打开的窗口保留。
- `strict`：包含智能模式规则，并阻止网页额外弹出的新窗口和通用模态浮层。显式 `browser.open` 创建的标签页仍可使用；固定导航、普通正文及已识别的登录、支付、业务确认界面保留。
- `off`：移除注入脚本、DOM 观察器和函数包装，恢复该功能修改的样式及仍存在的弹层；原生对话框交由用户处理。已经拦截的新窗口不能重新创建。

本功能不会点击“同意 Cookie”“确认订单”等按钮。原生确认返回 `false`，输入提示返回 `null`；`beforeunload` 选择取消会保留原页面，因此相应导航可能被网页取消。需要业务确认的步骤可先关闭屏蔽，再由明确的交互处理。

页面在文档初始化时安装防护，动态 DOM 变化按 120 毫秒节流；同时监测跨源 iframe 和注入后创建的 Shadow DOM。模式切换使用可移除的初始化脚本，避免旧模式随导航继续生效。关闭浏览器时注销会话事件并清理脚本。

这是基于特征的防护，无法保证屏蔽所有网站弹窗。无明显特征的营销组件、浏览器扩展及系统级弹窗、开启防护前已经存在的封闭 Shadow DOM、故意绕过包装的页面脚本可能无法识别。智能模式优先保留疑似业务界面；严格模式可能隐藏通用说明弹层，必要时切换为智能模式或关闭。不会代替浏览器自身的安全提示和权限控制。
