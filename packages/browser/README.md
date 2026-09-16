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
});
await browser.start();
console.log(browser.getInfo()); // { pageId: 'main', browserChannel: 'chrome', debugPort: ... }
await browser.call('browser.open', { url: 'http://127.0.0.1:3000' });
await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
await browser.close();
```

默认 `pageId` 为 `main`。元素动作支持直接传入 `selector`，或传入 `element: { pageRef, framePath, selector, expectedCount }`，其中 `framePath` 逐层描述 iframe 选择器。交互动作要求目标唯一。`timeoutMs` 默认 15000 毫秒，必须大于零。

| 方法 | 主要参数 | 输出 |
| --- | --- | --- |
| `browser.open` | `url`, `pageId?` | `{ pageId, url }` |
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
- 「启动浏览器」指令可以独立选择浏览器与端口；省略该指令时，第一个浏览器动作以默认配置建立会话。已启动的会话不会因再次执行启动指令而被替换。
- 每次新建会话的自动端口互不冲突，调试服务只监听 `127.0.0.1`。显式端口被占用时会报错，不会连接其它程序。连接地址中的 WebSocket 标识从本次浏览器子进程读取，防止误接另一个浏览器。
- `auto` 有界面模式找不到 Chrome/Edge 时给出安装提示，显式选择未安装的浏览器也会报错；`headless: true` 的 `auto` 使用项目安装的 Chromium，以保持自动测试环境可复现。可显式选择 Chrome/Edge 进行无头运行。show／hide 在无头模式只返回状态说明，不切换浏览器运行模式。
- 「保留浏览器」继续保留同一原生进程和端口；手动关闭最后一个窗口会释放流程会话。关闭或取消流程时，执行器关闭自己启动的进程；启动失败、端口错误和启动取消也会回收进程、释放配置目录租约。
- 配置目录内 `.rpa-profile.lock` 使用独占创建。失败实例没有锁所有权，不能清理成功实例的租约。异常退出留下的租约不会自动删除；先确认文件中记录的进程及浏览器已退出，再由运维清理该锁文件。
- `browser.response` 在点击前监听，只接受监听建立之后发出的匹配请求，避免把已经在途的旧响应当成本次操作结果。
- 下载在点击前监听。最终文件使用独占名称预留，同名追加 `(1)`、`(2)`；完成保存并读取实际文件信息后返回成功。浏览器关闭前已保存的文件会保留。
- `browser.evaluate` 面向用户自己的本地脚本，不构成运行不可信脚本的安全沙箱。任意页面表达式超时后关闭并废弃整个会话，以阻止晚到的脚本继续影响后续步骤。

## 受控样本

`tests/fixtures/server.ts` 导出 `startFixtureServer()`。它提供订单查询、状态筛选、延迟响应、延迟 CSV 导出和跨域嵌套 iframe。主页面使用 `127.0.0.1`，第一层 iframe 使用 `localhost`。输入 Alice 或 Bob 查询固定订单；输入其他客户名会生成一条标注 `ORD-DEMO` 的示例记录，用于核对跨语言传值和下载内容。

测试入口：`npx vitest run tests/browser.test.ts tests/browser-native.test.ts tests/browser-retention.test.ts`。有界面测试使用本机 Chrome/Edge，需要用户桌面会话；其余浏览器操作默认使用无头 Chromium。覆盖独立端口、端口占用、未安装浏览器、启动失败、取消启动、窗口关闭、浏览器保留和跨进程配置目录租约。原有红绿过程记录在 [TDD.md](./TDD.md)。

## 官方 API 依据

- [Playwright CDP 连接](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Chrome 调试端口与独立用户数据目录要求](https://developer.chrome.com/blog/remote-debugging-port)
- [Playwright 响应事件](https://playwright.dev/docs/api/class-page#page-wait-for-response)
- [Chromium Browser.setWindowBounds](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds)
