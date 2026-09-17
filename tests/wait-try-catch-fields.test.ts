import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StepDefinition, WorkflowDefinition } from "../packages/contracts/src/index.js";
import { ControlFlowFields, getControlStepErrors, parseWaitDuration, summarizeControlStep, validateErrorVariable } from "../apps/desktop/src/renderer/ControlFlowFields.js";
import { StepTree } from "../apps/desktop/src/renderer/StepTree.js";
import { getVariableOptions } from "../apps/desktop/src/renderer/variable-options.js";

const action = (stepId: string, overrides: Partial<StepDefinition> = {}): StepDefinition => ({
  stepId, name: stepId, actionType: "core.log", params: { message: "ok" }, ...overrides,
});
const set = (stepId: string, name: string, value: unknown) =>
  action(stepId, { actionType: "variables.set", params: { name, value } });
const flow = (steps: StepDefinition[], variables: WorkflowDefinition["variables"] = {}): WorkflowDefinition => ({
  schemaVersion: 1, workflowId: "controls", name: "控制流测试", revision: 1, variables, elements: {},
  settings: { downloadDir: "C:\\RPA", headless: true }, steps,
});
const optionsAt = (workflow: WorkflowDefinition, stepId: string) =>
  new Map(getVariableOptions(workflow, stepId).map(option => [option.name, option]));
const renderFields = (step: StepDefinition) => renderToStaticMarkup(createElement(ControlFlowFields, {
  workflow: flow([step]), step, onChange: () => {}, onValidity: () => {},
}));

