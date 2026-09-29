import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(headless = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-point-test-'));
  cleanups.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('rpa-point-test-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: directory, headless, runId: 'point-test', popupPolicy: 'strict' });
  cleanups.push(() => browser.close());
  await browser.start();
  const peer = await chromium.connectOverCDP(`http://127.0.0.1:${browser.getInfo().debugPort}`);
  cleanups.push(() => peer.close());
  const page = peer.contexts()[0]!.pages()[0]!;
  await page.setContent(`<style>body{height:3000px}button{position:fixed;left:20px;top:20px;width:100px;height:50px}</style>
    <button id="target" onclick="document.body.dataset.clicked='yes'">测试按钮</button>
    <iframe style="position:fixed;left:200px;top:100px;width:200px;height:100px;border:0" srcdoc="<button onclick='document.body.dataset.clicked=1' style='position:fixed;left:0;top:0;width:150px;height:80px'>frame</button>"></iframe>`);
  return { browser, page, peer };
}

const overlay = (page: Page) => page.locator('[data-rpa-coordinate-picker]');
async function select(page: Page, x: number, y: number) {
  await page.keyboard.down('Control'); await page.keyboard.down('Alt');
  try { await page.mouse.click(x, y); }
  finally { await page.keyboard.up('Alt'); await page.keyboard.up('Control'); }
}

describe('interactive coordinate picker', () => {
  it('blocks ordinary clicks, survives strict popup filtering, and returns reusable CSS viewport coordinates', async () => {
    const { browser, page } = await setup();
    const picking = browser.pickPoint('main', new AbortController().signal);
    await overlay(page).waitFor();
    await page.mouse.click(40, 40);
    await page.waitForTimeout(200);
    expect(await overlay(page).isVisible()).toBe(true);
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
    await expect(browser.call('browser.mouseClick', { x: 40, y: 40 })).rejects.toThrow('获取坐标');
    await expect(browser.pickPoint('main', new AbortController().signal)).rejects.toThrow('获取坐标');
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    await select(page, 40, 40);
    expect(await picking).toEqual({ pageId: 'main', x: 40, y: 40 });
    expect(await overlay(page).count()).toBe(0);
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBeUndefined();
    const cdp = await page.context().newCDPSession(page);
    expect((await cdp.send('Browser.getWindowForTarget')).bounds.windowState).toBe('minimized');
    await cdp.detach();
    await browser.call('browser.mouseClick', { x: 40, y: 40 });
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBe('yes');
  });

  it('takes iframe coordinates relative to the main viewport without triggering the frame', async () => {
    const { browser, page } = await setup();
    const picking = browser.pickPoint('main', new AbortController().signal);
    await overlay(page).waitFor();
    await select(page, 240, 130);
    expect(await picking).toEqual({ pageId: 'main', x: 240, y: 130 });
    expect(await page.frameLocator('iframe').locator('body').getAttribute('data-clicked')).toBeNull();
    await browser.call('browser.mouseClick', { x: 240, y: 130 });
    expect(await page.frameLocator('iframe').locator('body').getAttribute('data-clicked')).toBe('1');
  });

  it('cleans up after Escape, explicit cancellation, timeout and an already-cancelled request', async () => {
    const { browser, page } = await setup();
    for (const method of ['escape', 'button', 'abort', 'timeout'] as const) {
      const abort = new AbortController();
      const picking = browser.pickPoint('main', abort.signal, method === 'timeout' ? 800 : 10_000);
      await overlay(page).waitFor();
      if (method === 'escape') await page.keyboard.press('Escape');
      if (method === 'button') await page.getByRole('button', { name: '取消取点' }).click();
      if (method === 'abort') abort.abort();
      expect(await picking).toBeNull();
      expect(await overlay(page).count()).toBe(0);
    }
    const abort = new AbortController(); abort.abort();
    expect(await browser.pickPoint('main', abort.signal)).toBeNull();
    await browser.call('browser.mouseClick', { x: 40, y: 40 });
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBe('yes');
  });

  it('ends on navigation or page closure and releases its execution lock', async () => {
    const { browser, page } = await setup();
    const picking = browser.pickPoint('main', new AbortController().signal);
    const rejected = expect(picking).rejects.toThrow('跳转');
    await overlay(page).waitFor(); await page.goto('about:blank#changed'); await rejected;
    expect(await overlay(page).count()).toBe(0);
    expect(await browser.call('browser.evaluate', { expression: '42' })).toBe(42);
    const again = browser.pickPoint('main', new AbortController().signal);
    const closed = expect(again).rejects.toThrow(/关闭|closed/);
    await overlay(page).waitFor(); await page.close(); await closed;
  });

  it('rejects headless sessions and missing pages without starting another browser', async () => {
    const { browser } = await setup(true);
    await expect(browser.pickPoint('main', new AbortController().signal)).rejects.toThrow('无头');
    await browser.close();
    await expect(browser.pickPoint('main', new AbortController().signal)).rejects.toThrow('已关闭');
  });
});
