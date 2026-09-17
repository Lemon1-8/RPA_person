import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';

const browser = vi.hoisted(() => ({ call: vi.fn(), options: vi.fn(), starts: vi.fn(), pages: vi.fn() }));
vi.mock('../packages/browser/src/index.js', () => ({
  BrowserSession: class {
    private open = false;
    private listener?: () => void;
    constructor(options: unknown) { browser.options(options); }
    async start() { if (!this.open) { this.open = true; browser.starts(); } }
    isOpen() { return this.open; }
    onClosed(listener: () => void) { this.listener = listener; return () => {}; }
    async close() { this.open = false; this.listener?.(); }
    async screenshot() { return undefined; }
    getInfo() { return { pageId: 'main', browserChannel: 'chromium', debugPort: 9333 }; }
    call(method: string, params: Record<string, unknown>) { return browser.call(method, params); }
    listPages() { return browser.pages(); }
  },
}));
const directories: string[] = [];
beforeEach(() => {
  for (const mock of Object.values(browser)) mock.mockReset();
  browser.call.mockResolvedValue(null); browser.pages.mockResolvedValue([]);
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-pages-engine-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});
async function engine(steps: WorkflowDefinition['steps']) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-pages-engine-')); directories.push(dataDir);
  return new WorkflowEngine({
    schemaVersion: 1, workflowId: 'browser-pages', name: '网页列表', revision: 0,
    variables: {}, elements: {}, settings: { downloadDir: dataDir, headless: true }, steps,
  }, { dataDir, runId: 'pages-run' });
}

describe('网页列表执行器接口', () => {
  it('完整对象引用用于目标网页时指出字段并引导选择 pageId 属性', async () => {
    const runner = await engine([
      { stepId: 'set', name: '设置网页信息', actionType: 'variables.set', params: { name: 'pageInfo', value: { pageId: 'detail' } } },
      { stepId: 'click', name: '点击元素', actionType: 'browser.click', params: { selector: '#open', pageId: '{{pageInfo}}' } },
    ]);
    const result = await runner.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('目标网页');
    expect(result.error).toContain('对象');
    expect(result.error).toContain('{{变量.pageId}}');
    expect(browser.call).not.toHaveBeenCalled();
  });

  it.each(['{{missing.pageId}}', { pageId: 'main' }, 'main'])('旧点击选项 %j 不解析变量也不阻挡当前网页点击', async newPageId => {
    browser.call.mockResolvedValue({ ok: true });
    const runner = await engine([
      { stepId: 'click', name: '点击元素', actionType: 'browser.click', params: { selector: '#open', waitForNewPage: '{{missingFlag}}', newPageId }, output: 'clicked' },
    ]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(browser.call).toHaveBeenCalledWith('browser.click', expect.objectContaining({ selector: '#open' }));
    expect(browser.call.mock.calls[0]![1]).not.toHaveProperty('waitForNewPage');
    expect(browser.call.mock.calls[0]![1]).not.toHaveProperty('newPageId');
    expect(result.variables.clicked).toEqual({ ok: true });
    await runner.control('closeBrowser');
  });

  it('网页输出的 pageId 属性引用保留文本类型并传给后续动作', async () => {
    browser.call.mockImplementation(async (method: string) => method === 'browser.open'
      ? { pageId: 'orders', url: 'https://example.test/orders' }
      : method === 'browser.click' ? { ok: true } : '列表');
    const runner = await engine([
      { stepId: 'open', name: '打开列表', actionType: 'browser.open', params: { url: 'https://example.test/orders' }, output: 'source' },
      { stepId: 'click', name: '点击列表', actionType: 'browser.click', params: { selector: '#open', pageId: '{{source.pageId}}' }, output: 'clicked' },
      { stepId: 'read', name: '读取列表', actionType: 'browser.text', params: { selector: 'h1', pageId: '{{source.pageId}}' }, output: 'title' },
    ]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(browser.call).toHaveBeenCalledWith('browser.click', expect.objectContaining({ pageId: 'orders' }));
    expect(browser.call).toHaveBeenCalledWith('browser.text', expect.objectContaining({ pageId: 'orders' }));
    expect(result.variables.title).toBe('列表');
    expect(result.variables.clicked).toEqual({ ok: true });
    await runner.control('closeBrowser');
  });

  it('脚本查询网页列表不会自动启动浏览器', async () => {
    const runner = await engine([{
      stepId: 'list', name: '查询网页', actionType: 'script.run',
      params: { language: 'javascript', code: 'await rpa.output(await rpa.call("browser.listPages", {}));' }, output: 'pages',
    }]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.pages).toEqual([]);
    expect(result.browserOpen).toBe(false);
    expect(browser.options).not.toHaveBeenCalled();
    expect(browser.starts).not.toHaveBeenCalled();
    expect(browser.call).not.toHaveBeenCalled();
  });

  it('打开网页将浏览器类型和调试端口应用于首次启动，并在后续打开时复用', async () => {
    const runner = await engine([
      { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: 'https://example.com', browserChannel: 'chromium', debugPort: 9333 } },
      { stepId: 'next', name: '打开第二页', actionType: 'browser.open', params: { url: 'https://example.com/second', pageId: 'second' } },
    ]);
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(browser.options).toHaveBeenCalledOnce();
    expect(browser.options).toHaveBeenCalledWith(expect.objectContaining({ browserChannel: 'chromium', debugPort: 9333 }));
    expect(browser.starts).toHaveBeenCalledOnce();
    expect(browser.call).toHaveBeenCalledWith('browser.open', expect.objectContaining({ url: 'https://example.com/second', pageId: 'second' }));
    await runner.control('closeBrowser');
  });

  it('查询尚未启动或已经关闭的会话不创建浏览器，也不改变运行快照', async () => {
    const runner = await engine([{ stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: 'https://example.com' } }]);
    const initial = runner.getSnapshot();
    expect(await runner.listBrowserPages()).toEqual([]);
    expect(runner.getSnapshot()).toEqual(initial);
    expect(browser.options).not.toHaveBeenCalled();
    await runner.run();
    await runner.control('closeBrowser');
    const closed = runner.getSnapshot();
    expect(await runner.listBrowserPages()).toEqual([]);
    expect(runner.getSnapshot()).toEqual(closed);
    expect(browser.options).toHaveBeenCalledOnce();
    expect(browser.pages).not.toHaveBeenCalled();
  });

  it('读取真实页面列表及查询失败都不会更改运行结果或变量', async () => {
    const runner = await engine([{ stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: 'https://example.com' } }]);
    await runner.run();
    const before = runner.getSnapshot();
    const pages = [{ pageId: 'orders', title: '订单', url: 'https://example.com/orders', current: true }];
    browser.pages.mockResolvedValueOnce(pages).mockRejectedValueOnce(new Error('页面信息读取失败'));
    expect(await runner.listBrowserPages()).toEqual(pages);
    await expect(runner.listBrowserPages()).rejects.toThrow('页面信息读取失败');
    expect(runner.getSnapshot()).toEqual(before);
    expect(browser.starts).toHaveBeenCalledOnce();
    await runner.control('closeBrowser');
  });
});
