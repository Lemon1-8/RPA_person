import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-screenshot-smoke-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const bootstrap = () => page.evaluate(() => window.rpa.bootstrap());
async function save() {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
}
async function run(button) {
  const from = await page.evaluate(() => window.screenshotEvents.length);
  await button.click();
  await page.waitForFunction(from => window.screenshotEvents.slice(from).some(event => event.type === 'run' && ['succeeded', 'failed', 'stopped'].includes(event.status)), from);
  const event = await page.evaluate(from => window.screenshotEvents.slice(from).find(event => event.type === 'run' && ['succeeded', 'failed', 'stopped'].includes(event.status)), from);
  assert.equal(event.status, 'succeeded', event.run?.error);
  return event.run;
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0], name: '网页截图验收', variables: {}, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: true },
    steps: [{ stepId: 'open', name: '打开截图网页', actionType: 'browser.open', params: { url: initial.demoUrl, pageId: 'orders' } }],
  };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：打开截图网页', exact: true }).click();
  const library = page.getByRole('complementary', { name: '指令库' });
  await library.getByRole('button', { name: '网页截图', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '参数与设置' });
  assert.equal(await inspector.getByLabel('截取完整网页', { exact: true }).isChecked(), true);
  await inspector.getByLabel('目标网页', { exact: true }).selectOption('page');
  await inspector.getByLabel('选择网页', { exact: true }).selectOption('orders');
  await inspector.getByLabel('截取完整网页', { exact: true }).uncheck();
  await inspector.getByLabel('保存目录', { exact: true }).fill(join(data, 'pictures'));
  await inspector.getByLabel('文件名称', { exact: true }).fill('订单截图');
  await inspector.getByLabel(/^输出变量/).fill('shot');
  await save();
  const stored = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.steps[1].params, { pageId: 'orders', fullPage: false, directory: join(data, 'pictures'), filename: '订单截图' });
  await page.reload();
  await page.getByRole('button', { name: '步骤 2：网页截图', exact: true }).click();
  assert.equal(await inspector.getByLabel('截取完整网页', { exact: true }).isChecked(), false);
  assert.equal(await inspector.getByLabel('选择网页', { exact: true }).inputValue(), 'orders');
  assert.equal(await inspector.getByLabel('文件名称', { exact: true }).inputValue(), '订单截图');
  await page.evaluate(() => { window.screenshotEvents = []; window.rpa.onEvent(event => window.screenshotEvents.push(event)); });
  const first = await run(page.getByRole('button', { name: '运行', exact: true }));
  assert.equal(first.artifacts.length, 1);
  assert.equal(first.artifacts[0].path, join(data, 'pictures', '订单截图.png'));
  assert.equal(first.variables.shot.pageId, 'orders');
  const bytes = await readFile(first.artifacts[0].path);
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert.equal(first.variables.shot.size, bytes.length);
  await page.getByRole('tab', { name: /下载|产物/ }).click();
  const artifacts = page.getByRole('tabpanel', { name: '下载产物' });
  await artifacts.getByText('订单截图.png', { exact: true }).waitFor();
  await inspector.getByLabel('截取完整网页', { exact: true }).check();
  const second = await run(page.getByRole('button', { name: '单独运行 网页截图', exact: true }));
  assert.equal(second.runId, first.runId, '截图单条运行必须复用现有浏览器');
  assert.equal(second.artifacts.length, 2);
  assert.equal(second.artifacts[1].name, '订单截图 (1).png');
  assert.deepEqual(await readFile(first.artifacts[0].path), bytes, '重复截图不应覆盖原文件');
  await page.getByRole('tab', { name: /下载|产物/ }).click();
  await artifacts.getByText('订单截图 (1).png', { exact: true }).waitFor();
  await save();
  await page.screenshot({ path: join(qa, 'browser-screenshot-success.png'), fullPage: true });
  await page.evaluate(id => window.rpa.controlRun(id, 'closeBrowser'), first.runId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', viewport: true, fullPage: true, singleStep: true, noOverwrite: true, screenshot: join(qa, 'browser-screenshot-success.png') }));
} finally {
  await app?.close();
  const target = resolve(data);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-screenshot-smoke-')) throw new Error('拒绝清理验收目录之外的路径');
  await rm(target, { recursive: true, force: true });
}
