import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { RunEvent, StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const directories: string[] = [];
const runners: WorkflowEngine[] = [];
const failure: StepDefinition = { stepId: 'failure', name: '失败校验', actionType: 'core.assert', params: { actual: 1, expected: 2 } };
const after: StepDefinition = { stepId: 'after', name: '继续执行', actionType: 'variables.set', params: { name: 'continued', value: true } };
const capture: StepDefinition = { stepId: 'capture', name: '保存异常', actionType: 'variables.set', params: { name: 'captured', value: '{{error}}' } };
function wait(durationMs: number, overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { stepId: 'wait', name: '等待', actionType: 'core.wait', params: { durationSeconds: durationMs / 1000 }, ...overrides };
}
function tryCatch(children: StepDefinition[], elseSteps: StepDefinition[] = [capture], overrides: Partial<StepDefinition> = {}): StepDefinition {
  return { stepId: 'try', name: '尝试与捕获', actionType: 'control.tryCatch', params: { errorVariable: 'error' }, children, elseSteps, ...overrides };
}
async function engine(steps: StepDefinition[], variables: WorkflowDefinition['variables'] = {}, onEvent?: (event: RunEvent) => void) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-wait-try-catch-')); directories.push(dataDir);
  const runner = new WorkflowEngine({
    schemaVersion: 1, workflowId: 'wait-try-catch', name: '等待与异常捕获', revision: 1, variables, elements: {},
    settings: { downloadDir: dataDir, headless: true }, steps,
  }, { dataDir, runId: 'wait-try-catch-run', onEvent });
  runners.push(runner);
  return runner;
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.control('stop')));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-wait-try-catch-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

