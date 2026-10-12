import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

export function makeWorkflow(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'test-flow', name: '测试流程', revision: 1, variables: {}, elements: {}, settings: { downloadDir: tmpdir(), headless: true }, steps };
}
describe('流程公共执行接口', () => {
  it('保留跨步骤 JSON 类型并将结果绑定到输出变量', async () => {
    const workflow = makeWorkflow([
      { stepId: 'set', name: '设置列表', actionType: 'variables.set', params: { name: 'orders', value: [{ id: 101 }] } },
      { stepId: 'copy', name: '复制列表', actionType: 'variables.set', params: { name: 'copied', value: '{{orders}}' }, output: 'result' },
      { stepId: 'check', name: '校验', actionType: 'core.assert', params: { actual: '{{copied.0.id}}', expected: 101 } },
    ]);
    const events: RunEvent[] = [];
    const engine = new WorkflowEngine(workflow, { dataDir: await mkdtemp(join(tmpdir(), 'rpa-engine-')), runId: 'test-run', onEvent: event => events.push(event) });
    const result = await engine.run();
    expect(result.status).toBe('succeeded');
    expect(result.variables.copied).toEqual([{ id: 101 }]);
    expect(events.filter(event => event.stepId === 'set').every(event => event.stepName === '设置列表')).toBe(true);
  });
  it('纯计算循环也接收停止请求，不能阻塞控制消息', async () => {
    const workflow = makeWorkflow([{ stepId: 'loop', name: '遍历', actionType: 'control.forEach', params: { items: Array.from({ length: 10000 }, (_, i) => i), itemVariable: 'item' }, children: [{ stepId: 'copy', name: '复制', actionType: 'variables.set', params: { name: 'last', value: '{{item}}' } }] }]);
    let sent = false;
    const engine = new WorkflowEngine(workflow, { dataDir: await mkdtemp(join(tmpdir(), 'rpa-stop-')), runId: 'stop-run', onEvent: event => {
      if (event.type === 'step' && !sent) { sent = true; setTimeout(() => { void engine.control('stop'); }, 0); }
    } });
    expect((await engine.run()).status).toBe('stopped');
  });
  it('条件与循环的超时约束整个容器，包括脚本子步骤', async () => {
    const flow = makeWorkflow([{ stepId: 'loop', name: '限时循环', actionType: 'control.forEach', timeoutMs: 100, params: { items: [1, 2], itemVariable: 'item' }, children: [{ stepId: 'sleep', name: '等待脚本', actionType: 'script.run', params: { language: 'javascript', code: 'await new Promise(resolve => setTimeout(resolve, 150)); await rpa.output(1)' } }] }]);
    const engine = new WorkflowEngine(flow, { dataDir: await mkdtemp(join(tmpdir(), 'rpa-deadline-')), runId: 'deadline-run' });
    expect((await engine.run()).status).toBe('failed');
  });
  it('包含点号的完整变量名也可以被引用', async () => {
    const workflow = makeWorkflow([
      { stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'order.total', value: 42 } },
      { stepId: 'assert', name: '检查', actionType: 'core.assert', params: { actual: '{{order.total}}', expected: 42 } },
    ]);
    const engine = new WorkflowEngine(workflow, { dataDir: await mkdtemp(join(tmpdir(), 'rpa-variable-')), runId: 'variable-run' });
    expect((await engine.run()).status).toBe('succeeded');
  });
  it('指令可忽略失败并继续执行，失败不会进入 Try/Catch', async () => {
    const events: Array<{ stepId?: string; status?: string; data?: unknown }> = [];
    const workflow = makeWorkflow([
      { stepId: 'try', name: '异常容器', actionType: 'control.tryCatch', params: { errorVariable: 'error' }, children: [
        { stepId: 'optional', name: '可忽略校验', actionType: 'core.assert', params: { actual: 1, expected: 2 }, onError: 'continue' },
      ], elseSteps: [
        { stepId: 'catch', name: '不应执行', actionType: 'variables.set', params: { name: 'caught', value: true } },
      ] },
      { stepId: 'after', name: '继续', actionType: 'variables.set', params: { name: 'continued', value: true } },
    ]);
    const runner = new WorkflowEngine(workflow, {
      dataDir: await mkdtemp(join(tmpdir(), 'rpa-continue-')),
      runId: 'continue-run',
      onEvent: event => { if (event.type === 'step') events.push({ stepId: event.stepId, status: event.status, data: event.data }); },
    });
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.warningCount).toBe(1);
    expect(result.warnings?.[0]).toMatchObject({ stepId: 'optional' });
    expect(result.variables).toMatchObject({ continued: true });
    expect(result.variables).not.toHaveProperty('caught');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stepId: 'optional', status: 'failed', data: expect.objectContaining({ stepNumber: 2 }) }),
      expect.objectContaining({ stepId: 'after', status: 'succeeded', data: expect.objectContaining({ stepNumber: 4 }) }),
    ]));
  });
});
