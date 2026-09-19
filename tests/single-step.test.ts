import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const browser = vi.hoisted(() => ({ call: vi.fn(), options: vi.fn(), close: vi.fn(), starts: vi.fn() }));
vi.mock('../packages/browser/src/index.js', () => ({
  BrowserSession: class {
    private open = false;
    private listener?: () => void;
    constructor(options: unknown) { browser.options(options); }
    async start() { if (!this.open) { this.open = true; browser.starts(); } }
    isOpen() { return this.open; }
    onClosed(listener: () => void) { this.listener = listener; return () => {}; }
    async close() { this.open = false; browser.close(); this.listener?.(); }
    async screenshot() { return undefined; }
    getInfo() { return { pageId: 'main', browserChannel: 'chromium', debugPort: 9223 }; }
    call(method: string, params: Record<string, unknown>) { return browser.call(method, params); }
  },
}));
const directories: string[] = [];
function flow(steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'single-step', name: '单条指令', revision: 0, variables: { value: 'global' }, elements: {}, settings: { downloadDir: tmpdir(), headless: true, keepBrowserOpen: false }, steps };
}
async function engine(workflow: WorkflowDefinition, events: RunEvent[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-single-step-')); directories.push(dataDir);
  return new WorkflowEngine(workflow, { dataDir, runId: 'single-step-run', onEvent: event => events.push(event) });
}
beforeEach(() => { for (const mock of Object.values(browser)) mock.mockReset(); browser.call.mockResolvedValue(null); });
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('单条指令执行器', () => {
  it('只执行选中指令，继承祖先作用域但不计算祖先条件或执行相邻指令', async () => {
    const directory = join(tmpdir(), 'ancestor-downloads');
    const workflow = flow([
      { stepId: 'before', name: '不可执行', actionType: 'variables.set', params: { name: 'before', value: true } },
      { stepId: 'parent', name: '不计算父条件', actionType: 'control.if', params: { left: '{{missing}}', operator: 'truthy' }, variables: { value: 'ancestor' }, elements: { target: { selector: '#{{value}}' } }, settings: { downloadDir: directory }, elseSteps: [
        { stepId: 'selected', name: '下载', actionType: 'browser.download', params: { selector: '@target' }, output: 'download' },
        { stepId: 'sibling', name: '不可执行', actionType: 'variables.set', params: { name: 'sibling', value: true } },
      ] },
    ]);
    browser.call.mockResolvedValue({ path: join(directory, 'result.txt'), name: 'result.txt', size: 1 });
    const events: RunEvent[] = [];
    const runner = await engine(workflow, events);
    const result = await runner.runSingleStep('selected');
    expect(result.status).toBe('succeeded'); expect(result.stepId).toBe('selected'); expect(result.browserOpen).toBe(true);
    expect(result.variables).toMatchObject({ value: 'global', download: { name: 'result.txt' } });
    expect(result.variables).not.toHaveProperty('before'); expect(result.variables).not.toHaveProperty('sibling');
    expect(browser.call).toHaveBeenCalledWith('browser.download', expect.objectContaining({ element: { selector: '#ancestor' }, directory }));
    expect(browser.options).toHaveBeenCalledWith(expect.objectContaining({ popupPolicy: 'smart' }));
    expect(events.filter(event => event.type === 'step').map(event => event.stepId)).toEqual(['selected', 'selected']);
    await runner.control('closeBrowser');
  });

  it('选中容器时执行容器的全部子步骤，且遵守容器超时', async () => {
    const workflow = flow([{ stepId: 'loop', name: '循环', actionType: 'control.forEach', params: { items: [1, 2], itemVariable: 'item' }, children: [
      { stepId: 'copy', name: '记录', actionType: 'variables.set', params: { name: 'last', value: '{{item}}' } },
    ] }, { stepId: 'after', name: '不执行', actionType: 'variables.set', params: { name: 'after', value: true } }]);
    const result = await (await engine(workflow)).runSingleStep('loop');
    expect(result.status).toBe('succeeded'); expect(result.variables.last).toBe(2); expect(result.variables).not.toHaveProperty('after');
    workflow.steps[0].timeoutMs = 100;
    workflow.steps[0].children = [{ stepId: 'sleep', name: '等待脚本', actionType: 'script.run', params: { language: 'javascript', code: 'await new Promise(resolve => setTimeout(resolve, 500));' } }];
    expect((await (await engine(workflow)).runSingleStep('loop')).status).toBe('failed');
  });

  it('复用原浏览器和运行变量，应用编辑的默认值及弹窗模式并清除旧失败状态', async () => {
    const workflow = flow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: { browserChannel: 'chromium' }, output: 'connection' },
      { stepId: 'fail', name: '校验失败', actionType: 'core.assert', params: { actual: 1, expected: 2 } },
      { stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'savedConnection', value: '{{connection}}' } },
    ]);
    const runner = await engine(workflow);
    const first = await runner.runSingleStep('start');
    expect((await runner.runSingleStep('fail')).status).toBe('failed');
    workflow.revision = 4; workflow.name = '已编辑'; workflow.variables.value = 'edited'; workflow.settings.popupPolicy = 'strict';
    const result = await runner.runSingleStep('set', workflow);
    expect(result).toMatchObject({ runId: first.runId, revision: 4, workflowName: '已编辑', status: 'succeeded', browserOpen: true, stepId: 'set' });
    expect(result.error).toBeUndefined(); expect(result.variables.value).toBe('edited');
    expect(result.variables.savedConnection).toEqual(first.variables.connection);
    expect(browser.starts).toHaveBeenCalledTimes(1); expect(browser.options).toHaveBeenCalledTimes(1);
    expect(browser.call).toHaveBeenCalledWith('browser.popupGuard', { mode: 'strict' });
    await runner.control('closeBrowser');
    expect(() => runner.runSingleStep('start')).toThrow('浏览器已关闭');
    expect(browser.starts).toHaveBeenCalledTimes(1);
  });

  it('浏览器动作超时失败后默认保留当前浏览器现场', async () => {
    const workflow = flow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: {} },
      { stepId: 'click', name: '点击', actionType: 'browser.click', timeoutMs: 100, params: { selector: '#slow' } },
    ]);
    const runner = await engine(workflow);
    await runner.runSingleStep('start');
    browser.close.mockClear();
    browser.call.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 200)));

    const result = await runner.runSingleStep('click');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('浏览器动作超时');
    expect(result.browserOpen).toBe(true);
    expect(browser.close).not.toHaveBeenCalled();
    await runner.control('closeBrowser');
  });

  it('浏览器动作超时边界保留内部定位错误', async () => {
    const workflow = flow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: {} },
      { stepId: 'click', name: '点击', actionType: 'browser.click', timeoutMs: 100, params: { selector: '#missing' } },
    ]);
    const runner = await engine(workflow);
    await runner.runSingleStep('start');
    browser.call.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('locator.waitFor: Timeout 100ms exceeded. waiting for locator("#missing")')), 110);
    }));

    const result = await runner.runSingleStep('click');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('locator.waitFor');
    expect(result.error).toContain('#missing');
    await runner.control('closeBrowser');
  });

  it.each(['runId', 'scheduledFor'])('复用单步会话时 %s 与普通声明一样支持编辑和删除，保留已计算值', async name => {
    const workflow = flow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: { browserChannel: 'chromium' } },
      { stepId: 'set', name: '设置', actionType: 'variables.set', params: { name, value: 'computed' } },
    ]);
    workflow.variables = { [name]: 'declared' };
    const runner = await engine(workflow);
    expect((await runner.runSingleStep('start')).variables).toEqual({ [name]: 'declared' });
    workflow.variables[name] = 'edited';
    expect((await runner.runSingleStep('start', workflow)).variables).toEqual({ [name]: 'edited' });
    delete workflow.variables[name];
    expect((await runner.runSingleStep('start', workflow)).variables).toEqual({});
    workflow.variables[name] = 'declared-again';
    expect((await runner.runSingleStep('set', workflow)).variables).toEqual({ [name]: 'computed' });
    delete workflow.variables[name];
    const result = await runner.runSingleStep('start', workflow);
    expect(result.variables).toEqual({ [name]: 'computed' });
    expect(result.runId).toBe('single-step-run');
    await runner.control('closeBrowser');
  });

  it('拒绝不存在的指令、会话配置不匹配和并发重入；停止沿用原取消路径', async () => {
    const workflow = flow([
      { stepId: 'start', name: '启动', actionType: 'browser.start', params: {} },
      { stepId: 'wait', name: '等待', actionType: 'script.run', params: { language: 'javascript', code: 'await new Promise(() => {});' } },
    ]);
    const runner = await engine(workflow);
    expect(() => runner.runSingleStep('missing')).toThrow('不存在');
    await runner.runSingleStep('start');
    expect(() => runner.runSingleStep('start', { ...workflow, workflowId: 'other' })).toThrow('当前流程');
    expect(() => runner.runSingleStep('start', { ...workflow, settings: { ...workflow.settings, headless: false } })).toThrow('配置已改变');
    const pending = runner.runSingleStep('wait');
    expect(() => runner.runSingleStep('start')).toThrow('正在执行');
    await runner.control('stop');
    const result = await pending;
    expect(result.status).toBe('stopped'); expect(result.browserOpen).toBe(false);
  });

  it('单独设置弹窗模式后，后续指令保留当前策略，直到流程默认设置被修改', async () => {
    const workflow = flow([
      { stepId: 'guard', name: '关闭屏蔽', actionType: 'browser.popupGuard', params: { mode: 'off' } },
      { stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'done', value: true } },
    ]);
    const runner = await engine(workflow);
    await runner.runSingleStep('guard');
    await runner.runSingleStep('set');
    expect(browser.call).toHaveBeenCalledTimes(1);
    expect(browser.call).toHaveBeenCalledWith('browser.popupGuard', expect.objectContaining({ mode: 'off' }));
    workflow.settings.popupPolicy = 'strict';
    await runner.runSingleStep('set', workflow);
    expect(browser.call).toHaveBeenLastCalledWith('browser.popupGuard', { mode: 'strict' });
    await runner.control('closeBrowser');
  });
});
