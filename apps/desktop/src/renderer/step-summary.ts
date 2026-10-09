import type { ActionDefinition, ActionField, StepDefinition } from "../../../../packages/contracts/src/index.js";

type StepCategory = { id: "browser" | "desktop" | "control" | "script" | "data" | "file" | "core" | "note"; label: string };
type StepDetail = { label: string; value: string };

export function getStepCategory(actionType: string): StepCategory {
  if (actionType === "core.note") return { id: "note", label: "备注" };
  if (actionType.startsWith("desktop.")) return { id: "desktop", label: "电脑键鼠" };
  if (actionType.startsWith("control.")) return { id: "control", label: "流程控制" };
  if (actionType.startsWith("script.")) return { id: "script", label: "脚本" };
  if (actionType === "browser.download" || actionType.startsWith("file.")) return { id: "file", label: "文件" };
  if (["browser.text", "browser.table", "browser.response"].includes(actionType) || /^(variables|data)\./.test(actionType)) {
    return { id: "data", label: "数据" };
  }
  if (actionType.startsWith("browser.")) return { id: "browser", label: "浏览器" };
  return { id: "core", label: "常规" };
}

const labels: Record<string, string> = {
  url: "网页地址", openMode: "打开方式", pageId: "目标网页", browserChannel: "浏览器", debugPort: "调试端口",
  closeMode: "关闭范围", mode: "模式", selector: "元素选择器", element: "目标元素", framePath: "框架路径", fullPage: "截图范围",
  value: "参数值", text: "文本", directory: "保存目录", filename: "文件名称", path: "文件路径",
  x: "横坐标", y: "纵坐标", button: "鼠标按钮", clickCount: "点击次数", steps: "移动步数",
  deltaX: "横向滚动", deltaY: "纵向滚动", key: "按键", delayMs: "间隔时长", holdMs: "按键时长", sheetName: "工作表",
  rows: "行列表",
  urlIncludes: "响应网址包含", method: "请求方法", requestIncludes: "请求内容包含", language: "脚本语言",
  name: "变量名称", message: "日志内容", actual: "实际值", expected: "期望值", color: "备注颜色",
  durationSeconds: "等待时长", durationMs: "等待时长", timeoutMs: "超时时长",
};
const preferredKeys: Record<string, string[]> = {
  "browser.start": ["browserChannel", "debugPort"],
  "browser.open": ["url", "openMode"],
  "browser.screenshot": ["pageId", "fullPage", "filename", "directory"],
  "browser.fill": ["selector", "value", "pageId"],
  "browser.select": ["selector", "value", "pageId"],
  "browser.assertText": ["selector", "text", "pageId"],
  "browser.download": ["selector", "filename", "directory", "pageId"],
  "browser.response": ["selector", "urlIncludes", "method", "pageId"],
  "browser.closePage": ["closeMode", "pageId"],
  "browser.mouseClick": ["x", "y", "button", "clickCount"],
  "browser.mouseMove": ["x", "y", "steps"],
  "browser.mouseWheel": ["deltaX", "deltaY", "pageId"],
  "browser.keyPress": ["key", "pageId"],
  "browser.keyboardType": ["text", "delayMs", "pageId"],
  "desktop.mouseClick": ["x", "y", "button", "clickCount"],
  "desktop.mouseMove": ["x", "y"],
  "desktop.mouseWheel": ["deltaX", "deltaY"],
  "desktop.keyPress": ["key"],
  "desktop.keyboardType": ["text", "delayMs"],
  "file.xlsxRead": ["path", "sheetName"],
  "file.xlsxWrite": ["path", "sheetName", "rows"],
  "variables.set": ["name", "value"],
  "script.run": ["language"],
};
const options: Record<string, Record<string, string>> = {
  openMode: { reuse: "在已有标签页打开", new: "新建标签页" },
  closeMode: { page: "指定网页", all: "当前浏览器的所有网页" },
  button: { left: "左键", middle: "中键", right: "右键" },
  browserChannel: { auto: "自动选择本机 Chrome / Edge", chrome: "Google Chrome", msedge: "Microsoft Edge", chromium: "Chromium（测试用）" },
  language: { python: "Python", javascript: "JavaScript", typescript: "TypeScript" },
};
const hiddenFields = new Set(["code", "source", "script", "scriptcode", "sourcecode"]);
const referencePattern = /^\{\{\s*([^{}]+?)\s*\}\}$/;

function readableValue(value: unknown): string {
  if (value === undefined) return "未设置";
  if (value === null) return "空值";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return `列表（${value.length} 项）`;
  if (typeof value === "object") return `对象（${Object.keys(value).length} 个字段）`;
  return String(value);
}

