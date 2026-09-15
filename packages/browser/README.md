# 浏览器执行边界

`src/index.ts` 导出 `BrowserSession`，每个实例拥有一个 Playwright Chromium 持久化上下文。可视化步骤和 Python／JS／TS 脚本通过同一个 `call(method, params)` 入口顺序使用会话；原生 Page 和 Locator 不传出执行进程。

## 接口

```ts
const browser = new BrowserSession({
  profileDir: 'C:/RPA/profiles/account-a',
  downloadDir: 'C:/RPA/downloads',
  runId: 'run-001',
  headless: false,
});
await browser.start();
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
- `headless: true` 用于自动测试；show／hide 在无头模式只返回状态说明，不切换浏览器运行模式。
- 配置目录内 `.rpa-profile.lock` 使用独占创建。失败实例没有锁所有权，不能清理成功实例的租约。异常退出留下的租约不会自动删除；先确认文件中记录的进程及浏览器已退出，再由运维清理该锁文件。
- `browser.response` 在点击前监听，只接受监听建立之后发出的匹配请求，避免把已经在途的旧响应当成本次操作结果。
- 下载在点击前监听。最终文件使用独占名称预留，同名追加 `(1)`、`(2)`；完成保存并读取实际文件信息后返回成功。浏览器关闭前已保存的文件会保留。
- `browser.evaluate` 面向用户自己的本地脚本，不构成运行不可信脚本的安全沙箱。任意页面表达式超时后关闭并废弃整个会话，以阻止晚到的脚本继续影响后续步骤。

## 受控样本

`tests/fixtures/server.ts` 导出 `startFixtureServer()`。它提供订单查询、状态筛选、延迟响应、延迟 CSV 导出和跨域嵌套 iframe。主页面使用 `127.0.0.1`，第一层 iframe 使用 `localhost`。输入 Alice 或 Bob 查询固定订单；输入其他客户名会生成一条标注 `ORD-DEMO` 的示例记录，用于核对跨语言传值和下载内容。

测试入口：`npx vitest run tests/browser.test.ts`。包含一个真实有界面浏览器测试，需要用户桌面会话；其余测试使用无头浏览器。2026-09-15 在 Windows 上 7 项全部通过，TypeScript 检查通过。红绿过程记录在 [TDD.md](./TDD.md)。

## 官方 API 依据

- [Playwright 持久化上下文](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- [Playwright 响应事件](https://playwright.dev/docs/api/class-page#page-wait-for-response)
- [Chromium Browser.setWindowBounds](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setWindowBounds)
