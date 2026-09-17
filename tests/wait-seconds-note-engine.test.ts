import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getAction, validateActionParams } from '../packages/actions/src/index.js';
import type { RunEvent, StepDefinition, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const directories: string[] = [];
const runners: WorkflowEngine[] = [];
const after: StepDefinition = { stepId: 'after', name: '继续执行', actionType: 'variables.set', params: { name: 'continued', value: true } };
async function engine(steps: StepDefinition[], variables: WorkflowDefinition['variables'] = {}, onEvent?: (event: RunEvent) => void) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-wait-seconds-note-')); directories.push(dataDir);
  const runner = new WorkflowEngine({
    schemaVersion: 1, workflowId: 'wait-seconds-note', name: '秒数等待与备注', revision: 1, variables, elements: {},
    settings: { downloadDir: dataDir, headless: true }, steps,
  }, { dataDir, runId: 'wait-seconds-note-run', onEvent });
  runners.push(runner);
  return runner;
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map(runner => runner.control('stop')));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-wait-seconds-note-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

describe('等待以秒为单位', () => {
  it('新建指令默认 3 秒，字段与描述仅使用秒', () => {
    const action = getAction('core.wait').metadata;
    expect(action.defaults).toEqual({ durationSeconds: 3 });
    expect(action.fields).toEqual([{ key: 'durationSeconds', label: '等待时长（秒）', type: 'number', required: true, placeholder: '3' }]);
    expect(action.description).not.toMatch(/毫秒|durationMs/);
  });

  it('接受 0～3600 秒的小数，不再接受毫秒配置', () => {
    for (const durationSeconds of [0, 0.0001, 0.5, 3, 3600]) {
      expect(validateActionParams('core.wait', { durationSeconds })).toEqual({ durationSeconds });
    }
    for (const durationSeconds of [-1, 3600.001, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expect(() => validateActionParams('core.wait', { durationSeconds })).toThrow('等待');
    }
    expect(() => validateActionParams('core.wait', { durationMs: 1000 })).toThrow('等待时长（秒）');
  });

  it.each([0.25, 3, 31])('%s 秒确实按秒计时，输出也只包含秒数', async durationSeconds => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const runner = await engine([
      { stepId: 'wait', name: '等待', actionType: 'core.wait', params: durationSeconds === 3 ? getAction('core.wait').metadata.defaults : { durationSeconds }, output: 'result' }, after,
    ], {}, event => { if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = runner.run();
    await waiting;
    await vi.advanceTimersByTimeAsync(durationSeconds * 1000 - 1);
    expect(runner.getSnapshot().variables).not.toHaveProperty('continued');
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ result: { durationSeconds }, continued: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('引用数字变量也按秒等待', async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const runner = await engine([
      { stepId: 'wait', name: '等待变量', actionType: 'core.wait', params: { durationSeconds: '{{delay}}' }, output: 'result' }, after,
    ], { delay: 0.125 }, event => { if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = runner.run();
    await waiting;
    await vi.advanceTimersByTimeAsync(124);
    expect(runner.getSnapshot().variables).not.toHaveProperty('continued');
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ delay: 0.125, result: { durationSeconds: 0.125 }, continued: true });
  });

  it('停止取消秒数等待，清除定时器且不执行后续步骤', async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const runner = await engine([
      { stepId: 'wait', name: '等待', actionType: 'core.wait', params: { durationSeconds: 3600 } }, after,
    ], {}, event => { if (event.type === 'step' && event.stepId === 'wait' && event.status === 'running') started(); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runner.run();
    await waiting;
    await runner.control('stop');
    const result = await pending;
    expect(result.status).toBe('stopped');
    expect(result.variables).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('显式超时仍限制等待，错误提示使用秒', async () => {
    const result = await (await engine([
      { stepId: 'wait', name: '等待', actionType: 'core.wait', params: { durationSeconds: 3 }, timeoutMs: 100 }, after,
    ])).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('等待超时（0.1 秒）');
    expect(result.variables).toEqual({});
  });
});

describe('备注为纯说明', () => {
  it('备注默认空文本和黄色，支持多行及六位十六进制颜色', () => {
    const action = getAction('core.note').metadata;
    expect(action).toMatchObject({ label: '备注', category: '流程控制', safeToRetry: true, defaults: { text: '', color: '#FFE08A' } });
    expect(validateActionParams('core.note', { text: '' })).toEqual({ text: '', color: '#FFE08A' });
    expect(validateActionParams('core.note', { text: '第一行\n第二行', color: '#aBc123' })).toEqual({ text: '第一行\n第二行', color: '#aBc123' });
    for (const color of ['red', '#fff', 'FFE08A', '#12345678', '#12xz89']) {
      expect(() => validateActionParams('core.note', { text: '说明', color })).toThrow('颜色');
    }
  });

  it('正文保持字面量，不读取变量、不打印日志、不启动浏览器，且忽略输出绑定', async () => {
    const events: RunEvent[] = [];
    const note = '请检查 {{missing}}\n已知变量 {{value}} 也保持原文';
    const runner = await engine([
      { stepId: 'note', name: '备注', actionType: 'core.note', params: { text: note, color: '#FFE08A' }, output: 'value' }, after,
    ], { value: '原值' }, event => events.push(event));
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ value: '原值', continued: true });
    expect(result.browserOpen).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(events.filter(event => event.type === 'log')).toEqual([]);
    expect(events.find(event => event.type === 'step' && event.stepId === 'note' && event.status === 'succeeded')?.data).toMatchObject({ result: null });
    expect(runner.workflow.steps[0].params.text).toBe(note);
  });

  it('空备注也直接完成，不创建导入配置中的输出变量', async () => {
    const result = await (await engine([
      { stepId: 'note', name: '备注', actionType: 'core.note', params: { text: '' }, output: 'unwanted' },
    ])).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({});
    expect(result.browserOpen).toBe(false);
  });
});
