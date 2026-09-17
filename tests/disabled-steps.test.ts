import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { getControlStepErrors } from '../apps/desktop/src/renderer/ControlFlowFields.js';
import { getNoteStepErrors } from '../apps/desktop/src/renderer/NoteFields.js';
import { getBrowserPageErrors, getDeclaredPageAliases } from '../apps/desktop/src/renderer/page-options.js';
import { getVariableOptions } from '../apps/desktop/src/renderer/variable-options.js';
import { RunManager } from '../apps/runner/src/manager.js';
import { workflowSchema, type RunEvent, type StepDefinition, type WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

function flow(steps: StepDefinition[]): WorkflowDefinition {
  return {
    schemaVersion: 1, workflowId: 'disabled-steps', name: '指令注释', revision: 0,
    variables: { preserved: '原值' }, elements: {}, settings: { downloadDir: tmpdir(), headless: true }, steps,
  };
}
function engine(workflow: WorkflowDefinition, onEvent?: (event: RunEvent) => void) {
  return new WorkflowEngine(workflow, { dataDir: tmpdir(), runId: 'disabled-steps-run', onEvent });
}
const set = (stepId: string, value: unknown = true): StepDefinition => ({
  stepId, name: stepId, actionType: 'variables.set', params: { name: stepId, value },
});

describe('工作流指令注释', () => {
  it('注释指令跳过无效参数和缺失引用，不覆盖变量或输出，旧步骤与显式启用步骤正常执行', async () => {
    const events: RunEvent[] = [];
    const workflow = flow([
      { ...set('commented', '{{missing.value}}'), disabled: true, variables: { preserved: '局部值' }, output: 'preserved' },
      { stepId: 'invalid', name: '未配置的等待', actionType: 'core.wait', params: { durationSeconds: 'invalid' }, disabled: true },
      set('legacy', 1), { ...set('enabled', 2), disabled: false },
    ]);
    const result = await engine(workflow, event => events.push(event)).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toEqual({ preserved: '原值', legacy: 1, enabled: 2 });
    expect(events.filter(event => event.type === 'step').map(event => [event.stepId, event.status])).toEqual([
      ['commented', 'skipped'], ['invalid', 'skipped'], ['legacy', 'running'], ['legacy', 'succeeded'], ['enabled', 'running'], ['enabled', 'succeeded'],
    ]);
  });

  it('注释容器不解析条件、不执行任一分支，也不启动其超时计时', async () => {
    const events: RunEvent[] = [];
    const workflow = flow([
      {
        stepId: 'container', name: '注释容器', actionType: 'control.if', disabled: true, timeoutMs: 100,
        params: { left: '{{missing}}', operator: 'truthy' }, variables: { preserved: '局部值' }, output: 'preserved',
        settings: { pythonExecutable: 'does-not-exist.exe' },
        children: [{ stepId: 'wait', name: '不会等待', actionType: 'core.wait', params: { durationSeconds: 3600 } }],
        elseSteps: [{ stepId: 'fail', name: '不会失败', actionType: 'core.assert', params: { actual: 1, expected: 2 } }],
      },
      set('after', '{{preserved}}'),
    ]);
    const result = await engine(workflow, event => events.push(event)).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toEqual({ preserved: '原值', after: '原值' });
    expect(events.filter(event => event.type === 'step').map(event => event.stepId)).toEqual(['container', 'after', 'after']);
  });

  it('注释步骤不产生变量，后续依赖缺失值仍按正常失败路径报错', async () => {
    const result = await engine(flow([{ ...set('source', 42), disabled: true }, set('dependent', '{{source}}')])).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('找不到变量：source');
    expect(result.variables).toEqual({ preserved: '原值' });
  });

  it('连续跳过注释步骤时仍响应停止，不执行后续步骤', async () => {
    const events: RunEvent[] = [];
    const runner = engine(flow([
      ...Array.from({ length: 50 }, (_, index) => ({ ...set(`skip-${index}`), disabled: true })), set('after'),
    ]), event => {
      events.push(event);
      if (event.type === 'step' && event.status === 'skipped') void runner.control('stop');
    });
    const result = await runner.run();
    expect(result.status).toBe('stopped');
    expect(events.filter(event => event.type === 'step')).toHaveLength(1);
    expect(result.variables).toEqual({ preserved: '原值' });
  });

  it('跳过长等待后，活动容器的超时仍会限制后续未注释的等待', async () => {
    const result = await engine(flow([{
      stepId: 'container', name: '限时容器', actionType: 'control.if', timeoutMs: 100,
      params: { left: true, operator: 'truthy' }, children: [
        { stepId: 'skip', name: '跳过长等待', actionType: 'core.wait', disabled: true, params: { durationSeconds: 3600 } },
        { stepId: 'wait', name: '正常等待', actionType: 'core.wait', params: { durationSeconds: 1 } },
        set('after'),
      ],
    }])).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('容器步骤超时：限时容器');
    expect(result.variables).not.toHaveProperty('after');
  });

  it('执行器和管理器都拒绝单独运行已注释指令及注释容器的子步骤，且不创建运行', async () => {
    const workflow = flow([
      { ...set('direct'), disabled: true },
      {
        stepId: 'container', name: '注释条件', actionType: 'control.if', disabled: true,
        params: { left: true, operator: 'truthy' }, children: [set('child')], elseSteps: [set('otherwise')],
      }, set('enabled'),
    ]);
    const runner = engine(workflow);
    const manager = new RunManager({ dataDir: tmpdir(), autoStartSchedules: false });
    for (const stepId of ['direct', 'container', 'child', 'otherwise']) {
      expect(() => runner.runSingleStep(stepId)).toThrow('指令或所属容器已注释');
      expect(() => manager.runStep(workflow, stepId)).toThrow('指令或所属容器已注释');
    }
    expect(manager.listRuns()).toEqual([]);
    expect(runner.getSnapshot().status).toBe('queued');
    expect((await runner.runSingleStep('enabled')).variables.enabled).toBe(true);
  });

  it('流程结构只接受布尔注释状态，不改变旧步骤的默认执行语义', () => {
    const legacy = workflowSchema.parse(flow([set('legacy')]));
    expect(legacy.steps[0]).not.toHaveProperty('disabled');
    for (const disabled of ['true', 1, null]) {
      expect(() => workflowSchema.parse(flow([{ ...set('invalid'), disabled } as unknown as StepDefinition]))).toThrow();
    }
  });

  it('全流程参数校验忽略已注释节点与子树，恢复后继续检查原有错误', () => {
    const invalidSteps: StepDefinition[] = [
      { stepId: 'wait', name: '等待', actionType: 'core.wait', params: { durationSeconds: 'bad' } },
      { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: '' } },
      { stepId: 'note', name: '备注', actionType: 'core.note', params: { text: '', color: 'bad' } },
    ];
    const validators = [getControlStepErrors, getBrowserPageErrors, getNoteStepErrors];
    for (const validate of validators) {
      expect(validate(flow(invalidSteps))).toHaveLength(1);
      expect(validate(flow(invalidSteps.map(step => ({ ...step, disabled: true }))))).toEqual([]);
      const workflow = flow([{
        stepId: 'container', name: '容器', actionType: 'control.if', disabled: true,
        params: { left: true, operator: 'truthy' }, children: invalidSteps,
      }]);
      expect(validate(workflow)).toEqual([]);
      workflow.steps[0].disabled = false;
      expect(validate(workflow)).toHaveLength(1);
    }
  });

  it('后续变量及网页候选不包含注释步骤或容器产生的值，包括异常路径', () => {
    const workflow = flow([
      { ...set('disabledVariable'), disabled: true, output: 'disabledOutput' },
      { stepId: 'disabledPage', name: '注释网页', actionType: 'browser.open', disabled: true, params: { pageId: 'disabled-page' } },
      {
        stepId: 'try', name: '异常捕获', actionType: 'control.tryCatch', params: { errorVariable: 'error' }, children: [{
          stepId: 'container', name: '注释容器', actionType: 'control.if', disabled: true, output: 'containerOutput',
          params: { left: true, operator: 'truthy' }, children: [
            set('nestedVariable'),
            { stepId: 'nestedPage', name: '嵌套网页', actionType: 'browser.open', params: { pageId: 'nested-page' } },
          ],
        }], elseSteps: [set('catchStep')],
      },
      set('available'),
      { stepId: 'availablePage', name: '可用网页', actionType: 'browser.open', params: { pageId: 'available-page' } },
      set('after'),
    ]);
    const names = getVariableOptions(workflow, 'after').map(option => option.name);
    expect(names).toContain('available');
    for (const name of ['disabledVariable', 'disabledOutput', 'nestedVariable', 'containerOutput']) expect(names).not.toContain(name);
    const catchNames = getVariableOptions(workflow, 'catchStep').map(option => option.name);
    expect(catchNames).not.toContain('nestedVariable');
    expect(catchNames).not.toContain('containerOutput');
    expect(getDeclaredPageAliases(workflow)).toEqual(['available-page']);
  });
});
