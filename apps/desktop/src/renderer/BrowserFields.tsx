import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BrowserPageInfo, StepDefinition, WorkflowDefinition } from "../../../../packages/contracts/src/index.js";
import { VariablePicker } from "./VariablePicker.js";
import { changeBrowserPortMode, getBrowserPortError, getBrowserPortMode, getPageAliasError, getPageOptions, parseManualBrowserPort, type InheritedPageTarget } from "./page-options.js";

interface BrowserFieldsProps {
  workflow: WorkflowDefinition;
  step: StepDefinition;
  disabled?: boolean;
  onChange: (params: Record<string, unknown>) => void;
  onValidity: (key: string, valid: boolean) => void;
}

interface PageTargetFieldProps {
  workflow: WorkflowDefinition;
  pages: BrowserPageInfo[];
  value?: string;
  inheritedTarget?: InheritedPageTarget;
  stepId?: string;
  disabled?: boolean;
  onChange: (value: string | undefined) => void;
}

export function PageTargetField({ workflow, pages, value, inheritedTarget, stepId, disabled, onChange }: PageTargetFieldProps) {
  const id = useId();
  const [draftMode, setDraftMode] = useState<'page' | 'custom'>();
  const hasElementTarget = Boolean(inheritedTarget && (inheritedTarget.dynamic || inheritedTarget.value !== '$current'));
  const inherited = value === undefined && hasElementTarget;
  const dynamicInherited = inherited && inheritedTarget?.dynamic;
  const effectiveValue = inherited ? inheritedTarget!.value : value?.trim() || '$current';
  const options = useMemo(() => getPageOptions(workflow, pages, effectiveValue), [workflow, pages, effectiveValue]);
  const selected = options.find(option => option.value === effectiveValue);
  const mode = draftMode ?? (inherited ? 'element' : value?.includes('{{') ? 'custom' : effectiveValue === '$current' ? 'current' : 'page');
  const current = pages.find(page => page.current);
  const resolvedPage = dynamicInherited ? undefined : effectiveValue === '$current' ? current : pages.find(page => page.pageId === effectiveValue);
  const groups = [
    { label: '已打开的网页', items: options.filter(option => option.status === 'open' && !option.sessionOnly) },
    { label: '流程中的网页（尚未打开）', items: options.filter(option => option.status === 'declared') },
    { label: '临时网页（仅本次运行）', items: options.filter(option => option.sessionOnly) },
    { label: '不可用的网页', items: options.filter(option => option.status === 'missing' && !option.sessionOnly) },
  ];
  return (
    <div className="page-target-field">
      <div className="field">
        <label htmlFor={id}>目标网页</label>
        <select id={id} aria-label="目标网页" disabled={disabled} aria-describedby={`${id}-hint`} value={mode}
          onChange={event => {
            const next = event.target.value;
            setDraftMode(next === 'page' || next === 'custom' ? next : undefined);
            if (next === 'current') onChange('$current');
            else if (next === 'element') onChange(undefined);
            else if (next === 'page' && dynamicInherited) onChange('$current');
            else if (next === 'page' && effectiveValue !== '$current') onChange(effectiveValue);
            else if (next === 'custom' && inherited) onChange(dynamicInherited ? '' : inheritedTarget!.value);
            else if (next === 'custom' && (!value || value === '$current')) onChange('');
          }}>
          <option value="current">当前网页</option>
          {hasElementTarget && <option value="element">使用元素绑定的网页</option>}
          <option value="page">指定网页</option>
          <option value="custom">填写名称或变量</option>
        </select>
        <small id={`${id}-hint`} className="page-target-hint">
          {mode === 'current' ? '使用流程当前网页；操作其他网页时，选择“指定网页”。手动切换浏览器标签不影响它。'
            : mode === 'element' ? inheritedTarget?.dynamic ? '运行时从元素确定；未绑定时使用当前网页' : `使用元素保存的网页：${inheritedTarget?.value}`
              : mode === 'page' ? '本步骤在选定网页执行，无需添加切换步骤。' : '填写打开网页时设置的名称，或引用网页变量。'}
        </small>
      </div>
      {mode === 'page' && <label className="field page-target-choice">
        <span>选择网页</span>
        <select aria-label="选择网页" value={effectiveValue === '$current' ? '' : effectiveValue} disabled={disabled} onChange={event => onChange(event.target.value)}>
          <option value="" disabled>请选择网页</option>
          {groups.filter(group => group.items.length).map(group => <optgroup key={group.label} label={group.label}>
            {group.items.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </optgroup>)}
        </select>
        {effectiveValue === '$current' && <small>选择后固定目标；未选择时继续使用当前网页。</small>}
        {options.length === 1 && <small>暂无可选网页，请先运行“打开网页”，或填写网页名称。</small>}
        {selected?.status === 'declared' && <small>请先运行打开此网页的步骤。</small>}
        {selected?.status === 'missing' && <small className="page-target-warning">此网页尚未打开或已关闭，请重新打开后再运行。</small>}
      </label>}
      {mode === 'custom' && <>
        <label className="field">
          <span>网页名称或变量</span>
          <input aria-label="网页名称或变量" value={value === '$current' ? '' : value ?? ''} disabled={disabled}
            placeholder="例如：订单详情 或 {{网页结果.pageId}}" spellCheck={false} onChange={event => onChange(event.target.value)} />
          <small>引用“打开网页”的输出时请选择 .pageId 属性。留空使用当前网页。</small>
        </label>
        {stepId && <VariablePicker workflow={workflow} stepId={stepId} disabled={disabled} label="为目标网页插入变量" onPick={onChange} />}
      </>}
      {mode !== 'custom' && resolvedPage && <div className="page-target-preview" aria-label="目标网页详情">
        <span>{mode === 'current' ? '当前指向' : '已选择'} · {resolvedPage.pageId}</span>
        <strong title={resolvedPage.title}>{resolvedPage.title || '未命名网页'}</strong>
        <small title={resolvedPage.url}>{resolvedPage.url}</small>
      </div>}
      {mode !== 'custom' && selected?.sessionOnly && <p className="help-text page-session-hint">临时网页仅在本次运行中有效。重复使用时，请在打开它的步骤中设置名称。</p>}
    </div>
  );
}

function useFieldValidity(key: string, error: string | undefined, onValidity: BrowserFieldsProps['onValidity']) {
  const validity = useRef(onValidity);
  validity.current = onValidity;
  useEffect(() => { validity.current(key, !error); }, [key, error]);
  useEffect(() => () => validity.current(key, true), [key]);
}

function NewPageAliasField({ workflow, stepId, fieldKey, value, disabled, onChange, onValidity }: {
  workflow: WorkflowDefinition;
  stepId: string;
  fieldKey: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onValidity: BrowserFieldsProps['onValidity'];
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const error = getPageAliasError(value);
  useFieldValidity(`param:${fieldKey}`, error, onValidity);
  return (
    <div className="field browser-alias-field">
      <label htmlFor={id}>新网页别名<span className="required"> *</span></label>
      <input id={id} aria-label="新网页别名" ref={input} value={value} disabled={disabled} placeholder="例如：detail"
        spellCheck={false} aria-invalid={!!error} aria-describedby={`${id}-hint${touched && error ? ` ${id}-error` : ''}`}
        className={touched && error ? 'input-error' : ''} onBlur={() => setTouched(true)}
        onChange={event => onChange(event.target.value)} />
      <small id={`${id}-hint`}>后续通过此别名选择网页。请使用固定名称，且不要与仍打开的网页重名。</small>
      {touched && error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
      <VariablePicker workflow={workflow} stepId={stepId} disabled={disabled} label="为新网页别名插入变量"
        onPick={reference => {
          const start = input.current?.selectionStart ?? value.length;
          const end = input.current?.selectionEnd ?? value.length;
          onChange(value.slice(0, start) + reference + value.slice(end));
          requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + reference.length, start + reference.length); });
        }} />
    </div>
  );
}

