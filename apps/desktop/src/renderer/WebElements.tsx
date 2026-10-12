import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, ElementRef, StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';
const steps = (values: StepDefinition[]): StepDefinition[] => values.flatMap(step => [step, ...steps(step.children ?? []), ...steps(step.elseSteps ?? [])]);
export function WebElements({ api, workflow, step, runId, pageId, disabled, onChange, onBusy }: { api?: DesktopApi; workflow: WorkflowDefinition; step: StepDefinition; runId?: string; pageId: string; disabled: boolean; onChange(flow: WorkflowDefinition): void; onBusy(value: boolean): void }) {
  const [name, setName] = useState(''); const [query, setQuery] = useState(''); const [message, setMessage] = useState(''); const [draft, setDraft] = useState<ElementRef>(); const [oldName, setOldName] = useState<string>();
  const request = useRef<string | undefined>(undefined); const [picking, setPicking] = useState(false);
  const local = step.elements ?? {};
  useEffect(() => () => { if (request.current && runId) { void api?.cancelBrowserElement(runId, request.current).catch(() => {}); onBusy(false); } }, [runId, step.stepId]);
  const capture = async () => {
    if (!api || !runId) return; const id = crypto.randomUUID(); request.current = id; setPicking(true); onBusy(true); setMessage('');
    try { const result = await api.pickBrowserElement(runId, pageId, id); if (request.current !== id) return; if (result) { setDraft(result.element); setMessage(result.stable ? `已拾取：${result.text}` : '该定位依赖结构序号，页面变化后请重新验证。'); } }
    catch (error) { setMessage(String(error)); } finally { if (request.current === id) { request.current = undefined; setPicking(false); onBusy(false); } }
  };
  const references = (key: string) => steps(workflow.steps).filter(item => item.params.selector === `@${key}`).map(item => item.name);
  const update = (key: string, value?: ElementRef, rename?: string) => {
    const flow = structuredClone(workflow); const owner = steps(flow.steps).find(item => item.stepId === step.stepId)!;
    const elements = { ...(owner.elements ?? {}) }; delete elements[key]; if (value) elements[rename ?? key] = value; owner.elements = elements;
    if (value && Object.hasOwn(owner.params, 'selector')) owner.params.selector = `@${rename ?? key}`;
    if (rename && rename !== key) {
      const visit = (items: StepDefinition[], inherited: boolean) => { for (const item of items) { const owns = item.stepId === owner.stepId; const visible = owns || inherited && !Object.hasOwn(item.elements ?? {}, key); if (visible && item.params.selector === `@${key}`) item.params.selector = `@${rename}`; visit(item.children ?? [], visible); visit(item.elseSteps ?? [], visible); } };
      visit(flow.steps, false);
    }
    onChange(flow);
  };
  return <section className="web-elements" aria-label="网页元素库"><h3>网页元素库</h3><input aria-label="搜索网页元素" placeholder="搜索名称" value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="element-tools"><button disabled={disabled || !runId || picking} onClick={() => { setOldName(undefined); setName(''); void capture(); }}>拾取网页元素</button>{picking && <button onClick={() => void api?.cancelBrowserElement(runId!, request.current!)}>取消拾取元素</button>}<button disabled={disabled || !runId} onClick={() => void Promise.all(Object.entries(local).map(async ([key, element]) => { const result = await api!.validateBrowserElement(runId!, element); return `${key}：${result.count} 个匹配`; })).then(values => setMessage(values.join('；'))).catch(error => setMessage(String(error)))}>批量验证</button></div>
    {Object.entries(local).filter(([key]) => key.includes(query)).map(([key, element]) => <div key={key} className="element-row"><strong>{key}</strong><small>引用：{references(key).join('、') || '无'}{steps(workflow.steps).some(item => item.actionType === 'script.run' && String(item.params.code).includes(`@${key}`)) ? ' · 脚本字符串引用需人工核对' : ''}</small><button disabled={disabled} onClick={() => { setOldName(key); setName(key); setDraft(element); }}>编辑</button><button disabled={disabled || !runId} onClick={() => void api?.validateBrowserElement(runId!, element).then(result => setMessage(`匹配 ${result.count} 个：${result.texts.join(' / ')}`)).catch(error => setMessage(String(error)))}>验证并高亮</button></div>)}
    {draft && <fieldset disabled={disabled || picking}><legend>保存网页元素</legend><label className="field"><span>元素名称</span><input value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>选择器</span><input value={draft.selector} onChange={event => setDraft({ ...draft, selector: event.target.value })}/></label><label className="field"><span>iframe 路径（每行一层）</span><textarea value={draft.framePath?.join('\n') ?? ''} onChange={event => setDraft({ ...draft, framePath: event.target.value.split('\n').filter(Boolean) })}/></label><button onClick={() => { if (!name.trim() || name !== name.trim() || ['__proto__', 'constructor', 'prototype'].includes(name) || !draft.selector.trim()) { setMessage('请填写有效名称和选择器'); return; } if (name !== oldName && Object.hasOwn(local, name)) { setMessage('元素名称已存在'); return; } update(oldName ?? name, draft, name); setDraft(undefined); setMessage('已保存元素；请通过 @元素名 引用。'); }}>保存网页元素</button><button onClick={() => void capture()} disabled={!runId}>重新拾取</button><button onClick={() => setDraft(undefined)}>取消编辑</button></fieldset>}
    {message && <p role="status">{message}</p>}
  </section>;
}
