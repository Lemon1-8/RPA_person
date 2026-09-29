import { describe, expect, it } from "vitest";
import {
  changeControlOperator,
  inferControlValue,
  parseControlValue,
  summarizeControlStep,
} from "../apps/desktop/src/renderer/ControlFlowFields.js";
import type { StepDefinition } from "../packages/contracts/src/index.js";
import { resolveValue } from "../packages/engine/src/index.js";

describe("控制流参数编辑", () => {
  it("变量路径无需引号，序列化后仍保留完整变量引用", () => {
    expect(parseControlValue("variable", " item.status ")).toEqual({ value: "{{item.status}}" });
    expect(parseControlValue("variable", "{{orders.0.id}}")).toEqual({ value: "{{orders.0.id}}" });
    expect(parseControlValue("variable", '"item"')).toHaveProperty("error");
    expect(parseControlValue("variable", "")).toHaveProperty("error");
    expect(parseControlValue("variable", "item.__proto__")).toHaveProperty("error");
  });

  it("保留已有数字、布尔、null、复杂列表与对象的实际类型", () => {
    const values = [0, 12.5, false, true, null, "1", [1, { status: "已完成", nested: [false, null] }], { a: [1, 2] }];
    for (const value of values) {
      const draft = inferControlValue(value);
      expect(parseControlValue(draft.mode, draft.text)).toEqual({ value });
    }
    expect(inferControlValue("{{ item.status }}")).toEqual({ mode: "variable", text: "item.status" });
    expect(inferControlValue("订单 {{order.id}}").mode).toBe("text");
  });

  it("数字与文本有不同类型，空数字和错误 JSON 不能提交", () => {
    expect(parseControlValue("text", "1")).toEqual({ value: "1" });
    expect(parseControlValue("number", "1")).toEqual({ value: 1 });
    expect(parseControlValue("number", "")).toHaveProperty("error");
    expect(parseControlValue("number", "Infinity")).toHaveProperty("error");
    expect(parseControlValue("json", '{"status":')).toHaveProperty("error");
  });

  it("循环只接受数组或变量，不静默替换错误的旧数据", () => {
    expect(parseControlValue("json", '[1,{"status":"已完成"}]', true)).toEqual({ value: [1, { status: "已完成" }] });
    expect(parseControlValue("variable", "orders", true)).toEqual({ value: "{{orders}}" });
    expect(parseControlValue("json", '{"status":"已完成"}', true)).toHaveProperty("error");
    expect(parseControlValue("json", JSON.stringify(Array.from({ length: 10_001 }, () => 0)), true)).toHaveProperty("error");
  });

  it("切换为真后移除隐藏右值，避免运行时解析已无关的缺失变量", () => {
    const params = { left: "{{item}}", operator: "equals", right: "{{missingReference}}" };
    expect(() => resolveValue(params, { item: true })).toThrow("找不到变量：missingReference");
    const truthy = changeControlOperator(params, "truthy", params.right);
    expect(truthy).not.toHaveProperty("right");
    expect(resolveValue(truthy, { item: true })).toEqual({ left: true, operator: "truthy" });
    expect(changeControlOperator(truthy, "equals", params.right)).toEqual(params);
    expect(changeControlOperator(truthy, "notEquals", null).right).toBeNull();
  });

  it("行数组引用后可用方括号下标取得单值，包括嵌在日志中的引用", () => {
    const variables = { row: [0, "第二列", null] };
    expect(resolveValue("{{row}}[0]", variables)).toBe(0);
    expect(resolveValue("{{row}}[2]", variables)).toBeNull();
    expect(resolveValue("第一列={{row}}[0]；第二列={{row}}[1]", variables)).toBe("第一列=0；第二列=第二列");
    expect(() => resolveValue("{{row}}[3]", variables)).toThrow("列表下标超出范围");
    expect(() => resolveValue("{{row}}[0]", { row: { 0: "对象" } })).toThrow("变量不是列表");
  });

  it("摘要显示自然语言条件和循环当前项，不生成不存在的索引变量", () => {
    const step: StepDefinition = {
      stepId: "condition", name: "条件分支", actionType: "control.if",
      params: { left: "{{item.status}}", operator: "equals", right: "已完成" },
    };
    expect(summarizeControlStep(step)).toBe("item.status 等于 “已完成”");
    expect(summarizeControlStep({ ...step, params: { left: false, operator: "truthy", right: "不应显示" } })).toBe("假 为真");
    expect(summarizeControlStep({ ...step, actionType: "control.forEach", params: { items: [1, 2], itemVariable: "item" } })).toBe("逐项遍历 2 项列表 · 当前项 item");
    expect(summarizeControlStep({ ...step, actionType: "variables.set" })).toBeUndefined();
  });
});
