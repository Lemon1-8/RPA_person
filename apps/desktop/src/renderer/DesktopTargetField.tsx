import type { StepDefinition, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';
import { inheritedDesktopElements } from './desktop-element-library.js';

export function DesktopTargetField({ workflow, step, disabled, onChange, onElements }: {
  workflow: WorkflowDefinition; step: StepDefinition; disabled: boolean;
  onChange(params: StepDefinition['params']): void; onElements(): void;
}) {
  const variable = step.params.element !== undefined;
  return <div className="field"><label htmlFor={`param-${step.stepId}-selector`}>桌面目标元素</label>
    <select id={`param-${step.stepId}-selector`} disabled={disabled} value={variable ? '$variable' : String(step.params.selector ?? '')} onChange={event => {
      const { selector: _selector, element: _element, ...params } = step.params;
      onChange(event.target.value === '$variable' ? { ...params, element: '{{元素变量}}' } : { ...params, selector: event.target.value });
    }}><option value="">请选择桌面元素</option>{Object.keys(inheritedDesktopElements(workflow, step.stepId)).map(name => <option key={name} value={`@${name}`}>{name}</option>)}<option value="$variable">使用变量中的定位引用</option></select>
    {variable && <label>元素变量<input aria-label="桌面元素变量" disabled={disabled} value={typeof step.params.element === 'string' ? step.params.element : JSON.stringify(step.params.element)} onChange={event => onChange({ ...step.params, element: event.target.value })} placeholder="{{结果.element}} 或 {{关联元素}}" /><small>获取元素输出使用 {"{{结果.element}}"}，关联元素输出直接使用 {"{{关联元素}}"}。</small></label>}
    <button type="button" disabled={disabled} onClick={onElements}>捕获或编辑桌面元素</button>
  </div>;
}
