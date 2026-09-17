import { useEffect, useRef, useState } from "react";
import type {
  StepDefinition,
  WorkflowDefinition,
} from "../../../../packages/contracts/src/index.js";
import { VariablePicker } from "./VariablePicker.js";

type ValueMode = "variable" | "text" | "number" | "boolean" | "json";
type ValueDraft = { mode: ValueMode; text: string };
type ParseResult = { value: unknown; error?: never } | { error: string; value?: never };
const modes: { value: ValueMode; label: string }[] = [
  { value: "variable", label: "变量" },
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "布尔值" },
  { value: "json", label: "JSON（高级）" },
];
const operators: Record<string, string> = {
  equals: "等于",
  notEquals: "不等于",
  truthy: "为真",
};
const reservedNames = new Set(["__proto__", "prototype", "constructor"]);
const referencePattern = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const serialize = (value: unknown) => JSON.stringify(value);
const asJson = (value: unknown) => JSON.stringify(value, null, 2) ?? "";

export function inferControlValue(value: unknown): ValueDraft {
  if (typeof value === "string") {
    const reference = value.match(referencePattern);
    return reference
      ? { mode: "variable", text: reference[1].trim() }
      : { mode: "text", text: value };
  }
  if (typeof value === "number") return { mode: "number", text: String(value) };
  if (typeof value === "boolean") return { mode: "boolean", text: String(value) };
  return { mode: "json", text: asJson(value) };
}

export function parseControlValue(mode: ValueMode, text: string, listOnly = false): ParseResult {
  if (mode === "variable") {
    const name = (text.match(referencePattern)?.[1] ?? text).trim();
    if (!name) return { error: "请输入变量名，例如 orders 或 item.status。" };
    if (/[{}]/.test(name) || /^['\"]|['\"]$/.test(name)) {
      return { error: "直接填写变量名，无需引号，例如 item.status。" };
    }
    if (name.split(".").some((part) => reservedNames.has(part))) {
      return { error: "该变量路径包含保留名称，请使用其他变量。" };
    }
    return { value: `{{${name}}}` };
  }
  if (mode === "text") return { value: text };
  if (mode === "number") {
    if (!text.trim() || !Number.isFinite(Number(text))) {
      return { error: "请输入有效数字，例如 0、12 或 3.5。" };
    }
    return { value: Number(text) };
  }
  if (mode === "boolean") return { value: text === "true" };
  try {
    const value: unknown = JSON.parse(text);
    if (listOnly && !Array.isArray(value)) {
      return { error: "循环列表必须是 JSON 数组，例如 [1, 2, 3]；引用变量请切换来源。" };
    }
    if (listOnly && Array.isArray(value) && value.length > 10_000) {
      return { error: "循环列表最多支持 10000 项，请缩小列表范围。" };
    }
    return { value };
  } catch {
    return { error: "JSON 格式无效，请检查双引号、逗号和括号。" };
  }
}

function readable(value: unknown): string {
  if (typeof value === "string") {
    const reference = value.match(referencePattern);
    return reference ? reference[1].trim() : `“${value}”`;
  }
  if (value === undefined) return "未设置";
  if (value === true) return "真";
  if (value === false) return "假";
  return JSON.stringify(value);
}

export function summarizeControlStep(step: StepDefinition): string | undefined {
  const { params } = step;
  if (step.actionType === "control.if") {
    return `${readable(params.left)} ${operators[String(params.operator)] ?? "请选择比较方式"}${params.operator === "truthy" ? "" : ` ${readable(params.right)}`}`;
  }
  if (step.actionType === "control.forEach") {
    const list = Array.isArray(params.items)
      ? `${params.items.length} 项列表`
      : readable(params.items);
    return `逐项遍历 ${list} · 当前项 ${String(params.itemVariable ?? "item")}`;
  }
  return undefined;
}

export function changeControlOperator(
  params: Record<string, unknown>,
  operator: string,
  cachedRight?: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, operator };
  // The engine resolves every parameter before evaluating the operator.
  if (operator === "truthy") delete next.right;
  else if (next.right === undefined) next.right = cachedRight === undefined ? "" : cachedRight;
  return next;
}

interface ControlFlowFieldsProps {
  step: StepDefinition;
  workflow: WorkflowDefinition;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
  onValidity: (key: string, valid: boolean) => void;
}

