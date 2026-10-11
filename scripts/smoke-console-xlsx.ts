import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-console-xlsx-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const workflow = { ...initial.workflows[0], name: 'XLSX 下标与面板验收', steps: [
    { stepId: 'xlsx-loop', name: '按下标遍历', actionType: 'control.forEachXlsx',
      params: { path: resolve('tests/fixtures/zip64-sample.xlsx'), sheetName: '订单', valueMode: 'array', itemVariable: 'row' }, children: [
        { stepId: 'log', name: '打印日志', actionType: 'core.log', params: { message: '{{row}}[0]' } },
      ] },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), workflow);
  await page.reload();
  await page.getByRole('heading', { name: 'XLSX 下标与面板验收', exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：按下标遍历', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  assert.equal(await inspector.getByLabel('遍历内容').inputValue(), 'array');
  await inspector.getByText('每轮是一整行；用', { exact: false }).waitFor();
  assert.equal(await inspector.getByLabel('列下标（从 0 开始）').count(), 0);
  await inspector.getByLabel('遍历内容').selectOption('column');
  assert.equal(await inspector.getByLabel('列下标（从 0 开始）').inputValue(), '0');
  await inspector.getByLabel('列下标（从 0 开始）').fill('1');
  await inspector.getByLabel('遍历内容').selectOption('row');
  assert.equal(await inspector.getByLabel('列下标（从 0 开始）').count(), 0);
  await page.getByRole('button', { name: '步骤 2：打印日志', exact: true }).click();
  await inspector.getByRole('textbox', { name: /^日志内容/ }).fill('{{row}}.0');
  const legacyHint = await inspector.locator('small.field-error').textContent();
  assert.ok(legacyHint?.includes('普通文字') && legacyHint.includes('整行对象'));
  await inspector.getByRole('button', { name: '切换整行数组并修正下标' }).click();
  assert.equal(await inspector.getByRole('textbox', { name: /^日志内容/ }).inputValue(), '{{row}}[0]');
  await page.getByRole('button', { name: '步骤 1：按下标遍历', exact: true }).click();
  assert.equal(await inspector.getByLabel('遍历内容').inputValue(), 'array');
  await inspector.getByLabel('遍历内容').selectOption('row');
  await inspector.getByLabel('遍历内容').selectOption('column');
  assert.equal(await inspector.getByLabel('列下标（从 0 开始）').inputValue(), '1');
  await inspector.getByLabel('遍历内容').selectOption('array');
  await page.getByRole('button', { name: '步骤 2：打印日志', exact: true }).click();
  await inspector.getByText('当前行是数组：', { exact: false }).waitFor();
  await inspector.getByRole('textbox', { name: /^日志内容/ }).fill('{{row}}.0');
  assert.equal(await inspector.locator('small.field-error').count(), 1);
  await inspector.getByRole('textbox', { name: /^日志内容/ }).fill('{{row}}[0]');

  const consolePanel = page.getByRole('region', { name: '运行监控' });
  const before = (await page.locator('.step-scroll').boundingBox())!;
  await page.getByRole('button', { name: '运行结果', exact: true }).click();
  const monitor = (await consolePanel.boundingBox())!;
  const after = (await page.locator('.step-scroll').boundingBox())!;
  assert.ok(Math.abs(before.height - after.height) <= 1, '切换运行结果不能减少流程高度');
  assert.ok(monitor.x >= (await inspector.boundingBox())!.x, '运行结果必须位于右栏');
  await page.reload();
  await page.getByRole('heading', { name: 'XLSX 下标与面板验收', exact: true }).waitFor();
  assert.equal(await consolePanel.isVisible(), true, '重新打开后应记住右栏内容');
  await page.getByRole('button', { name: '步骤编辑', exact: true }).click();
  assert.equal(await consolePanel.isVisible(), false);
  await page.getByRole('button', { name: '步骤 2：打印日志', exact: true }).click();
  assert.equal(await inspector.getByRole('textbox', { name: /^日志内容/ }).inputValue(), '{{row}}[0]');
  await page.screenshot({ path: join(qa, 'console-xlsx-success.png'), fullPage: true });
  console.log('三栏切换及 XLSX 下标界面冒烟测试通过');
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-console-xlsx-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
