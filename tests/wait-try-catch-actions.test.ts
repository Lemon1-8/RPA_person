import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { actionDefinitions, validateActionParams, validateActions } from '../packages/actions/src/index.js';
import { findStepPath, workflowSchema, type StepDefinition, type WorkflowDefinition } from '../packages/contracts/src/index.js';

const workflow = (steps: StepDefinition[]): WorkflowDefinition => ({
  schemaVersion: 1, workflowId: 'controls', name: '流程控制', revision: 1,
  variables: {}, elements: {}, steps, settings: { downloadDir: tmpdir(), headless: true },
});
const wait = (stepId: string): StepDefinition => ({ stepId, name: '等待', actionType: 'core.wait', params: { durationSeconds: 0 } });
const block = (): StepDefinition => ({
  stepId: 'try', name: 'Try / Catch', actionType: 'control.tryCatch', params: { errorVariable: 'error' },
  children: [wait('normal')], elseSteps: [wait('recovery')],
});

describe('等待与 Try / Catch 指令契约', () => {
  it('将两个新指令加入流程控制指令库，默认参数可执行', () => {
    for (const [type, label, defaults, safeToRetry] of [
      ['core.wait', '等待', { durationSeconds: 3 }, true],
      ['control.tryCatch', 'Try / Catch', { errorVariable: 'error' }, false],
    ] as const) {
      const action = actionDefinitions.find(action => action.type === type);
      expect(action).toMatchObject({ label, category: '流程控制', defaults, safeToRetry });
      expect(validateActionParams(type, { ...defaults })).toEqual(defaults);
    }
  });

  it('等待接受零到一小时的秒数（含小数），拒绝无效时长及旧毫秒参数', () => {
    for (const durationSeconds of [0, 0.001, 0.5, 3, 3600]) {
      expect(validateActionParams('core.wait', { durationSeconds })).toEqual({ durationSeconds });
    }
    for (const durationSeconds of [undefined, null, -1, 3600.001, NaN, Infinity, '3', {}, []]) {
      expect(() => validateActionParams('core.wait', { durationSeconds })).toThrow('等待时长（秒）');
    }
    expect(() => validateActionParams('core.wait', { durationMs: 3000 })).toThrow('等待时长（秒）');
  });

  it('异常变量允许中文名称并阻止不可引用或保留的名称', () => {
    for (const errorVariable of ['error', '异常', 'requestError']) {
      expect(validateActionParams('control.tryCatch', { errorVariable })).toEqual({ errorVariable });
    }
    for (const errorVariable of [undefined, null, 1, '', ' ', ' error', 'error ', '{{error}}', '__proto__', 'prototype', 'constructor']) {
      expect(() => validateActionParams('control.tryCatch', { errorVariable })).toThrow('异常变量');
    }
  });

  it('Try 和 Catch 沿用现有嵌套格式，能校验、保存和定位分支步骤', () => {
    const flow = workflow([block()]);
    expect(() => validateActions(flow)).not.toThrow();
    const saved = workflowSchema.parse(JSON.parse(JSON.stringify(flow)));
    expect(saved).toEqual(flow);
    expect(findStepPath(saved, 'recovery')?.map(step => step.stepId)).toEqual(['try', 'recovery']);
    expect(findStepPath(saved, 'normal')?.map(step => step.stepId)).toEqual(['try', 'normal']);
    const nested = block();
    nested.elseSteps!.push({ ...block(), stepId: 'inner', children: [wait('inner-normal')], elseSteps: [wait('inner-catch')] });
    expect(() => validateActions(workflowSchema.parse(workflow([nested])))).not.toThrow();
  });

  it('不能自动重试整个 Try / Catch，也不能给等待添加分支', () => {
    expect(() => validateActions(workflow([{ ...block(), retry: { maxAttempts: 2, delayMs: 0 } }]))).toThrow('不允许自动重试');
    expect(() => validateActions(workflow([{ ...block(), onError: 'pause' }]))).toThrow('仅支持读取和校验动作失败后暂停');
    expect(() => validateActions(workflow([{ ...wait('wait'), children: [wait('nested')] }]))).toThrow('不是容器动作');
    expect(() => validateActions(workflow([{ ...block(), elseSteps: [{ stepId: 'bad', name: '未知', actionType: 'missing', params: {} }] }]))).toThrow('不支持的动作');
  });

  it('Catch 分支内仍检查重复标识和无效重试', () => {
    const duplicate = block();
    duplicate.elseSteps = [wait('normal')];
    expect(() => workflowSchema.parse(workflow([duplicate]))).toThrow('重复步骤标识');
    const unsafe = block();
    unsafe.elseSteps = [{ stepId: 'click', name: '点击', actionType: 'browser.click', params: { selector: '#button' }, retry: { maxAttempts: 2, delayMs: 0 } }];
    expect(() => validateActions(workflow([unsafe]))).toThrow('不允许自动重试');
  });
});
