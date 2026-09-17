import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const directories: string[] = [];
function logStep(message: unknown, stepId = 'print'): StepDefinition {
  return { stepId, name: '打印日志', actionType: 'core.log', params: { message } };
}
function flow(steps: StepDefinition[], variables: WorkflowDefinition['variables'] = {}): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'log-flow', name: '日志流程', revision: 1, variables, elements: {}, settings: { downloadDir: tmpdir(), headless: true, keepBrowserOpen: false }, steps };
}
async function engine(workflow: WorkflowDefinition, onEvent?: (event: RunEvent) => void) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-log-action-'));
  directories.push(dataDir);
  const events: RunEvent[] = [];
  const runner = new WorkflowEngine(workflow, { dataDir, runId: 'log-run', onEvent: event => { events.push(event); onEvent?.(event); } });
  return { runner, events };
}
function printed(events: RunEvent[]) {
  return events.filter(event => event.type === 'log' && event.stepId === 'print');
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('打印日志指令', () => {
  it('保留普通文本和换行，日志关联步骤且输出变量保留原值', async () => {
    const text = '第一行日志\n第二行日志';
    const { runner, events } = await engine(flow([{ ...logStep(text), output: 'printedText' }]));
    const result = await runner.run();
    expect(result.status).toBe('succeeded');
    expect(result.browserOpen).toBe(false);
    expect(result.variables.printedText).toBe(text);
    expect(printed(events)).toEqual([expect.objectContaining({ runId: 'log-run', message: text, data: { value: text } })]);
  });

  it('读取前序步骤产生的变量并支持文字内插值', async () => {
    const { runner, events } = await engine(flow([
      { stepId: 'prepare', name: '产生订单', actionType: 'variables.set', params: { name: 'order', value: { id: 101, paid: false } }, output: 'previousResult' },
      logStep('订单 {{previousResult.id}}，已支付：{{order.paid}}；详情：{{order}}'),
    ]));
    expect((await runner.run()).status).toBe('succeeded');
    expect(printed(events).map(event => event.message)).toEqual(['订单 101，已支付：false；详情：{"id":101,"paid":false}']);
  });

  it.each([
    { name: '数值零', value: 0, message: '0' },
    { name: '布尔值 false', value: false, message: 'false' },
    { name: 'null', value: null, message: 'null' },
    { name: '对象', value: { id: 101, nested: { ok: true } }, message: '{"id":101,"nested":{"ok":true}}' },
    { name: '列表', value: [1, false, null, { id: 2 }], message: '[1,false,null,{"id":2}]' },
    { name: '空文本', value: '', message: '（空文本）' },
  ])('完整引用 $name 时可见地打印，保留日志数据和输出类型', async ({ value, message }) => {
    const { runner, events } = await engine(flow([{ ...logStep('{{value}}'), output: 'copied' }], { value }));
    const result = await runner.run();
    expect(result.status).toBe('succeeded');
    expect(result.variables.copied).toEqual(value);
    expect(printed(events)).toEqual([expect.objectContaining({ message, data: { value } })]);
  });

  it.each([false, true])('循环按顺序打印每一项，退出时恢复当前项作用域（已有变量：%s）', async hadItem => {
    const items = [1, false, null, { id: 4 }];
    const { runner, events } = await engine(flow([
      { stepId: 'loop', name: '遍历列表', actionType: 'control.forEach', params: { items, itemVariable: 'item' }, children: [logStep('{{item}}')] },
    ], hadItem ? { item: 'outer' } : {}));
    const result = await runner.run();
    expect(result.status).toBe('succeeded');
    expect(printed(events).map(event => event.message)).toEqual(['1', 'false', 'null', '{"id":4}']);
    expect(printed(events).map(event => event.data)).toEqual(items.map(value => ({ value })));
    if (hadItem) expect(result.variables.item).toBe('outer');
    else expect(result.variables).not.toHaveProperty('item');
  });

  it('引用缺失变量时失败，不打印模板文本或执行后续步骤', async () => {
    const { runner, events } = await engine(flow([logStep('当前项：{{missing}}'), logStep('不可打印', 'after')]));
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('找不到变量：missing');
    expect(events.filter(event => event.type === 'log')).toEqual([]);
    expect(events.some(event => event.stepId === 'after')).toBe(false);
  });

  it('缺失日志内容参数时失败，但直接传入的 false、0 和 null 均可打印', async () => {
    const invalid = await engine(flow([{ ...logStep(''), params: {} }]));
    expect((await invalid.runner.run()).status).toBe('failed');
    expect(printed(invalid.events)).toEqual([]);
    const valid = await engine(flow([logStep(false), logStep(0, 'zero'), logStep(null, 'null')]));
    expect((await valid.runner.run()).status).toBe('succeeded');
    expect(valid.events.filter(event => event.type === 'log').map(event => event.message)).toEqual(['false', '0', 'null']);
  });

  it('单步打印不需要浏览器，也不执行相邻步骤', async () => {
    const { runner, events } = await engine(flow([
      logStep('前面不执行', 'before'), logStep('当前值：{{value}}'), logStep('后面不执行', 'after'),
    ], { value: 42 }));
    const result = await runner.runSingleStep('print');
    expect(result).toMatchObject({ status: 'succeeded', stepId: 'print', browserOpen: false });
    expect(printed(events).map(event => event.message)).toEqual(['当前值：42']);
    expect(events.filter(event => event.type === 'step').every(event => event.stepId === 'print')).toBe(true);
  });

  it('循环收到停止请求后不再打印，并恢复外层当前项变量', async () => {
    let runner: WorkflowEngine;
    const execution = await engine(flow([
      { stepId: 'loop', name: '遍历列表', actionType: 'control.forEach', params: { items: [1, 2, 3], itemVariable: 'item' }, children: [logStep('{{item}}')] },
    ], { item: 'outer' }), event => {
      if (event.type === 'log' && event.stepId === 'print') void runner.control('stop');
    });
    runner = execution.runner;
    const result = await runner.run();
    expect(result.status).toBe('stopped');
    expect(result.variables.item).toBe('outer');
    expect(printed(execution.events).map(event => event.message)).toEqual(['1']);
  });

  it('打印后暂停的循环可停止，未执行的项不会继续打印', async () => {
    let runner: WorkflowEngine;
    const execution = await engine(flow([
      { stepId: 'loop', name: '遍历列表', actionType: 'control.forEach', params: { items: [1, 2, 3], itemVariable: 'item' }, children: [logStep('{{item}}')] },
    ]), event => {
      if (event.type === 'log' && event.stepId === 'print') void runner.control('pause');
      if (event.type === 'run' && event.status === 'paused') void runner.control('stop');
    });
    runner = execution.runner;
    const result = await runner.run();
    expect(result.status).toBe('stopped');
    expect(result.variables).not.toHaveProperty('item');
    expect(execution.events.some(event => event.type === 'run' && event.status === 'paused')).toBe(true);
    expect(printed(execution.events).map(event => event.message)).toEqual(['1']);
  });
});