describe('固定时间等待', () => {
  it.each([1000, 31_000])('等待 %i 毫秒后才继续，长等待不受默认 30 秒截断', async durationMs => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const runner = await engine([
      wait(durationMs, { output: 'waitResult' }), after,
    ], {}, event => { if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = runner.run();
    await waiting;
    await vi.advanceTimersByTimeAsync(durationMs - 1);
    expect(runner.getSnapshot().variables).not.toHaveProperty('continued');
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ waitResult: { durationSeconds: durationMs / 1000 }, continued: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('支持零时长与变量引用，不启动浏览器', async () => {
    const result = await (await engine([wait(0, { params: { durationSeconds: '{{delay}}' }, output: 'waitResult' }), after], { delay: 0 })).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ delay: 0, waitResult: { durationSeconds: 0 }, continued: true });
    expect(result.browserOpen).toBe(false);
  });

  it('显式步骤超时提前结束等待，不执行后续步骤', async () => {
    const result = await (await engine([wait(10_000, { timeoutMs: 100 }), after])).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('等待超时');
    expect(result.variables).not.toHaveProperty('continued');
  });

  it('停止立即取消等待并清除定时器', async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const runner = await engine([wait(60_000), after], {}, event => {
      if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started();
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runner.run();
    await waiting;
    await runner.control('stop');
    const result = await pending;
    expect(result.status).toBe('stopped');
    expect(result.variables).not.toHaveProperty('continued');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Try / Catch 执行与异常作用域', () => {
  it('单独运行 Try / Catch 会处理异常，单独运行内部指令不会隐式执行容器', async () => {
    const steps = [tryCatch([failure]), after];
    const selectedContainer = await (await engine(steps)).runSingleStep('try');
    expect(selectedContainer.status, selectedContainer.error).toBe('succeeded');
    expect(selectedContainer.variables.captured).toMatchObject({ stepId: 'failure' });
    expect(selectedContainer.variables).not.toHaveProperty('continued');
    const selectedChild = await (await engine(steps)).runSingleStep('failure');
    expect(selectedChild.status).toBe('failed');
    expect(selectedChild.variables).not.toHaveProperty('captured');
    const selectedCatch = await (await engine(steps)).runSingleStep('capture');
    expect(selectedCatch.status).toBe('failed');
    expect(selectedCatch.error).toContain('找不到变量：error');
  });

  it('Try 成功时跳过 Catch，返回未捕获并继续执行', async () => {
    const result = await (await engine([tryCatch([wait(0)], [capture], { output: 'tryResult' }), after], { error: '原值' })).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ error: '原值', tryResult: { caught: false }, continued: true });
  });

  it('重试耗尽后进入 Catch，优先于人工暂停，并暴露原始失败步骤信息', async () => {
    const events: RunEvent[] = [];
    const runner = await engine([
      tryCatch([{ ...failure, retry: { maxAttempts: 3, delayMs: 0 }, onError: 'pause' }, { ...after, stepId: 'skipped', params: { name: 'skipped', value: true } }], [capture], { output: 'tryResult' }), after,
    ], {}, event => {
      events.push(event);
      if (event.status === 'waiting_manual') void runner.control('stop');
    });
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.error).toBeUndefined();
    expect(result.variables).toEqual({
      captured: { message: '结果校验失败：期望 2，实际 1', stepId: 'failure', stepName: '失败校验', actionType: 'core.assert' },
      tryResult: { caught: true }, continued: true,
    });
    expect(events.filter(event => event.type === 'step' && event.stepId === 'failure' && event.status === 'running').map(event => event.data)).toEqual([
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ attempt: 3 }),
    ]);
    expect(events.some(event => event.status === 'waiting_manual')).toBe(false);
  });

  it('空 Catch 也能处理错误，默认错误变量在退出后删除', async () => {
    const result = await (await engine([tryCatch([failure], [], { output: 'tryResult' }), after])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.error).toBeUndefined();
    expect(result.variables).toEqual({ tryResult: { caught: true }, continued: true });
  });

  it('错误变量仅在 Catch 内覆盖，局部声明与原有全局值均恢复', async () => {
    const result = await (await engine([
      tryCatch([
        { stepId: 'try-read', name: 'Try 中读取原值', actionType: 'core.assert', params: { actual: '{{error}}', expected: '容器局部值' } }, failure,
      ], [capture, { stepId: 'mutate', name: '改写错误变量', actionType: 'variables.set', params: { name: 'error', value: '修改值' } }], { variables: { error: '容器局部值' } }),
      { stepId: 'outside', name: '恢复全局值', actionType: 'core.assert', params: { actual: '{{error}}', expected: { original: true } } },
    ], { error: { original: true } })).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.error).toEqual({ original: true });
    expect(result.variables.captured).toMatchObject({ stepId: 'failure' });
  });

  it('自定义错误变量支持捕获参数解析失败，并保留叶步骤信息', async () => {
    const result = await (await engine([
      tryCatch([wait(0, { params: { durationSeconds: '{{missing}}' } })], [{ ...capture, params: { name: 'captured', value: '{{problem}}' } }], { params: { errorVariable: 'problem' } }),
    ])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.captured).toEqual({ message: '找不到变量：missing', stepId: 'wait', stepName: '等待', actionType: 'core.wait' });
    expect(result.variables).not.toHaveProperty('problem');
  });

  it('嵌套条件与循环中的失败保留原始叶步骤信息', async () => {
    const result = await (await engine([tryCatch([{
      stepId: 'condition', name: '条件容器', actionType: 'control.if', params: { left: true, operator: 'truthy' }, children: [{
        stepId: 'loop', name: '循环容器', actionType: 'control.forEach', params: { items: [1], itemVariable: 'item' }, children: [failure],
      }],
    }])])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.captured).toEqual({ message: '结果校验失败：期望 2，实际 1', stepId: 'failure', stepName: '失败校验', actionType: 'core.assert' });
    expect(result.variables).not.toHaveProperty('item');
  });

  it('Catch 自身失败向外传播，恢复原错误变量且不执行后续步骤', async () => {
    const events: RunEvent[] = [];
    const runner = await engine([
      tryCatch([failure], [{ ...failure, stepId: 'catch-failure', name: 'Catch 失败', onError: 'pause' }]), after,
    ], { error: '原值' }, event => {
      events.push(event);
      if (event.status === 'waiting_manual') void runner.control('stop');
    });
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Catch 失败');
    expect(result.variables).toEqual({ error: '原值' });
    expect(events.some(event => event.status === 'waiting_manual')).toBe(false);
  });

  it('外层 Try 可捕获内层 Catch 的失败', async () => {
    const result = await (await engine([
      tryCatch([tryCatch([failure], [{ ...failure, stepId: 'inner-catch-failure', name: '内部处理失败' }], { stepId: 'inner-try' })]), after,
    ])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.captured).toMatchObject({ stepId: 'inner-catch-failure', stepName: '内部处理失败', actionType: 'core.assert' });
    expect(result.variables).not.toHaveProperty('error');
    expect(result.variables.continued).toBe(true);
  });

  it('Catch 中嵌套的 Try 使用同名错误变量时会恢复外层错误', async () => {
    const result = await (await engine([tryCatch([failure], [
      tryCatch([{ ...failure, stepId: 'inner-failure' }], [{ ...capture, stepId: 'inner-capture', params: { name: 'innerError', value: '{{error}}' } }], { stepId: 'inner-try' }),
      capture,
    ])], { error: '全局值' })).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.innerError).toMatchObject({ stepId: 'inner-failure' });
    expect(result.variables.captured).toMatchObject({ stepId: 'failure' });
    expect(result.variables.error).toBe('全局值');
  });
});

