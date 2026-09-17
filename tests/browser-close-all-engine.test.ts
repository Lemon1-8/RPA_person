import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const browser = vi.hoisted(() => ({
  instances: [] as { runId: string; open: boolean; starts: number; close: () => Promise<void> }[],
  calls: vi.fn(),
  closeMode: 'complete' as 'complete' | 'pending' | 'fail',
  onCloseStarted: undefined as (() => void) | undefined,
}));
vi.mock('../packages/browser/src/index.js', () => ({
  BrowserSession: class {
    open = false;
    starts = 0;
    runId: string;
    private pageIds: string[] = [];
    private listener?: () => void;
    private pendingClose?: () => void;
    constructor(options: { runId: string }) { this.runId = options.runId; browser.instances.push(this); }
    async start() { this.starts++; this.open = true; if (!this.pageIds.length) this.pageIds.push('main'); }
    isOpen() { return this.open; }
    onClosed(listener: () => void) { this.listener = listener; return () => {}; }
    async close() {
      this.open = false;
      this.pageIds = [];
      this.listener?.();
      this.pendingClose?.();
      this.pendingClose = undefined;
    }
    async screenshot() { return undefined; }
    getInfo() { return { pageId: 'main', browserChannel: 'chromium', debugPort: 9333 }; }
    async call(method: string, params: Record<string, unknown>) {
      browser.calls(this.runId, method, params);
      if (method === 'browser.open') {
        const pageId = typeof params.pageId === 'string' ? params.pageId : 'main';
        if (!this.pageIds.includes(pageId)) this.pageIds.push(pageId);
        return { pageId, url: params.url };
      }
      if (method === 'browser.closePage' && params.closeMode === 'all') {
        const closedPageIds = [...this.pageIds];
        if (browser.closeMode === 'fail') throw new Error('关闭失败');
        if (browser.closeMode === 'pending') await new Promise<void>(resolve => {
          this.pendingClose = resolve;
          browser.onCloseStarted?.();
        });
        await this.close();
        return { ok: true, closedPageIds };
      }
      if (method === 'browser.closePage') return { ok: true, pageId: params.pageId ?? 'main' };
      return null;
    }
  },
}));

