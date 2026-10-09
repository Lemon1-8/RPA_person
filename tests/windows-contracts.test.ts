import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { desktopElementSchema, workflowSchema, type DesktopElementRef, type WorkflowDefinition } from '../packages/contracts/src/index.js';
import { validateActionParams } from '../packages/actions/src/index.js';
import { changeDesktopElement, inheritedDesktopElements } from '../apps/desktop/src/renderer/desktop-element-library.js';

const element: DesktopElementRef = { backend: 'uia', window: { title: { value: '窗口', match: 'exact' } }, path: [{ axis: 'descendant', properties: { AutomationId: { value: 'input', match: 'exact' } } }] };
function flow(): WorkflowDefinition { return { schemaVersion: 1, workflowId: 'windows-contract', name: '桌面', revision: 0, variables: {}, elements: {}, steps: [], settings: { downloadDir: tmpdir(), headless: true } }; }
describe('桌面元素协议和作用域编辑', () => {
  it('旧流程无需新增字段；桌面元素能够序列化重载且校验空定位规则', () => {
    expect(workflowSchema.parse(flow()).desktopElements).toBeUndefined();
    expect(workflowSchema.parse(JSON.parse(JSON.stringify({ ...flow(), desktopElements: { 输入: element } }))).desktopElements).toEqual({ 输入: element });
    expect(() => desktopElementSchema.parse({ backend: 'uia', window: {}, path: [] })).toThrow('窗口条件');
    expect(() => desktopElementSchema.parse({ backend: 'uia', window: { title: undefined }, path: [] })).toThrow('窗口条件');
    expect(() => desktopElementSchema.parse({ ...element, path: [{ properties: {} }] })).toThrow('节点需要属性');
    expect(() => validateActionParams('windows.click', { element, mode: 'unknown' })).toThrow();
    expect(() => validateActionParams('windows.getAttribute', { element, name: 'arbitrary' })).toThrow();
    expect(validateActionParams('windows.click', { element })).toMatchObject({ mode: 'api' });
  });
  it('重命名更新绑定到当前作用域的引用，保留同名覆盖，并阻止删除被引用元素', () => {
    const workflow = { ...flow(), desktopElements: { 输入: element }, steps: [
      { stepId: 'first', name: '全局读取', actionType: 'windows.text', params: { selector: '@输入' } },
      { stepId: 'shadow', name: '局部读取', actionType: 'windows.text', params: { selector: '@输入' }, desktopElements: { 输入: element } },
      { stepId: 'script', name: '脚本读取', actionType: 'script.run', params: { code: `await rpa.call('windows.text', {selector: '@输入'}); await rpa.call('browser.text', {selector: '@输入'}); await rpa.call('windows.fill', {selector: '@输入', value: '@输入'});` } },
      { stepId: 'python', name: 'Python 引用', actionType: 'script.run', params: { code: `rpa.call("windows.text", {"selector": "@输入"})` } },
    ] };
    expect(inheritedDesktopElements(workflow, 'shadow')).toEqual({ 输入: element });
    const renamed = changeDesktopElement(workflow, undefined, '输入', '搜索', element);
    expect(renamed.steps[0].params.selector).toBe('@搜索');
    expect(renamed.steps[1].params.selector).toBe('@输入');
    expect(renamed.steps[2].params.code).toContain('@搜索');
    expect(renamed.steps[2].params.code).toContain(`'browser.text', {selector: '@输入'}`);
    expect(renamed.steps[2].params.code).toContain(`value: '@输入'`);
    expect(renamed.steps[3].params.code).toContain('"selector": "@搜索"');
    expect(() => changeDesktopElement(renamed, undefined, '搜索', undefined)).toThrow('全局读取');
    expect(() => changeDesktopElement(workflow, 'shadow', '输入', undefined)).toThrow('局部读取');
    expect(workflow.steps[0].params.selector).toBe('@输入');
    const collision = { ...workflow, steps: [{ stepId: 'collision', name: '新名称覆盖', actionType: 'windows.text', params: { selector: '@输入' }, desktopElements: { 搜索: element } }] };
    expect(() => changeDesktopElement(collision, undefined, '输入', '搜索', element)).toThrow('被局部元素覆盖');
  });
});
