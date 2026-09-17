import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowSchema, type WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine, type EngineOptions } from '../packages/engine/src/index.js';
import * as scripts from '../packages/scripts/src/index.js';

const browser = vi.hoisted(() => ({ call: vi.fn(), starts: vi.fn(), options: vi.fn() }));
vi.mock('../packages/browser/src/index.js', () => ({
  BrowserSession: class {
    private open = false;
    constructor(private options: Record<string, unknown>) { browser.options(options); }
    async start() { if (!this.open) { this.open = true; browser.starts(); } }
    isOpen() { return this.open; }
    onClosed() { return () => {}; }
    async close() { this.open = false; }
    async screenshot() { return undefined; }
    getInfo() { return { pageId: 'main', browserChannel: this.options.browserChannel === 'auto' || !this.options.browserChannel ? 'chrome' : this.options.browserChannel, debugPort: this.options.debugPort || 9223 }; }
    call(method: string, params: Record<string, unknown>) { return browser.call(method, params); }
  },
}));

const directories: string[] = [];
function workflow(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'scoped-flow', name: '步骤配置', revision: 1, variables: { value: 'global' }, elements: { target: { selector: '#global' } }, settings: { downloadDir: tmpdir(), headless: true, keepBrowserOpen: false, pythonExecutable: 'default-python' }, steps };
}
async function engine(flow: WorkflowDefinition, options: Partial<EngineOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-scope-'));
  directories.push(dataDir);
  return new WorkflowEngine(flow, { dataDir, runId: 'scope-run', ...options });
}
beforeEach(() => {
  browser.call.mockReset(); browser.options.mockClear(); browser.starts.mockClear();
  browser.call.mockImplementation(async (_method: string, params: Record<string, unknown>) => (params.element as { selector: string } | undefined)?.selector ?? null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('指令独立配置与作用域', () => {
  it('局部变量、元素和下载目录仅用于当前步骤，随后恢复流程默认值', async () => {
    const localDirectory = join(tmpdir(), 'local-downloads');
    const flow = workflow([
      { stepId: 'local', name: '当前指令', actionType: 'browser.download', variables: { value: 'local' }, elements: { target: { selector: '#{{value}}' } }, settings: { downloadDir: localDirectory }, params: { selector: '@target' } },
      { stepId: 'global', name: '下一指令', actionType: 'browser.download', params: { selector: '@target' } },
    ]);
    browser.call.mockImplementation(async (_method: string, params: Record<string, unknown>) => ({ path: join(String(params.directory), 'file.txt'), name: 'file.txt', size: 1 }));
    const result = await (await engine(flow)).run();
    expect(result.status).toBe('succeeded');
    expect(browser.call.mock.calls[0][1]).toMatchObject({ element: { selector: '#local' }, directory: localDirectory });
    expect(browser.call.mock.calls[1][1]).toMatchObject({ element: { selector: '#global' }, directory: tmpdir() });
    expect(result.variables.value).toBe('global');
    expect(flow.steps[0].variables?.value).toBe('local');
  });

  it('容器子步骤继承局部配置，子步骤覆盖后恢复父配置，循环项退出时恢复', async () => {
    const flow = workflow([
      { stepId: 'container', name: '条件', actionType: 'control.if', variables: { value: 'parent', item: 'parent-item' }, elements: { target: { selector: '#{{value}}' } }, settings: { downloadDir: join(tmpdir(), 'parent-downloads') }, params: { left: true, operator: 'truthy' }, children: [
        { stepId: 'nested', name: '局部覆盖', actionType: 'browser.text', variables: { value: 'child' }, params: { selector: '@target' }, output: 'childText' },
        { stepId: 'parent', name: '父级元素', actionType: 'browser.text', params: { selector: '@target' }, output: 'parentText' },
        { stepId: 'inherit', name: '清空覆盖后继承父级目录', actionType: 'browser.download', settings: { downloadDir: undefined }, params: { selector: '@target' } },
        { stepId: 'loop', name: '循环', actionType: 'control.forEach', params: { items: ['first', 'second'], itemVariable: 'item' }, children: [
          { stepId: 'item', name: '读循环项', actionType: 'variables.set', params: { name: 'lastItem', value: '{{item}}' } },
        ] },
        { stepId: 'check-item', name: '恢复循环项', actionType: 'core.assert', params: { actual: '{{item}}', expected: 'parent-item' } },
      ] },
      { stepId: 'outside', name: '外部元素', actionType: 'browser.text', params: { selector: '@target' }, output: 'outsideText' },
    ]);
    const result = await (await engine(flow)).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toMatchObject({ value: 'global', childText: '#child', parentText: '#parent', outsideText: '#global', lastItem: 'second' });
    expect(result.variables).not.toHaveProperty('item');
    expect(browser.call.mock.calls.find(([method]) => method === 'browser.download')?.[1]).toMatchObject({ directory: join(tmpdir(), 'parent-downloads') });
  });

  it('脚本 get/set 使用当前作用域，显式 output 在离开作用域后发布同名结果', async () => {
    const scriptSpy = vi.spyOn(scripts, 'runScript');
    const flow = workflow([
      { stepId: 'script', name: '局部脚本', actionType: 'script.run', variables: { value: 'local', scratch: 0 }, settings: { pythonExecutable: 'local-python' }, params: { language: 'javascript', code: `await rpa.set('scratch', 42); await rpa.set('shared', 'explicit'); await rpa.set('value', (await rpa.get('value')) + '-edited'); await rpa.output(await rpa.get('value'));` }, output: 'value' },
      { stepId: 'read', name: '后续脚本', actionType: 'script.run', params: { language: 'javascript', code: `await rpa.output(await rpa.get('value'));` }, output: 'later' },
    ]);
    const result = await (await engine(flow)).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toMatchObject({ value: 'local-edited', later: 'local-edited', shared: 'explicit' });
    expect(result.variables).not.toHaveProperty('scratch');
    expect(scriptSpy.mock.calls.map(([options]) => options.pythonExecutable)).toEqual(['local-python', 'default-python']);
  });

  it('失败重试使用新局部配置，重试等待与终态不泄漏局部变量', async () => {
    browser.call.mockRejectedValueOnce(new Error('暂未出现')).mockResolvedValueOnce('found');
    const snapshots: unknown[] = [];
    let runner: WorkflowEngine;
    runner = await engine(workflow([
      { stepId: 'retry', name: '重试读取', actionType: 'browser.text', variables: { value: 'local' }, elements: { target: { selector: '#{{value}}' } }, retry: { maxAttempts: 2, delayMs: 0 }, params: { selector: '@target' }, output: 'result' },
    ]), { onEvent: event => {
      if (event.type === 'step' && event.status === 'running' || event.type === 'log') snapshots.push(runner.getSnapshot().variables.value);
    } });
    const result = await runner.run();
    expect(result.status).toBe('succeeded');
    expect(snapshots).toEqual(['local', 'global', 'local']);
    expect(result.variables).toMatchObject({ value: 'global', result: 'found' });
  });

  it('失败脚本与父容器退出时恢复局部变量，不发布失败步骤的输出', async () => {
    const runner = await engine(workflow([
      { stepId: 'container', name: '父容器', actionType: 'control.if', variables: { value: 'parent' }, params: { left: true, operator: 'truthy' }, children: [
        { stepId: 'failure', name: '失败脚本', actionType: 'script.run', variables: { value: 'child', scratch: 1 }, params: { language: 'javascript', code: `await rpa.set('value', 'mutated'); await rpa.set('scratch', 2); throw new Error('expected failure');` }, output: 'result' },
      ] },
    ]));
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('expected failure');
    expect(result.variables.value).toBe('global');
    expect(result.variables).not.toHaveProperty('scratch');
    expect(result.variables).not.toHaveProperty('result');
  });

  it.each(['stop', 'timeout'] as const)('%s 恢复容器及脚本局部变量并阻止迟到输出', async mode => {
    let runner: WorkflowEngine;
    runner = await engine(workflow([
      { stepId: 'container', name: '父容器', actionType: 'control.if', variables: { value: 'parent' }, params: { left: true, operator: 'truthy' }, children: [
        { stepId: 'wait', name: '等待脚本', actionType: 'script.run', timeoutMs: mode === 'timeout' ? 300 : 10_000, variables: { value: 'child', scratch: 1 }, params: { language: 'javascript', code: `await rpa.set('value', 'changed'); console.log('scope-ready'); await new Promise(resolve => setTimeout(resolve, 10_000)); await rpa.output('late');` }, output: 'result' },
      ] },
    ]), { onEvent: event => {
      if (mode === 'stop' && event.type === 'log' && event.message === 'scope-ready') void runner.control('stop');
    } });
    const result = await runner.run();
    expect(result.status).toBe(mode === 'stop' ? 'stopped' : 'failed');
    expect(result.variables.value).toBe('global');
    expect(result.variables).not.toHaveProperty('scratch');
    expect(result.variables).not.toHaveProperty('result');
  });

  it('步骤配置允许普通变量名，仍拒绝保留属性及相对下载路径', () => {
    const step = { stepId: 'invalid', name: '无效配置', actionType: 'core.assert', params: { actual: 1, expected: 1 } };
    expect(workflowSchema.safeParse(workflow([{ ...step, variables: { runId: 'local-id', scheduledFor: 'local-time' } }])).success).toBe(true);
    expect(workflowSchema.safeParse(workflow([{ ...step, variables: { constructor: 'invalid' } }])).success).toBe(false);
    expect(workflowSchema.safeParse(workflow([{ ...step, settings: { downloadDir: 'relative' } }])).success).toBe(false);
    if (process.platform === 'win32') expect(workflowSchema.safeParse(workflow([{ ...step, settings: { downloadDir: '\\\\server\\share\\downloads' } }])).success).toBe(true);
  });

  it('浏览器启动参数传入真实会话并输出实际端口，已启动后拒绝切换端口', async () => {
    const runner = await engine(workflow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: { browserChannel: 'chrome', debugPort: 9333 }, output: 'browser' },
      { stepId: 'conflict', name: '冲突端口', actionType: 'browser.start', params: { debugPort: 9444 } },
    ]));
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('不能更改浏览器类型或调试端口');
    expect(browser.options).toHaveBeenCalledWith(expect.objectContaining({ browserChannel: 'chrome', debugPort: 9333 }));
    expect(result.variables.browser).toEqual({ pageId: 'main', browserChannel: 'chrome', debugPort: 9333 });
    expect(browser.starts).toHaveBeenCalledTimes(1);
  });

  it('手动执行不自动注入变量', async () => {
    const runner = await engine({ ...workflow([]), variables: {} });
    expect(runner.getSnapshot().variables).toEqual({});
    const result = await runner.run();
    expect(result.status).toBe('succeeded');
    expect(result.runId).toBe('scope-run');
    expect(result.variables).toEqual({});
  });

  it('计划标识与触发时间只保存在运行记录中，不自动注入变量', async () => {
    const scheduledFor = '2026-09-16T04:00:00.000Z';
    const result = await (await engine(workflow([]), { scheduleId: 'daily', scheduledFor })).run();
    expect(result).toMatchObject({ runId: 'scope-run', scheduleId: 'daily', scheduledFor });
    expect(result.variables).toEqual({ value: 'global' });
  });

  it.each(['runId', 'scheduledFor'])('%s 可由用户声明、局部覆盖和写入，且不改变运行元数据', async name => {
    const scheduledFor = '2026-09-16T04:00:00.000Z';
    const flow = workflow([
      { stepId: 'local', name: '局部值', actionType: 'core.assert', variables: { [name]: 'local' }, params: { actual: `{{${name}}}`, expected: 'local' } },
      { stepId: 'restored', name: '恢复声明值', actionType: 'core.assert', params: { actual: `{{${name}}}`, expected: 'declared' } },
      { stepId: 'set', name: '设置变量', actionType: 'variables.set', params: { name, value: 'assigned' } },
      { stepId: 'script', name: '脚本读写', actionType: 'script.run', params: { language: 'javascript', code: `await rpa.set('${name}', (await rpa.get('${name}')) + '-script'); await rpa.output(await rpa.get('${name}'));` }, output: name },
    ]);
    flow.variables = { [name]: 'declared' };
    const result = await (await engine(flow, { scheduleId: 'daily', scheduledFor })).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toEqual({ [name]: 'assigned-script' });
    expect(result).toMatchObject({ runId: 'scope-run', scheduleId: 'daily', scheduledFor });
  });
});
