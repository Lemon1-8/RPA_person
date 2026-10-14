import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each(['browser.download', 'browser.response'])('%s 等待超时正常返回错误，进程和后续动作仍可用', async method => {
  // Isolate the timer callback: an uncaught exception must fail this test, not the test runner.
  const entry = pathToFileURL(join(process.cwd(), 'packages/browser/src/index.ts')).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { BrowserSession } from ${JSON.stringify(entry)};
    import { EventEmitter } from 'node:events';
    const session = new BrowserSession({ profileDir: 'unused', downloadDir: 'unused', runId: 'audit', headless: true });
    const page = new EventEmitter(); page.evaluate = async () => 'alive';
    session.start = async () => {};
    session.page = () => page;
    session.locator = async () => ({ click: async () => {} });
    let code;
    try { await session.call(${JSON.stringify(method)}, { selector: '#button', urlIncludes: '/never', timeoutMs: 100 }); }
    catch (error) { code = error.code; }
    console.log(JSON.stringify({ code, next: await session.call('browser.evaluate', { expression: 'true' }) }));
  `], { cwd: process.cwd(), windowsHide: true, timeout: 10000 });
  expect(JSON.parse(stdout)).toEqual({ code: method === 'browser.download' ? 'DOWNLOAD_TIMEOUT' : 'RESPONSE_TIMEOUT', next: 'alive' });
});
