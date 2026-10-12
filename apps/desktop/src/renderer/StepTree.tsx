import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, CornerDownRight, Play, Plus, Search, Slash, Trash2, X } from "lucide-react";
import type { ActionDefinition, StepDefinition } from "../../../../packages/contracts/src/index.js";
import { getStepCategory, getStepDetails } from "./step-summary.js";
import { noteStyle } from "./NoteFields.js";
import { listSteps } from './step-editing.js';

type Branch = "children" | "elseSteps";
type Props = {
  steps: StepDefinition[];
  actions: ActionDefinition[];
  selectedId: string;
  disabled: boolean;
  cannotRun: boolean;
  statuses: Map<string | undefined, string | undefined>;
  renderIcon: (type: string) => ReactNode;
  renderStatus: (status: string) => ReactNode;
  onSelect: (id: string) => void;
  onRun: (id: string) => void;
  onToggleComment: (ids: string[]) => void;
  onMutate: (id: string, command: "up" | "down" | "copy" | "delete") => void;
  onAdd: (action: ActionDefinition, targetId: string, branch: "after" | Branch) => void;
  onBatch?: (ids: string[], command: 'copy' | 'delete' | 'move', target?: string) => void;
};

function contains(steps: StepDefinition[], id: string): boolean {
  return steps.some(step => step.stepId === id || contains(step.children ?? [], id) || contains(step.elseSteps ?? [], id));
}

