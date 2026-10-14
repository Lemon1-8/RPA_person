# Agent 使用与分发

本项目提供独立的 `rpa-agent` CLI、通用 `personal-rpa` Skill 和 Skill 插件包。Agent 负责编写、检查和调用，实际自动化仍由现有运行器执行；无需启动 Electron。支持流程 JSON、Python、JavaScript 和 TypeScript，不提供 MCP 或常驻会话。

## 安装与使用

要求 Windows、Node.js 22.13+；执行 Python 时需要 Python 3.10+。从分发目录取得 `.tgz` 后：

```powershell
npm install -g .\personal-rpa-runtime-0.1.0.tgz
rpa-agent doctor
# 无头执行需要当前版本 Chromium；安装显式执行，不在运行任务时自动下载
rpa-agent setup-browser
rpa-agent check .\task.ts --variables .\inputs.json
rpa-agent run .\task.ts --variables .\inputs.json --output .\downloads
```

安装需联网获取依赖，包含来自 SheetJS CDN 的 XLSX 包。运行时不包含 Electron、React、开发源码或用户依赖；有头浏览器默认选择本机 Chrome／Edge。Python 依赖自行安装，虚拟环境可用 `--python C:\项目\.venv\Scripts\python.exe` 指定。

JS／TS 文件导出 `async function main(rpa)`；CommonJS 使用 `exports.main = async function (rpa) { ... }`。运行器等待 main 完成，结果使用 `rpa.output()`，不读取 main 的返回值。Python 使用 `from rpa_sdk import rpa`，按普通脚本执行。可导入相邻模块和项目已安装的依赖，首版不提供 Python `-m` 包入口。文件模式的 cwd 默认为调用目录，`--cwd` 可覆盖；内联脚本仍保留原行为。

```javascript
export async function main(rpa) {
  await rpa.call('browser.open', { url: await rpa.get('url') });
  await rpa.output(await rpa.call('browser.text', { selector: '#status' }));
}
```

流程 JSON 继续使用 v1，可直接运行，不需要保存到桌面流程库。`--variables inputs.json` 必须是对象，浅合并覆盖默认变量；`inputs` 仍是名称声明，`outputs` 指定业务结果。子流程通过可重复的 `--dependency child.json` 显式传入，按固定 workflowId@revision 匹配，不扫描文件夹。

脚本动作新增 `filePath`，与内联 `code` 二选一。JSON 中相对 filePath 按所属流程文件目录解析；其他动作的文件参数仍使用完整绝对路径。代码模式的相对模块从源文件目录解析，业务资源按 cwd 或输入的绝对路径定位。

## 命令与机器输出

| 命令 | 用途 |
| --- | --- |
| `doctor` / `setup-browser` | 检查环境／显式安装 Chromium |
| `actions [动作名]` / `schema` | 查询真实动作定义／流程 JSON Schema |
| `check <文件>` / `run <文件>` | 检查／执行流程或代码文件 |
| `runs [runId]` | 查询历史列表／完整运行快照 |
| `logs <runId> --limit 100 --before <sequence>` | 分页读取日志，首次省略 before |
| `result <runId>` | 查询业务结果、最终状态及产物位置 |
| `result <runId> --result-id <resultId>` | 读取日志引用的大型步骤结果 |

CLI 的 stdout 是单个 `{apiVersion:1,ok,data?,error?}` JSON，日志写入 stderr。成功退出码 0（含警告），执行未成功为 1，输入／环境／预检／目录占用错误为 2。直接调用安装后的 `rpa-agent`；`npm run rpa:agent` 会额外打印 npm 自身提示，不应把整段 stdout 当作协议响应。

`run` 的 data 包含 `run`、`result`、`reason` 和 `paths`。代码结果取 rpa.output（默认 null），JSON 结果取 outputs 声明且实际产生的变量。完整变量在 run.variables，产物在 run.artifacts。`MANUAL_REQUIRED`、`TIMEOUT`、`CANCELLED`、`EXECUTION_FAILED`、`CLEANUP_FAILED` 可用于区分失败原因；目录占用为 `DATA_DIR_BUSY`。

