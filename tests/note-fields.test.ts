import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StepDefinition, WorkflowDefinition } from "../packages/contracts/src/index.js";
import { defaultNoteColor, getNoteStepErrors, NoteFields, noteStyle, noteTextColor, validateNoteParams } from "../apps/desktop/src/renderer/NoteFields.js";
import { StepTree } from "../apps/desktop/src/renderer/StepTree.js";
import { getVariableOptions } from "../apps/desktop/src/renderer/variable-options.js";

const note = (params: Record<string, unknown> = { text: "", color: defaultNoteColor }): StepDefinition => ({
  stepId: "note", name: "备注", actionType: "core.note", params,
});
const flow = (steps: StepDefinition[]): WorkflowDefinition => ({
  schemaVersion: 1, workflowId: "notes", name: "备注测试", revision: 1, variables: { original: true }, elements: {},
  settings: { downloadDir: "C:\\RPA", headless: true }, steps,
});

describe("流程备注编辑", () => {
  it("接受空白、多行及变量样式原文，只允许完整十六进制颜色", () => {
    for (const text of ["", "第一行\n第二行", "{{customer.name}}", "<script>alert('text')</script>"]) {
      expect(validateNoteParams({ text, color: "#FFE08A" })).toBeUndefined();
    }
    expect(validateNoteParams({ text: "正文" })).toBeUndefined();
    expect(validateNoteParams({ text: 12, color: defaultNoteColor })).toBeDefined();
    for (const color of ["", "red", "#fff", "#12345g", "#12345678", "#123456; color:red", null]) {
      expect(validateNoteParams({ text: "正文", color })).toBeDefined();
    }
    expect(validateNoteParams({ text: "正文", color: "#abcdef" })).toBeUndefined();
  });

  it("提供多行正文、预设色、系统取色器与颜色代码编辑，不插入变量", () => {
    const html = renderToStaticMarkup(createElement(NoteFields, {
      step: note({ text: "第一行\n{{literal}}", color: "#253858" }), onChange: () => {}, onValidity: () => {},
    }));
    expect(html).toContain('aria-label="备注内容"');
    expect(html).toContain("第一行\n{{literal}}");
    expect(html).toContain('type="color"');
    expect(html).toContain('aria-label="选择备注颜色"');
    expect(html).toContain('aria-label="备注颜色代码"');
    expect(html).toContain('aria-label="使用金黄色"');
    expect(html).toContain('aria-label="使用深蓝色"');
    expect(html).not.toContain('aria-label="插入变量"');
    expect(html).not.toContain("输出变量");
  });

  it("备注行保持整行配色和多行正文，转义 HTML 并移除单独运行入口", () => {
    const html = renderToStaticMarkup(createElement(StepTree, {
      steps: [note({ text: "第一行\n{{literal}} <b>原文</b>", color: "#253858" })], actions: [], selectedId: "note",
      disabled: false, cannotRun: false, statuses: new Map([["note", "succeeded"]]), renderIcon: () => null,
      renderStatus: () => "运行状态", onSelect: () => {}, onRun: () => {}, onToggleComment: () => {}, onMutate: () => {}, onAdd: () => {},
    }));
    expect(html).toContain('class="step-card note-card selected step-succeeded"');
    expect(html).toContain("--note-background:#253858;--note-foreground:#FFFFFF");
    expect(html).toContain('class="note-content"');
    expect(html).toContain("第一行\n{{literal}} &lt;b&gt;原文&lt;/b&gt;");
    expect(html).not.toContain("<b>原文</b>");
    expect(html).not.toContain("单独运行 备注");
    expect(html).not.toContain("运行状态");
    expect(html).toContain('aria-label="复制 备注"');
    expect(html).toContain('aria-label="删除 备注"');
  });

  it("为自选背景使用对比至少 4.5 的黑白文字，非法草稿用默认底色安全预览", () => {
    expect(noteTextColor(defaultNoteColor)).toBe("#000000");
    expect(noteTextColor("#253858")).toBe("#FFFFFF");
    const luminance = (color: string) => {
      const values = color.slice(1).match(/../g)!.map(hex => parseInt(hex, 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    for (const red of [0, 51, 102, 153, 204, 255]) {
      for (const green of [0, 51, 102, 153, 204, 255]) {
        for (const blue of [0, 51, 102, 153, 204, 255]) {
          const color = `#${[red, green, blue].map(value => value.toString(16).padStart(2, "0")).join("")}`;
          const values = [luminance(color), luminance(noteTextColor(color))].sort((a, b) => a - b);
          expect((values[1] + 0.05) / (values[0] + 0.05)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    expect(noteStyle("#nope")).toEqual({ "--note-background": defaultNoteColor, "--note-foreground": "#000000" });
  });

  it("备注非法颜色在整个流程内仍阻止保存，不要求填写正文", () => {
    const workflow = flow([{ stepId: "try", name: "捕获异常", actionType: "control.tryCatch", params: { errorVariable: "error" },
      children: [note({ text: "", color: "bad" })], elseSteps: [],
    }]);
    expect(getNoteStepErrors(workflow)).toEqual([{ stepId: "note", stepName: "备注", error: "请输入完整的十六进制颜色，例如 #FFE08A。" }]);
    expect(getNoteStepErrors(flow([note()]))).toEqual([]);
  });

  it("备注的局部变量和输出不进入后续步骤候选", () => {
    const workflow = flow([{ ...note({ text: "{{missing}}", color: defaultNoteColor }), output: "unused", variables: { local: true } },
      { stepId: "after", name: "下一步", actionType: "core.wait", params: { durationSeconds: 3 } },
    ]);
    expect(getVariableOptions(workflow, "after").map(option => option.name)).toEqual(["original"]);
  });
});