function OpenFields({ workflow, step, pages, disabled, onChange, onValidity }: BrowserFieldsProps & { pages: BrowserPageInfo[] }) {
  const urlId = useId();
  const urlInput = useRef<HTMLInputElement>(null);
  const [urlTouched, setUrlTouched] = useState(false);
  const [portTouched, setPortTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => getBrowserPortMode(step.params.debugPort) === 'manual');
  const url = String(step.params.url ?? '');
  const openMode = step.params.openMode === 'new' ? 'new' : 'reuse';
  const pageId = String(step.params.pageId ?? '');
  const port = step.params.debugPort;
  const portMode = getBrowserPortMode(port);
  const urlError = url.trim() ? undefined : '请填写网页地址。';
  const portError = getBrowserPortError(port);
  useEffect(() => { if (portError) setAdvancedOpen(true); }, [portError]);
  useFieldValidity('param:url', urlError, onValidity);
  useFieldValidity('param:debugPort', portError, onValidity);
  const setParam = (key: string, value: unknown) => {
    const params = { ...step.params, [key]: value };
    if (value === undefined) delete params[key];
    onChange(params);
  };
  return (
    <div className="browser-fields">
      <div className="field">
        <label htmlFor={urlId}>网页地址<span className="required"> *</span></label>
        <input id={urlId} aria-label="网页地址" ref={urlInput} value={url} disabled={disabled} placeholder="https://…"
          spellCheck={false} aria-invalid={!!urlError} className={urlTouched && urlError ? 'input-error' : ''}
          onBlur={() => setUrlTouched(true)} onChange={event => setParam('url', event.target.value)} />
        {urlTouched && urlError && <span className="field-error" role="alert">{urlError}</span>}
      </div>
      <VariablePicker workflow={workflow} stepId={step.stepId} disabled={disabled} label="为网页地址插入变量"
        onPick={reference => {
          const start = urlInput.current?.selectionStart ?? url.length;
          const end = urlInput.current?.selectionEnd ?? url.length;
          setParam('url', url.slice(0, start) + reference + url.slice(end));
          requestAnimationFrame(() => { urlInput.current?.focus(); urlInput.current?.setSelectionRange(start + reference.length, start + reference.length); });
        }} />
      <label className="field">
        <span>打开方式</span>
        <select aria-label="打开方式" value={openMode} disabled={disabled}
          onChange={event => onChange({ ...step.params, openMode: event.target.value, pageId: event.target.value === 'new' ? '' : pageId || '$current' })}>
          <option value="reuse">在目标标签页打开</option>
          <option value="new">新建标签页</option>
        </select>
      </label>
      <details className="advanced browser-startup-settings" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
        <summary><span>浏览器高级设置</span><small className="browser-port-summary">{portMode === 'auto' ? '端口：自动分配' : `端口：${port || '待填写'}`}</small></summary>
        <p className="help-text">首次启动时生效；复用已有浏览器时沿用原端口。</p>
        <label className="field">
          <span>浏览器</span>
          <select aria-label="浏览器" value={String(step.params.browserChannel ?? 'auto')} disabled={disabled}
            onChange={event => setParam('browserChannel', event.target.value)}>
            <option value="auto">自动选择本机 Chrome / Edge</option>
            <option value="chrome">Google Chrome</option>
            <option value="msedge">Microsoft Edge</option>
            <option value="chromium">Chromium（测试用）</option>
          </select>
        </label>
        <label className="field">
          <span>浏览器端口分配</span>
          <select aria-label="浏览器端口分配" value={portMode} disabled={disabled} onChange={event => {
            setPortTouched(false);
            onChange(changeBrowserPortMode(step.params, event.target.value as 'auto' | 'manual'));
          }}>
            <option value="auto">自动分配</option>
            <option value="manual">手动指定</option>
          </select>
          {portMode === 'auto' && <small>默认由系统分配可用端口，无需填写。</small>}
        </label>
        {portMode === 'manual' && <label className="field browser-port-field">
          <span>浏览器端口<span className="required"> *</span></span>
          <input aria-label="浏览器端口" type={typeof port === 'string' && port.includes('{{') ? 'text' : 'number'}
            min={1024} max={65535} step={1} value={String(port ?? '')} disabled={disabled} placeholder="例如：9222"
            aria-invalid={!!portError} onBlur={() => setPortTouched(true)} className={portTouched && portError ? 'input-error' : ''}
            onChange={event => setParam('debugPort', parseManualBrowserPort(event.target.value))} />
          <small>填写 1024–65535 的整数，指定端口被占用时会提示错误。</small>
          {portTouched && portError && <span className="field-error" role="alert">{portError}</span>}
        </label>}
      </details>
      {openMode === 'new'
        ? <NewPageAliasField workflow={workflow} stepId={step.stepId} fieldKey="pageId" value={pageId} disabled={disabled}
          onChange={value => setParam('pageId', value)} onValidity={onValidity} />
        : <PageTargetField workflow={workflow} pages={pages} stepId={step.stepId} value={pageId} disabled={disabled}
          onChange={value => setParam('pageId', value)} />}
      <p className="help-text">首次打开时自动启动浏览器，后续复用同一浏览器。打开成功后，此网页成为流程当前网页。{openMode === 'reuse' && '指定尚未打开的别名时，会创建标签页并绑定该别名。'}</p>
    </div>
  );
}