默认总超时 30 分钟，`--timeout-ms` 可覆盖；代码文件同时受单步骤最多 1 小时的现有限制。JSON 保留自己的浏览器模式与步骤超时，代码入口默认有头，`--headless` 启用无头。资源等待也受总超时限制。Agent 入口在成功、失败、暂停、人工等待、超时及取消时清理本次浏览器和子进程后返回；人工等待不自动确认或重试。原始人工处理原因写入记录，即使停止后的快照 error 已改变也可查询。

路径参数按调用命令时的 cwd 解析；`--cwd` 设置业务工作目录。数据目录优先级为 `--data`、`RPA_DATA_DIR`、`<工作目录>/.rpa/agent`。代码默认下载到数据目录 downloads，JSON 保留自己的下载目录，`--output` 覆盖流程默认值；显式步骤目录保持优先。

动作目录中的 scriptRpc 标记能否从 rpa.call 调用。脚本支持 browser、windows、desktop、XLSX 读写、变量及运行信息接口；容器、workflow.call 和 script.run 不开放为 RPC。目录提供参数形状，不能表达所有运行时 refine 约束，以 check／执行校验为准。共享目录仅允许一个本机运行器持有写锁；各电脑使用独立数据目录，不支持跨机器共用网络数据目录。历史查询不初始化运行器、不恢复或修改状态。

## 安装 Skill 与插件

`npm root -g` 可查看包位置；完整 Skill 位于其中的 `personal-rpa-runtime/skills/personal-rpa`。将整个目录复制到对应宿主的用户级或项目级 Skill 目录：

- Codex：`.agents/skills/personal-rpa`；已有安装使用 `.codex/skills` 时按当前宿主配置选择一个位置。
- Claude Code：`.claude/skills/personal-rpa`。
- Cursor：`.cursor/skills/personal-rpa`。

保留 references、assets 和 agents。更新时替换同名 Skill，不要重复安装。也可在支持的宿主导入 `personal-rpa-plugin-0.1.0.zip`，该插件只包含 Skill，运行时仍需单独安装。npm 安装不会修改 Agent 配置或自动授权操作。

打包使用 [OpenAI 插件规范](https://developers.openai.com/plugins/build/plugins)的根 plugin.json，标记本地执行要求。Skill 加载方式参考 [Codex](https://learn.chatgpt.com/docs/build-skills)、[Claude Code](https://code.claude.com/docs/en/skills)、[Cursor](https://cursor.com/docs/skills) 当前文档。

## 构建与验收

在源码仓库执行：

```powershell
npm run build:agent
npm run pack:agent
npm run test:agent-package
```

构建目录为 `dist/agent-runtime`，分发包位于 `dist/releases`。独立构建只打包 Agent CLI、worker、脚本桥和 Python SDK，运行依赖为 Playwright、XLSX、Zod、esbuild 和 tsx；不依赖仓库源码或 Electron。`test:agent-package` 将 tgz 安装到仓库外临时目录，验证命令输出、三种语言、模块导入、XLSX 及 Skill／插件文件，结束后清理。

Skill 附带网页导出 JSON／JS／TS／Python 和 Windows 控件读取示例。先查询业务页面、选择器或 UIA 引用，再提供 url、selector、reportFile 或 element 变量。不要把示例当作已适配真实业务站点的模板。

真实键鼠需要空闲且可交互的桌面，保留输入保护。CLI 使用 Ctrl+C 取消，桌面工作台的 Ctrl+Alt+F12 仍只控制其自身管理的任务。脚本拥有本机用户权限，不是安全沙箱。文件模式使用当前项目代码和依赖，不保证历史记录能自动重建原依赖环境。`.rpa/`、登录资料、日志及生成包均不提交。