describe('Try / Catch 的超时与停止边界', () => {
  it('可以捕获子等待步骤自身的超时', async () => {
    const result = await (await engine([tryCatch([wait(10_000, { timeoutMs: 100 })]), after])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.captured).toMatchObject({ stepId: 'wait', message: expect.stringContaining('等待超时') });
    expect(result.variables.continued).toBe(true);
  });

  it.each(['self', 'ancestor'] as const)('%s 容器期限耗尽不得由 Catch 吞掉', async mode => {
    const guarded = tryCatch([wait(10_000)], [capture], mode === 'self' ? { timeoutMs: 100 } : {});
    const steps = mode === 'self' ? [guarded, after] : [{ stepId: 'parent', name: '限时父容器', actionType: 'control.if', params: { left: true, operator: 'truthy' }, timeoutMs: 100, children: [guarded] }, after];
    const result = await (await engine(steps)).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('容器步骤超时');
    expect(result.variables).toEqual({});
  });

  it.each(['control.if', 'control.forEach', 'control.tryCatch'])('内部 %s 的独立期限耗尽可由仍有期限的外层 Catch 处理', async actionType => {
    const inner: StepDefinition = {
      stepId: 'limited', name: '短时限内部容器', actionType, timeoutMs: 100,
      params: actionType === 'control.if' ? { left: true, operator: 'truthy' } : actionType === 'control.forEach' ? { items: [1], itemVariable: 'item' } : { errorVariable: 'error' },
      children: [wait(10_000)],
    };
    if (actionType === 'control.tryCatch') inner.elseSteps = [{ stepId: 'inner-capture', name: '内部 Catch 不应执行', actionType: 'variables.set', params: { name: 'innerCaught', value: true } }];
    const result = await (await engine([tryCatch([inner], [capture], { timeoutMs: 2000 }), after])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.captured).toMatchObject({ stepId: 'wait', message: expect.stringContaining('短时限内部容器') });
    expect(result.variables).not.toHaveProperty('innerCaught');
    expect(result.variables.continued).toBe(true);
  });

  it('Catch 执行同样受容器总期限约束，失败时恢复错误变量', async () => {
    const result = await (await engine([tryCatch([failure], [capture, wait(10_000)], { timeoutMs: 100 }), after], { error: '原值' })).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('容器步骤超时');
    expect(result.variables.error).toBe('原值');
    expect(result.variables).not.toHaveProperty('continued');
  });

  it('重试等待受父期限限制，期限结束后不继续重试或执行 Catch', async () => {
    const events: RunEvent[] = [];
    const result = await (await engine([
      tryCatch([{ ...failure, retry: { maxAttempts: 3, delayMs: 10_000 } }], [capture], { timeoutMs: 100 }), after,
    ], {}, event => events.push(event))).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('容器步骤超时');
    expect(result.variables).toEqual({});
    expect(events.filter(event => event.type === 'step' && event.stepId === 'failure' && event.status === 'running')).toHaveLength(1);
  });

  it.each(['try', 'catch'] as const)('停止 %s 中的等待不会被捕获或继续，错误变量仍恢复', async branch => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const steps = branch === 'try' ? [tryCatch([wait(60_000)]), after] : [tryCatch([failure], [wait(60_000), capture]), after];
    const runner = await engine(steps, { error: '原值' }, event => {
      if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started();
    });
    const pending = runner.run();
    await waiting;
    await runner.control('stop');
    const result = await pending;
    expect(result.status).toBe('stopped');
    expect(result.variables).toEqual({ error: '原值' });
  });

  it('重试间隔中的停止立即结束，不进入 Catch', async () => {
    const runner = await engine([tryCatch([{ ...failure, retry: { maxAttempts: 3, delayMs: 60_000 } }]), after], {}, event => {
      if (event.type === 'log' && event.message?.includes('准备第 2 次尝试')) void runner.control('stop');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await runner.run();
    expect(result.status).toBe('stopped');
    expect(result.variables).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });
});