function expressionValue(value: unknown): string {
  if (typeof value === "string") return value.match(referencePattern)?.[1].trim() ?? `“${value}”`;
  if (typeof value === "boolean") return value ? "真" : "假";
  return readableValue(value);
}

function formatField(key: string, value: unknown, field?: ActionField): string {
  if (key === "fullPage" && typeof value === "boolean") return value ? "完整网页" : "当前可见区域";
  if (key === "pageId" && (value === "$current" || value === "")) return "当前网页";
  if (typeof value === "string") {
    const option = field?.options?.find(item => item.value === value)?.label ?? options[key]?.[value];
    if (option) return option;
  }
  if (key === "debugPort" && value === 0) return "自动分配";
  const readable = readableValue(value);
  if (key === "durationSeconds") return `${readable} 秒`;
  if (["durationMs", "timeoutMs", "delayMs", "holdMs"].includes(key)) return `${readable} 毫秒`;
  return readable;
}

/** Keep full text for tooltips; card width and ellipsis belong to the renderer. */
export function getStepDetails(step: StepDefinition, action?: ActionDefinition): StepDetail[] {
  const { actionType, params } = step;
  if (actionType === "control.if") {
    const operator = { equals: "等于", notEquals: "不等于", truthy: "为真" }[String(params.operator)] ?? "请选择比较方式";
    return [{ label: "执行条件", value: `${expressionValue(params.left)} ${operator}${params.operator === "truthy" ? "" : ` ${expressionValue(params.right)}`}` }];
  }
  if (actionType === "control.forEach") {
    return [
      { label: "循环列表", value: Array.isArray(params.items) ? `${params.items.length} 项列表` : expressionValue(params.items) },
      { label: "当前项变量", value: readableValue(params.itemVariable ?? "item") },
    ];
  }
  if (actionType === "control.forEachXlsx") {
    return [
      { label: "XLSX 文件", value: readableValue(params.path) },
      { label: params.valueMode === "column" ? "单值列下标" : params.valueMode === "array" ? "当前行数组" : "当前行变量",
        value: params.valueMode === "column" ? readableValue(params.columnIndex ?? 0) : readableValue(params.itemVariable ?? "row") },
    ];
  }
  if (actionType === "control.tryCatch") {
    return [{ label: "执行规则", value: "主流程失败后执行异常处理" }, { label: "异常变量", value: readableValue(params.errorVariable ?? "error") }];
  }
  if (actionType === "core.wait") return [{ label: "等待时长", value: formatField("durationSeconds", params.durationSeconds) }];
  if (["browser.mouseClick", "browser.mouseMove", "desktop.mouseClick", "desktop.mouseMove"].includes(actionType)) {
    const position = { label: actionType.startsWith("desktop.") ? "屏幕坐标" : "网页坐标", value: `X ${readableValue(params.x)} · Y ${readableValue(params.y)}` };
    if (actionType.endsWith("mouseMove")) return [position, { label: "移动方式", value: params.humanLike === false ? "直接定位" : "弧形轨迹" }].slice(0, actionType.startsWith("desktop.") ? 2 : 1);
    return [position, { label: "鼠标按钮", value: formatField("button", params.button ?? "left", action?.fields.find(field => field.key === "button")) }];
  }

  // Read aliases from structured element references without printing the entire object.
  const element = params.element && typeof params.element === "object" && !Array.isArray(params.element)
    ? params.element as Record<string, unknown> : undefined;
  const values = { ...params };
  if (element) {
    if (!values.selector && typeof element.selector === "string") values.selector = element.selector;
    if (!values.pageId && typeof element.pageRef === "string") values.pageId = element.pageRef;
  }
  if (actionType === "browser.open") values.openMode ??= "reuse";
  if (actionType === "browser.screenshot") { values.pageId ??= "$current"; values.fullPage ??= true; }
  if (actionType === "browser.closePage") values.closeMode ??= "page";
  const fields = action?.fields ?? [];
  const keys = [...new Set([...(preferredKeys[actionType] ?? []), ...fields.map(field => field.key), ...Object.keys(values)])];
  const result: StepDetail[] = [];
  for (const key of keys) {
    if (hiddenFields.has(key.toLowerCase()) || (key === "element" && values.selector)) continue;
    if (actionType === "browser.closePage" && values.closeMode === "all" && key === "pageId") continue;
    const value = values[key];
    if (value === undefined || (value === "" && key !== "pageId")) continue;
    const field = fields.find(item => item.key === key);
    const label = (key === "fullPage" ? labels.fullPage : field?.label ?? labels[key] ?? `参数 ${result.length + 1}`).replace(/（[^）]*）|\([^)]*\)/g, "").trim();
    result.push({ label, value: formatField(key, value, field) });
    if (result.length === 2) break;
  }
  return result;
}
