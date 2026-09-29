import { describe, expect, it } from "vitest";
import { getStepCategory, getStepDetails } from "../apps/desktop/src/renderer/step-summary.js";
import { actionDefinitions } from "../packages/actions/src/index.js";
import type { ActionDefinition, StepDefinition } from "../packages/contracts/src/index.js";

function step(actionType: string, params: Record<string, unknown>): StepDefinition {
  return { stepId: "step", name: "指令", actionType, params };
}
function details(actionType: string, params: Record<string, unknown>) {
  return getStepDetails(step(actionType, params), actionDefinitions.find(action => action.type === actionType));
}

describe("工作流指令摘要", () => {
  it("按用途提供中文类别，不暴露技术动作名称", () => {
    expect(getStepCategory("browser.open")).toEqual({ id: "browser", label: "浏览器" });
    expect(getStepCategory("browser.table").id).toBe("data");
    expect(getStepCategory("variables.set").id).toBe("data");
    expect(getStepCategory("browser.download").id).toBe("file");
    expect(getStepCategory("file.xlsxRead").id).toBe("file");
    expect(getStepCategory("desktop.mouseClick").id).toBe("desktop");
    expect(getStepCategory("control.if").id).toBe("control");
    expect(getStepCategory("script.run").id).toBe("script");
    expect(getStepCategory("core.note").id).toBe("note");
    expect(getStepCategory("extension.custom")).toEqual({ id: "core", label: "常规" });
  });

  it("打开网页优先显示网址和中文打开方式", () => {
    expect(details("browser.open", { pageId: "$current", browserChannel: "chrome", openMode: "new", url: "https://example.com" })).toEqual([
      { label: "网页地址", value: "https://example.com" }, { label: "打开方式", value: "新建标签页" },
    ]);
    expect(details("browser.open", { url: "https://example.com" })[1].value).toBe("在已有标签页打开");
    expect(getStepDetails(step("browser.open", { url: "https://example.com", openMode: "new" }))[1].value).toBe("新建标签页");
  });

  it("动作定义的字段和选项提供中文说明，输入内容不会被网页别名挤掉", () => {
    expect(details("browser.fill", { selector: "#name", pageId: "main", value: "张三" })).toEqual([
      { label: "元素选择器", value: "#name" }, { label: "输入内容", value: "张三" },
    ]);
    expect(details("browser.popupGuard", { mode: "smart" })).toEqual([{ label: "屏蔽模式", value: "智能屏蔽（推荐）" }]);
    expect(details("browser.start", { browserChannel: "auto", debugPort: 0 })[1].value).toBe("自动分配");
    expect(details("browser.click", { selector: "#save", pageId: "$current" })[1]).toEqual({ label: "目标网页", value: "当前网页" });
    expect(details("browser.closePage", { closeMode: "all", pageId: "unused" })).toEqual([{ label: "关闭范围", value: "当前浏览器的所有网页" }]);
    expect(details("browser.mouseClick", { x: 12, y: 34, button: "right", clickCount: 2 })).toEqual([
      { label: "网页坐标", value: "X 12 · Y 34" }, { label: "鼠标按钮", value: "右键" },
    ]);
    expect(details("desktop.mouseMove", { x: -20, y: 400, humanLike: true })).toEqual([
      { label: "屏幕坐标", value: "X -20 · Y 400" }, { label: "移动方式", value: "弧形轨迹" },
    ]);
    expect(details("browser.keyPress", { key: "ControlOrMeta+A", pageId: "$current" })).toEqual([
      { label: "按键", value: "ControlOrMeta+A" }, { label: "目标网页", value: "当前网页" },
    ]);
    expect(details("file.xlsxWrite", { path: "C:\\RPA\\orders.xlsx", sheetName: "结果", rows: [{ id: 1 }] })).toEqual([
      { label: "文件路径", value: "C:\\RPA\\orders.xlsx" }, { label: "工作表名称", value: "结果" },
    ]);
  });

  it("支持结构化元素引用，同时保持原流程数据不变", () => {
    const value = step("browser.click", { element: { selector: "#save", pageRef: "$current", framePath: ["iframe"] } });
    const before = structuredClone(value);
    expect(getStepDetails(value, actionDefinitions.find(action => action.type === value.actionType))).toEqual([
      { label: "元素选择器", value: "#save" }, { label: "目标网页", value: "当前网页" },
    ]);
    expect(value).toEqual(before);
  });

  it("保留条件表达式的类型和比较含义，拆开循环及异常处理信息", () => {
    expect(details("control.if", { left: "{{item.status}}", operator: "equals", right: "已完成" })).toEqual([
      { label: "执行条件", value: "item.status 等于 “已完成”" },
    ]);
    expect(details("control.if", { left: false, operator: "truthy", right: "隐藏" })[0].value).toBe("假 为真");
    expect(details("control.forEach", { items: [1, 2], itemVariable: "order" })).toEqual([
      { label: "循环列表", value: "2 项列表" }, { label: "当前项变量", value: "order" },
    ]);
    expect(details("control.forEach", { items: "{{orders}}" })[0].value).toBe("orders");
    expect(details("control.forEachXlsx", { path: "C:\\RPA\\orders.xlsx", valueMode: "column", columnIndex: 0, itemVariable: "item" })).toEqual([
      { label: "XLSX 文件", value: "C:\\RPA\\orders.xlsx" }, { label: "单值列下标", value: "0" },
    ]);
    expect(details("control.forEachXlsx", { path: "C:\\RPA\\orders.xlsx", valueMode: "array", itemVariable: "row" })[1]).toEqual({ label: "当前行数组", value: "row" });
    expect(details("control.forEachXlsx", { path: "C:\\RPA\\orders.xlsx", itemVariable: "row" })[1]).toEqual({ label: "当前行变量", value: "row" });
    expect(details("control.tryCatch", { errorVariable: "failure" })).toEqual([
      { label: "执行规则", value: "主流程失败后执行异常处理" }, { label: "异常变量", value: "failure" },
    ]);
  });

  it("秒与毫秒保持明确单位，零时长及变量引用不被丢弃", () => {
    expect(details("core.wait", { durationSeconds: 0.5 })).toEqual([{ label: "等待时长", value: "0.5 秒" }]);
    expect(details("core.wait", { durationSeconds: 0 })[0].value).toBe("0 秒");
    expect(details("core.wait", { durationSeconds: "{{delay}}" })[0].value).toBe("{{delay}} 秒");
    expect(getStepDetails(step("custom.wait", { durationMs: 500, timeoutMs: 1000 }))).toEqual([
      { label: "等待时长", value: "500 毫秒" }, { label: "超时时长", value: "1000 毫秒" },
    ]);
  });

  it("脚本正文不进入摘要，复杂数据只显示类型与数量", () => {
    expect(details("script.run", { code: "print('a very long script')", language: "python" })).toEqual([{ label: "脚本语言", value: "Python" }]);
    expect(getStepDetails(step("extension.custom", { source: "正文", script: "正文", sourceCode: "正文", code: "正文" }))).toEqual([]);
    expect(details("variables.set", { name: "order", value: { id: 1, rows: [1, 2] } })[1].value).toBe("对象（2 个字段）");
    expect(details("core.assert", { actual: [1, 2], expected: null })).toEqual([
      { label: "实际值", value: "列表（2 项）" }, { label: "期望值", value: "空值" },
    ]);
  });

  it("未知字段有中文回退，保留布尔和长文本，最多展示两项", () => {
    const longText = "很长的文本\n".repeat(100);
    const value = step("extension.custom", { empty: "", absent: undefined, enabled: false, content: longText, third: 3 });
    expect(getStepDetails(value)).toEqual([{ label: "参数 1", value: "否" }, { label: "参数 2", value: longText }]);
    const action: ActionDefinition = {
      type: "extension.custom", label: "自定义", category: "扩展", description: "", safeToRetry: true,
      defaults: {}, fields: [{ key: "enabled", label: "启用功能", type: "boolean" }],
    };
    expect(getStepDetails(step(action.type, { enabled: true }), action)).toEqual([{ label: "启用功能", value: "是" }]);
  });
});
