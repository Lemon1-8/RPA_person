import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { StepDefinition, WorkflowDefinition } from "../../../../packages/contracts/src/index.js";

export const defaultNoteColor = "#FFE08A";
export const noteColors = [
  { label: "金黄色", color: defaultNoteColor },
  { label: "浅绿色", color: "#C7EBD2" },
  { label: "浅蓝色", color: "#CFE3FF" },
  { label: "浅粉色", color: "#F6D0E1" },
  { label: "深蓝色", color: "#253858" },
];
const validColor = (value: unknown): value is string => typeof value === "string" && /^#[\da-f]{6}$/i.test(value);

export function noteTextColor(color: string): "#000000" | "#FFFFFF" {
  const channels = (validColor(color) ? color : defaultNoteColor).slice(1).match(/.{2}/g)!.map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#FFFFFF";
}

export function noteStyle(color: unknown): CSSProperties {
  const background = validColor(color) ? color : defaultNoteColor;
  return { "--note-background": background, "--note-foreground": noteTextColor(background) } as CSSProperties;
}

export function validateNoteParams(params: Record<string, unknown>): string | undefined {
  if (typeof params.text !== "string") return "备注内容必须是文本。";
  if (params.color !== undefined && !validColor(params.color)) return "请输入完整的十六进制颜色，例如 #FFE08A。";
}

export function getNoteStepErrors(workflow: WorkflowDefinition): { stepId: string; stepName: string; error: string }[] {
  const errors: { stepId: string; stepName: string; error: string }[] = [];
  const visit = (steps: StepDefinition[]) => {
    for (const step of steps) {
      if (step.disabled) continue;
      const error = step.actionType === "core.note" ? validateNoteParams(step.params) : undefined;
      if (error) errors.push({ stepId: step.stepId, stepName: step.name, error });
      visit(step.children ?? []);
      visit(step.elseSteps ?? []);
    }
  };
  visit(workflow.steps);
  return errors;
}

export function NoteFields({ step, disabled, onChange, onValidity }: {
  step: StepDefinition;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const [touched, setTouched] = useState(false);
  const color = step.params.color === undefined ? defaultNoteColor : String(step.params.color);
  const error = validateNoteParams(step.params);
  const validity = useRef(onValidity);
  validity.current = onValidity;
  useEffect(() => { validity.current("param:note", !error); }, [error]);
  useEffect(() => () => validity.current("param:note", true), []);
  const setColor = (value: string) => onChange({ ...step.params, color: value });
  return <div className="note-fields">
    <label className="field">
      <span>备注内容</span>
      <textarea aria-label="备注内容" className="note-text-input" rows={6} value={typeof step.params.text === "string" ? step.params.text : ""}
        disabled={disabled} placeholder="记录这段流程的用途、操作说明或注意事项…" spellCheck={false}
        onChange={event => onChange({ ...step.params, text: event.target.value })} />
      <small>仅用于说明流程，按原样显示文字，不解析 {"{{变量}}"}，不执行操作。</small>
    </label>
    <div className="field">
      <span>备注底色</span>
      <div className="note-color-presets" role="group" aria-label="备注预设颜色">
        {noteColors.map(preset => <button type="button" key={preset.color} aria-label={`使用${preset.label}`} title={preset.label}
          aria-pressed={color.toUpperCase() === preset.color} disabled={disabled} style={noteStyle(preset.color)}
          onClick={() => { setTouched(false); setColor(preset.color); }}>
          {color.toUpperCase() === preset.color ? "✓" : ""}
        </button>)}
      </div>
    </div>
    <div className="note-custom-color">
      <label className="field">
        <span>自选颜色</span>
        <input type="color" aria-label="选择备注颜色" value={validColor(color) ? color : defaultNoteColor} disabled={disabled}
          onChange={event => { setTouched(false); setColor(event.target.value); }} />
      </label>
      <label className="field">
        <span>颜色代码</span>
        <input aria-label="备注颜色代码" value={color} disabled={disabled} placeholder="#FFE08A" spellCheck={false}
          aria-invalid={!validColor(color)} aria-describedby={`note-color-${step.stepId}-hint`} className={touched && error ? "input-error" : ""}
          onBlur={() => setTouched(true)} onChange={event => setColor(event.target.value)} />
      </label>
    </div>
    <small id={`note-color-${step.stepId}-hint`} className="help-text">输入 # 加 6 位颜色代码，文字会自动使用对比清晰的黑色或白色。</small>
    {touched && error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}
