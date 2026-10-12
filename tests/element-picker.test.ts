import { afterEach, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { elementPickerSource, disposeElementPicker } from '../packages/browser/src/element-picker.js';
import { BrowserSession } from '../packages/browser/src/index.js';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let browser: Browser | undefined;
afterEach(async () => { await browser?.close(); browser = undefined; });
it('iframe 内拦截普通业务点击，拾取唯一稳定元素并清理界面', async () => {
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.setContent('<iframe srcdoc="<button id=target onclick=window.clicked=true>目标</button>"></iframe>');
  const frame = page.frames()[1]; await frame.locator('#target').waitFor(); await frame.evaluate(elementPickerSource('pick'));
  await frame.locator('#target').click(); expect(await frame.evaluate('window.clicked')).toBeUndefined();
  await frame.locator('#target').click({ modifiers: ['Control','Alt'] });
  const value = await frame.evaluate('window.pick.result'); expect(value).toMatchObject({ selector: '#target', stable: true, text: '目标' });
  expect(await frame.locator('[data-rpa-element-picker]').count()).toBe(0); await frame.evaluate(disposeElementPicker, 'pick');
  await frame.locator('#target').click(); expect(await frame.evaluate('window.clicked')).toBe(true);
});
it('取消后不保留事件监听', async () => {
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage(); await page.setContent('<button id=button onclick=window.clicked=true>按钮</button>');
  await page.evaluate(elementPickerSource('cancel')); await page.evaluate(disposeElementPicker, 'cancel');
  await page.locator('#button').click(); expect(await page.evaluate('window.clicked')).toBe(true);
});
it('通过实际会话拾取跨域嵌套iframe并重新验证保存的定位', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rpa-element-'));
  const server = createServer((request, response) => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<button id="target" onclick="window.clicked=true">跨域按钮</button>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const session = new BrowserSession({ profileDir: join(dir, 'profile'), downloadDir: dir, runId: 'element-test', popupPolicy: 'off' });
  let peer;
  try {
    await session.start(); peer = await chromium.connectOverCDP(`http://127.0.0.1:${session.getInfo().debugPort}`);
    const page = peer.contexts()[0].pages()[0];
    await page.setContent(`<iframe id="outer" srcdoc="<iframe id='inner' src='http://127.0.0.1:${address.port}'></iframe>"></iframe>`);
    const target = page.frameLocator('#outer').frameLocator('#inner').locator('#target'); await target.waitFor();
    const pending = session.pickElement('main');
    await page.frameLocator('#outer').frameLocator('#inner').locator('[data-rpa-element-picker]').waitFor();
    await target.click({ modifiers: ['Control','Alt'] }); const result = await pending;
    expect(result?.element.framePath).toEqual(['#outer','#inner']); expect(result?.element.pageRef).toBe('main');
    expect(await session.validateElement(result!.element)).toMatchObject({ count: 1, texts: ['跨域按钮'] });
    expect(await page.frameLocator('#outer').frameLocator('#inner').locator('[data-rpa-element-picker]').count()).toBe(0);
  } finally { await peer?.close(); await session.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
