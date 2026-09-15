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

JS／TS 脚本结束前会等待已经提交的 RPC。未处理的请求失败会使步骤失败；用户通过 `await` 与 `try/catch` 处理的失败可以继续运行。定时器或其他异步任务中尚未提交的请求需要由脚本自己 `await`。

## 运行环境

- `RPA_ROOT` 指向项目／安装资源根目录，缺省为当前工作目录。
- 生产构建将 `packages/scripts/src/child.ts` 打包为 `dist/scripts/child.cjs`，使用 esbuild `platform: 'node', format: 'cjs', target: 'node22'`。
- `RPA_SCRIPT_CHILD` 可显式指定子进程入口；源码运行使用 `node --import tsx packages/scripts/src/child.ts`，生产 bundle 使用 `dist/scripts/child.cjs`，避免源码开发误用旧构建。
- Python 默认使用 PATH 中的 `python`，可通过 `runScript` 的 `pythonExecutable` 指定虚拟环境解释器。SDK 目录通过 `PYTHONPATH` 传入，不会安装用户依赖。
- Node 子进程继承明确配置的项目环境。脚本进程分离用于故障隔离和生命周期管理，**不是安全沙箱**；只运行可信的本地脚本。

`console.log`／`print` 作为步骤日志传回；RPC 与普通日志分开处理。脚本超时或取消会终止该脚本的进程树，不应关闭任务浏览器。执行器应在 `dispatch` 中检查运行取消状态，拒绝取消后才完成的浏览器／变量请求。