export function BrowserOpenFields(props: BrowserFieldsProps & { pages: BrowserPageInfo[] }) {
  return <OpenFields key={props.step.stepId} {...props} />;
}

export function BrowserCloseFields({ workflow, step, pages, disabled, onChange }: Omit<BrowserFieldsProps, 'onValidity'> & { pages: BrowserPageInfo[] }) {
  const mode = step.params.closeMode === 'all' ? 'all' : 'page';
  return (
    <div className="browser-fields">
      <label className="field">
        <span>关闭范围</span>
        <select aria-label="关闭范围" value={mode} disabled={disabled} onChange={event => {
          const params: Record<string, unknown> = { ...step.params, closeMode: event.target.value };
          if (event.target.value === 'all') delete params.pageId;
          else params.pageId = '$current';
          onChange(params);
        }}>
          <option value="page">指定网页</option>
          <option value="all">当前浏览器的所有网页</option>
        </select>
      </label>
      {mode === 'page'
        ? <PageTargetField key={step.stepId} workflow={workflow} pages={pages} stepId={step.stepId}
            value={typeof step.params.pageId === 'string' ? step.params.pageId : undefined} disabled={disabled}
            onChange={value => {
              const params = { ...step.params, pageId: value };
              if (value === undefined) delete params.pageId;
              onChange(params);
            }} />
        : <p className="help-text action-description">仅关闭本次使用的自动化浏览器中的所有网页，包括在这个浏览器里手动打开的网页。其他浏览器不受影响。单独运行时，以工作区上方“目标浏览器”的选择为准。</p>}
    </div>
  );
}
