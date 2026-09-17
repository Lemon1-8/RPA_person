import { describe, expect, it } from 'vitest';
import type { StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { getVariableOptions } from '../apps/desktop/src/renderer/variable-options.js';

const action = (stepId: string, overrides: Partial<StepDefinition> = {}): StepDefinition => ({
  stepId, name: stepId, actionType: 'core.assert', params: { actual: true, expected: true }, ...overrides,
});
const set = (stepId: string, name: string, value: unknown, overrides: Partial<StepDefinition> = {}) =>
  action(stepId, { actionType: 'variables.set', params: { name, value }, ...overrides });
const flow = (steps: StepDefinition[], variables: WorkflowDefinition['variables'] = {}): WorkflowDefinition => ({
  schemaVersion: 1, workflowId: 'variables', name: '变量测试', revision: 1, variables, elements: {},
  settings: { downloadDir: 'C:\\RPA', headless: true }, steps,
});
const byName = (workflow: WorkflowDefinition, stepId: string) => new Map(getVariableOptions(workflow, stepId).map(option => [option.name, option]));

describe('编辑器变量候选与执行作用域一致', () => {
  it('空流程不预置变量，同名用户变量按实际声明展示', () => {
    expect(getVariableOptions(flow([action('selected')]), 'selected')).toEqual([]);
    const options = byName(flow([action('selected')], { runId: { custom: true }, scheduledFor: '自定义时间' }), 'selected');
    expect([...options.keys()]).toEqual(['runId', 'runId.custom', 'scheduledFor']);
    expect(options.get('runId')?.source).toBe('流程变量');
    expect(options.get('scheduledFor')?.source).toBe('流程变量');
  });

  it('展示流程变量、前序设置值与输出，不展示当前或后序输出', () => {
    const workflow = flow([
      set('before', 'orders', [{ id: 101 }], { output: 'saved' }),
      action('current', { output: 'currentResult' }),
      set('after', 'future', true, { output: 'futureResult' }),
    ], { account: { name: '演示' } });
    const options = byName(workflow, 'current');
    expect([...options.keys()]).toEqual(expect.arrayContaining(['account', 'account.name', 'orders', 'orders.0', 'orders.0.id', 'saved.0.id']));
    expect(options.get('orders.0.id')).toMatchObject({ reference: '{{orders.0.id}}', source: '「before」设置的变量', conditional: false });
    expect(options.has('currentResult')).toBe(false);
    expect(options.has('future')).toBe(false);
    expect(options.has('futureResult')).toBe(false);
  });

  it('只进入当前分支，不泄漏互斥分支、后续子步骤或尚未完成容器的输出', () => {
    const workflow = flow([
      action('branch', {
        actionType: 'control.if', params: { left: true, operator: 'truthy' }, output: 'branchResult',
        children: [set('trueSet', 'onlyTrue', true)],
        elseSteps: [set('falseSet', 'onlyFalse', true), action('selected'), set('later', 'laterValue', 1)],
      }),
    ]);
    const options = byName(workflow, 'selected');
    expect(options.get('onlyFalse')?.conditional).toBe(false);
    expect(options.has('onlyTrue')).toBe(false);
    expect(options.has('laterValue')).toBe(false);
    expect(options.has('branchResult')).toBe(false);
  });

  it('前序分支只在一侧产生的值标记可能未产生，两侧产生的值可直接引用', () => {
    const workflow = flow([
      action('branch', {
        actionType: 'control.if', params: { left: '{{condition}}', operator: 'truthy' }, output: 'decision',
        children: [set('yes', 'shared', { common: 1, yesOnly: 1 }), set('extra', 'optional', 1)],
        elseSteps: [set('no', 'shared', { common: 2, noOnly: 2 })],
      }),
      action('selected'),
    ]);
    const options = byName(workflow, 'selected');
    expect(options.get('optional')?.conditional).toBe(true);
    expect(options.get('shared')?.conditional).toBe(false);
    expect(options.get('shared.common')?.conditional).toBe(false);
    expect(options.get('shared.yesOnly')?.conditional).toBe(true);
    expect(options.get('shared.noOnly')?.conditional).toBe(true);
    expect(options.get('decision.matched')?.conditional).toBe(false);
  });

  it('流程、祖先和当前局部变量按作用域覆盖，当前项只能在循环体中使用', () => {
    const workflow = flow([
      action('loop', {
        actionType: 'control.forEach', params: { items: '{{orders}}', itemVariable: 'order' },
        variables: { scope: { parent: true } },
        children: [action('selected', { variables: { scope: { current: true } } })],
      }),
      action('after'),
    ], { scope: { global: true }, orders: [{ id: 1 }, { id: 2, extra: 'optional' }] });
    const inside = byName(workflow, 'selected');
    expect(inside.get('order.id')).toMatchObject({ source: '「loop」的当前项', conditional: false });
    expect(inside.get('order.extra')?.conditional).toBe(true);
    expect(inside.has('scope.current')).toBe(true);
    expect(inside.has('scope.parent')).toBe(false);
    expect(inside.has('scope.global')).toBe(false);
    const after = byName(workflow, 'after');
    expect(after.has('order')).toBe(false);
    expect(after.has('scope.global')).toBe(true);
    expect(after.has('scope.parent')).toBe(false);
    expect(byName(workflow, 'loop').has('order')).toBe(false);
  });

  it('循环结束恢复同名变量，循环体产生的新值仅标记为可能存在', () => {
    const workflow = flow([
      action('loop', {
        actionType: 'control.forEach', params: { items: [1, 2], itemVariable: 'item' }, output: 'loopResult',
        children: [set('overwrite', 'item', { inner: 1 }), set('save', 'last', '{{item}}')],
      }),
      action('selected'),
    ], { item: { original: true } });
    const options = byName(workflow, 'selected');
    expect(options.has('item.original')).toBe(true);
    expect(options.has('item.inner')).toBe(false);
    expect(options.get('last')?.conditional).toBe(true);
    expect(options.get('loopResult.count')?.conditional).toBe(false);
  });

  it('前序步骤局部声明在退出时恢复，但同名输出在恢复之后发布', () => {
    const workflow = flow([
      set('localOnly', 'temporary', { hidden: true }, { variables: { temporary: '局部' } }),
      set('restore', 'shared', { changed: true }, { variables: { shared: '局部' } }),
      set('publish', 'localOutput', { published: true }, { variables: { localOutput: '局部' }, output: 'localOutput' }),
      action('selected'),
    ], { shared: { original: true } });
    const options = byName(workflow, 'selected');
    expect(options.has('temporary')).toBe(false);
    expect(options.has('shared.original')).toBe(true);
    expect(options.has('shared.changed')).toBe(false);
    expect(options.get('localOutput.published')).toMatchObject({ conditional: false, source: '「publish」的输出' });
  });

  it('祖先局部范围中前序赋值可见，离开祖先后恢复', () => {
    const workflow = flow([
      action('branch', {
        actionType: 'control.if', params: { left: true, operator: 'truthy' }, variables: { local: { initial: true } },
        children: [set('change', 'local', { updated: true }), action('inside')],
      }),
      action('outside'),
    ]);
    expect(byName(workflow, 'inside').has('local.updated')).toBe(true);
    expect(byName(workflow, 'inside').has('local.initial')).toBe(false);
    expect(byName(workflow, 'outside').has('local')).toBe(false);
  });

  it('变量引用保留静态对象形状，未知运行输出只展示根变量', () => {
    const workflow = flow([
      set('alias', 'copy', '{{config}}'),
      action('fetch', { actionType: 'browser.response', params: {}, output: 'response' }),
      action('selected'),
    ], { config: { customer: { id: 7 }, rows: [{ name: 'A' }] } });
    const options = byName(workflow, 'selected');
    expect(options.has('copy.customer.id')).toBe(true);
    expect(options.has('copy.rows.0.name')).toBe(true);
    expect(options.has('response')).toBe(true);
    expect([...options.keys()].some(name => name.startsWith('response.'))).toBe(false);
  });

  it('网页动作输出提供真实网页名称属性，普通点击不提供不存在的网页属性', () => {
    const workflow = flow([
      action('start', { actionType: 'browser.start', params: {}, output: 'started' }),
      action('open', { actionType: 'browser.open', params: { url: 'https://example.test' }, output: 'opened' }),
      action('switch', { actionType: 'browser.switchPage', params: { pageId: 'main' }, output: 'switched' }),
      action('popup', { actionType: 'browser.click', params: { selector: '#popup', waitForNewPage: true }, output: 'popup' }),
      action('click', { actionType: 'browser.click', params: { selector: '#button' }, output: 'clicked' }),
      action('close', { actionType: 'browser.closePage', params: { pageId: 'detail' }, output: 'closed' }),
      action('selected'),
    ]);
    const options = byName(workflow, 'selected');
    expect(options.get('opened.pageId')).toMatchObject({ reference: '{{opened.pageId}}', source: '「open」的输出', conditional: false });
    expect(options.has('popup.pageId')).toBe(false);
    expect([...options.keys()]).toEqual([
      'started', 'started.pageId', 'started.browserChannel', 'started.debugPort',
      'opened', 'opened.pageId', 'opened.url', 'switched', 'switched.pageId', 'switched.url',
      'popup', 'popup.ok', 'clicked', 'clicked.ok',
      'closed', 'closed.ok', 'closed.pageId',
    ]);
  });

  it('关闭所有网页提供关闭名单，不误导用户引用单个网页名称', () => {
    const options = byName(flow([
      action('close-all', { actionType: 'browser.closePage', params: { closeMode: 'all' }, output: 'closed' }),
      action('selected'),
    ]), 'selected');
    expect(options.has('closed.pageId')).toBe(false);
    expect(options.has('closed.closedPageIds')).toBe(true);
    expect(options.has('closed.ok')).toBe(true);
  });

  it('与引擎一致优先匹配完整点号变量，不生成无法读取的点号根属性', () => {
    const workflow = flow([action('selected')], { order: { total: { nested: true }, id: 1 }, 'order.total': { exact: true } });
    const options = byName(workflow, 'selected');
    expect(options.get('order.total')?.depth).toBe(0);
    expect(options.has('order.total.nested')).toBe(false);
    expect(options.has('order.total.exact')).toBe(false);
    expect(options.has('order.id')).toBe(true);
  });

  it('打印日志的输出保留引用值的对象属性，可供后续指令使用', () => {
    const workflow = flow([
      action('print', { actionType: 'core.log', params: { message: '{{order}}' }, output: 'printed' }),
      action('selected'),
    ], { order: { id: 7, rows: [{ amount: 3 }] } });
    const options = byName(workflow, 'selected');
    expect(options.get('printed.id')).toMatchObject({ source: '「print」的输出', conditional: false, reference: '{{printed.id}}' });
    expect(options.has('printed.rows.0.amount')).toBe(true);
  });

  it('不存在的步骤不显示其他步骤变量，也不推荐无法插入的动态名称', () => {
    const workflow = flow([set('dynamic', '{{name}}', 1), action('selected')]);
    expect(getVariableOptions(workflow, 'missing')).toEqual([]);
    expect(byName(workflow, 'selected').has('{{name}}')).toBe(false);
  });
});
