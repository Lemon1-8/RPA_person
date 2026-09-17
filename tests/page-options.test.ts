import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserPageInfo, StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { PageTargetField } from '../apps/desktop/src/renderer/BrowserFields.js';
import { changeBrowserPortMode, getBrowserPageErrors, getBrowserPortError, getBrowserPortMode, getDeclaredPageAliases, getEffectivePageTarget, getInheritedPageTarget, getPageAliasError, getPageOptions, parseManualBrowserPort } from '../apps/desktop/src/renderer/page-options.js';

const step = (actionType: string, params: Record<string, unknown>, children?: StepDefinition[], elseSteps?: StepDefinition[]): StepDefinition => ({
  stepId: actionType, name: actionType, actionType, params, children, elseSteps,
});
const flow = (steps: StepDefinition[] = []): WorkflowDefinition => ({
  schemaVersion: 1, workflowId: 'pages', name: '网页测试', revision: 1, variables: {}, elements: {},
  settings: { downloadDir: 'C:\\RPA', headless: true }, steps,
});
const page = (pageId: string, title: string, current = false): BrowserPageInfo => ({ pageId, title, current, url: `https://example.test/${pageId}` });

describe('网页目标候选', () => {
  it('合并流程嵌套声明并去重，排除动态别名和已移除的弹出页配置', () => {
    const workflow = flow([
      step('browser.open', { pageId: 'orders' }),
      step('control.if', {}, [step('browser.click', { waitForNewPage: true, newPageId: 'detail' })], [step('browser.open', { pageId: 'report' })]),
      step('browser.open', { pageId: 'orders' }),
      step('browser.open', { pageId: '{{pageName}}' }),
      step('browser.open', { pageId: '$current' }),
      step('browser.open', { pageId: ' leading' }),
      step('browser.click', { waitForNewPage: false, newPageId: 'unused' }),
      step('browser.fill', { pageId: 'notDeclared' }),
    ]);
    expect(getDeclaredPageAliases(workflow)).toEqual(['orders', 'report']);
    expect(getPageOptions(workflow, []).some(option => option.value === 'detail')).toBe(false);
  });

  it('使用别名定位同标题网页，实时标题和网址随页面变化', () => {
    const workflow = flow([step('browser.open', { pageId: 'orders' })]);
    const pages = [page('orders', '订单', true), page('detail', '订单')];
    const options = getPageOptions(workflow, pages);
    expect(options.map(option => option.value)).toEqual(['$current', 'orders', 'detail']);
    expect(options[0]).toMatchObject({ label: '当前网页', description: 'https://example.test/orders' });
    expect(options.find(option => option.value === 'orders')).toMatchObject({ status: 'open', label: 'orders — 订单' });
    expect(options.find(option => option.value === 'detail')).toMatchObject({ status: 'open', label: 'detail — 订单' });
    expect(getPageOptions(workflow, [{ ...pages[0], title: '已跳转', url: 'https://example.test/new' }])[1]).toMatchObject({ value: 'orders', label: 'orders — 已跳转', description: 'https://example.test/new' });
  });

  it('自动登记网页提示仅本次会话，流程显式声明的同形别名按固定别名处理', () => {
    const options = getPageOptions(flow([step('browser.open', { pageId: 'page-8' })]), [page('page-7', '手动打开'), page('page-8', '固定别名')]);
    expect(options.find(option => option.value === 'page-7')).toMatchObject({ sessionOnly: true, label: '手动打开（page-7）' });
    expect(options.find(option => option.value === 'page-8')).toMatchObject({ sessionOnly: false, label: 'page-8 — 固定别名' });
  });

  it('关闭页面从实时列表消失，已选别名和已有流程声明仍保留并提示不可用', () => {
    const options = getPageOptions(flow(), [], 'closed');
    expect(options.map(option => option.value)).toEqual(['$current', 'closed']);
    expect(options[1]).toMatchObject({ status: 'missing', label: 'closed' });
    expect(getPageOptions(flow(), [], '{{pageName}}').at(-1)?.value).toBe('{{pageName}}');
  });
});

describe('打开网页的新网页别名', () => {
  it('要求有效别名，允许中文和运行时变量引用', () => {
    for (const name of ['', ' ', '$current', ' detail', 'detail ', '{page}', '{{}}', '{{ }}', '{{page}']) {
      expect(getPageAliasError(name), name).toBeTruthy();
    }
    for (const name of ['detail', '订单详情', 'main', '{{pageName}}', 'detail-{{item.id}}']) {
      expect(getPageAliasError(name), name).toBeUndefined();
    }
  });

});

