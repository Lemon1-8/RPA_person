import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium, type Dialog } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { PopupGuard, type PopupPolicy } from '../packages/browser/src/popup-guard.js';
import { BrowserSession } from '../packages/browser/src/index.js';
import { validateActionParams, getAction } from '../packages/actions/src/index.js';
import { startPopupFixture } from './fixtures/popup-server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(mode: PopupPolicy = 'smart') {
  const fixture = await startPopupFixture();
  cleanups.push(fixture.close);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const guard = new PopupGuard(context, mode);
  cleanups.push(async () => { await browser.close(); await guard.dispose(); });
  await guard.start();
  const page = await context.newPage();
  await page.goto(fixture.url);
  return { browser, context, guard, page, fixture };
}

describe('智能弹窗屏蔽', () => {
  it('validates a selectable runtime action without a selector', () => {
    expect(getAction('browser.popupGuard').metadata.defaults).toEqual({ mode: 'smart' });
    for (const mode of ['off', 'smart', 'strict']) expect(validateActionParams('browser.popupGuard', { mode })).toEqual({ mode });
    expect(() => validateActionParams('browser.popupGuard', { mode: 'unknown' })).toThrow('参数错误');
  });

  it('hides dynamic marketing and cookie popups with body-level backdrops, preserving business UI', async () => {
    const { page } = await setup();
    await page.evaluate(() => {
      document.body.style.overflow = 'hidden';
      document.body.insertAdjacentHTML('beforeend', '<div class="backdrop" id="shade"></div><div class="popup" id="newsletter" role="dialog">Subscribe to our newsletter</div>');
    });
    await expect.poll(() => page.locator('#newsletter').isVisible()).toBe(false);
    expect(await page.locator('#shade').isVisible()).toBe(false);
    await page.locator('#business-action').click();
    expect(await page.locator('#output').textContent()).toBe('business done');
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('auto');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div id="cookie" class="popup">Cookie consent: accept all</div><div id="login" role="dialog" class="popup">Sign in<input type="password"></div>');
    });
    await expect.poll(() => page.locator('#cookie').isVisible()).toBe(false);
    expect(await page.locator('#login').isVisible()).toBe(true);
    expect(await page.locator('#navigation').isVisible()).toBe(true);
    await page.locator('#newsletter').evaluate(element => { element.textContent = '登录并验证密码'; });
    await expect.poll(() => page.locator('#newsletter').isVisible()).toBe(true);
  });

  it('keeps business confirmations, payments, normal content and fixed navigation visible in strict mode', async () => {
    const { page } = await setup('strict');
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div class="popup" id="confirm">确认删除订单？</div><div class="popup" id="pay">Payment confirmation<input autocomplete="cc-number"></div><div class="popup" id="generic">Welcome message</div><div id="inline">Subscribe to the order status feed</div>');
    });
    await expect.poll(() => page.locator('#generic').isVisible()).toBe(false);
    for (const selector of ['#confirm', '#pay', '#navigation', '#inline', 'h1']) expect(await page.locator(selector).isVisible()).toBe(true);
  });

  it('preserves subscription navigation and does not associate later loading or business masks with an old advertisement', async () => {
    const { page } = await setup();
    await page.locator('#navigation').evaluate(element => { element.textContent = 'Home | Products | Subscriptions'; });
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="popup" id="cookie">Cookie preferences</div>'));
    await expect.poll(() => page.locator('#cookie').isVisible()).toBe(false);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="loading" class="loading-overlay" style="position:fixed;inset:0"></div><div class="backdrop" id="business-mask"></div><div class="popup" id="edit" role="dialog">Edit contact details<input></div>'));
    // A subsequent known advert ensures that the observer has completed a new scan.
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="popup" id="later-ad">Subscribe to newsletter</div>'));
    await expect.poll(() => page.locator('#later-ad').isVisible()).toBe(false);
    for (const selector of ['#navigation', '#loading', '#business-mask', '#edit']) expect(await page.locator(selector).isVisible()).toBe(true);
  });

  it('watches cross-origin frames and newly attached shadow roots', async () => {
    const { page, fixture, guard } = await setup();
    await page.goto(`${fixture.url}/frames`);
    const child = page.frameLocator('#child');
    await child.locator('h1').waitFor();
    await page.frames()[1]!.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<div id="frame-ad" class="popup" role="dialog">Advertisement offer</div>');
      const host = document.createElement('section'); host.id = 'shadow-host'; document.body.append(host);
      host.attachShadow({ mode: 'open' }).innerHTML = '<div id="shadow-ad" role="dialog" style="position:fixed;inset:0;background:white">Subscribe to newsletter</div>';
    });
    await expect.poll(() => child.locator('#frame-ad').isVisible()).toBe(false);
    await expect.poll(() => child.locator('#shadow-ad').isVisible()).toBe(false);
    await guard.setMode('off');
    expect(await child.locator('#frame-ad').isVisible()).toBe(true);
    expect(await child.locator('#shadow-ad').isVisible()).toBe(true);
  });

  it('blocks unsolicited windows while allowing a deliberate normal link and closes extra windows in strict mode', async () => {
    const { page, context, guard } = await setup();
    expect(await page.evaluate(() => window.open('/unsolicited', '_blank') === null)).toBe(true);
    const popup = await Promise.all([page.waitForEvent('popup'), page.locator('#normal').click()]).then(([popup]) => popup);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('/invoice');
    await popup.close();
    const linked = await Promise.all([page.waitForEvent('popup'), page.locator('#link').click()]).then(([popup]) => popup);
    await linked.close();
    await guard.setMode('strict');
    await page.locator('#normal').click();
    await page.locator('#link').click();
    expect(context.pages()).toHaveLength(1);
    const explicit = await context.newPage();
    await explicit.goto(page.url());
    expect(explicit.isClosed()).toBe(false);
  });

  it('dismisses native dialogs without confirming business effects and restores manual dialogs with off', async () => {
    const { page, guard } = await setup();
    await page.locator('#native').click();
    await expect.poll(() => page.locator('#output').textContent()).toBe('done');
    expect(await page.evaluate('({ confirmed: window.confirmed, prompted: window.prompted })')).toEqual({ confirmed: false, prompted: null });
    await guard.setMode('off');
    const dialogEvent = page.waitForEvent('dialog');
    const evaluation = page.evaluate('confirm("Manual confirmation")');
    const dialog: Dialog = await dialogEvent;
    expect(dialog.message()).toBe('Manual confirmation');
    await dialog.accept();
    expect(await evaluation).toBe(true);
    const pendingEvent = page.waitForEvent('dialog');
    const pendingEvaluation = page.evaluate('confirm("Pending manual confirmation")');
    await pendingEvent;
    await guard.setMode('smart');
    expect(await pendingEvaluation).toBe(false);
    await page.locator('#business-action').click();
    await page.evaluate(() => window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; }));
    const beforeUnload = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    expect((await beforeUnload).type()).toBe('beforeunload');
    await expect.poll(() => page.evaluate(() => document.title)).toBe('');
    expect(page.isClosed()).toBe(false);
  });

  it('restores styles and native window.open, and switches policies across repeated navigations without stale patches', async () => {
    const { page, guard, fixture } = await setup('off');
    const nativeOpen = await page.evaluate(() => window.open.toString());
    await guard.setMode('smart');
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="popup" id="cookie" style="visibility:visible">Cookie preferences</div>'));
    await expect.poll(() => page.locator('#cookie').isVisible()).toBe(false);
    await guard.setMode('off');
    expect(await page.locator('#cookie').isVisible()).toBe(true);
    expect(await page.evaluate(() => window.open.toString())).toBe(nativeOpen);
    for (const mode of ['strict', 'off', 'smart', 'off'] as const) {
      await guard.setMode(mode);
      await page.goto(fixture.url);
      await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="popup" id="cookie">Cookie consent</div>'));
      if (mode === 'off') {
        expect(await page.evaluate(() => window.open.toString())).toBe(nativeOpen);
        expect(await page.locator('#cookie').isVisible()).toBe(true);
      } else await expect.poll(() => page.locator('#cookie').isVisible()).toBe(false);
    }
    await expect(guard.dispose()).resolves.toBeUndefined();
    await expect(guard.dispose()).resolves.toBeUndefined();
  });

  it('defaults BrowserSession to smart, permits explicit pageIds in strict mode and releases the profile on shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-popup-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fixture = await startPopupFixture();
    cleanups.push(fixture.close);
    const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: directory, runId: 'popup-test', headless: true });
    cleanups.push(() => browser.close());
    await browser.call('browser.open', { url: fixture.url });
    expect(await browser.call('browser.evaluate', { expression: 'window.open("/ad", "_blank") === null' })).toBe(true);
    expect(await browser.call('browser.popupGuard', { mode: 'strict' })).toEqual({ mode: 'strict' });
    expect(await browser.call('browser.open', { url: fixture.url, pageId: 'invoice' })).toEqual({ pageId: 'invoice', url: `${fixture.url}/` });
    expect(await browser.call('browser.text', { selector: 'h1', pageId: 'invoice' })).toBe('Controlled popup fixture');
    await expect(browser.call('browser.popupGuard', { mode: 'invalid' })).rejects.toThrow('弹窗屏蔽模式');
    await browser.close();
    expect(browser.isOpen()).toBe(false);
    await expect(access(join(directory, 'profile', '.rpa-profile.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('injects working guards from a real tsx source process without leaking transform helpers onto the page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-popup-tsx-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const fixture = await startPopupFixture();
    cleanups.push(fixture.close);
    const options = { profileDir: join(directory, 'profile'), downloadDir: directory, runId: 'popup-tsx', headless: true };
    const expression = `new Promise(resolve => {
      document.body.insertAdjacentHTML('beforeend', '<div id="cookie" role="dialog" style="position:fixed;inset:0">Cookie consent</div>');
      const blocked = window.open('/unsolicited', '_blank') === null;
      let attempts = 0;
      const timer = setInterval(() => {
        const hidden = getComputedStyle(document.querySelector('#cookie')).display === 'none';
        if (hidden || ++attempts >= 25) { clearInterval(timer); resolve({ blocked, hidden, helperGlobal: '__name' in window }); }
      }, 80);
    })`;
    const program = `import { BrowserSession } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'packages/browser/src/index.ts')).href)};
      const browser = new BrowserSession(${JSON.stringify(options)});
      try {
        await browser.call('browser.open', { url: ${JSON.stringify(fixture.url)} });
        const result = await browser.call('browser.evaluate', { expression: ${JSON.stringify(expression)} });
        await browser.call('browser.popupGuard', { mode: 'off' });
        result.restored = await browser.call('browser.evaluate', { expression: 'getComputedStyle(document.querySelector("#cookie")).display !== "none"' });
        process.stdout.write(JSON.stringify(result));
      } finally { await browser.close(); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { timeout: 20_000 });
    expect(JSON.parse(stdout)).toEqual({ blocked: true, hidden: true, helperGlobal: false, restored: true });
  });
});
