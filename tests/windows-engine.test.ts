import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import type { DesktopElementRef, WorkflowDefinition } from '../packages/contracts/src/index.js';

const windows = vi.hoisted(() => ({ call: vi.fn(), close: vi.fn() }));
vi.mock('../packages/windows/src/index.js', () => ({ WindowsSession: class { call = windows.call; close = windows.close; } }));
const directories: string[] = [];
const element = (title: string): DesktopElementRef => ({ backend: 'uia', window: { title: { value: title, match: 'exact' } }, path: [] });
function flow(steps: WorkflowDefinition['steps']): WorkflowDefinition { return { schemaVersion: 1, workflowId: 'windows-engine', name: '桌面', revision: 0, variables: { title: '全局' }, elements: {}, desktopElements: { target: element('{{title}}') }, steps, settings: { downloadDir: tmpdir(), headless: true } }; }
async function engine(workflow: WorkflowDefinition) { const dataDir = await mkdtemp(join(tmpdir(), 'rpa-windows-engine-')); directories.push(dataDir); return new WorkflowEngine(workflow, { dataDir, runId: 'windows-run' }); }
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('Windows 流程和脚本共享执行器', () => {
  it('继承和覆盖桌面元素作用域，插值后定位，并在运行结束清理会话', async () => {
    windows.call.mockImplementation(async (_method, params) => params.element.window.title.value);
    const result = await (await engine(flow([
      { stepId: 'parent', name: '容器', actionType: 'control.if', params: { left: true, operator: 'truthy' }, variables: { title: '局部' }, children: [
        { stepId: 'local', name: '继承', actionType: 'windows.text', params: { selector: '@target' }, output: 'local' },
        { stepId: 'override', name: '覆盖', actionType: 'windows.text', desktopElements: { target: element('覆盖') }, params: { selector: '@target' }, output: 'override' },
      ] },
      { stepId: 'global', name: '恢复', actionType: 'windows.text', params: { selector: '@target' }, output: 'global' },
    ]))).run();
    expect(result.status).toBe('succeeded');
    expect(result.variables).toMatchObject({ local: '局部', override: '覆盖', global: '全局' });
    expect(windows.close).toHaveBeenCalledOnce();
    expect(result.browserOpen).toBe(false);
  });
  it.each(['javascript', 'python'])('%s 通过 RPC 访问同一桌面元素库', async language => {
    windows.call.mockResolvedValue('软件文本');
    const code = language === 'python' ? `from rpa_sdk import rpa\nrpa.output(rpa.call('windows.text', {'selector': '@target'}))` : `await rpa.output(await rpa.call('windows.text', {selector: '@target'}));`;
    const result = await (await engine(flow([{ stepId: 'script', name: '脚本', actionType: 'script.run', params: { language, code }, output: 'text' }]))).run();
    expect(result.status).toBe('succeeded'); expect(result.variables.text).toBe('软件文本');
    expect(windows.call).toHaveBeenCalledWith('windows.text', expect.objectContaining({ element: element('全局') }), expect.any(Number), expect.any(AbortSignal));
  });
  it('单步只执行目标指令，桌面动作无需打开浏览器', async () => {
    windows.call.mockResolvedValue('值');
    const runner = await engine(flow([{ stepId: 'before', name: '不执行', actionType: 'variables.set', params: { name: 'before', value: true } }, { stepId: 'read', name: '读取', actionType: 'windows.text', params: { selector: '@target' }, output: 'value' }]));
    const result = await runner.runSingleStep('read');
    expect(result.status).toBe('succeeded'); expect(result.variables.value).toBe('值'); expect(result.variables.before).toBeUndefined(); expect(result.browserOpen).toBe(false);
  });
  it('元素缺失及原生错误定位到步骤，失败仍清理会话', async () => {
    const missing = await (await engine(flow([{ stepId: 'missing', name: '元素缺失', actionType: 'windows.text', params: { selector: '@missing' } }]))).run();
    expect(missing.error).toContain('桌面元素库不存在');
    windows.call.mockRejectedValue(new Error('PERMISSION: 权限不足'));
    const failed = await (await engine(flow([{ stepId: 'denied', name: '读取', actionType: 'windows.text', params: { selector: '@target' } }]))).run();
    expect(failed.status).toBe('failed'); expect(failed.error).toContain('权限不足'); expect(windows.close).toHaveBeenCalled();
  });
});
