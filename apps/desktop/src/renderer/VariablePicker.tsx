import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Braces, ChevronDown } from "lucide-react";
import type { WorkflowDefinition } from "../../../../packages/contracts/src/index.js";
import { getVariableOptions } from "./variable-options.js";

interface VariablePickerProps {
  workflow: WorkflowDefinition;
  stepId: string;
  disabled?: boolean;
  label?: string;
  onPick: (reference: string) => void;
}

export function VariablePicker({ workflow, stepId, disabled, label = "插入变量", onPick }: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const searchId = useId();
  const options = useMemo(() => getVariableOptions(workflow, stepId), [workflow, stepId]);
  const filtered = options.filter(option => `${option.name} ${option.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => { setOpen(false); setQuery(""); }, [stepId, disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div className="variable-picker" ref={container} onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button type="button" className="text-button variable-picker-trigger" ref={trigger}
        aria-label={label} aria-expanded={open && !disabled} aria-controls={panelId} disabled={disabled}
        onClick={() => { setQuery(""); setOpen(current => !current); }}>
        <Braces size={13} /> 插入变量 <ChevronDown size={12} />
      </button>
      {open && !disabled && (
        <div className="variable-picker-panel" id={panelId} role="group" aria-label={`${label}列表`}>
          <label className="variable-picker-search" htmlFor={searchId}>
            搜索变量
            <input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="变量名称或来源" />
          </label>
          <div className="variable-picker-options">
            {filtered.map(option => (
              <button type="button" className="variable-picker-option" key={option.name}
                aria-label={`插入 ${option.reference}${option.conditional ? "，可能未产生" : ""}`}
                onClick={() => { onPick(option.reference); setOpen(false); trigger.current?.focus(); }}>
                <span className="variable-picker-option-name"><code>{option.reference}</code>
                  {option.conditional && <span className="variable-picker-conditional">可能未产生</span>}
                </span>
                <span className="variable-picker-source">{option.source}{option.depth > 0 ? " · 属性" : ""}</span>
              </button>
            ))}
            {!filtered.length && <p className="variable-picker-empty">{query ? "没有匹配的变量" : "当前步骤还没有可用变量"}</p>}
          </div>
          <p className="variable-picker-hint">完整引用保留原始类型；可用 .属性名 或 .0 读取对象或列表。</p>
          {options.some(option => option.conditional) && <p className="variable-picker-hint">标记值取决于前序分支、循环或列表项结构，请先确保它已产生。</p>}
        </div>
      )}
    </div>
  );
}
