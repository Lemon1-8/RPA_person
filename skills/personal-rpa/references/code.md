# 代码入口

JS／TS 必须导出 `main(rpa)`；运行器显式等待它完成。业务结果只通过 `rpa.output()` 提交，`main` 返回值不作为结果。JS 遵循入口项目的 ESM／CommonJS 配置，TS 使用 tsx；支持相邻模块及项目已安装的依赖。

```javascript
export async function main(rpa) {
  const url = await rpa.get('url');
  await rpa.call('browser.open', { url });
  await rpa.output(await rpa.call('browser.text', { selector: '#status' }));
}
```

CommonJS 项目使用 `.js` 文件和 `exports.main = async function (rpa) { ... }`；入口只支持 `.js`，不支持 `.cjs`／`.mjs`。不要只在顶层启动未等待的异步函数；`main` 内自己等待定时器和异步任务。子进程退出后不保留后台任务。

Python 像普通脚本执行，使用同步接口：

```python
from rpa_sdk import rpa
rpa.call('browser.open', {'url': rpa.get('url')})
rpa.output(rpa.call('browser.text', {'selector': '#status'}))
```

Python 支持 `import sibling`，首版不提供 `python -m` 模式的包内相对导入。通过 `--python C:\项目\.venv\Scripts\python.exe` 选虚拟环境。

文件模式 cwd 默认是调用项目目录，可用 `--cwd` 覆盖。模块导入仍从源文件所在位置解析；资源文件应以 cwd 或输入的绝对路径定位。`argv` 只包含实际入口，无用户命令行参数；业务输入用 JSON 变量。

接口：`rpa.call(method, params)`、`rpa.get(name)`、`rpa.set(name,value)`、`rpa.getRunContext()`（Python 为 `get_run_context`）、`rpa.output(value)`。JS／TS 均需 await；Python 为同步。跨进程仅传 JSON，不能返回 Page、Locator 或类实例。

可调用 browser、windows、desktop 动作、file.xlsxRead/Write，以及变量和运行信息接口；先查询动作目录的 scriptRpc。容器、workflow.call、script.run 不能通过 RPC 递归调用。循环和异常处理使用本语言语法。SDK 不进行 `{{变量}}` 模板替换。

XLSX 返回值：`file.xlsxRead` 返回 `{sheetName, rows}`，其中 rows 才是行对象数组；`file.xlsxWrite` 返回产物对象 `{path, name, size, stepId?}`，同时登记到 run.artifacts。例如：

```javascript
const { rows } = await rpa.call('file.xlsxRead', { path: await rpa.get('inputFile') });
const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
const report = await rpa.call('file.xlsxWrite', { path: await rpa.get('outputFile'), rows: [{ total }] });
await rpa.output({ total, report });
```

脚本错误使所属步骤失败。真实输入被接管后，即使捕获了 RPC 异常，Agent 模式仍会停止，不能继续发送输入。流程内部的旧内联脚本继续支持顶层 await，并使用安装根 cwd；文件模式的 main 契约不影响它。
