import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';
import { startFixtureServer } from './fixtures/server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(headless = true) {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-browser-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const fixture = await startFixtureServer();
  cleanups.push(() => fixture.close());
  const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless, runId: 'test-run' });
  cleanups.push(() => browser.close());
  await browser.start();
  return { browser, directory, fixture };
}

describe('BrowserSession public browser boundary', () => {
  it('queries real orders and reads the rendered table', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
    await browser.call('browser.click', { selector: '#query' });
    await browser.call('browser.assertText', { selector: '#status', text: '查询完成：Alice，已找到 2 条订单' });
    expect(await browser.call('browser.table', { selector: '#orders' })).toEqual({
      headers: ['订单号', '客户', '金额', '状态'],
      rows: [['ORD-1001', 'Alice', '128', 'paid'], ['ORD-1003', 'Alice', '64', 'paid']],
    });
  });

  it('runs low-level mouse and keyboard actions inside the selected browser page', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.evaluate', { expression: `
      document.body.style.minHeight = '2200px';
      document.body.insertAdjacentHTML('afterbegin', '<button id="raw-click" style="position:fixed;left:20px;top:20px;width:100px;height:40px;z-index:9999">raw</button><input id="raw-input" style="position:fixed;left:20px;top:80px;width:180px;height:32px;z-index:9999">');
      document.querySelector('#raw-click').addEventListener('click', () => { document.body.dataset.clicked = 'yes'; });
      document.addEventListener('mousemove', event => { if (event.clientX === 50 && event.clientY === 60) document.body.dataset.moved = 'yes'; });
      null;
    ` });
    await browser.call('browser.mouseMove', { x: 50, y: 60, steps: 2 });
    await browser.call('browser.mouseClick', { x: 30, y: 30, button: 'left', clickCount: 1 });
    expect(await browser.call('browser.evaluate', { expression: '({ clicked: document.body.dataset.clicked, moved: document.body.dataset.moved })' }))
      .toEqual({ clicked: 'yes', moved: 'yes' });
    await browser.call('browser.mouseClick', { x: 30, y: 90 });
    await browser.call('browser.evaluate', { expression: `
      window.__keyTimings = [];
      document.querySelector('#raw-input').addEventListener('keydown', event => window.__keyTimings.push({ type: event.type, at: performance.now() }));
      document.querySelector('#raw-input').addEventListener('keyup', event => window.__keyTimings.push({ type: event.type, at: performance.now() }));
      null;
    ` });
    await browser.call('browser.keyPress', { key: 'ArrowRight' });
    const timings = await browser.call('browser.evaluate', { expression: 'window.__keyTimings' }) as Array<{ type: string; at: number }>;
    expect(timings.map(item => item.type)).toEqual(['keydown', 'keyup']);
    expect(timings[1].at - timings[0].at).toBeGreaterThanOrEqual(40);
    await browser.call('browser.evaluate', { expression: 'window.__keyTimings = []; null' });
    await browser.call('browser.keyboardType', { text: 'Alice' });
    await browser.call('browser.keyPress', { key: 'ControlOrMeta+A' });
    await browser.call('browser.keyboardType', { text: 'Bob' });
    expect(await browser.call('browser.evaluate', { expression: 'document.querySelector("#raw-input").value' })).toBe('Bob');
    await browser.call('browser.mouseWheel', { deltaX: 0, deltaY: 600 });
    await expect.poll(async () => browser.call('browser.evaluate', { expression: 'window.scrollY' }), { timeout: 3_000 }).toBeGreaterThan(0);
  });

  it('isolates two browser profiles and refuses a leased profile across processes', async () => {
    const { browser, directory, fixture } = await setup();
    const other = new BrowserSession({ profileDir: join(directory, 'other-profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'other' });
    cleanups.push(() => other.close());
    await other.start();
    expect(browser.getInfo()).toMatchObject({ browserChannel: 'chromium' });
    expect(browser.getInfo().debugPort).toBeGreaterThan(0);
    expect(other.getInfo().debugPort).not.toBe(browser.getInfo().debugPort);
    await browser.call('browser.open', { url: fixture.url });
    await other.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
    await other.call('browser.fill', { selector: '#customer', value: 'Bob' });
    await browser.call('browser.click', { selector: '#query' });
    await other.call('browser.click', { selector: '#query' });
    await browser.call('browser.assertText', { selector: '#status', text: '查询完成：Alice，已找到 2 条订单' });
    await other.call('browser.assertText', { selector: '#status', text: '查询完成：Bob，已找到 1 条订单' });

    const duplicate = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'duplicate' });
    cleanups.push(() => duplicate.close());
    await expect(duplicate.start()).rejects.toThrow('配置目录正在使用');
    await duplicate.close();
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `import { BrowserSession } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages/browser/src/index.ts')).href)};
       const session = new BrowserSession(${JSON.stringify({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'child' })});
       try { await session.start(); process.stdout.write('UNEXPECTED_SUCCESS'); }
       catch (error) { process.stdout.write(error.code ?? error.message); }
       finally { await session.close(); }`,
    ], { timeout: 20_000 });
    expect(stdout).toBe('PROFILE_IN_USE');
    await browser.close();
    const replacement = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'replacement' });
    cleanups.push(() => replacement.close());
    await replacement.start();
    expect(await replacement.call('browser.open', { url: fixture.url })).toEqual({ pageId: 'main', url: `${fixture.url}/` });
  });

  it('uses cross-origin nested frames and keeps script updates in the current page', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    const element = { pageRef: 'main', framePath: ['#outer-frame', '#inner-frame'], selector: '#frame-input', expectedCount: 1 };
    await browser.call('browser.fill', { element, value: 'frame value' });
    expect(await browser.call('browser.text', { element: { ...element, selector: '#frame-text' } })).toBe('Nested frame ready');
    await expect(browser.call('browser.click', { selector: '.ambiguous' })).rejects.toThrow(/歧义|strict mode/);
    await browser.call('browser.evaluate', { expression: "document.querySelector('#customer').value = 'Bob'" });
    await browser.call('browser.select', { selector: '#order-status', value: 'pending' });
    await browser.call('browser.click', { selector: '#query' });
    await browser.call('browser.wait', { selector: '#orders tbody tr' });
    expect(await browser.call('browser.table', { selector: '#orders' })).toEqual({ headers: ['订单号', '客户', '金额', '状态'], rows: [['ORD-1002', 'Bob', '256', 'pending']] });
    expect(await browser.call('browser.evaluate', { expression: '({ customer: document.querySelector("#customer").value, count: document.querySelectorAll("#orders tbody tr").length })' })).toEqual({ customer: 'Bob', count: 1 });
  });

  it('can DOM-click an XPath target that is present but not pointer-clickable', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.evaluate', { expression: `
      document.body.insertAdjacentHTML('afterbegin', '<button id="blocked-click" style="pointer-events:none"><span>月</span></button>');
      document.querySelector('#blocked-click').addEventListener('click', () => { document.body.dataset.domClicked = 'yes'; });
      null;
    ` });

    await expect(browser.call('browser.click', { selector: '//*[@id="blocked-click"]/span', timeoutMs: 300 }))
      .rejects.toThrow(/元素已定位|Timeout/);
    expect(await browser.call('browser.evaluate', { expression: 'document.body.dataset.domClicked ?? null' })).toBeNull();
    await expect(browser.call('browser.click', { selector: '//*[@id="blocked-click"]/span', clickMode: 'dom', timeoutMs: 300 }))
      .resolves.toEqual({ ok: true });
    expect(await browser.call('browser.evaluate', { expression: 'document.body.dataset.domClicked' })).toBe('yes');

    await browser.call('browser.evaluate', { expression: 'delete document.body.dataset.domClicked' });
    await expect(browser.call('browser.click', { selector: '/html/body/button[@id="blocked-click"]/span', clickMode: 'dom', timeoutMs: 300 }))
      .resolves.toEqual({ ok: true });
    expect(await browser.call('browser.evaluate', { expression: 'document.body.dataset.domClicked' })).toBe('yes');
  });

  it('captures the triggered response instead of an older matching request already in flight', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
    await browser.call('browser.evaluate', { expression: "void fetch('/api/orders?customer=Alice&delayMs=80')" });
    const response = await browser.call('browser.response', { selector: '#fetch-response', urlIncludes: '/api/orders', method: 'GET', requestIncludes: 'customer=Alice' });
    expect(response).toMatchObject({ status: 200, method: 'GET', requestBody: null, body: { requestId: 2, customer: 'Alice', orders: [{ id: 'ORD-1001' }, { id: 'ORD-1003' }] } });
  });

  it('saves simultaneous delayed downloads without overwriting and retains files after browser close', async () => {
    const { browser, directory, fixture } = await setup();
    const other = new BrowserSession({ profileDir: join(directory, 'other-profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'other' });
    cleanups.push(() => other.close());
    await other.start();
    await browser.call('browser.open', { url: fixture.url });
    await other.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
    await other.call('browser.fill', { selector: '#customer', value: '跨语言订单' });
    const downloads = await Promise.all([
      browser.call('browser.download', { selector: '#download', filename: 'report.csv' }),
      other.call('browser.download', { selector: '#download', filename: 'report.csv' }),
    ]) as Array<{ path: string; name: string; size: number; sourceUrl: string }>;
    await browser.close();
    await other.close();
    expect(downloads.map((file) => file.name).sort()).toEqual(['report (1).csv', 'report.csv']);
    expect(await readFile(downloads[0]!.path, 'utf8')).toBe('order_id,customer,amount,status\nORD-1001,Alice,128,paid\nORD-1003,Alice,64,paid\n');
    expect(await readFile(downloads[1]!.path, 'utf8')).toBe('order_id,customer,amount,status\nORD-DEMO,跨语言订单,32,paid\n');
    expect((await stat(downloads[1]!.path)).size).toBe(downloads[1]!.size);
    expect(downloads[0]!.sourceUrl).toContain('/download?customer=Alice');
  });

  it.each([true, false])('downloads again after reopening the same persistent browser profile (headless=%s)', async (headless) => {
    const { browser, directory, fixture } = await setup(headless);
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'Alice' });
    await browser.call('browser.download', { selector: '#download', filename: 'repeat.csv' });
    await browser.call('browser.evaluate', { expression: 'localStorage.setItem("retained", "session-data")' });
    await browser.close();
    const history = new DatabaseSync(join(directory, 'profile', 'Default', 'History'), { readOnly: true });
    try {
      expect(history.prepare('SELECT COUNT(*) AS count FROM downloads').get()?.count).toBe(0);
      expect(history.prepare('SELECT COUNT(*) AS count FROM urls WHERE url = ?').get(`${fixture.url}/`)?.count).toBeGreaterThan(0);
    } finally { history.close(); }
    const next = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless, runId: 'download-again' });
    cleanups.push(() => next.close());
    await next.start();
    await next.call('browser.open', { url: fixture.url });
    expect(await next.call('browser.evaluate', { expression: 'localStorage.getItem("retained")' })).toBe('session-data');
    await next.call('browser.fill', { selector: '#customer', value: 'Bob' });
    const file = await next.call('browser.download', { selector: '#download', filename: 'repeat.csv' }) as { path: string };
    expect(await readFile(file.path, 'utf8')).toBe('order_id,customer,amount,status\nORD-1002,Bob,256,pending\n');
  });

  it('restores and minimizes a real headed window while retaining the same page state', async () => {
    const { browser, fixture, directory } = await setup(false);
    expect(['chrome', 'msedge']).toContain(browser.getInfo().browserChannel);
    const other = new BrowserSession({ profileDir: join(directory, 'second-native-profile'), downloadDir: join(directory, 'downloads'), headless: false, runId: 'second-native' });
    cleanups.push(() => other.close());
    await other.start();
    expect(other.getInfo().browserChannel).toBe(browser.getInfo().browserChannel);
    expect(other.getInfo().debugPort).not.toBe(browser.getInfo().debugPort);
    await browser.call('browser.open', { url: fixture.url });
    await browser.call('browser.fill', { selector: '#customer', value: 'same headed session' });
    expect(await browser.call('browser.show', {})).toEqual({ state: 'normal', headless: false });
    expect(await browser.call('browser.hide', {})).toEqual({ state: 'minimized', headless: false });
    expect(await browser.call('browser.evaluate', { expression: 'document.querySelector("#customer").value' })).toBe('same headed session');
    await browser.call('browser.click', { selector: '#query' });
    await browser.call('browser.assertText', { selector: '#status', text: '查询完成：same headed session，已找到 1 条订单' });
  });

  it('discards the session when evaluated page code times out so delayed mutations cannot leak into later steps', async () => {
    const { browser, fixture } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await expect(browser.call('browser.evaluate', {
      expression: 'new Promise(resolve => setTimeout(() => { document.querySelector("#customer").value = "late mutation"; resolve(true); }, 500))',
      timeoutMs: 60,
    })).rejects.toThrow('浏览器操作超过 60 毫秒');
    await expect(browser.call('browser.text', { selector: '#status' })).rejects.toThrow('浏览器会话已经关闭');
  });

  it('reports closure once after releasing the profile so its owner can start a replacement browser', async () => {
    const { browser, directory, fixture } = await setup();
    const replacement = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'replacement-after-notification' });
    cleanups.push(() => replacement.close());
    let notifications = 0;
    let replacementStarted: Promise<void> | undefined;
    let removedNotifications = 0;
    const unsubscribe = browser.onClosed(() => { removedNotifications++; });
    unsubscribe();
    browser.onClosed(() => {
      notifications++;
      expect(browser.isOpen()).toBe(false);
      replacementStarted = replacement.start();
    });
    expect(browser.isOpen()).toBe(true);
    expect(replacement.isOpen()).toBe(false);
    await Promise.all([browser.close(), browser.close()]);
    await replacementStarted;
    await browser.close();
    expect(notifications).toBe(1);
    expect(removedNotifications).toBe(0);
    expect(replacement.isOpen()).toBe(true);
    expect(await browser.screenshot(join(directory, 'closed.png'))).toBeUndefined();
    expect(await replacement.call('browser.open', { url: fixture.url })).toEqual({ pageId: 'main', url: `${fixture.url}/` });
    await expect(browser.start()).rejects.toThrow('浏览器会话已经关闭');
  });

  it('releases a headed browser profile when its last window closes outside the session API', async () => {
    const { browser, directory } = await setup(false);
    const replacement = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'replacement-after-window-close' });
    cleanups.push(() => replacement.close());
    let notifications = 0;
    let replacementStarted: Promise<void> | undefined;
    const unsubscribe = browser.onClosed(() => {
      notifications++;
      replacementStarted = replacement.start();
    });
    cleanups.push(async () => unsubscribe());
    // Chromium permits the untouched initial page to close its single-entry window.
    // This exercises the real browser close event without calling BrowserSession.close().
    await browser.call('browser.evaluate', { expression: 'void setTimeout(() => window.close(), 20)' });
    await expect.poll(() => browser.isOpen(), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => notifications, { timeout: 5_000 }).toBe(1);
    await replacementStarted;
    expect(replacement.isOpen()).toBe(true);
    await browser.close();
    expect(notifications).toBe(1);
    await expect(browser.call('browser.evaluate', { expression: 'true' })).rejects.toThrow('浏览器会话已经关闭');
  });

  it('rejects an occupied debug port and releases its profile for another start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-port-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.listening ? server.close(error => error ? reject(error) : resolve()) : resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener port');
    const options = { profileDir: join(directory, 'profile'), downloadDir: directory, headless: true, runId: 'occupied-port' };
    const blocked = new BrowserSession({ ...options, debugPort: address.port });
    cleanups.push(() => blocked.close());
    await expect(blocked.start()).rejects.toMatchObject({ code: 'DEBUG_PORT_IN_USE' });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const replacement = new BrowserSession({ ...options, debugPort: address.port });
    cleanups.push(() => replacement.close());
    await replacement.start();
    expect(replacement.isOpen()).toBe(true);
    expect(replacement.getInfo().debugPort).toBe(address.port);
  });

  it('cancels startup and releases the profile without leaving a browser process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-start-cancel-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const options = { profileDir: join(directory, 'profile'), downloadDir: directory, headless: true, runId: 'cancel-start' };
    const browser = new BrowserSession(options);
    cleanups.push(() => browser.close());
    const startup = browser.start();
    const rejected = expect(startup).rejects.toMatchObject({ code: 'BROWSER_START_CANCELLED' });
    await browser.close();
    await rejected;
    expect(browser.isOpen()).toBe(false);
    const replacement = new BrowserSession(options);
    cleanups.push(() => replacement.close());
    await replacement.start();
    expect(replacement.isOpen()).toBe(true);
  });
});
