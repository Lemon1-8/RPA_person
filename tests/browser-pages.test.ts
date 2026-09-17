import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';
import { startPagesServer } from './fixtures/pages-server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(headless = true) {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-browser-pages-'));
  cleanups.push(async () => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-browser-pages-')) throw new Error(`Refusing unsafe cleanup: ${target}`);
    await rm(target, { recursive: true, force: true });
  });
  const fixture = await startPagesServer();
  cleanups.push(() => fixture.close());
  const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless, runId: 'test-pages' });
  cleanups.push(() => browser.close());
  return { browser, fixture };
}

async function externalContext(browser: BrowserSession) {
  const peer = await chromium.connectOverCDP(`http://127.0.0.1:${browser.getInfo().debugPort}`);
  cleanups.push(() => peer.close());
  return peer.contexts()[0]!;
}

describe('BrowserSession multiple pages', () => {
  it('waits for the browser startup tab instead of creating a duplicate when its CDP page event arrives late', async () => {
    const { browser } = await setup();
    const connect = chromium.connectOverCDP.bind(chromium);
    let notify!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const announced = new Promise<void>(resolve => { notify = resolve; });
    const connecting = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (endpoint: string | Parameters<typeof connect>[0], options?: Parameters<typeof connect>[0]) => {
      const connected = typeof endpoint === 'string' ? await connect(endpoint, options) : await connect(endpoint);
      const context = connected.contexts()[0]!;
      const startupPage = context.pages()[0] ?? await context.waitForEvent('page');
      // Delay only this client's observation of the native browser's real initial tab.
      vi.spyOn(context, 'pages').mockReturnValueOnce([]);
      timer = setTimeout(() => { (context as unknown as EventEmitter).emit('page', startupPage); notify(); }, 80);
      return connected;
    });
    try {
      await browser.start();
      await announced;
      expect(await browser.listPages()).toEqual([{ pageId: 'main', title: '', url: 'about:blank', current: true }]);
      const peer = await connect(`http://127.0.0.1:${browser.getInfo().debugPort}`);
      try { expect(peer.contexts()[0]!.pages()).toHaveLength(1); }
      finally { await peer.close(); }
    } finally {
      clearTimeout(timer);
      connecting.mockRestore();
    }
  });

  it('cancels startup promptly while waiting for the initial page event', async () => {
    const { browser } = await setup();
    const connect = chromium.connectOverCDP.bind(chromium);
    const connecting = vi.spyOn(chromium, 'connectOverCDP').mockImplementation(async (endpoint: string | Parameters<typeof connect>[0], options?: Parameters<typeof connect>[0]) => {
      const connected = typeof endpoint === 'string' ? await connect(endpoint, options) : await connect(endpoint);
      const context = connected.contexts()[0]!;
      if (!context.pages().length) await context.waitForEvent('page');
      vi.spyOn(context, 'pages').mockReturnValueOnce([]);
      return connected;
    });
    const session = browser as unknown as { waitForStartupPage(): Promise<void> };
    const waitForPage = session.waitForStartupPage.bind(browser);
    let notify!: () => void;
    const entered = new Promise<void>(resolve => { notify = resolve; });
    const waiting = vi.spyOn(session, 'waitForStartupPage').mockImplementation(() => {
      const pending = waitForPage(); notify(); return pending;
    });
    try {
      const pending = browser.start();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'BROWSER_START_CANCELLED' });
      await entered;
      await browser.close();
      await rejected;
      expect(browser.isOpen()).toBe(false);
      expect(await browser.listPages()).toEqual([]);
    } finally {
      connecting.mockRestore();
      waiting.mockRestore();
    }
  });

  it('registers clicked popups and clicks each explicitly targeted page without changing the current target', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    expect(await browser.call('browser.click', { selector: '#detail' })).toEqual({ ok: true });
    await expect.poll(() => browser.listPages()).toEqual([
      { pageId: 'main', title: '订单列表', url: `${fixture.url}/`, current: true },
      { pageId: 'page-2', title: '订单详情', url: `${fixture.url}/detail`, current: false, openerPageId: 'main' },
    ]);
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('订单列表');
    expect(await browser.call('browser.click', { pageId: 'page-2', selector: '#report' })).toEqual({ ok: true });
    expect(await browser.call('browser.text', { pageId: 'page-2', selector: '#title' })).toBe('报表');
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('订单列表');
    await browser.call('browser.click', { pageId: 'main', selector: '#nothing' });
    expect(await browser.call('browser.evaluate', { expression: 'document.body.dataset.clicked' })).toBe('true');
    expect(await browser.call('browser.evaluate', { pageId: 'page-2', expression: 'document.body.dataset.clicked ?? null' })).toBeNull();
    expect((await browser.listPages()).find(page => page.current)?.pageId).toBe('main');
  });

  it('ignores retired popup options without alias validation, waiting or switching', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    for (const newPageId of ['main', '{{missing.pageId}}', { pageId: 'main' }]) {
      expect(await browser.call('browser.click', { selector: '#nothing', waitForNewPage: true, newPageId, timeoutMs: 500 }))
        .toEqual({ ok: true });
    }
    expect(await browser.call('browser.evaluate', { expression: 'document.body.dataset.clicked' })).toBe('true');
    expect(await browser.call('browser.click', { selector: '#detail', waitForNewPage: true, newPageId: 'main' })).toEqual({ ok: true });
    await expect.poll(async () => (await browser.listPages()).map(page => page.pageId)).toEqual(['main', 'page-2']);
    expect((await browser.listPages()).find(page => page.current)?.pageId).toBe('main');
  });

  it('does not start a browser when listing its pages', async () => {
    const { browser } = await setup();
    expect(await browser.listPages()).toEqual([]);
    expect(await browser.call('browser.listPages')).toEqual([]);
    expect(browser.isOpen()).toBe(false);
  });

  it('automatically registers manual tabs and normal click popups without changing the current target', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    const context = await externalContext(browser);
    const manual = await context.newPage();
    await manual.goto(`${fixture.url}/report`);
    await manual.bringToFront();
    await expect.poll(() => browser.listPages()).toEqual([
      { pageId: 'main', title: '订单列表', url: `${fixture.url}/`, current: true },
      { pageId: 'page-2', title: '报表', url: `${fixture.url}/report`, current: false },
    ]);
    expect(await browser.call('browser.text', { pageId: '', selector: '#title' })).toBe('订单列表');
    expect(await browser.call('browser.click', { selector: '#detail' })).toEqual({ ok: true });
    await expect.poll(async () => (await browser.listPages()).find(page => page.pageId === 'page-3')).toEqual({ pageId: 'page-3', title: '订单详情', url: `${fixture.url}/detail`, current: false, openerPageId: 'main' });
    await browser.call('browser.switchPage', { pageId: 'page-3' });
    expect(await browser.call('browser.text', { pageId: '$current', selector: '#title' })).toBe('订单详情');
    await manual.close();
    await expect.poll(async () => (await browser.listPages()).map(page => page.pageId)).toEqual(['main', 'page-3']);
    await expect(browser.call('browser.switchPage', { pageId: 'page-2' })).rejects.toThrow('不存在或已关闭：page-2');
    const another = await context.newPage();
    await another.goto(`${fixture.url}/report`);
    await expect.poll(async () => (await browser.listPages()).map(page => page.pageId)).toEqual(['main', 'page-3', 'page-4']);
  });

  it('keeps aliases across navigation, reads live metadata and uses empty page IDs as the current page', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: '详情', openMode: 'new' });
    expect(await browser.call('browser.open', { url: `${fixture.url}/report`, pageId: '详情' })).toEqual({ pageId: '详情', url: `${fixture.url}/report` });
    await browser.call('browser.evaluate', { pageId: '', expression: 'document.title = "最新报表"' });
    expect(await browser.listPages()).toEqual([
      { pageId: 'main', title: '订单列表', url: `${fixture.url}/`, current: false },
      { pageId: '详情', title: '最新报表', url: `${fixture.url}/report`, current: true },
    ]);
    expect(await browser.call('browser.text', { pageId: 'main', selector: '#title' })).toBe('订单列表');
    expect(await browser.call('browser.text', { pageId: '', element: { pageRef: 'main', selector: '#title' } })).toBe('报表');
    expect(await browser.call('browser.text', { element: { pageRef: 'main', selector: '#title' } })).toBe('订单列表');
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('报表');
    await browser.call('browser.switchPage', { pageId: 'main' });
    expect(await browser.call('browser.text', { pageId: '$current', selector: '#title' })).toBe('订单列表');
    for (const pageId of [undefined, '', ' ', '$current']) {
      expect(await browser.call('browser.switchPage', { pageId })).toEqual({ pageId: 'main', url: `${fixture.url}/` });
    }
  });

  it('creates an automatic alias for unnamed new tabs and never overwrites an occupied alias', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    expect(await browser.call('browser.open', { url: `${fixture.url}/report`, pageId: '', openMode: 'new' })).toEqual({ pageId: 'page-2', url: `${fixture.url}/report` });
    await expect(browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'page-2', openMode: 'new' })).rejects.toThrow('别名已被打开的标签页占用：page-2');
    expect(await browser.call('browser.evaluate', { pageId: 'main', expression: 'document.body.dataset.clicked ?? null' })).toBeNull();
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('报表');
    expect(await browser.listPages()).toHaveLength(2);
  });

  it('rejects malformed explicit open aliases while allowing whitespace to mean the current page', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    for (const pageId of [' detail ', '{{detail}}']) {
      await expect(browser.call('browser.open', { url: `${fixture.url}/detail`, pageId, openMode: 'new' })).rejects.toThrow('网页别名不能包含首尾空格或花括号');
    }
    expect(await browser.call('browser.open', { url: `${fixture.url}/report`, pageId: ' ' })).toEqual({ pageId: 'main', url: `${fixture.url}/report` });
    expect(await browser.listPages()).toHaveLength(1);
  });

  it('reports a closed current page until the workflow explicitly switches or opens a new page', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'detail', openMode: 'new' });
    expect(await browser.call('browser.closePage')).toEqual({ ok: true, pageId: 'detail' });
    expect(await browser.listPages()).toEqual([{ pageId: 'main', title: '订单列表', url: `${fixture.url}/`, current: false }]);
    await expect(browser.call('browser.text', { selector: '#title' })).rejects.toThrow('不存在或已关闭：detail');
    await expect(browser.call('browser.open', { url: `${fixture.url}/report`, pageId: '' })).rejects.toThrow('不存在或已关闭：detail');
    expect(await browser.call('browser.text', { pageId: 'main', selector: '#title' })).toBe('订单列表');
    await expect(browser.call('browser.text', { pageId: '$current', selector: '#title' })).rejects.toThrow('不存在或已关闭：detail');
    await browser.call('browser.switchPage', { pageId: 'main' });
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('订单列表');
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'detail', openMode: 'new' });
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('订单详情');
  });

  it('still shows the native browser after closing the current tab without changing the workflow target', async () => {
    const { browser, fixture } = await setup(false);
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'detail', openMode: 'new' });
    await browser.call('browser.closePage');
    expect(await browser.call('browser.show')).toEqual({ state: 'normal', headless: false });
    expect(await browser.call('browser.hide')).toEqual({ state: 'minimized', headless: false });
    await expect(browser.call('browser.show', { pageId: 'detail' })).rejects.toThrow('不存在或已关闭：detail');
    await expect(browser.call('browser.text', { selector: '#title' })).rejects.toThrow('不存在或已关闭：detail');
    expect((await browser.listPages()).some(page => page.current)).toBe(false);
  });

  it('retired click options do not bypass strict popup blocking', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.popupGuard', { mode: 'strict' });
    expect(await browser.call('browser.click', { selector: '#detail', waitForNewPage: true, newPageId: 'detail' }))
      .toEqual({ ok: true });
    expect(await browser.listPages()).toEqual([
      { pageId: 'main', title: '订单列表', url: `${fixture.url}/`, current: true },
    ]);
    expect(await browser.call('browser.evaluate', { expression: "window.open('/report') === null" })).toBe(true);
  });
});
