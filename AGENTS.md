# Repository Guidelines

## 项目结构与模块组织

本项目是 Windows 本地 RPA 工作台，使用 Electron、React、TypeScript 和 Playwright。

- `apps/desktop/`：主进程、preload 与 React 界面；界面样式位于 `src/renderer/styles.css`。
- `apps/runner/`：CLI、运行管理器及独立任务进程。
- `packages/`：`contracts` 定义共享协议，`actions` 定义动作，`engine` 编排执行；`browser`、`windows`、`scripts`、`sdk-js`、`persistence` 分别负责浏览器、Windows UIA 与输入保护、脚本桥、SDK 和存储。
- `python/rpa_sdk/`：Python SDK；`examples/demo.ts`：跨语言演示流程。
- `tests/`：模块测试；`tests/integration/`：端到端流程验证；`tests/fixtures/`：受控 HTTP 网站。
- `scripts/`：构建、开发与桌面冒烟脚本；`docs/`：需求和设计；`dist/`：生成产物。

当前使用说明以 `README.md` 为入口；可靠运行、调度、历史和子流程见 `docs/可靠性与长期运行.md`。D0／D1 验收及 2026-09-15 需求设计为历史记录，不能据此判断当前功能是否实现。行为变化应同步维护对应的当前说明。

## 构建、测试与本地开发

在仓库根目录执行命令。环境要求：Windows、Node.js 22.13+（浏览器兼容处理使用内置 SQLite）；Python 步骤需要 Python 3.10+。

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run setup` | 安装 Electron 二进制与 Chromium |
| `npm run dev` | 启动开发界面；主进程或执行器修改后需重启 |
| `npm run build` / `npm start` | 使用 esbuild、Vite 构建，再启动桌面程序 |
| `npm run typecheck` | 检查 TypeScript 类型 |
| `npm test` / `npm run test:integration` | 运行全部 Vitest 测试或仅集成测试 |
| `npm run test:desktop` | 构建并验证真实 Electron、图标、恢复、调度、历史、浏览器、XLSX 与 Windows 自动化 |
| `npm run check` | 依次执行类型检查、测试和构建 |

无头演示：`npm run demo -- --headless --close-browser --output C:\RPA\downloads`。

## 代码风格与命名

TypeScript 启用 `strict`，使用 ESM、两空格缩进和分号；相对模块导入沿用 `.js` 后缀。函数与变量用 `camelCase`，类型、类和 React 组件用 `PascalCase`。Python 使用四空格缩进及 `snake_case`。引号风格遵循所在文件。当前未配置 ESLint 或 Prettier，避免无关的全文件格式化。

共享流程格式和 IPC 类型放入 `packages/contracts/`。浏览器对象留在执行器内，脚本 RPC 仅传递 JSON 值。

## 测试规范

测试命名为 `tests/**/*.test.ts`，使用 Vitest 的 `describe`、`it`、`expect`；单文件示例：`npx vitest run tests/browser.test.ts`。当前未设置覆盖率门槛，测试文件串行执行。

行为变更应覆盖成功、失败及相关的超时或取消路径；浏览器测试复用受控网站，清理临时目录、进程和会话。部分测试需要 Windows 桌面会话，跨语言测试需要 Python。界面变更运行桌面冒烟测试，截图输出至 `.rpa/qa/desktop-success.png`。

全量检查与桌面冒烟串行执行。真实键鼠及快捷键捕获需要空闲且可交互的桌面；设置 `RPA_SKIP_DESKTOP_INTERACTION=1` 可显式跳过这些验收，必须报告跳过项，恢复交互后去掉该变量补验。

## 提交与 Pull Request

提交沿用 `类型: 简短说明`，如 `fix: 修复下载取消后的状态`、`docs: 更新当前功能说明`；每次提交聚焦一个目的。

PR 应说明问题、行为变化及验证命令和结果，有关联 issue 时附链接。界面变更附截图；涉及流程格式、RPC 或配置时，同步更新相关文档并说明兼容性影响。

## 配置与代理约定

不要提交 `.rpa/`、浏览器登录资料、`.env`、日志或生成产物。CLI 数据目录可通过 `--data` 或 `RPA_DATA_DIR` 指定，桌面与 CLI 不应同时共享同一数据目录。脚本进程不是安全沙箱，仅运行可信脚本。代理始终使用中文回复。
