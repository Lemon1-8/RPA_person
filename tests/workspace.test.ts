import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { refreshDemoUrls } from '../apps/desktop/src/workspace.js';
import type { RunManager } from '../apps/runner/src/manager.js';
import { createDemoWorkflow } from '../examples/demo.js';
import type { StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { resolveValue, WorkflowEngine } from '../packages/engine/src/index.js';

const oldUrl = 'http://127.0.0.1:1234';
const currentUrl = 'http://127.0.0.1:4567';

function legacyDemo() {
  const workflow = createDemoWorkflow(oldUrl, tmpdir(), true);
  workflow.variables = { demoUrl: oldUrl, customer: '跨语言订单' };
  workflow.steps[0].params.url = '{{demoUrl}}';
  workflow.steps[1].params.value = '{{customer}}';
  workflow.steps.find(step => step.stepId === 'verify')!.params.text = '查询完成：{{customer}}';
  return workflow;
}

function workspace(workflow: WorkflowDefinition) {
  let saved = structuredClone(workflow);
  const saveWorkflow = vi.fn(async (next: WorkflowDefinition) => {
    saved = structuredClone({ ...next, revision: saved.revision + 1 }); return saved;
  });
  const manager = { listWorkflows: async () => [structuredClone(saved)], saveWorkflow } as unknown as RunManager;
  return { manager, saveWorkflow, workflow: () => saved };
}

describe('内置示例默认值迁移', () => {
  it('新示例把输入直接保存在动作参数中，不预置流程变量', () => {
    const workflow = createDemoWorkflow(currentUrl, tmpdir());
    expect(workflow.variables).toEqual({});
    expect(workflow.steps[0].params.url).toBe(currentUrl);
    expect(workflow.steps[1].params.value).toBe('跨语言订单');
    expect(workflow.steps.find(step => step.stepId === 'verify')!.params.text).toBe('查询完成：跨语言订单');
  });

  it('旧示例移除默认变量，将原始引用替换为可运行的参数，重复刷新不保存', async () => {
    const state = workspace(legacyDemo());
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({});
    expect(state.workflow().steps[0].params.url).toBe(currentUrl);
    expect(state.workflow().steps[1].params.value).toBe('跨语言订单');
    expect(state.workflow().steps.find(step => step.stepId === 'verify')!.params.text).toBe('查询完成：跨语言订单');
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.saveWorkflow).toHaveBeenCalledTimes(1);
  });

  it('原始步骤已被删除后仍清理遗留默认值，保留用户变量', async () => {
    const workflow = legacyDemo(); workflow.steps = []; workflow.variables.actualInput = '保留';
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({ actualInput: '保留' });
  });

  it('打开网页混合引用两个旧默认变量时仍清除声明并替换为字面量', async () => {
    const workflow = legacyDemo();
    workflow.steps = [{ stepId: 'edited-open', name: '打开网页', actionType: 'browser.open', params: { url: '{{customer}}{{demoUrl}}' } }];
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({});
    expect(state.workflow().steps[0].params.url).toBe(`跨语言订单${currentUrl}`);
  });

  it('迁移嵌套原始步骤，保留局部变量及循环项同名引用', async () => {
    const workflow = legacyDemo();
    const [open, fill] = workflow.steps;
    workflow.steps = [{
      stepId: 'branch', name: '分支', actionType: 'control.if', params: { left: true, operator: 'truthy' },
      children: [open, { ...fill, variables: { customer: '局部客户' } }],
      elseSteps: [{
        stepId: 'loop', name: '遍历', actionType: 'control.forEach', params: { items: ['循环客户'], itemVariable: 'customer' },
        children: [{ stepId: 'log', name: '记录', actionType: 'core.log', params: { message: '{{customer}}' } }],
      }],
    }];
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({});
    const branch = state.workflow().steps[0];
    expect(branch.children![0].params.url).toBe(currentUrl);
    expect(branch.children![1]).toMatchObject({ variables: { customer: '局部客户' }, params: { value: '{{customer}}' } });
    expect(branch.elseSteps![0].children![0].params.message).toBe('{{customer}}');
  });

  it('保留普通流程的同名变量，以及已修改的默认值和外部网址', async () => {
    const ordinary = legacyDemo(); ordinary.workflowId = 'user-flow';
    const ordinaryState = workspace(ordinary);
    await refreshDemoUrls(ordinaryState.manager, currentUrl);
    expect(ordinaryState.saveWorkflow).not.toHaveBeenCalled();
    const customized = legacyDemo();
    customized.variables = { demoUrl: 'https://example.com', customer: '实际客户' };
    customized.steps[0].params.url = 'https://example.com';
    const customState = workspace(customized);
    await refreshDemoUrls(customState.manager, currentUrl);
    expect(customState.saveWorkflow).not.toHaveBeenCalled();
  });

  it.each<StepDefinition>([
    { stepId: 'custom', name: '自定义引用', actionType: 'core.log', params: { message: '{{customer}}' } },
    { stepId: 'custom', name: '脚本引用', actionType: 'script.run', params: { language: 'javascript', code: 'await rpa.output(await rpa.get("customer"));' } },
    { stepId: 'custom', name: '脚本反引号引用', actionType: 'script.run', params: { language: 'typescript', code: 'await rpa.output(await rpa.get(`customer`));' } },
    { stepId: 'custom', name: '修改默认值', actionType: 'variables.set', params: { name: 'customer', value: '修改后' } },
    { stepId: 'custom', name: '覆盖默认值', actionType: 'browser.text', params: { selector: '#customer' }, output: 'customer' },
    { stepId: 'custom', name: '局部同名输出', actionType: 'browser.text', params: { selector: '#customer' }, variables: { customer: '局部客户' }, output: 'customer' },
  ])('区分默认常量与显式业务写入，保留自定义用途：$name', async step => {
    const workflow = legacyDemo(); workflow.steps.push(step);
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    const businessVariable = step.actionType === 'variables.set' || step.output === 'customer';
    expect(state.workflow().variables).toEqual(businessVariable ? { customer: '跨语言订单' } : {});
    expect(state.workflow().steps[1].params.value).toBe(businessVariable ? '{{customer}}' : '跨语言订单');
    const migrated = state.workflow().steps.at(-1)!;
    if (step.actionType === 'core.log') expect(migrated.params.message).toBe('跨语言订单');
    else expect(migrated).toEqual(step);
  });

  it('示例地址已有自定义引用时也删除变量，将引用写为当前地址', async () => {
    const workflow = legacyDemo();
    workflow.steps.push({ stepId: 'custom', name: '记录地址', actionType: 'core.log', params: { message: '{{demoUrl}}' } });
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({});
    expect(state.workflow().steps[0].params.url).toBe(currentUrl);
    expect(state.workflow().steps.at(-1)!.params.message).toBe(currentUrl);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.saveWorkflow).toHaveBeenCalledTimes(1);
  });

  it('递归替换文本与JSON模板，保留其它变量及脚本原文', async () => {
    const workflow = legacyDemo();
    const code = 'await rpa.output([await rpa.get("customer"), "{{customer}}"]);';
    workflow.variables.actual = '实际用户值';
    workflow.elements = { row: { selector: '[data-customer="{{customer}}"]' } };
    workflow.steps = [
      { stepId: 'custom', name: '混合引用', actionType: 'core.log', params: { message: { list: ['{{ customer }}', '{{demoUrl}}/{{actual}}'], nested: { customer: '{{customer}}' } } } },
      { stepId: 'script', name: '自定义脚本', actionType: 'script.run', params: { language: 'javascript', code } },
    ];
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({ actual: '实际用户值' });
    expect(state.workflow().steps[0].params.message).toEqual({ list: ['跨语言订单', `${currentUrl}/{{actual}}`], nested: { customer: '跨语言订单' } });
    expect(state.workflow().elements.row.selector).toBe('[data-customer="跨语言订单"]');
    expect(state.workflow().steps[1].params.code).toBe(code);
  });

  it.each(['variables.set', 'browser.text'])('保留 %s 显式写入及之后对该值的引用', async actionType => {
    const workflow = legacyDemo();
    workflow.steps = [
      { stepId: 'before', name: '旧默认引用', actionType: 'core.log', params: { message: '{{customer}}' } },
      { stepId: 'write', name: '用户写入', actionType, params: actionType === 'variables.set' ? { name: 'customer', value: '实际客户' } : { selector: '#customer' }, ...(actionType === 'browser.text' ? { output: 'customer' } : {}) },
      { stepId: 'after', name: '读取用户写入', actionType: 'core.log', params: { message: '{{customer}}' } },
    ];
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({ customer: '跨语言订单' });
    expect(state.workflow().steps[0].params.message).toBe('{{customer}}');
    expect(state.workflow().steps[1]).toEqual(workflow.steps[1]);
    expect(state.workflow().steps[2].params.message).toBe('{{customer}}');
  });

  it('条件分支只在另一侧写入时，未写入路径仍可读取用户业务变量初值', async () => {
    const workflow = legacyDemo();
    workflow.steps = [
      { stepId: 'branch', name: '不写入分支', actionType: 'control.if', params: { left: false, operator: 'truthy' }, children: [
        { stepId: 'write', name: '用户写入', actionType: 'variables.set', params: { name: 'customer', value: '用户值' } },
      ] },
      { stepId: 'read', name: '读取初值', actionType: 'core.log', params: { message: '{{customer}}' }, output: 'readCustomer' },
    ];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    const result = await new WorkflowEngine(state.workflow(), { dataDir: tmpdir(), runId: 'migration-branch' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.readCustomer).toBe('跨语言订单');
  });

  it('循环先读取再写入业务变量时，下一轮读取上轮值而非固化的默认值', async () => {
    const workflow = legacyDemo();
    workflow.steps = [{ stepId: 'loop', name: '遍历', actionType: 'control.forEach', params: { items: [1, 2], itemVariable: 'item' }, children: [
      { stepId: 'read', name: '读取', actionType: 'core.log', params: { message: '{{customer}}' } },
      { stepId: 'write', name: '写入', actionType: 'variables.set', params: { name: 'customer', value: '{{item}}' } },
    ] }];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    const values: unknown[] = [];
    const result = await new WorkflowEngine(state.workflow(), { dataDir: tmpdir(), runId: 'migration-loop', onEvent: event => {
      if (event.type === 'log' && event.stepId === 'read') values.push((event.data as { value: unknown }).value);
    } }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(values).toEqual(['跨语言订单', 1]);
  });

  it('共享元素在根作用域使用字面量，在同名局部作用域继承原模板与祖先覆盖', async () => {
    const workflow = legacyDemo();
    workflow.elements = { target: { selector: '[data-customer="{{customer}}"]' } };
    workflow.steps = [
      { stepId: 'root', name: '根引用', actionType: 'browser.text', params: { selector: '@target' } },
      { stepId: 'local', name: '局部覆盖', actionType: 'browser.text', variables: { customer: '局部客户' }, params: { selector: '@target' } },
      { stepId: 'parent', name: '祖先覆盖', actionType: 'control.if', params: { left: true, operator: 'truthy' }, elements: { target: { selector: '#ancestor-{{customer}}' } }, children: [
        { stepId: 'nested', name: '嵌套局部', actionType: 'browser.text', variables: { customer: '嵌套客户' }, params: { selector: '@target' } },
      ] },
      { stepId: 'loop', name: '循环项', actionType: 'control.forEach', params: { items: ['循环客户'], itemVariable: 'customer' }, children: [
        { stepId: 'loop-read', name: '循环中引用', actionType: 'browser.text', params: { selector: '@target' } },
      ] },
    ];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    const migrated = state.workflow();
    const rootElements = migrated.elements;
    const local = migrated.steps[1];
    const parent = migrated.steps[2]; const nested = parent.children![0];
    expect(resolveValue(rootElements.target, migrated.variables)).toEqual({ selector: '[data-customer="跨语言订单"]' });
    expect(resolveValue({ ...rootElements, ...local.elements }.target, { ...migrated.variables, ...local.variables })).toEqual({ selector: '[data-customer="局部客户"]' });
    expect(resolveValue({ ...rootElements, ...parent.elements, ...nested.elements }.target, { ...migrated.variables, ...nested.variables })).toEqual({ selector: '#ancestor-嵌套客户' });
    const loopRead = migrated.steps[3].children![0];
    expect(resolveValue({ ...rootElements, ...loopRead.elements }.target, { ...migrated.variables, customer: '循环客户' })).toEqual({ selector: '[data-customer="循环客户"]' });
  });

  it('仅写入局部同名变量与循环项不会把旧默认识别为全局业务变量', async () => {
    const workflow = legacyDemo();
    workflow.steps = [
      { stepId: 'local', name: '局部写入', actionType: 'control.if', variables: { customer: '局部客户' }, params: { left: true, operator: 'truthy' }, children: [
        { stepId: 'local-write', name: '写局部', actionType: 'variables.set', params: { name: 'customer', value: '局部已改' }, output: 'customer' },
      ] },
      { stepId: 'loop', name: '循环项写入', actionType: 'control.forEach', params: { items: ['循环客户'], itemVariable: 'customer' }, children: [
        { stepId: 'item-write', name: '写循环项', actionType: 'variables.set', params: { name: 'customer', value: '循环已改' }, output: 'customer' },
      ] },
      { stepId: 'after', name: '读取旧常量', actionType: 'core.log', params: { message: '{{customer}}' }, output: 'after' },
    ];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({});
    const result = await new WorkflowEngine(state.workflow(), { dataDir: tmpdir(), runId: 'migration-shadow' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ after: '跨语言订单' });
  });

  it('已成为业务变量的示例网址只更新原本地根地址，保留初值引用和显式写入', async () => {
    const workflow = legacyDemo();
    workflow.steps = [
      { stepId: 'read', name: '读取旧地址', actionType: 'core.log', params: { message: '{{demoUrl}}' }, output: 'before' },
      { stepId: 'write', name: '业务写入', actionType: 'variables.set', params: { name: 'demoUrl', value: 'https://example.com' } },
    ];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables).toEqual({ demoUrl: currentUrl });
    expect(state.workflow().steps[0].params.message).toBe('{{demoUrl}}');
    const result = await new WorkflowEngine(state.workflow(), { dataDir: tmpdir(), runId: 'migration-business-url' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ before: currentUrl, demoUrl: 'https://example.com' });
  });

  it('动态设置变量名可能写入同名全局值时，保守保留初值及后续动态读取', async () => {
    const workflow = legacyDemo(); workflow.variables.targetName = 'customer';
    workflow.steps = [
      { stepId: 'before', name: '读取初值', actionType: 'core.log', params: { message: '{{customer}}' }, output: 'before' },
      { stepId: 'write', name: '动态写入', actionType: 'variables.set', params: { name: '{{targetName}}', value: '动态客户' } },
      { stepId: 'after', name: '读取写入值', actionType: 'core.log', params: { message: '{{customer}}' }, output: 'after' },
    ];
    const state = workspace(workflow); await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().variables.customer).toBe('跨语言订单');
    const result = await new WorkflowEngine(state.workflow(), { dataDir: tmpdir(), runId: 'migration-dynamic-name' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toMatchObject({ before: '跨语言订单', customer: '动态客户', after: '动态客户' });
  });

  it('只刷新原示例打开步骤的本地根地址，其它本地网页保持原样', async () => {
    const workflow = createDemoWorkflow(oldUrl, tmpdir());
    workflow.steps.push({ stepId: 'other', name: '自定义本地网页', actionType: 'browser.open', params: { url: oldUrl } });
    const state = workspace(workflow);
    await refreshDemoUrls(state.manager, currentUrl);
    expect(state.workflow().steps[0].params.url).toBe(currentUrl);
    expect(state.workflow().steps.at(-1)!.params.url).toBe(oldUrl);
    const pathWorkflow = createDemoWorkflow(`${oldUrl}/custom`, tmpdir());
    const pathState = workspace(pathWorkflow);
    await refreshDemoUrls(pathState.manager, currentUrl);
    expect(pathState.saveWorkflow).not.toHaveBeenCalled();
  });
});
