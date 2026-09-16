# Personal RPA · 本地流程工作台

按照 [RPA 开发方案 v0.1](docs/RPA开发方案-v0.1.md) 实现的首个可运行增量，覆盖 D0 技术验证与 D1 桌面下载闭环。

Electron + React + TypeScript 界面，独立 Node 任务进程，Playwright 浏览器，Python／JavaScript／TypeScript 脚本通过 RPC 共用当前浏览器。真实网站自动化由保存的流程和程序执行。

## 启动

环境：Windows、Node.js 22.13+（本机已用 24.18 验证）、Python 3.10+（执行 Python 步骤需要）。浏览器兼容处理使用 Node 内置 SQLite，因此最低 Node 版本从 22.12 提升至 22.13；不需要额外数据库服务。依赖版本由 `package-lock.json` 固定。

```powershell
npm ci
npm run setup
npm run build
npm start
```

本机依赖和 Chromium 已安装，代码也已构建，可直接运行 `npm start`，或双击根目录的 **启动工作台.cmd**。

开发模式：`npm run dev`，React 界面热更新；修改主进程／执行器后重新启动开发命令。

### 第一次使用

1. 打开内置「订单采集与导出」流程。
2. 在「运行设置」选择下载目录。默认桌面；路径须为完整绝对路径。
3. 点击「运行」。程序依次打开受控订单页面，混合执行可视化动作、Python、JS 和 TS，读取表格并保存 CSV。
4. 在底部「下载产物」查看实际文件，点击「打开」。重复导出同名文件自动增加序号。

默认使用本机安装的 Chrome（其次 Edge），以独立调试端口启动并连接，启动后最小化。在「启动浏览器」指令中可选择浏览器和端口，`0` 表示自动分配；不同会话使用不同端口，指定端口被占用时明确报错。无头自动模式使用项目安装的 Chromium，适合受控测试。可在底部显示或最小化当前任务浏览器，页面与登录状态保持在同一会话中。需要登录时可在关键步骤前暂停，显示浏览器手动操作，再继续。

**流程结束后默认保留浏览器，已有流程同样适用。** 在「运行设置 → 流程结束后的浏览器」选择「保留浏览器（默认）」或「自动关闭浏览器」。保留后可在运行记录中显示、最小化或手动关闭浏览器，也可直接关闭浏览器窗口。保留的会话继续占用浏览器配置与并发名额；再次运行同一流程／配置前请手动关闭。停止任务或退出程序会清理浏览器。

关闭编辑窗口会收起到托盘，运行继续。**托盘菜单「退出并停止任务」才退出程序**。

## 已实现

- 流程管理页面：新建、搜索、排序、重命名、复制、删除；多标签编辑，切换页面保留尚未保存的流程草稿。
- 纵向步骤编辑器：指令搜索、拖拽到目标步骤之后，或点击插入到选中步骤之后；增删复制排序、脚本代码、条件／循环缩进分组。
- 每条指令拥有独立参数、设置、变量和元素；左、右、底部面板可分别收起，布局在重开后保留。
- 定时运行页面：单次、每天、固定分钟间隔，创建／编辑／启停／删除，显示下次触发及最近运行结果。
- 版本化流程 JSON、输入变量、元素库；运行使用保存时的不可变版本。
- 网页打开、等待／点击／输入、文本／表格、原生下拉、页面结果校验。
- 逐层 iframe 定位、严格唯一匹配、元素库引用。
- 点击前建立响应或下载监听；响应按新请求及筛选信息关联。
- 自定义下载目录与文件名，跨进程独占文件名，成功落盘后记录产物。
- Python／JS／TS 独立进程，共用浏览器和变量，步骤日志、超时与取消。
- 变量设置、条件、遍历、JSON 结果校验；容器超时约束其子步骤，人工暂停不消耗容器的剩余期限。
- 多任务运行（默认 2）、同流程互斥、排队、步骤边界暂停／继续／停止。
- 安全读取／校验动作可重试或失败暂停。点击、下载、脚本等有外部效果的动作当前拒绝自动重试及失败后重跑。
- 运行状态、事件日志、失败截图、变量与下载结果持久化；启动时将未结束记录标为意外中断。
- CLI 与 TypeScript 运行管理公共接口。

## 编排约定

### 变量

`{{customer}}` 引用变量；完整引用保留数字、对象、数组等原始 JSON 类型；`订单-{{runId}}.csv` 将变量插入文本。

`{{orders.rows.0.0}}` 访问嵌套对象或数组。若存在名为 `order.total` 的完整变量名，`{{order.total}}` 优先读取该完整键。运行自动注入只读 `runId` 与 `scheduledFor`（手动运行的触发时间或定时任务的计划时间）。

步骤的「输出变量」保存动作结果。日期值使用 ISO 字符串；Page／Locator 等原生对象不跨进程。

右侧「步骤参数、设置、变量、元素」均对应当前选中的指令。步骤可选的 `variables`、`elements`、`settings.downloadDir` 和 `settings.pythonExecutable` 优先于流程默认值；容器子步骤继承，兄弟步骤隔离，失败或取消后也会恢复作用域。设置变量动作或脚本 `rpa.set` 对已声明的局部变量写入当前作用域，对未声明的名称保留原有共享变量行为；显式「输出变量」在退出局部作用域后写入父级，供后续步骤使用。旧流程无需迁移，流程默认变量与元素仍可在独立「运行设置」页面编辑。

### 定时运行

