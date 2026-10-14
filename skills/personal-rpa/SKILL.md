---
name: personal-rpa
description: 开发、检查、运行和排查 Windows 本地 RPA 自动化，使用 rpa-agent 执行流程 JSON 或 Python、JavaScript、TypeScript 文件，操作网页、Windows 控件、真实键鼠及 XLSX。适用于创建可复用自动化；不用于逐步代操作电脑或纯前端界面开发。
---

# Personal RPA

使用已安装的 `rpa-agent` 命令执行任务；无需启动 Electron。先运行 `rpa-agent doctor` 确认环境。找不到命令时阅读 [安装说明](references/install.md)，不要猜测本机仓库路径。

## 开发与执行

1. 确定需要的动作，通过 `rpa-agent actions <动作名>` 查询真实参数，按需读取 [CLI 与结果约定](references/cli.md)。目录中的 `scriptRpc` 表示能否从 `rpa.call()` 调用，不能把全部流程动作当作脚本接口。
2. 按任务选择格式：现有流程与固定修订子流程使用 JSON，读取 [流程格式](references/workflow.md)；复杂逻辑、模块与项目依赖使用代码文件，读取 [代码入口](references/code.md)。不需要把简单脚本强行改成步骤树。
3. 将业务参数放在 JSON 变量文件，以 `--variables` 传入；文件路径参数按动作要求使用绝对路径。保持代码、流程和元素定位可供后续项目维护。
4. 运行 `rpa-agent check <文件>`，处理错误并判断警告是否影响当前任务；再使用相同的参数执行 `run`。检查不会执行业务代码，也不证明真实站点能成功操作。
5. 解析 stdout 的 JSON 和退出码。检查最终状态、业务结果、警告及产物；需要更多信息时用 `logs`、`result`。只有退出码 0 且结果符合业务预期才报告完成。

## 运行边界

- 运行器执行实际动作，Agent 负责开发、验证和解释结果。用项目依赖处理语言自身的数据逻辑，复用运行时处理浏览器、Windows 和产物。
- 默认运行数据位于调用项目的 `.rpa/agent`。不要让不同运行器共用一个活动数据目录；忙时会返回 `DATA_DIR_BUSY`。历史查询只读。
- 遇到 `MANUAL_REQUIRED`、用户接管、超时或取消，保存并报告原因与产物。涉及外部效果的失败先核实是否已部分完成，再决定是否重跑；不盲目自动重试。
- Agent 入口会关闭本次浏览器并退出。验证码、人工确认需要由用户处理；运行时不自动绕过。
- 真实键鼠需要可交互的 Windows 桌面，沿用输入保护；CLI 可用 Ctrl+C 取消。脚本拥有本机用户权限，不是安全沙箱。
- 不隐式安装业务依赖。Python 虚拟环境通过 `--python` 指定；Chromium 通过 `rpa-agent setup-browser` 显式安装。

可参考 [流程示例](assets/workflow.json)、[JS 示例](assets/web-export.js)、[TS 示例](assets/web-export.ts)、[Python 示例](assets/web-export.py) 和 [Windows 控件示例](assets/windows-read.js)，替换业务 URL、选择器及路径后使用。
