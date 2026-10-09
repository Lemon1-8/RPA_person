import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actionDefinitions, validateActionParams } from '../packages/actions/src/index.js';
import { BrowserSession } from '../packages/browser/src/index.js';
import type { BrowserScreenshotResult, RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { getStepDetails } from '../apps/desktop/src/renderer/step-summary.js';
import { getVariableOptions } from '../apps/desktop/src/renderer/variable-options.js';
import { startFixtureServer } from './fixtures/server.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-screenshot-'));
  cleanups.push(async () => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-screenshot-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  });
  const fixture = await startFixtureServer();
  cleanups.push(() => fixture.close());
  const browser = new BrowserSession({ profileDir: join(directory, 'profile'), downloadDir: join(directory, 'downloads'), headless: true, runId: 'screenshot' });
  cleanups.push(() => browser.close());
  return { directory, fixture, browser };
}

async function png(result: BrowserScreenshotResult) {
  const bytes = await readFile(result.path);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(result.size).toBe(bytes.length);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function blockFonts(browser: BrowserSession) {
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  const server = createServer((_request, response) => { response.setHeader('Access-Control-Allow-Origin', '*'); requested(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  await browser.call('browser.evaluate', { expression: `
    const font = new FontFace('ScreenshotWait', 'url(http://127.0.0.1:${port}/font)');
    document.fonts.add(font); void font.load().catch(() => {}); null;
  ` });
  await request;
}

describe('网页截图指令', () => {
  it('提供整页默认值，并校验保存路径、PNG 文件名和参数类型', () => {
    const action = actionDefinitions.find(action => action.type === 'browser.screenshot')!;
    expect(action.defaults).toMatchObject({ pageId: '$current', fullPage: true, directory: '', filename: '' });
    expect(validateActionParams(action.type, {})).toEqual({});
    expect(validateActionParams(action.type, { filename: '订单', fullPage: false })).toEqual({ filename: '订单', fullPage: false });
    for (const params of [
      { directory: 'relative' }, { filename: '../page.png' }, { filename: 'C:\\page.png' },
      { filename: 'page.jpg' }, { filename: 'NUL.png' }, { filename: ' page.png' },
      { filename: '   ' }, { filename: 'page.' }, { fullPage: 'false' }, { pageId: { pageId: 'main' } },
    ]) expect(() => validateActionParams(action.type, params), JSON.stringify(params)).toThrow('参数错误');
  });

  it('截取指定网页与当前可见区域，输出真实 PNG，且不切换后续目标', async () => {
    const { browser, fixture, directory } = await setup();
    await browser.call('browser.open', { url: fixture.url, pageId: 'orders' });
    await browser.call('browser.evaluate', { expression: "document.body.style.minHeight = '2200px'; null" });
    await browser.call('browser.open', { url: `${fixture.url}/?detail`, pageId: 'detail', openMode: 'new' });
    await browser.call('browser.evaluate', { expression: "document.body.style.minHeight = '3100px'; null" });
    await browser.call('browser.switchPage', { pageId: 'orders' });
    const whole = await browser.call('browser.screenshot', { pageId: 'detail', directory: join(directory, 'nested', 'pictures'), filename: '详情' }) as BrowserScreenshotResult;
    expect(whole).toMatchObject({ name: '详情.png', pageId: 'detail', sourceUrl: `${fixture.url}/?detail` });
    expect((await png(whole)).height).toBeGreaterThanOrEqual(3100);
    expect((await browser.listPages()).find(page => page.current)?.pageId).toBe('orders');
    const metrics = await browser.call('browser.evaluate', { expression: '({ width: innerWidth, height: innerHeight })' });
    const viewport = await browser.call('browser.screenshot', { fullPage: false }) as BrowserScreenshotResult;
    expect(viewport).toMatchObject({ path: join(directory, 'downloads', 'screenshot.png'), name: 'screenshot.png', pageId: 'orders' });
    expect(await png(viewport)).toEqual(metrics);
    const defaultWhole = await browser.call('browser.screenshot', {}) as BrowserScreenshotResult;
    expect((await png(defaultWhole)).height).toBeGreaterThanOrEqual(2200);
    expect(defaultWhole.name).toBe('screenshot (1).png');
  });

  it('跨会话保存同名截图不会覆盖已有文件', async () => {
    const { browser, fixture, directory } = await setup();
    const output = join(directory, 'downloads');
    await browser.call('browser.open', { url: fixture.url });
    await writeFile(join(output, 'report.png'), 'existing');
    const other = new BrowserSession({ profileDir: join(directory, 'other-profile'), downloadDir: output, headless: true, runId: 'other' });
    cleanups.push(() => other.close());
    await other.call('browser.open', { url: fixture.url });
    const results = await Promise.all([browser, other].map(browser => browser.call('browser.screenshot', { filename: 'report.png' }))) as BrowserScreenshotResult[];
    expect(new Set(results.map(result => result.name))).toEqual(new Set(['report (1).png', 'report (2).png']));
    expect(await readFile(join(output, 'report.png'), 'utf8')).toBe('existing');
    for (const result of results) await png(result);
  });

  it('缺失或关闭的网页以及不可写目录明确失败', async () => {
    const { browser, fixture, directory } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await expect(browser.call('browser.screenshot', { pageId: 'missing' })).rejects.toThrow('不存在或已关闭');
    await browser.call('browser.open', { url: fixture.url, pageId: 'detail', openMode: 'new' });
    await browser.call('browser.closePage', { pageId: 'detail' });
    await expect(browser.call('browser.screenshot', { pageId: 'detail' })).rejects.toThrow('不存在或已关闭');
    const blocked = join(directory, 'not-a-directory');
    await writeFile(blocked, 'file');
    await expect(browser.call('browser.screenshot', { pageId: 'main', directory: join(blocked, 'child') })).rejects.toThrow();
    expect(await readdir(join(directory, 'downloads'))).toEqual([]);
  });

  it('截图等待超时不会留下空文件，浏览器仍可继续操作', async () => {
    const { browser, fixture, directory } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await blockFonts(browser);
    await expect(browser.call('browser.screenshot', { timeoutMs: 200 })).rejects.toThrow(/Timeout|超时/);
    expect(await readdir(join(directory, 'downloads'))).toEqual([]);
    await browser.call('browser.evaluate', { expression: 'document.fonts.clear(); null' });
    expect(await browser.call('browser.text', { selector: 'h1' })).toBeTruthy();
  });

  it('关闭浏览器会中断正在等待的截图，不生成文件', async () => {
    const { browser, fixture, directory } = await setup();
    await browser.call('browser.open', { url: fixture.url });
    await blockFonts(browser);
    const pending = expect(browser.call('browser.screenshot', { timeoutMs: 10_000 })).rejects.toThrow(/closed|关闭|abort/i);
    await new Promise(resolve => setTimeout(resolve, 100));
    await browser.close();
    await pending;
    expect(await readdir(join(directory, 'downloads'))).toEqual([]);
  });

  it('流程与脚本调用共用截图能力，继承目录并登记产物和输出变量', async () => {
    const { directory, fixture } = await setup();
    const events: RunEvent[] = [];
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'screenshot-flow', name: '截图流程', revision: 1,
      variables: { filename: '订单' }, elements: {}, settings: { downloadDir: join(directory, 'flow-output'), headless: true, keepBrowserOpen: false },
      steps: [
        { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: fixture.url }, output: 'opened' },
        { stepId: 'shot', name: '网页截图', actionType: 'browser.screenshot', params: { pageId: '{{opened.pageId}}', filename: '{{filename}}', directory: '' }, settings: { downloadDir: join(directory, 'step-output') }, output: 'shot' },
        { stepId: 'path', name: '引用截图路径', actionType: 'variables.set', params: { name: 'savedPath', value: '{{shot.path}}' } },
        { stepId: 'script', name: '脚本截图', actionType: 'script.run', params: { language: 'javascript', code: "rpa.output(await rpa.call('browser.screenshot', { fullPage: false }));" }, output: 'scriptShot' },
      ],
    };
    const engine = new WorkflowEngine(workflow, { dataDir: directory, runId: 'flow-run', onEvent: event => events.push(event) });
    cleanups.push(() => engine.control('closeBrowser'));
    const result = await engine.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts[0]).toMatchObject({ path: join(directory, 'step-output', '订单.png'), stepId: 'shot' });
    expect(result.artifacts[1]).toMatchObject({ path: join(directory, 'flow-output', 'screenshot.png'), stepId: 'script' });
    expect(result.variables.savedPath).toBe(result.artifacts[0].path);
    expect(result.variables.scriptShot).toMatchObject({ path: result.artifacts[1].path });
    expect(events.filter(event => event.type === 'artifact').map(event => event.data)).toEqual(result.artifacts);
    for (const artifact of result.artifacts) await png(artifact as BrowserScreenshotResult);
    expect(getVariableOptions(workflow, 'path').map(option => option.name)).toEqual(expect.arrayContaining(['shot.path', 'shot.name', 'shot.size', 'shot.sourceUrl', 'shot.pageId']));
    const action = actionDefinitions.find(action => action.type === 'browser.screenshot');
    expect(getStepDetails({ stepId: 'summary', name: '截图', actionType: 'browser.screenshot', params: {} }, action)).toEqual([
      { label: '目标网页', value: '当前网页' }, { label: '截图范围', value: '完整网页' },
    ]);
  });
});
