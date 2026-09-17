import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';
import { startPagesServer } from './fixtures/pages-server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-browser-close-all-'));
  cleanups.push(async () => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-browser-close-all-')) throw new Error(`Refusing unsafe cleanup: ${target}`);
    await rm(target, { recursive: true, force: true });
  });
  const fixture = await startPagesServer();
  cleanups.push(() => fixture.close());
  const createSession = (name: string) => {
    const session = new BrowserSession({ profileDir: join(directory, name, 'profile'), downloadDir: join(directory, name, 'downloads'), headless: true, runId: name });
    cleanups.push(() => session.close());
    return session;
  };
  return { browser: createSession('first'), fixture, createSession };
}

describe('BrowserSession close all pages', () => {
  it('closes only its owned browser, including manual tabs, and leaves a second browser usable', async () => {
    const { browser, fixture, createSession } = await setup();
    const other = createSession('other');
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'detail', openMode: 'new' });
    await other.call('browser.open', { url: fixture.url });
    const peer = await chromium.connectOverCDP(`http://127.0.0.1:${browser.getInfo().debugPort}`);
    cleanups.push(() => peer.close());
    const manual = await peer.contexts()[0]!.newPage();
    await manual.goto(`${fixture.url}/report`);
    await expect.poll(async () => (await browser.listPages()).map(page => page.pageId)).toEqual(['main', 'detail', 'page-3']);

    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: ['main', 'detail', 'page-3'] });

    expect(browser.isOpen()).toBe(false);
    expect(await browser.listPages()).toEqual([]);
    expect(peer.isConnected()).toBe(false);
    expect(manual.isClosed()).toBe(true);
    expect(other.isOpen()).toBe(true);
    expect(await other.call('browser.text', { selector: '#title' })).toBe('订单列表');
    expect(await other.call('browser.click', { selector: '#nothing' })).toEqual({ ok: true });
    expect(await other.call('browser.evaluate', { expression: 'document.body.dataset.clicked' })).toBe('true');
    expect(await other.call('browser.open', { url: `${fixture.url}/report`, openMode: 'new' })).toMatchObject({ url: `${fixture.url}/report` });
    expect(await other.listPages()).toHaveLength(2);
  });

  it('closes remaining pages even after the selected page is closed and ignores the page target', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/detail`, pageId: 'detail', openMode: 'new' });
    expect(await browser.call('browser.closePage', { closeMode: 'page' })).toEqual({ ok: true, pageId: 'detail' });
    await expect(browser.call('browser.text', { selector: '#title' })).rejects.toThrow('不存在或已关闭：detail');

    expect(await browser.call('browser.closePage', { closeMode: 'all', pageId: 'missing' })).toEqual({ ok: true, closedPageIds: ['main'] });
    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: [] });
    expect(browser.isOpen()).toBe(false);
  });

  it('does not start an unused browser and remains harmless when repeated', async () => {
    const { browser } = await setup();
    const start = vi.spyOn(browser, 'start');
    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: [] });
    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: [] });
    expect(start).not.toHaveBeenCalled();
    expect(browser.isOpen()).toBe(false);
  });

  it('rejects invalid close modes before starting or closing any browser', async () => {
    const { browser, fixture } = await setup();
    const start = vi.spyOn(browser, 'start');
    const close = vi.spyOn(browser, 'close');
    for (const closeMode of [null, 'ALL', '', false, 1]) {
      await expect(browser.call('browser.closePage', { closeMode })).rejects.toThrow('关闭范围必须是 page 或 all');
    }
    expect(start).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.open', { url: `${fixture.url}/report`, openMode: 'new' });
    await expect(browser.call('browser.closePage', { closeMode: 'invalid' })).rejects.toThrow('关闭范围必须是 page 或 all');
    expect(close).not.toHaveBeenCalled();
    expect(await browser.listPages()).toHaveLength(2);
    expect(await browser.call('browser.text', { selector: '#title' })).toBe('报表');
  });

  it('finishes prior queued actions before closing and rejects later page actions without deadlocking', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    const before = browser.call('browser.evaluate', { expression: 'new Promise(resolve => setTimeout(() => resolve("finished"), 100))' });
    const closing = browser.call('browser.closePage', { closeMode: 'all' });
    const after = expect(browser.call('browser.text', { selector: '#title' })).rejects.toThrow('浏览器会话已经关闭');

    expect(await before).toBe('finished');
    expect(await closing).toEqual({ ok: true, closedPageIds: ['main'] });
    await after;
    expect(browser.isOpen()).toBe(false);
  });

  it('can overlap a direct session close and returns an empty result after shutdown', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    const closing = browser.call('browser.closePage', { closeMode: 'all' });
    const shutdown = browser.close();
    expect(await closing).toMatchObject({ ok: true, closedPageIds: expect.any(Array) });
    await shutdown;
    expect(browser.isOpen()).toBe(false);
    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: [] });
  });

  it('cancels an in-flight explicit startup without waiting on its own action queue', async () => {
    const { browser } = await setup();
    const starting = browser.start();
    const rejected = expect(starting).rejects.toMatchObject({ code: 'BROWSER_START_CANCELLED' });
    expect(await browser.call('browser.closePage', { closeMode: 'all' })).toEqual({ ok: true, closedPageIds: [] });
    await rejected;
    expect(browser.isOpen()).toBe(false);
  });
});
