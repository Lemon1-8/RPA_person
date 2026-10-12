# Windows 元素自动化

在“桌面软件自动化”分类中添加指令，点击“捕获或编辑桌面元素”，打开桌面元素库。点击“捕获新软件元素”后工作台暂时隐藏，将鼠标移到目标软件控件上，橙色边框表示当前目标，按 F8 确认；Esc、取消按钮或 30 秒超时结束捕获，原配置保留。

捕获后输入元素名称，可选择保存到整个流程或当前指令及其子步骤。编辑器允许调整窗口条件、控件层级、属性和匹配方式。点击“校验桌面元素”查看匹配数量；运行时要求唯一目标。界面保存有效的定位规则，之后再保存流程即可持久化。重命名会更新对应作用域的指令引用，以及脚本中直接传给 `rpa.call('windows.…', {selector: '@元素名'})` 的静态引用；被引用的元素不能直接删除。脚本通过变量或动态拼接提供的名称需要自行维护。

## 定位与兼容性

窗口可按进程名称（不含 .exe）、标题和类名定位；控件可按 AutomationId、Name、ControlType、ClassName 和层级定位。精确匹配区分大小写，通配符支持 PowerShell 通配符语法，例如 `订单*`。捕获同级同属性控件时会自动记录匹配序号，序号从 0 开始；手动编辑时仅在确有必要时指定。旧捕获规则如因重复控件产生歧义，可重新捕获或补充序号，无需迁移流程格式。移除中间层级后，下一级改为搜索全部后代。

窗口重开或控件重建后，每次操作都会重新查找目标；流程不保存原生控件对象。`desktopElements` 为流程及步骤的可选字段，与现有网页 `elements` 分开，旧流程不需要迁移。子步骤继承父级元素，同名元素可局部覆盖。

目前支持 Windows UI Automation。控件必须提供相应 UIA 接口，图像/OCR、独立 ACC 与 Java 自动化不在本版范围内。默认通过控件接口点击和输入，不支持时明确报错；手动选择“模拟操作”会激活窗口并占用真实鼠标键盘。它与原有电脑键鼠指令共享交互锁，等待锁也计入步骤超时。发送真实键鼠前再次确认前台窗口和点击位置；目标失去焦点或位置被遮挡时停止并报错。模拟操作需要可见、可用的目标及可交互桌面会话；权限受 Windows 限制。

## 指令与脚本

指令包括获取窗口、获取元素、点击、填写、读取文本、读取属性、读取位置、判断存在、等待、设置复选框、选择下拉项、获取关联元素。只读动作可重试，有外部效果的动作禁止自动重试。默认超时 30 秒，可在步骤设置中修改。

所有元素动作接受 `selector: "@元素名"` 或 `element: DesktopElementRef`，两者以元素库引用为准。`windows.find` 返回 `{ element, attributes, bounds }`，其中 `element` 可用于后续调用。`windows.related` 返回定位引用、引用列表或空值。`windows.exists` 只有真正未找到时返回 false，歧义和系统错误仍报错；`windows.wait` 的 `state` 可为 `exists`、`visible` 或 `gone`。

JavaScript / TypeScript 示例（元素已保存在流程库）：

```ts
await rpa.call('windows.fill', { selector: '@搜索框', value: '订单编号', mode: 'api' });
await rpa.call('windows.click', { selector: '@查询按钮' });
await rpa.call('windows.wait', { selector: '@结果', state: 'visible' });
await rpa.output(await rpa.call('windows.text', { selector: '@结果' }));
```

Python 示例：

```python
from rpa_sdk import rpa

rpa.call('windows.fill', {'selector': '@搜索框', 'value': '订单编号'})
rpa.call('windows.click', {'selector': '@查询按钮'})
result = rpa.call('windows.find', {'selector': '@结果'})
rpa.output(rpa.call('windows.getAttribute', {'element': result['element'], 'name': 'Name'}))
```

`windows.findWindow` 接受 `processName`、`title`、`className` 文本字段或结构化 `window` 条件；返回窗口快照。`windows.check` 使用 `checked` 布尔值；`windows.select` 使用 `item` 文本和 `match`（exact / wildcard）；`windows.related` 使用 `relation`（parent / children / child / previous / next），指定子元素时传 `index`。

位置 `bounds` 使用整个屏幕的物理像素坐标 `{ x, y, width, height }`，多显示器坐标可为负数。捕获和屏幕取点不能同时进行；结束操作或退出应用会释放快捷键、高亮层和辅助进程。

低代码中要使用前序动作的定位结果，选择“使用变量中的定位引用”，填写 `{{获取结果.element}}`；关联动作返回的引用可直接填写 `{{父元素}}`。这里传入定位对象，不要把对象填到元素名称下拉框。

## 验证

`npm run check` 包含协议、作用域、JS/Python RPC、受控 WinForms 控件、失败取消和交互锁测试。`npm run test:desktop` 包含 Electron 元素编辑与执行验收，截图保存到 `.rpa/qa/desktop-success.png`。

真实键鼠及 F8/Esc 捕获测试需要可交互的 Windows 桌面。锁屏、断开的远程会话或电脑管控环境中，可明确设置 `RPA_SKIP_DESKTOP_INTERACTION=1`，仅跳过真实键鼠和快捷键捕获验收；UIA、元素编辑、保存重载与单步测试仍执行，日志会报告跳过项。恢复交互后去掉该变量重新运行。模拟操作并未在这种环境中得到完整验收，不能把跳过视为通过。