describe('网页目标与元素继承一致', () => {
  it('缺省目标使用元素库pageRef，明确选择当前网页或其他别名时覆盖继承', () => {
    const workflow = flow([step('browser.click', { selector: '@submit' })]);
    workflow.elements.submit = { selector: '#submit', pageRef: 'orders' };
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('orders');
    for (const pageId of ['', ' ', '$current']) {
      workflow.steps[0].params.pageId = pageId;
      expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('$current');
    }
    workflow.steps[0].params.pageId = 'detail';
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('detail');
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: 'orders', dynamic: false });
    expect(getEffectivePageTarget(workflow, 'missing')).toBe('$current');
  });

  it('当前步骤及祖先覆盖流程元素，兄弟步骤元素不泄漏到其他分支', () => {
    const workflow = flow([
      { ...step('browser.text', { selector: '@submit' }), stepId: 'before', elements: { submit: { selector: '#before', pageRef: 'before' } } },
      { ...step('control.if', {}, [
        { ...step('browser.click', { selector: '@submit' }), stepId: 'inside' },
        { ...step('browser.click', { selector: '@submit' }), stepId: 'local', elements: { submit: { selector: '#local', pageRef: 'local' } } },
      ], [{ ...step('browser.click', { selector: '@submit' }), stepId: 'otherwise' }]), elements: { submit: { selector: '#parent', pageRef: 'parent' } } },
      { ...step('browser.text', { selector: '@submit' }), stepId: 'after' },
    ]);
    workflow.elements.submit = { selector: '#global', pageRef: 'global' };
    expect(getEffectivePageTarget(workflow, 'before')).toBe('before');
    expect(getEffectivePageTarget(workflow, 'inside')).toBe('parent');
    expect(getEffectivePageTarget(workflow, 'local')).toBe('local');
    expect(getEffectivePageTarget(workflow, 'otherwise')).toBe('parent');
    expect(getEffectivePageTarget(workflow, 'after')).toBe('global');
  });

  it('遵循内联元素、framePath重建及@元素优先级，并保留变量引用', () => {
    const workflow = flow([step('browser.click', { element: { selector: '#inline', pageRef: 'inline' } })]);
    const params = workflow.steps[0].params;
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('inline');
    params.selector = '#plain';
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('inline');
    params.framePath = ['iframe'];
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('$current');
    params.selector = '@submit';
    workflow.elements.submit = { selector: '#saved', pageRef: '{{pageName}}' };
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('{{pageName}}');
    params.pageId = '{{override}}';
    expect(getEffectivePageTarget(workflow, 'browser.click')).toBe('{{override}}');
  });

  it('动态选择器和内联元素引用保守保留运行时继承，不把当前变量值当作固定目标', () => {
    const workflow = flow([step('browser.click', { selector: '{{selector}}' })]);
    workflow.variables.selector = '@submit';
    workflow.elements.submit = { selector: '#submit', pageRef: 'orders' };
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: true });
    workflow.variables.selector = '#plain';
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: true });
    workflow.steps[0].params = { element: '{{element}}' };
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: true });
    workflow.steps[0].params = { selector: '@submit' };
    workflow.elements.submit.pageRef = '{{pageName}}';
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '{{pageName}}', dynamic: true });
  });

  it('动态@元素优先于framePath，而确定为普通选择器时framePath重建清除元素绑定', () => {
    const workflow = flow([step('browser.click', { selector: '@{{elementName}}', framePath: ['iframe'], element: { selector: '#inline', pageRef: 'inline' } })]);
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: true });
    workflow.steps[0].params.selector = '{{selector}}';
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: true });
    workflow.steps[0].params.selector = '#{{id}}';
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: '$current', dynamic: false });
    delete workflow.steps[0].params.framePath;
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: 'inline', dynamic: false });
    workflow.steps[0].params = { selector: '@submit', framePath: ['iframe'], element: '{{element}}' };
    workflow.elements.submit = { selector: '#submit', pageRef: 'orders' };
    expect(getInheritedPageTarget(workflow, 'browser.click')).toEqual({ value: 'orders', dynamic: false });
  });

  it('动态元素默认显示运行时继承，显式当前网页仍覆盖继承并显示实际当前网页', () => {
    const workflow = flow([step('browser.click', { selector: '{{selector}}' })]);
    const render = () => renderToStaticMarkup(createElement(PageTargetField, {
      workflow, pages: [page('main', '当前标题', true)],
      value: workflow.steps[0].params.pageId as string | undefined,
      inheritedTarget: getInheritedPageTarget(workflow, 'browser.click'), onChange: () => {},
    }));
    const inherited = render();
    expect(inherited).toMatch(/<option value="element" selected="">使用元素绑定的网页<\/option>/);
    expect(inherited).toContain('运行时从元素确定；未绑定时使用当前网页');
    expect(inherited).not.toContain('aria-label="目标网页详情"');
    expect(Object.hasOwn(workflow.steps[0].params, 'pageId')).toBe(false);
    workflow.steps[0].params.pageId = '$current';
    const current = render();
    expect(current).toMatch(/<option value="current" selected="">当前网页<\/option>/);
    expect(current).toContain('当前指向 · main');
    expect(current).toContain('value="element"');
    workflow.steps[0].params = { selector: '#plain' };
    const plain = render();
    expect(plain).toMatch(/<option value="current" selected="">当前网页<\/option>/);
    expect(plain).not.toContain('value="element"');
    expect(Object.hasOwn(workflow.steps[0].params, 'pageId')).toBe(false);
  });
});