describe("等待与 Try / Catch 参数编辑", () => {
  it("等待接受秒数、小数和完整变量引用，拒绝空值及超出范围", () => {
    for (const value of [0, 0.5, 3, 3600]) expect(parseWaitDuration("number", String(value))).toEqual({ value });
    for (const invalid of ["", " ", "-1", "3601", "NaN", "Infinity", "abc"]) {
      expect(parseWaitDuration("number", invalid)).toHaveProperty("error");
    }
    expect(parseWaitDuration("variable", " delaySeconds ")).toEqual({ value: "{{delaySeconds}}" });
    expect(parseWaitDuration("variable", "{{config.delaySeconds}}")).toEqual({ value: "{{config.delaySeconds}}" });
    expect(parseWaitDuration("variable", "")).toHaveProperty("error");
    expect(parseWaitDuration("variable", "config.__proto__")).toHaveProperty("error");
  });

  it("等待读取已保存数值或变量并提供直接时长和变量两种来源", () => {
    const step = action("wait", { actionType: "core.wait", params: { durationSeconds: 3 } });
    expect(renderFields(step)).toContain('value="3"');
    const html = renderFields({ ...step, params: { durationSeconds: "{{config.delaySeconds}}" } });
    expect(html).toContain('<option value="variable" selected="">使用变量</option>');
    expect(html).toContain('value="config.delaySeconds"');
    expect(html).toContain('aria-label="为等待时长插入变量"');
    expect(renderFields({ ...step, params: { durationSeconds: -5 } })).toContain('aria-invalid="true"');
    expect(renderFields({ ...step, params: { durationSeconds: "1000" } })).toContain('aria-invalid="true"');
  });

  it("流程校验包含未选中的内部步骤，且不会把数字字符串误认作合法时长", () => {
    const workflow = flow([action("try", { actionType: "control.tryCatch", params: { errorVariable: " error " },
      children: [action("wait", { actionType: "core.wait", params: { durationSeconds: "3601" } })],
      elseSteps: [action("textNumber", { actionType: "core.wait", params: { durationSeconds: "1000" } })],
    })]);
    expect(getControlStepErrors(workflow).map(error => error.stepId)).toEqual(["try", "wait", "textNumber"]);
    expect(getControlStepErrors(flow([action("valid", { actionType: "core.wait", params: { durationSeconds: "{{delaySeconds}}" } })]))).toEqual([]);
    expect(getControlStepErrors(flow([action("bad", { actionType: "control.tryCatch", params: { errorVariable: 123 } })]))).toHaveLength(1);
    for (const errorVariable of [undefined, null]) {
      const malformed = action("bad", { actionType: "control.tryCatch", params: { errorVariable }, children: [], elseSteps: [action("catchBody")] });
      expect(getControlStepErrors(flow([malformed]))).toHaveLength(1);
      expect(renderFields(malformed)).toContain('aria-invalid="true"');
      expect(optionsAt(flow([malformed]), "catchBody").has("error")).toBe(false);
    }
  });

  it("异常变量拒绝空名、模板、首尾空白和保留名称", () => {
    for (const name of ["", "  ", " error", "error ", "{{error}}", "__proto__", "prototype", "constructor"]) {
      expect(validateErrorVariable(name)).not.toBe("");
    }
    expect(validateErrorVariable("caughtError")).toBe("");
    expect(validateErrorVariable("异常信息")).toBe("");
    const html = renderFields(action("try", { actionType: "control.tryCatch", params: { errorVariable: "caughtError" } }));
    expect(html).toContain('aria-label="异常变量"');
    expect(html).toContain("{{caughtError.message}}");
    expect(html).toContain("仅在 Catch 内可用");
  });

  it("步骤摘要显示等待单位、变量名和异常处理关系", () => {
    expect(summarizeControlStep(action("wait", { actionType: "core.wait", params: { durationSeconds: 1.5 } }))).toBe("等待 1.5 秒");
    expect(summarizeControlStep(action("wait", { actionType: "core.wait", params: { durationSeconds: "{{delaySeconds}}" } }))).toBe("等待 delaySeconds 秒");
    expect(summarizeControlStep(action("try", { actionType: "control.tryCatch", params: { errorVariable: "caught" } }))).toBe("Try 失败后执行 Catch · 异常变量 caught");
  });

  it("树将 Try 和 Catch 显示为独立可添加区域并保留条件、循环标记", () => {
    const html = renderToStaticMarkup(createElement(StepTree, {
      steps: [action("try", { actionType: "control.tryCatch", params: { errorVariable: "error" },
        children: [action("if", { actionType: "control.if", params: { left: true, operator: "truthy" }, children: [], elseSteps: [] })],
        elseSteps: [action("loop", { actionType: "control.forEach", params: { items: [], itemVariable: "item" }, children: [] })],
      })],
      actions: [], selectedId: "try", disabled: false, cannotRun: false, statuses: new Map(),
      renderIcon: () => null, renderStatus: () => null, onSelect: () => {}, onRun: () => {}, onMutate: () => {}, onAdd: () => {},
    }));
    for (const label of ["添加到 Try 执行区", "添加到 Catch 异常区", "结束 Try / Catch", "添加到满足条件", "添加到否则分支", "结束条件", "添加到循环体", "结束循环"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-step-id="try" data-depth="0"');
    expect(html).toContain('data-step-id="loop" data-depth="1"');
  });
});

describe("Try / Catch 的变量候选", () => {
  it("异常信息只在 Catch 及嵌套步骤中可见，容器前后和 Try 内不泄漏", () => {
    const workflow = flow([
      action("try", { actionType: "control.tryCatch", params: { errorVariable: "error" }, output: "result",
        children: [action("tryBody")],
        elseSteps: [action("if", { actionType: "control.if", params: { left: true, operator: "truthy" }, children: [action("catchBody")] })],
      }),
      action("after"),
    ]);
    const inside = optionsAt(workflow, "catchBody");
    for (const name of ["error", "error.message", "error.stepId", "error.stepName", "error.actionType"]) {
      expect(inside.get(name)).toMatchObject({ conditional: false, source: "「try」的 Catch 异常" });
    }
    for (const id of ["try", "tryBody", "after"]) expect(optionsAt(workflow, id).has("error")).toBe(false);
    expect(optionsAt(workflow, "after").has("result.caught")).toBe(true);
  });

  it("Catch 显示 Try 的中间赋值且标记可能未产生，Catch 完成后恢复同名异常变量", () => {
    const workflow = flow([
      action("try", { actionType: "control.tryCatch", params: { errorVariable: "error" },
        children: [set("first", "progress", { first: true }), set("second", "progress", { second: true })],
        elseSteps: [set("overwrite", "error", { temporary: true }), action("catchBody"), set("recover", "recovered", true)],
      }), action("after"),
    ], { error: { original: true } });
    const inside = optionsAt(workflow, "catchBody");
    expect(inside.get("progress.first")?.conditional).toBe(true);
    expect(inside.get("progress.second")?.conditional).toBe(true);
    expect(inside.has("error.temporary")).toBe(true);
    const after = optionsAt(workflow, "after");
    expect(after.has("error.original")).toBe(true);
    expect(after.has("error.temporary")).toBe(false);
    expect(after.has("error.message")).toBe(false);
    expect(after.get("recovered")?.conditional).toBe(true);
  });

  it("Try 内嵌套容器的中间赋值可提示，已退出的局部变量与循环当前项会恢复", () => {
    const workflow = flow([action("try", { actionType: "control.tryCatch", params: { errorVariable: "caught" },
      children: [action("loop", { actionType: "control.forEach", params: { items: [1, 2], itemVariable: "item" }, variables: { hidden: 1 },
        children: [set("save", "partial", { ready: true }), action("fail")],
      })],
      elseSteps: [action("catchBody")],
    })]);
    const inside = optionsAt(workflow, "catchBody");
    expect(inside.get("partial.ready")?.conditional).toBe(true);
    expect(inside.has("hidden")).toBe(false);
    expect(inside.has("item")).toBe(false);
  });

  it("嵌套 Catch 暂时覆盖同名异常，结束后恢复外层异常", () => {
    const workflow = flow([action("outer", { actionType: "control.tryCatch", params: { errorVariable: "error" }, children: [],
      elseSteps: [action("inner", { actionType: "control.tryCatch", params: { errorVariable: "error" }, children: [], elseSteps: [action("innerCatch")] }), action("outerCatch")],
    })]);
    expect(optionsAt(workflow, "innerCatch").get("error.message")?.source).toBe("「inner」的 Catch 异常");
    expect(optionsAt(workflow, "outerCatch").get("error.message")?.source).toBe("「outer」的 Catch 异常");
  });

  it("等待结果向后续步骤提供真实时长属性", () => {
    const workflow = flow([action("wait", { actionType: "core.wait", params: { durationSeconds: 20 }, output: "waited" }), action("after")]);
    expect(optionsAt(workflow, "after").get("waited.durationSeconds")).toMatchObject({ conditional: false, reference: "{{waited.durationSeconds}}" });
  });
});