export function StepTree({ steps, actions, selectedId, disabled, cannotRun, statuses, renderIcon, renderStatus, onSelect, onRun, onToggleComment, onMutate, onAdd, onBatch }: Props) {
  const [stepSearch, setStepSearch] = useState(''); const [moveTarget, setMoveTarget] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [picker, setPicker] = useState<{ id: string; branch: Branch }>();
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const previousSelection = useRef(selectedId);
  const [selectedIds, setSelectedIds] = useState<string[]>(selectedId ? [selectedId] : []);
  const anchor = useRef(selectedId);
  const numbers = new Map<string, number>();
  const visibleIds: string[] = [];
  const commentedIds = new Set<string>();
  const numberSteps = (items: StepDefinition[], visible = true, inheritedComment = false) => {
    for (const step of items) {
      numbers.set(step.stepId, numbers.size + 1);
      if (visible) visibleIds.push(step.stepId);
      const commented = inheritedComment || !!step.disabled;
      if (commented) commentedIds.add(step.stepId);
      numberSteps(step.children ?? [], visible && !collapsed.has(step.stepId), commented);
      numberSteps(step.elseSteps ?? [], visible && !collapsed.has(step.stepId), commented);
    }
  };
  numberSteps(steps);
  const currentIds = previousSelection.current === selectedId ? selectedIds : selectedId ? [selectedId] : [];
  const selection = currentIds.filter(id => visibleIds.includes(id));

  const select = (id: string, event?: MouseEvent) => {
    let next: string[];
    const additive = event?.ctrlKey || event?.metaKey;
    if (event?.shiftKey) {
      const from = visibleIds.indexOf(visibleIds.includes(anchor.current) ? anchor.current : selectedId);
      const to = visibleIds.indexOf(id);
      const range = visibleIds.slice(Math.min(from < 0 ? to : from, to), Math.max(from < 0 ? to : from, to) + 1);
      next = additive ? [...new Set([...selection, ...range])] : range;
    } else {
      next = additive ? selection.includes(id) ? selection.filter(item => item !== id) : [...selection, id] : [id];
      anchor.current = id;
    }
    const primary = next.includes(id) ? id : next.at(-1) ?? "";
    setSelectedIds(next);
    previousSelection.current = primary;
    setPicker(undefined);
    onSelect(primary);
  };

  useEffect(() => {
    // A step selected outside the canvas must remain reachable, even inside a folded block.
    setCollapsed(previous => {
      const next = new Set(previous);
      const visit = (items: StepDefinition[]) => {
        for (const step of items) {
          if (contains([...(step.children ?? []), ...(step.elseSteps ?? [])], selectedId)) next.delete(step.stepId);
          visit(step.children ?? []);
          visit(step.elseSteps ?? []);
        }
      };
      visit(steps);
      return next.size === previous.size ? previous : next;
    });
    if (previousSelection.current !== selectedId) {
      setPicker(undefined);
      setSelectedIds(selectedId ? [selectedId] : []);
      anchor.current = selectedId;
    }
    previousSelection.current = selectedId;
  }, [selectedId, steps]);

  useEffect(() => {
    if (!picker) return;
    pickerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const outside = (event: PointerEvent) => {
      const trigger = document.getElementById(`add-${picker.id}-${picker.branch}`);
      if (!pickerRef.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) setPicker(undefined);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [picker]);

  const drop = (event: DragEvent, id: string, branch: "after" | Branch) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.classList.remove("drop-target");
    if (disabled) return;
    const action = actions.find(item => item.type === event.dataTransfer.getData("application/x-rpa-action"));
    if (action) { setPicker(undefined); onAdd(action, id, branch); }
  };
  const dragOver = (event: DragEvent) => {
    if (!disabled && event.dataTransfer.types.includes("application/x-rpa-action")) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      event.currentTarget.classList.add("drop-target");
    }
  };
  const dragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.classList.remove("drop-target");
  };
  const closePicker = () => {
    const target = picker;
    setPicker(undefined);
    if (target) document.getElementById(`add-${target.id}-${target.branch}`)?.focus();
  };

  function renderBranch(step: StepDefinition, branch: Branch, depth: number) {
    const isLoop = ["control.forEach", "control.forEachXlsx"].includes(step.actionType);
    const isTry = step.actionType === "control.tryCatch";
    const label = isTry ? branch === "children" ? "Try 执行区" : "Catch 异常区" : isLoop ? "循环体" : branch === "children" ? "满足条件" : "否则";
    const addLabel = isTry ? `添加到 ${label}` : isLoop ? "添加到循环体" : branch === "children" ? "添加到满足条件" : "添加到否则分支";
    const children = step[branch] ?? [];
    const choosing = picker?.id === step.stepId && picker.branch === branch;
    const matches = actions.filter(action => `${action.label} ${action.type} ${action.description}`.toLowerCase().includes(query.toLowerCase()));
    return (
      <div key={branch} className="control-branch" role="group" aria-label={`${step.name}：${label}`} data-branch={branch}>
        <div className="control-branch-heading">
          <span>{label}</span><small>{children.length} 条指令</small>
        </div>
        {renderSteps(children, depth + 1)}
        <div className="control-add-area" onDragOver={dragOver} onDragLeave={dragLeave} onDrop={event => drop(event, step.stepId, branch)}>
          <button type="button" id={`add-${step.stepId}-${branch}`} className="control-add" disabled={disabled} aria-label={addLabel}
            aria-expanded={!!choosing} aria-controls={choosing ? "control-action-picker" : undefined}
            onClick={() => { setPicker(choosing ? undefined : { id: step.stepId, branch }); setQuery(""); }}>
            <Plus size={14} />{addLabel}
            {!children.length && <span>或将左侧指令拖到这里</span>}
          </button>
          {choosing && <div ref={pickerRef} id="control-action-picker" className="control-action-picker" role="group" aria-label="选择要添加的指令"
            onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePicker(); } }}>
            <div className="control-picker-search"><Search size={14} />
              <input aria-label="搜索要添加的指令" placeholder="搜索指令" value={query} onChange={event => setQuery(event.target.value)} />
              <button type="button" className="icon-button" aria-label="关闭指令选择" onClick={closePicker}><X size={14} /></button>
            </div>
            <div className="control-picker-options">
              {matches.map(action => <button type="button" key={action.type} disabled={disabled} aria-label={action.label}
                onClick={() => { setPicker(undefined); onAdd(action, step.stepId, branch); }}>
                {renderIcon(action.type)}<span>{action.label}</span><small>{action.category}</small>
              </button>)}
              {!matches.length && <p>没有匹配的指令，试试其他关键词。</p>}
            </div>
          </div>}
        </div>
      </div>
    );
  }

  function renderSteps(items: StepDefinition[], depth: number): ReactNode {
    return items.map((step, index) => {
      const container = ["control.if", "control.forEach", "control.forEachXlsx", "control.tryCatch"].includes(step.actionType);
      const note = step.actionType === "core.note";
      const folded = collapsed.has(step.stepId);
      const state = statuses.get(step.stepId);
      const number = numbers.get(step.stepId)!;
      const action = actions.find(item => item.type === step.actionType);
      const details = getStepDetails(step, action);
      const category = getStepCategory(step.actionType);
      const commented = commentedIds.has(step.stepId);
      const chosen = selection.includes(step.stepId);
      return <div key={step.stepId} className={`step-node${container ? " control-node" : ""}${commented ? " is-disabled" : ""}`} data-step-id={step.stepId} data-depth={depth}>
        <div className="step-node-heading">
          {container && <button type="button" className="control-toggle" aria-label={`${folded ? "展开" : "折叠"} ${step.name}`}
            aria-expanded={!folded} aria-controls={`body-${step.stepId}`} onClick={() => {
              if (!folded) {
                const descendants = [...(step.children ?? []), ...(step.elseSteps ?? [])];
                if (contains(descendants, selectedId)) select(step.stepId);
                else setSelectedIds(previous => previous.filter(id => !contains(descendants, id)));
              }
              setCollapsed(previous => { const next = new Set(previous); if (folded) next.delete(step.stepId); else next.add(step.stepId); return next; });
              setPicker(undefined);
            }}>{folded ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</button>}
          <article className={`step-card${container ? " control-card" : ""}${note ? " note-card" : ""}${chosen ? " selected" : ""}${commented ? " step-disabled" : ""}${state ? ` step-${state}` : ""}`}
            data-category={category.id}
            style={note ? noteStyle(step.params.color) : undefined}
            onDragOver={dragOver} onDragLeave={dragLeave} onDrop={event => drop(event, step.stepId, "after")}>
            <button type="button" className="step-main" aria-label={`步骤 ${number}：${step.name}`} aria-pressed={chosen} aria-keyshortcuts="Control+/ Meta+/" onClick={event => select(step.stepId, event)}>
              <span className="step-number">{String(number).padStart(2, "0")}</span>
              <span className="step-action-icon">{renderIcon(step.actionType)}</span>
              <span className="step-copy"><span className="step-title-row"><strong>{note && <span className="note-tag">备注</span>}{note && step.name === "备注" ? "" : step.name}</strong>
                {!note && <span className="step-category">{container ? step.actionType === "control.if" ? "条件" : step.actionType === "control.tryCatch" ? "异常处理" : "循环" : category.label}</span>}
                {commented && <span className="step-comment-tag">{step.disabled ? "已注释" : "随容器跳过"}</span>}
                {!note && state && renderStatus(state)}
                </span>
                {note ? <span className="note-content">{typeof step.params.text === "string" && step.params.text ? step.params.text : "在右侧填写备注内容"}</span>
                  : <span className="step-details">{details.map((detail, index) => <span className="step-detail" key={`${detail.label}-${index}`}>
                    <span className="step-detail-label">{detail.label}</span><span className="step-detail-value" title={detail.value}>{detail.value}</span>
                  </span>)}{!details.length && <span className="step-description">{action?.description ?? "在右侧配置指令参数"}</span>}</span>}
                {!note && step.output && <span className="step-output"><span className="step-detail-label">输出到</span><span className="step-detail-value" title={step.output}>{step.output}</span></span>}
              </span>
            </button>
            {!note && <div className="step-run-action"><button type="button" className="icon-button" aria-label={`单独运行 ${step.name}`} title={commented ? "已注释的指令不会执行" : `单独运行 ${step.name}`} disabled={cannotRun || commented} onClick={() => onRun(step.stepId)}><Play size={14} /></button></div>}
            <div className="step-actions">
              <button type="button" className="icon-button" aria-label={`${step.disabled ? "取消注释" : "注释"} ${step.name}`} title={`${step.disabled ? "取消注释" : "注释"} · Ctrl+/`} disabled={disabled} onClick={() => onToggleComment([step.stepId])}><Slash size={14} /></button>
              <button type="button" className="icon-button" aria-label={`上移 ${step.name}`} title={`上移 ${step.name}`} disabled={disabled || index === 0} onClick={() => onMutate(step.stepId, "up")}><ArrowUp size={14} /></button>
              <button type="button" className="icon-button" aria-label={`下移 ${step.name}`} title={`下移 ${step.name}`} disabled={disabled || index === items.length - 1} onClick={() => onMutate(step.stepId, "down")}><ArrowDown size={14} /></button>
              <button type="button" className="icon-button" aria-label={`复制 ${step.name}`} title={`复制 ${step.name}`} disabled={disabled} onClick={() => onMutate(step.stepId, "copy")}><Copy size={14} /></button>
              <button type="button" className="icon-button danger" aria-label={`删除 ${step.name}`} title={`删除 ${step.name}`} disabled={disabled} onClick={() => onMutate(step.stepId, "delete")}><Trash2 size={14} /></button>
            </div>
          </article>
        </div>
        {container && <>
          <div id={`body-${step.stepId}`} className="control-body" hidden={folded}>
            {renderBranch(step, "children", depth)}
            {["control.if", "control.tryCatch"].includes(step.actionType) && renderBranch(step, "elseSteps", depth)}
          </div>
          {folded && <button className="control-folded" type="button" onClick={() => setCollapsed(previous => { const next = new Set(previous); next.delete(step.stepId); return next; })}>
            已折叠 {countSteps([...(step.children ?? []), ...(step.elseSteps ?? [])])} 条内部指令，点击展开
          </button>}
          <div className="control-end"><CornerDownRight size={14} /><span>{step.actionType === "control.if" ? "结束条件" : step.actionType === "control.tryCatch" ? "结束 Try / Catch" : "结束循环"}</span><small>自动闭合</small></div>
        </>}
      </div>;
    });
  }

  return <div className="step-tree-root" onKeyDown={event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || (event.key !== "/" && event.code !== "Slash")) return;
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
    if (event.repeat || event.nativeEvent.isComposing || disabled || !selection.length) return;
    event.preventDefault();
    event.stopPropagation();
    onToggleComment(selection);
  }}>
    <details className="step-tools"><summary>查找与批量编辑{selection.length > 1 ? ` · 已选 ${selection.length} 条` : ''}</summary><label className="field"><span>搜索流程步骤</span><input value={stepSearch} onChange={event => setStepSearch(event.target.value)}/></label>{stepSearch && <div className="step-search-results">{listSteps(steps).filter(step => `${step.name} ${step.actionType} ${JSON.stringify(step.params)}`.toLowerCase().includes(stepSearch.toLowerCase())).map(step => <button key={step.stepId} onClick={() => { onSelect(step.stepId); setStepSearch(''); }}>{step.name}</button>)}</div>}
      <div className="batch-tools"><button disabled={disabled || !selection.length} onClick={() => onBatch?.(selection, 'copy')}>复制所选</button><button disabled={disabled || !selection.length} onClick={() => { if (confirm(`删除所选 ${selection.length} 条指令及其子步骤？可撤销恢复。`)) onBatch?.(selection, 'delete'); }}>删除所选</button><select aria-label="移动到分支" value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value="">流程末尾</option>{listSteps(steps).filter(step => ['control.if','control.forEach','control.forEachXlsx','control.tryCatch'].includes(step.actionType)).flatMap(step => [<option key={`${step.stepId}:children`} value={`${step.stepId}:children`}>{step.name} / 执行区</option>, ...(['control.if','control.tryCatch'].includes(step.actionType) ? [<option key={`${step.stepId}:elseSteps`} value={`${step.stepId}:elseSteps`}>{step.name} / 否则或 Catch</option>] : [])])}</select><button disabled={disabled || !selection.length} onClick={() => onBatch?.(selection, 'move', moveTarget)}>移动所选</button></div>
    </details>
    <div className="step-tree">{renderSteps(steps, 0)}</div>
  </div>;
}

function countSteps(steps: StepDefinition[]): number {
  return steps.reduce((count, step) => count + 1 + countSteps(step.children ?? []) + countSteps(step.elseSteps ?? []), 0);
}