describe('完整流程网页参数校验', () => {
  it('打开网页仍校验必填别名，不再校验点击的旧新网页名称', () => {
    const workflow = flow([
      { ...step('browser.open', { url: 'https://example.test', openMode: 'new', pageId: '' }), stepId: 'new', name: '新建网页' },
      step('control.if', {}, [
        { ...step('browser.click', { selector: '#open', waitForNewPage: true, newPageId: '$current' }), stepId: 'popup', name: '打开详情' },
      ], [
        { ...step('browser.open', { url: 'https://example.test', openMode: 'new', pageId: '$current' }), stepId: 'other', name: '备用网页' },
      ]),
    ]);
    expect(getBrowserPageErrors(workflow)).toEqual([
      { stepId: 'new', stepName: '新建网页', error: '请填写新网页别名，例如 detail。' },
      { stepId: 'other', stepName: '备用网页', error: '“$current”代表当前网页，请使用其他别名。' },
    ]);
  });

  it('接受有效变量别名和空的复用目标，不校验已移除的弹出页参数', () => {
    expect(getBrowserPageErrors(flow([
      step('browser.open', { url: '{{url}}', openMode: 'new', pageId: 'detail-{{item.id}}' }),
      step('browser.open', { url: 'https://example.test', openMode: 'reuse', pageId: '' }),
      step('browser.click', { selector: '#open', waitForNewPage: true, newPageId: '{{pageName}}' }),
      step('browser.click', { selector: '#open', waitForNewPage: true }),
      step('browser.click', { selector: '#open', waitForNewPage: true, newPageId: ' ' }),
      step('browser.click', { selector: '#open', waitForNewPage: true, newPageId: { pageId: 'main' } }),
      step('browser.click', { selector: '#open', waitForNewPage: false, newPageId: '{{}}' }),
    ]))).toEqual([]);
  });

  it('切走字段后仍拒绝空网址和非法端口，接受自动端口与完整数字变量引用', () => {
    for (const url of ['', ' ', undefined, 42]) {
      expect(getBrowserPageErrors(flow([step('browser.open', { url })]))[0]?.error).toBe('请填写网页地址。');
    }
    for (const debugPort of [-1, 1, 1023, 65536, 9333.5, NaN, '', '9333', '{{ }}', '9{{suffix}}']) {
      expect(getBrowserPageErrors(flow([step('browser.open', { url: 'https://example.test', debugPort })]))[0]?.error, String(debugPort)).toContain('调试端口');
    }
    for (const debugPort of [undefined, 0, 1024, 65535, '{{port}}', '{{ port }}']) {
      expect(getBrowserPageErrors(flow([step('browser.open', { url: 'https://example.test', debugPort })])), String(debugPort)).toEqual([]);
    }
  });
});

describe('浏览器端口自动与手动设置', () => {
  it('切回自动分配时移除旧手动端口，不会改变其他参数或保留隐藏值', () => {
    const params = { url: 'https://example.test', pageId: 'orders', debugPort: 9222 };
    const automatic = changeBrowserPortMode(params, 'auto');
    expect(automatic).toEqual({ url: 'https://example.test', pageId: 'orders' });
    expect(params.debugPort).toBe(9222);
    expect(getBrowserPortMode(automatic.debugPort)).toBe('auto');
    const manual = changeBrowserPortMode(automatic, 'manual');
    expect(manual.debugPort).toBe('');
    expect(getBrowserPortMode(manual.debugPort)).toBe('manual');
    expect(getBrowserPortError(manual.debugPort)).toContain('1024–65535');
  });

  it('手动输入有效端口转为数字，0或未完成输入保持手动错误而不会意外恢复自动', () => {
    expect(parseManualBrowserPort('9222')).toBe(9222);
    expect(parseManualBrowserPort('1024')).toBe(1024);
    expect(parseManualBrowserPort('65535')).toBe(65535);
    for (const draft of ['', '0', '1023', '65536', '9222.5']) {
      const value = parseManualBrowserPort(draft);
      expect(getBrowserPortMode(value), draft).toBe('manual');
      expect(getBrowserPortError(value), draft).toBeTruthy();
    }
    expect(changeBrowserPortMode({ debugPort: 9222 }, 'manual')).toEqual({ debugPort: 9222 });
    expect(getBrowserPortMode(0)).toBe('auto');
    expect(getBrowserPortMode(undefined)).toBe('auto');
  });
});
