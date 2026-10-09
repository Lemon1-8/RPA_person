import { useEffect, useRef, useState } from 'react';
import { desktopElementSchema, type DesktopElementRef, type DesktopMatch } from '../../../../packages/contracts/src/windows.js';
import type { DesktopApi, StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';
import { changeDesktopElement, inheritedDesktopElements } from './desktop-element-library.js';

const propertyNames = ['AutomationId', 'Name', 'ControlType', 'ClassName'] as const;
export function DesktopElements({ api, workflow, step, disabled, onChange, onBusy }: {
  api?: DesktopApi; workflow: WorkflowDefinition; step?: StepDefinition; disabled: boolean;
  onChange(workflow: WorkflowDefinition): void; onBusy(busy: boolean): void;
}) {
  const [ownerId, setOwnerId] = useState<string | undefined>(step?.stepId);
  const [editing, setEditing] = useState(false);
  const [oldName, setOldName] = useState<string>();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<DesktopElementRef>();
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const active = useRef<string | undefined>(undefined);
  const busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  useEffect(() => () => { if (active.current) { void api?.cancelDesktopElement(active.current); busyCallback.current(false); } }, [api]);
  const local = ownerId ? step?.desktopElements ?? {} : workflow.desktopElements ?? {};
  const inherited = inheritedDesktopElements(workflow, step?.stepId);
  const setBusy = (value: boolean) => { setWorking(value); onBusy(value); };
  async function capture() {
    if (!api || working) return;
    const id = crypto.randomUUID(); active.current = id; setBusy(true); setMessage('');
    try {
      const snapshot = await api.pickDesktopElement(id);
      if (snapshot) { setDraft(snapshot.element); setEditing(true); if (!name) setName(String(snapshot.attributes.Name || snapshot.attributes.ControlType || '软件元素')); setMessage('已捕获，保存前可校验定位结果。'); }
      else setMessage('捕获已取消，原配置保留。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { active.current = undefined; setBusy(false); }
  }
  const change = (update: (value: DesktopElementRef) => void) => { if (draft) { const next = structuredClone(draft); update(next); setDraft(next); } };
  const rule = (label: string, value: DesktopMatch | undefined, onRule: (value?: DesktopMatch) => void) => <div className="desktop-element-rule" key={label}>
    <label><input type="checkbox" checked={!!value} onChange={event => onRule(event.target.checked ? { value: '', match: 'exact' } : undefined)} />{label}</label>
    <input aria-label={`${label}条件`} value={value?.value ?? ''} disabled={!value} onChange={event => onRule({ value: event.target.value, match: value?.match ?? 'exact' })} />
    <select aria-label={`${label}匹配方式`} disabled={!value} value={value?.match ?? 'exact'} onChange={event => onRule({ value: value?.value ?? '', match: event.target.value as DesktopMatch['match'] })}><option value="exact">精确</option><option value="wildcard">通配符</option></select>
  </div>;
  function save() {
    try {
      if (!name.trim() || ['__proto__', 'prototype', 'constructor'].includes(name.trim()) || /["'@\r\n]/.test(name)) throw new Error('请输入有效的元素名称，不能包含引号、@ 或换行');
      const element = desktopElementSchema.parse(draft);
      let next = changeDesktopElement(workflow, ownerId, oldName, name.trim(), element);
      if (step?.actionType.startsWith('windows.') && step.actionType !== 'windows.findWindow') {
        const select = (steps: StepDefinition[]) => { for (const item of steps) { if (item.stepId === step.stepId) { item.params.selector = '@' + name.trim(); delete item.params.element; } select(item.children ?? []); select(item.elseSteps ?? []); } };
        select(next.steps);
      }
      onChange(next); setEditing(false); setOldName(undefined); setDraft(undefined); setName(''); setMessage('桌面元素已保存。');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function validate() {
    if (!api || !draft) return;
    setBusy(true);
    try { const result = await api.validateDesktopElement(desktopElementSchema.parse(draft)); setMessage(`校验结果：匹配 ${result.count} 个元素${result.count === 1 ? '，定位唯一' : '，请调整定位条件'}。`); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="desktop-elements" aria-label="桌面元素库">
    <h3>桌面元素库</h3>
    {step && <label>保存范围<select aria-label="桌面元素保存范围" disabled={working || editing} value={ownerId ?? 'workflow'} onChange={event => setOwnerId(event.target.value === 'workflow' ? undefined : step.stepId)}><option value={step.stepId}>当前指令及子步骤</option><option value="workflow">整个流程</option></select></label>}
    <p className="help-text">捕获软件控件并命名保存，在指令中直接选择。脚本可用 @元素名 或结构化定位引用调用。</p>
    <button type="button" disabled={disabled || working || !api} onClick={() => { setOldName(undefined); setName(''); setDraft(undefined); void capture(); }}>捕获新软件元素</button>
    {working && active.current && <button type="button" onClick={() => void api?.cancelDesktopElement(active.current!)}>取消捕获</button>}
    {Object.entries(local).map(([key, element]) => <div className="desktop-element-row" key={key}><strong>{key}</strong><button type="button" disabled={disabled || working} onClick={() => { setOldName(key); setName(key); setDraft(structuredClone(element)); setEditing(true); setMessage(''); }}>编辑</button><button type="button" disabled={disabled || working} onClick={() => { try { onChange(changeDesktopElement(workflow, ownerId, key, undefined)); setMessage('元素已删除。'); } catch (error) { setMessage(String(error)); } }}>删除</button></div>)}
    {step && <small>当前可用：{Object.keys(inherited).join('、') || '尚无桌面元素'}</small>}
    {editing && draft && <fieldset disabled={working || disabled} className="desktop-element-editor"><legend>{oldName ? '编辑桌面元素' : '保存新桌面元素'}</legend>
      <label>元素名称<input aria-label="桌面元素名称" value={name} onChange={event => setName(event.target.value)} /></label>
      <h4>窗口条件</h4>
      {(['processName', 'title', 'className'] as const).map(key => rule(({ processName: '进程名称', title: '窗口标题', className: '窗口类名' })[key], draft.window[key], value => change(next => { if (value) next.window[key] = value; else delete next.window[key]; })))}
      <h4>控件层级</h4>
      {draft.path.map((node, index) => <div className="desktop-element-node" key={index}>
        <label>第 {index + 1} 层<select aria-label={`第${index + 1}层查找范围`} value={node.axis} onChange={event => change(next => { next.path[index].axis = event.target.value as 'child' | 'descendant'; })}><option value="child">直接子元素</option><option value="descendant">全部后代元素</option></select></label>
        {propertyNames.map(key => rule(key, node.properties[key], value => change(next => { if (value) next.path[index].properties[key] = value; else delete next.path[index].properties[key]; })))}
        <label>匹配序号（留空要求唯一）<input aria-label={`第${index + 1}层序号`} type="number" min="0" value={node.index ?? ''} onChange={event => change(next => { if (event.target.value === '') delete next.path[index].index; else next.path[index].index = Number(event.target.value); })} /></label>
        <button type="button" onClick={() => change(next => { next.path.splice(index, 1); if (next.path[index]) next.path[index].axis = 'descendant'; })}>移除第 {index + 1} 层</button>
      </div>)}
      <div className="desktop-element-buttons"><button type="button" onClick={() => void validate()}>校验桌面元素</button><button type="button" onClick={() => void capture()}>重新捕获</button><button type="button" onClick={save}>保存桌面元素</button><button type="button" onClick={() => { setEditing(false); setDraft(undefined); setOldName(undefined); setName(''); }}>取消编辑</button></div>
    </fieldset>}
    {message && <p role="status" className="desktop-element-message">{message}</p>}
  </section>;
}
