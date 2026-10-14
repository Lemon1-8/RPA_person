# 本地脚本桥

脚本作为独立子进程运行，通过逐行 JSON RPC 使用当前任务执行器。浏览器对象留在执行器；仅 JSON 值跨进程。

```javascript
const count = await rpa.call('browser.text', { selector: '#value' });
await rpa.set('count', count);
await rpa.output({ count: await rpa.get('count') });
```

```python
from rpa_sdk import rpa

count = rpa.call('browser.text', { 'selector': '#value' })
rpa.set('count', count)
rpa.output({ 'count': rpa.get('count') })
```

`rpa.get` 和 `rpa.set` 每次请求当前执行器的变量。JavaScript／TypeScript 接口为异步；Python 接口为同步。`rpa.output` 保存该步骤的输出；未指定时输出为 `null`。脚本异常仍会使步骤失败。

## 运行信息

运行标识和计划时间不自动注入变量。通过 JS／TS 的 `await rpa.getRunContext()` 或 Python 的 `rpa.get_run_context()` 显式读取，只读返回 `runId`、`attemptId`、`scheduleId`、`scheduledFor`、`startedAt` 和 `actualTime`；手动运行的计划字段为 `null`。低代码对应“读取运行信息”（`core.runContext`）。

```typescript
const context = await rpa.getRunContext();
await rpa.set('context', context);
await rpa.output(context);
```

```python
context = rpa.get_run_context()
rpa.set('context', context)
rpa.output(context)
```

脚本源码原样执行，不替换 `{{变量}}` 文本；需要当前业务变量时使用 SDK。子流程中的脚本使用子流程局部变量和脚本环境，浏览器请求仍使用父流程共享的会话。

## 动作与执行收尾

Windows 软件控件使用 `rpa.call('windows.…', …)`，与低代码共用桌面元素库、参数校验、超时与取消机制，无需启动浏览器。`windows.find` 的输出含 JSON 定位引用，后续以 `element: result.element`（Python 为 `result['element']`）调用。接口和用法见 [Windows 元素自动化](../../docs/Windows元素自动化.md)，可粘贴的 [JavaScript 示例](../../examples/windows-elements.js) 和 [Python 示例](../../examples/windows-elements.py) 使用已捕获的命名元素。

网页截图通过 `browser.screenshot` 使用当前任务浏览器，也会登记运行产物。例如 JS／TS：`await rpa.output(await rpa.call('browser.screenshot', { pageId: 'orders', filename: '订单.png', fullPage: true }));`；Python：`rpa.output(rpa.call('browser.screenshot', { 'pageId': 'orders', 'filename': '订单.png', 'fullPage': True }))`。省略保存目录时继承当前指令／流程的下载目录；返回 `path`、`name`、`size`、`sourceUrl`、`pageId`。

JS／TS 脚本结束前会等待已经提交的 RPC。未处理的请求失败会使步骤失败；用户通过 `await` 与 `try/catch` 处理的失败可以继续运行。定时器或其他异步任务中尚未提交的请求需要由脚本自己 `await`。

## 运行环境

`script.run` 也可用 `filePath` 执行文件，与内联 `code` 二选一。Agent CLI 会按流程文件目录解析相对路径。JS／TS 文件需导出 `async function main(rpa)`，执行器等待其完成；结果仍由 `rpa.output()` 指定，main 返回值不作为结果。CommonJS 使用 `exports.main`，Python 按普通脚本执行并支持相邻模块导入。文件模式 cwd 由调用入口指定；旧内联脚本保持安装根 cwd 与顶层 await 行为。详见 [Agent 使用与分发](../../docs/Agent使用与分发.md)。

脚本 RPC 现在也支持 `desktop.*`、`file.xlsxRead` 和 `file.xlsxWrite`，与流程步骤共用参数校验、输入保护和产物登记。容器、子流程调用和脚本执行动作不开放为 RPC。在 Agent 模式下，`INPUT_INTERRUPTED` 即使被脚本捕获也会停止后续操作，由 CLI 保存原因并收尾。

- `RPA_ROOT` 指向项目／安装资源根目录，缺省为当前工作目录。
- 生产构建将 `packages/scripts/src/child.ts` 打包为 `dist/scripts/child.cjs`，使用 esbuild `platform: 'node', format: 'cjs', target: 'node22'`。
- `RPA_SCRIPT_CHILD` 可显式指定子进程入口；源码运行使用 `node --import tsx packages/scripts/src/child.ts`，生产 bundle 使用 `dist/scripts/child.cjs`，避免源码开发误用旧构建。
- Python 默认使用 PATH 中的 `python`，可通过 `runScript` 的 `pythonExecutable` 指定虚拟环境解释器。SDK 目录通过 `PYTHONPATH` 传入，不会安装用户依赖。
- Node 子进程继承明确配置的项目环境。脚本进程分离用于故障隔离和生命周期管理，**不是安全沙箱**；只运行可信的本地脚本。

`console.log`／`print` 作为步骤日志传回；RPC 与普通日志分开处理。脚本超时或取消会终止该脚本的进程树，不应关闭任务浏览器。执行器应在 `dispatch` 中检查运行取消状态，拒绝取消后才完成的浏览器／变量请求。