const directories: string[] = [];
const openStep = { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: 'https://example.test/' } };
const closeStep = { stepId: 'close', name: '关闭所有网页', actionType: 'browser.closePage', params: { closeMode: 'all' }, output: 'closed' };
const afterStep = { stepId: 'after', name: '继续执行', actionType: 'variables.set', params: { name: 'continued', value: true } };
async function engine(steps: WorkflowDefinition['steps'], runId = 'close-all-run', events: RunEvent[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-close-all-engine-')); directories.push(dataDir);
  return new WorkflowEngine({
    schemaVersion: 1, workflowId: 'close-all', name: '关闭所有网页', revision: 0,
    variables: {}, elements: {}, settings: { downloadDir: dataDir, headless: true }, steps,
  }, { dataDir, runId, onEvent: event => events.push(event) });
}
beforeEach(() => {
  browser.instances.length = 0;
  browser.calls.mockReset();
  browser.closeMode = 'complete';
  browser.onCloseStarted = undefined;
});
afterEach(async () => {
  await Promise.all(browser.instances.map(instance => instance.close()));
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-close-all-engine-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

describe('关闭所有网页的执行器隔离', () => {
  it('尚未启动浏览器时直接成功，忽略旧目标网页引用并继续后续步骤', async () => {
    const runner = await engine([{ ...closeStep, params: { closeMode: 'all', pageId: '{{missing.pageId}}' } }, afterStep]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toEqual({ closed: { ok: true, closedPageIds: [] }, continued: true });
    expect(result.browserOpen).toBe(false);
    expect(browser.instances).toHaveLength(0);
    expect(browser.calls).not.toHaveBeenCalled();
  });

  it('关闭当前运行的全部网页后清除浏览器状态，重复关闭不会重新启动', async () => {
    const events: RunEvent[] = [];
    const runner = await engine([
      openStep,
      { ...openStep, stepId: 'second', params: { url: 'https://example.test/second', pageId: 'second' } },
      closeStep,
      { ...closeStep, stepId: 'again', output: 'closedAgain' },
      afterStep,
    ], 'close-all-run', events);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toMatchObject({ closed: { ok: true, closedPageIds: ['main', 'second'] }, closedAgain: { ok: true, closedPageIds: [] }, continued: true });
    expect(result.browserOpen).toBe(false);
    expect(browser.instances).toHaveLength(1);
    expect(browser.instances[0]!.starts).toBe(2);
    expect(browser.calls.mock.calls.filter(([, method]) => method === 'browser.closePage')).toHaveLength(1);
    expect(events.find(event => event.type === 'run' && event.run?.currentStepId === 'close')?.run).toMatchObject({ browserOpen: false });
  });

  it('完整流程关闭后再次打开网页时创建新会话，旧会话保持关闭', async () => {
    const runner = await engine([openStep, closeStep, { ...openStep, stepId: 'reopen' }]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.browserOpen).toBe(true);
    expect(browser.instances).toHaveLength(2);
    expect(browser.instances.map(instance => instance.open)).toEqual([false, true]);
    await runner.control('closeBrowser');
  });

  it('省略关闭范围时仍然按原方式关闭指定网页', async () => {
    const runner = await engine([openStep, { ...closeStep, params: { pageId: 'main' } }]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.closed).toEqual({ ok: true, pageId: 'main' });
    expect(result.browserOpen).toBe(true);
    expect(browser.calls).toHaveBeenLastCalledWith('close-all-run', 'browser.closePage', expect.objectContaining({ pageId: 'main' }));
    await runner.control('closeBrowser');
  });

  it('复用单步运行时只关闭选中的会话，不影响其他任务也不替换已关浏览器', async () => {
    const other = await engine([openStep], 'other-run');
    await other.run();
    const runner = await engine([openStep, closeStep]);
    await runner.runSingleStep('open');
    const result = await runner.runSingleStep('close');
    expect(result.status, result.error).toBe('succeeded');
    expect(result.browserOpen).toBe(false);
    expect(other.getSnapshot().browserOpen).toBe(true);
    expect(browser.instances.map(instance => instance.open)).toEqual([true, false]);
    expect(browser.instances[1]!.starts).toBe(1);
    expect(() => runner.runSingleStep('open')).toThrow('浏览器已关闭');
    expect(browser.instances).toHaveLength(2);
    await other.control('closeBrowser');
  });

  it('关闭失败时报告失败，不改动其他任务的会话', async () => {
    const other = await engine([openStep], 'other-run');
    await other.run();
    browser.closeMode = 'fail';
    const runner = await engine([openStep, closeStep, afterStep]);
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('关闭失败');
    expect(result.variables).not.toHaveProperty('continued');
    expect(other.getSnapshot().browserOpen).toBe(true);
    expect(browser.instances[0]!.open).toBe(true);
    await runner.control('closeBrowser');
    await other.control('closeBrowser');
  });

  it.each(['timeout', 'stop'])('关闭所有网页遭遇 %s 时只清理当前会话且不执行后续步骤', async mode => {
    const other = await engine([openStep], 'other-run');
    await other.run();
    browser.closeMode = 'pending';
    const runner = await engine([openStep, { ...closeStep, timeoutMs: mode === 'timeout' ? 100 : 30_000 }, afterStep]);
    const started = new Promise<void>(resolve => { browser.onCloseStarted = resolve; });
    const pending = runner.run();
    await started;
    if (mode === 'stop') await runner.control('stop');
    const result = await pending;
    expect(result.status).toBe(mode === 'stop' ? 'stopped' : 'failed');
    if (mode === 'timeout') expect(result.error).toContain('浏览器动作超时');
    expect(result.browserOpen).toBe(false);
    expect(result.variables).not.toHaveProperty('continued');
    expect(other.getSnapshot().browserOpen).toBe(true);
    expect(browser.instances.map(instance => instance.open)).toEqual([true, false]);
    expect(browser.instances).toHaveLength(2);
    await other.control('closeBrowser');
  });
});