function ValueField({
  label,
  fieldKey,
  value,
  workflow,
  stepId,
  disabled,
  onChange,
  onValidity,
  listOnly = false,
}: {
  label: string;
  fieldKey: string;
  value: unknown;
  workflow: WorkflowDefinition;
  stepId: string;
  disabled?: boolean;
  onChange: (value: unknown) => void;
  onValidity: (key: string, valid: boolean) => void;
  listOnly?: boolean;
}) {
  const initial = inferControlValue(value);
  if (listOnly && initial.mode !== "variable") {
    initial.mode = "json";
    initial.text = asJson(value);
  }
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const ownValue = useRef(serialize(value));
  const drafts = useRef<Partial<Record<ValueMode, string>>>({ [initial.mode]: initial.text });
  const validity = useRef(onValidity);
  validity.current = onValidity;
  const serialized = serialize(value);
  useEffect(() => {
    if (serialized !== ownValue.current) {
      const next = inferControlValue(value);
      if (listOnly && next.mode !== "variable") {
        next.mode = "json";
        next.text = asJson(value);
      }
      setDraft(next);
      drafts.current = { [next.mode]: next.text };
      ownValue.current = serialized;
      setTouched(false);
    }
  }, [serialized]);
  const parsed = parseControlValue(draft.mode, draft.text, listOnly);
  const error = parsed.error;
  useEffect(() => {
    validity.current(fieldKey, !error);
  }, [error, fieldKey]);
  useEffect(() => () => validity.current(fieldKey, true), [fieldKey]);

  const edit = (next: ValueDraft) => {
    drafts.current[next.mode] = next.text;
    setDraft(next);
    const result = parseControlValue(next.mode, next.text, listOnly);
    validity.current(fieldKey, !result.error);
    if (!result.error) {
      ownValue.current = serialize(result.value);
      onChange(result.value);
    }
  };
  const changeMode = (mode: ValueMode) => {
    let text = drafts.current[mode];
    if (text === undefined) {
      if (mode === "json") text = asJson(value);
      else if (mode === "text") text = typeof value === "string" ? value : asJson(value);
      else if (mode === "number") text = typeof value === "number" ? String(value) : "";
      else if (mode === "boolean") text = typeof value === "boolean" ? String(value) : "true";
      else text = typeof value === "string" && value.match(referencePattern)
        ? value.match(referencePattern)![1].trim()
        : "";
    }
    setTouched(false);
    edit({ mode, text });
  };
  const id = `control-${stepId}-${fieldKey.replace(":", "-")}`;
  const hints: Record<ValueMode, string> = {
    variable: listOnly
      ? "填写列表变量名，例如 orders；该变量运行时需要是数组。无需引号或双花括号。"
      : "填写变量名或属性路径，例如 item.status；无需引号或双花括号。",
    text: "直接输入文字，无需加引号。",
    number: "按数字比较；数字 1 与文本“1”不相等。",
    boolean: "真 / 假对应布尔值 true / false，与文字“true”不同。",
    json: listOnly
      ? '例如 [1, 2, 3] 或 [{"status": "已完成"}]。最多 10000 项。'
      : '支持数组、对象和 null，例如 {"status": "已完成"}。',
  };
  return (
    <div className="control-value-field">
      <label className="field control-type-field">
        <span>{listOnly ? `${label}来源` : `${label}类型`}</span>
        <select
          aria-label={listOnly ? `${label}来源` : `${label}类型`}
          value={draft.mode}
          disabled={disabled}
          onChange={(event) => changeMode(event.target.value as ValueMode)}
        >
          {listOnly ? <>
            <option value="json">直接填写列表（JSON）</option>
            <option value="variable">使用变量</option>
          </> : modes.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
        </select>
      </label>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        {draft.mode === "json" ? (
          <textarea
            id={id}
            aria-label={label}
            rows={4}
            className={`code-input control-json-input${touched && error ? " input-error" : ""}`}
            value={draft.text}
            disabled={disabled}
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={`${id}-hint`}
            onBlur={() => setTouched(true)}
            onChange={(event) => edit({ ...draft, text: event.target.value })}
          />
        ) : draft.mode === "boolean" ? (
          <select id={id} aria-label={label} disabled={disabled} value={draft.text} onChange={(event) => edit({ ...draft, text: event.target.value })}>
            <option value="true">真（true）</option>
            <option value="false">假（false）</option>
          </select>
        ) : (
          <input
            id={id}
            aria-label={label}
            value={draft.text}
            disabled={disabled}
            className={touched && error ? "input-error" : ""}
            inputMode={draft.mode === "number" ? "decimal" : undefined}
            placeholder={draft.mode === "variable" ? listOnly ? "例如：orders" : "例如：item.status" : draft.mode === "number" ? "例如：10" : "例如：已完成"}
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={`${id}-hint`}
            onBlur={() => setTouched(true)}
            onChange={(event) => edit({ ...draft, text: event.target.value })}
          />
        )}
        <small id={`${id}-hint`}>{hints[draft.mode]}</small>
        {touched && error && <span className="field-error" role="alert">{error}</span>}
        <VariablePicker
          workflow={workflow}
          stepId={stepId}
          disabled={disabled}
          label={`为${label}插入变量`}
          onPick={(reference) => {
            setTouched(false);
            edit({ mode: "variable", text: reference.match(referencePattern)?.[1].trim() ?? reference });
          }}
        />
      </div>
    </div>
  );
}

function Fields({ step, workflow, disabled, onChange, onValidity }: ControlFlowFieldsProps) {
  const setParam = (key: string, value: unknown) => onChange({ ...step.params, [key]: value });
  const cachedRight = useRef(step.params.right);
  const itemVariable = String(step.params.itemVariable ?? "");
  const itemError = !itemVariable.trim()
    ? "请填写当前项变量名，例如 item。"
    : itemVariable !== itemVariable.trim() || /[{}]/.test(itemVariable)
      ? "直接填写变量名，例如 item；不要包含首尾空格或花括号。"
    : reservedNames.has(itemVariable)
      ? "该名称不可用，请使用其他名称。"
      : "";
  const [itemTouched, setItemTouched] = useState(false);
  const validity = useRef(onValidity);
  validity.current = onValidity;
  useEffect(() => {
    if (step.actionType === "control.forEach") validity.current("param:itemVariable", !itemError);
    return () => validity.current("param:itemVariable", true);
  }, [itemError, step.actionType]);
  const common = { workflow, stepId: step.stepId, disabled, onValidity };
  if (step.actionType === "control.if") {
    return (
      <div className="control-flow-fields">
        <ValueField {...common} fieldKey="param:left" label="判断对象" value={step.params.left} onChange={(value) => setParam("left", value)} />
        <label className="field">
          <span>比较方式</span>
          <select
            aria-label="比较方式"
            value={String(step.params.operator ?? "truthy")}
            disabled={disabled}
            onChange={(event) => {
              if (step.params.operator !== "truthy") cachedRight.current = step.params.right;
              onChange(changeControlOperator(step.params, event.target.value, cachedRight.current));
            }}
          >
            {Object.entries(operators).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <small>{step.params.operator === "truthy"
            ? "假、0、空文本和 null 视为假；数组、对象及其他值视为真。"
            : step.params.operator === "notEquals"
              ? "两边的值或类型不同即成立；数组和对象按完整内容比较。"
              : "两边的值和类型都相同才成立；数组和对象按完整内容比较。"}</small>
        </label>
        {step.params.operator !== "truthy" && <ValueField {...common} fieldKey="param:right" label="比较值" value={step.params.right} onChange={(value) => setParam("right", value)} />}
        <div className="control-preview" aria-live="polite">
          <span>执行条件</span>
          <strong>{summarizeControlStep(step)}</strong>
          <p>成立执行“满足条件”内的指令，否则执行“否则”内的指令。分支结束后继续下一个步骤。</p>
        </div>
        <p className="help-text control-example">例如：判断对象选择“变量”并填写 item.status，比较方式选择“等于”，比较值选择“文本”并填写 已完成。</p>
      </div>
    );
  }
  if (step.actionType !== "control.forEach") return null;
  return (
    <div className="control-flow-fields">
      <ValueField {...common} fieldKey="param:items" label="循环列表" listOnly value={step.params.items} onChange={(value) => setParam("items", value)} />
      <label className="field">
        <span>当前项变量</span>
        <input
          aria-label="当前项变量"
          value={itemVariable}
          disabled={disabled}
          placeholder="例如：item"
          className={itemTouched && itemError ? "input-error" : ""}
          aria-invalid={!!itemError}
          onBlur={() => setItemTouched(true)}
          onChange={(event) => setParam("itemVariable", event.target.value)}
        />
        <small>循环内用 <code>{`{{${itemVariable || "item"}}}`}</code> 读取当前项；对象属性可用 <code>{`{{${itemVariable || "item"}.status}}`}</code>。</small>
        {itemTouched && itemError && <span className="field-error" role="alert">{itemError}</span>}
      </label>
      <div className="control-preview" aria-live="polite">
        <span>循环内容</span>
        <strong>{summarizeControlStep(step)}</strong>
        <p>每一项都会执行缩进区域内的指令。遍历完成自动结束循环，继续后面的步骤，并恢复原来的同名变量。</p>
      </div>
    </div>
  );
}

export function ControlFlowFields(props: ControlFlowFieldsProps) {
  return <Fields key={props.step.stepId} {...props} />;
}