先保存流程，再进入顶部「定时运行」新建计划。支持指定日期时间、每天 `HH:mm`、每 N 分钟；使用运行电脑的本地时间，触发时读取流程的最新保存版本。关闭编辑窗口至托盘仍会运行，彻底退出或电脑关机后停止；重启跳过错过的时刻，不补跑。重复计划建议将「流程结束后的浏览器」设为自动关闭，避免保留的会话占用下一次运行资源。

计划会持久化下一次触发时间、最近触发和运行标识。调度失败显示错误，不自动重试造成外部效果的流程；实际执行结果在计划列表与运行历史中查看。删除流程会同时删除其关联计划，保留历史运行；活动或保留浏览器的流程需要结束运行、关闭浏览器后删除。定时调度由桌面进程负责，CLI 查询和手动运行不会启动计划。

### 元素库与 iframe

在元素面板保存 JSON：

```json
{
  "客户输入框": {
    "pageRef": "main",
    "framePath": ["#outer-frame", "#inner-frame"],
    "selector": "#frame-input",
    "expectedCount": 1
  }
}
```

动作选择器填 `@客户输入框`。脚本也可传 `element` 对象或 `selector + framePath`。所有单元素动作要求唯一目标；重建页面后重新定位。

### 脚本

Python：

```python
from rpa_sdk import rpa
text = rpa.call("browser.text", {"selector": "#status"})
rpa.set("statusText", text)
rpa.output({"text": text})
```

JavaScript／TypeScript 支持顶层 `await`：

```typescript
const text = await rpa.call("browser.text", { selector: "#status" });
await rpa.set("statusText", text);
await rpa.output({ text });
```

脚本中的代码原样执行，通过 SDK 读取变量，不进行 `{{…}}` 文本替换。通过「Python 可执行文件」选择虚拟环境解释器。不会隐式安装用户依赖；仅运行自己信任的本地脚本。脚本进程是生命周期隔离，不是安全沙箱。更多接口见 [脚本桥说明](packages/scripts/README.md) 和 [浏览器接口](packages/browser/README.md)。

## 命令行

```powershell
# 最小化的有界面浏览器，下载到桌面
npm run demo

# 无头受控验证，自选绝对输出路径
npm run demo -- --headless --close-browser --output C:\RPA\downloads

# 运行导出的流程 JSON
npm run rpa -- run C:\RPA\workflow.json --headless --close-browser
npm run rpa -- list
```

CLI 默认使用项目 `.rpa/` 数据目录；`--data` 或 `RPA_DATA_DIR` 可覆盖。桌面默认使用系统应用数据目录，在「运行设置」可查看位置。现阶段桌面和 CLI 各自启动运行管理器，勿同时共享同一数据目录；统一常驻服务 API 属于后续交付。

CLI 同样遵循流程的浏览器保留设置；保留时命令等待用户关闭浏览器窗口或按 Ctrl+C。加 `--close-browser` 可选择结束后自动关闭，适合无头批量执行。

桌面并发可通过环境变量 `RPA_MAX_CONCURRENT` 配置为 1–16（默认 2）。浏览器配置名默认为流程 ID，可复用登录，但一个配置同时只允许一个任务占用。网站是否允许并发登录必须逐站验证。

## 验证

```powershell
npm run typecheck
npm test
npm run test:desktop
```

测试使用真实 HTTP 演示站、Chromium、本机 Chrome/Edge、Python／Node 子进程和 Electron；包含 Windows 有界面最小化／恢复、独立端口与启动失败测试。`test:desktop` 验证真正的界面编辑、保存、运行、文件内容、流程管理、指令配置隔离、拖拽插入、侧栏记忆、计划管理及托盘定时触发，截图位于 `.rpa/qa/desktop-success.png` 与 `.rpa/qa/workspace-*.png`。测试不连接拼多多。

## 数据与目录

```text
apps/desktop/          Electron 主进程、preload、React 编辑器
apps/runner/           CLI、运行管理器、独立任务进程
packages/contracts/   流程格式、运行事件、桌面接口
packages/actions/     动作校验与表单元数据
packages/engine/      执行、变量、条件循环、暂停取消
packages/browser/     会话、元素、下载、响应
packages/scripts/     脚本子进程与 RPC
packages/sdk-js/      JS/TS SDK
packages/persistence/ D1 JSON 文件存储
python/rpa_sdk/        Python SDK
examples/demo.ts      可视化 + 三种语言的订单演示流程
tests/fixtures/       受控网站
```

运行目录保存 `workflow.json`、`run.json`、`events.jsonl` 与失败截图。浏览器配置目录保存登录资料和 `.rpa-profile.lock`。正常停止会清理租约；崩溃遗留租约不会自动删除，须确认原浏览器已退出再处理，避免并发破坏配置。

## 下一阶段与限制

详细验收见 [D0/D1 开发进展](docs/开发进展-D0-D1.md)。当前已实现第一个可运行增量；以下仍在后续里程碑：

- D2：可视化元素拾取、自定义下拉／日期等复杂控件适配、完整调试能力。
- D3：Win32 键鼠空闲检测和前台排队、外部效果动作的业务恢复策略、资源用量记录。
- D4：SQLite、周／月等更多日历规则、停机补跑、统一常驻服务入口、Windows 安装包；当前已支持单次／每日／固定分钟间隔计划。
- 拼多多订单导出：尚未适配。需要登录后验证真实 DOM、弹窗、异步导出任务关联与网站兼容性；将作为独立流程模板维护。

最小化／恢复通过 CDP 操作窗口，不保证获得 Windows 前台焦点。锁屏、无人登录与开机运行尚未验收。进程崩溃后记录意外中断，不能恢复原 DOM 现场。
