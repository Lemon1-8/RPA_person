import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';
import { resolveBrowser } from '../packages/browser/src/native-browser.js';
import { observeForeground } from './fixtures/foreground-observer.js';

for (const channel of ['chrome', 'msedge'] as const) {
it.skipIf(process.platform !== 'win32')(`${channel} starts and executes browser input without activating its native window`, async ({ skip }) => {
  try { await resolveBrowser(channel, false); } catch { skip(); return; }
  const directory = await mkdtemp(join(tmpdir(), 'rpa-background-test-'));
  const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: directory, headless: false, browserChannel: channel, runId: 'background-test' });
  const observer = await observeForeground();
  try {
    expect(observer.events[0]?.hwnd).not.toBe('0');
    observer.phase('startup');
    // Edge may create an auxiliary native window shortly after CDP is ready.
    await browser.start(); await new Promise(resolve => setTimeout(resolve, 1_500));
    const pid = (browser as unknown as { native: { child: { pid: number } } }).native.child.pid;
    observer.phase('open');
    await browser.call('browser.open', { url: 'data:text/html,<input id="input" style="position:fixed;left:20px;top:20px;width:200px;height:40px"><a id="new" href="about:blank" target="_blank">open</a><div style="height:3000px"></div>' });
    observer.phase('input');
    await browser.call('browser.mouseClick', { x: 40, y: 40 });
    await browser.call('browser.keyboardType', { text: 'Alice' });
    await browser.call('browser.keyPress', { key: 'ControlOrMeta+A' });
    await browser.call('browser.keyboardType', { text: 'Bob' });
    expect(await browser.call('browser.evaluate', { expression: 'document.querySelector("#input").value' })).toBe('Bob');
    observer.phase('wheel');
    await browser.call('browser.mouseMove', { x: 500, y: 500 });
    await browser.call('browser.mouseWheel', { deltaX: 0, deltaY: 300 });
    await expect.poll(() => browser.call('browser.evaluate', { expression: 'scrollY' }), { timeout: 3_000 }).toBeGreaterThan(0);
    observer.phase('new-tab');
    await browser.call('browser.open', { url: 'about:blank', openMode: 'new', pageId: 'second' });
    await new Promise(resolve => setTimeout(resolve, 100));
    observer.phase('switch');
    await browser.call('browser.switchPage', { pageId: 'main' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(observer.events.filter(event => event.pid === pid), JSON.stringify(observer.events)).toEqual([]);
    // Business popups remain allowed even when Chromium activates their window.
    observer.phase('popup');
    await browser.call('browser.click', { selector: '#new' });
    await expect.poll(async () => (await browser.listPages()).filter(page => page.openerPageId === 'main').length).toBe(1);
  } finally {
    await browser.close(); observer.stop();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('rpa-background-test-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
}
