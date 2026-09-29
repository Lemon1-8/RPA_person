import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-xlsx-desktop-'));
const file = resolve('tests/fixtures/zip64-sample.xlsx');
const output = join(data, '选定的输出.xlsx');
const qa = resolve('.rpa/qa');
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const workflow = { ...initial.workflows[0], name: 'XLSX 循环验收', variables: {}, elements: {}, steps: [],
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false } };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), workflow);
  await page.reload();
  await page.getByRole('heading', { name: workflow.name, exact: true }).waitFor();
  const files = page.locator('.action-group').filter({ has: page.getByRole('heading', { name: '文件', exact: true }) });
  await app.evaluate(({ dialog }, paths) => {
    globalThis.xlsxPicker = { openPath: paths[0], savePath: paths[1], cancel: false, calls: [] };
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.xlsxPicker.calls.push({ mode: 'open', options });
      return globalThis.xlsxPicker.cancel ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [globalThis.xlsxPicker.openPath] };
    };
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.xlsxPicker.calls.push({ mode: 'save', options });
      return { canceled: false, filePath: globalThis.xlsxPicker.savePath };
    };
  }, [file, output]);
  await files.getByRole('button', { name: '遍历 XLSX', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await inspector.getByRole('button', { name: '选择 XLSX 文件' }).click();
  await page.waitForFunction(path => document.querySelector('input[aria-label="文件路径"]')?.value === path, file);
  assert.equal(await inspector.getByLabel('文件路径', { exact: true }).inputValue(), file);
  await app.evaluate(() => { globalThis.xlsxPicker.cancel = true; });
  await inspector.getByRole('button', { name: '选择 XLSX 文件' }).click();
  assert.equal(await inspector.getByLabel('文件路径', { exact: true }).inputValue(), file, '取消选择应保留原路径');
  await app.evaluate(() => { globalThis.xlsxPicker.cancel = false; });
  await inspector.getByLabel('工作表名称', { exact: true }).fill('订单');
  await inspector.getByLabel('当前项变量', { exact: true }).fill('row');
  const loop = page.getByRole('group', { name: '遍历 XLSX：循环体', exact: true });
  await loop.getByRole('button', { name: '添加到循环体', exact: true }).click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true })
    .getByRole('button', { name: '打印日志', exact: true }).click();
  await inspector.getByLabel(/^日志内容/).fill('{{row}}[0]');
  await page.getByRole('button', { name: '单独运行 遍历 XLSX', exact: true }).click();
  let run;
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    run = (await page.evaluate(() => window.rpa.bootstrap())).runs[0];
    if (run && ['succeeded', 'failed', 'stopped'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(run?.status, 'succeeded', run?.error ?? 'XLSX 循环未在 20 秒内完成');
  await files.getByRole('button', { name: '读取 XLSX', exact: true }).click();
  await inspector.getByRole('button', { name: '选择 XLSX 文件' }).click();
  await page.waitForFunction(path => document.querySelector('input[aria-label="文件路径"]')?.value === path, file);
  assert.equal(await inspector.getByLabel('文件路径', { exact: true }).inputValue(), file);
  await app.evaluate(() => { globalThis.xlsxPicker.openPath = 'C:\\wrong.csv'; });
  await inspector.getByRole('button', { name: '选择 XLSX 文件' }).click();
  await inspector.getByRole('alert').getByText('请选择 .xlsx 文件').waitFor();
  assert.equal(await inspector.getByLabel('文件路径', { exact: true }).inputValue(), file, '不支持的扩展名不能覆盖已选路径');
  await files.getByRole('button', { name: '保存 XLSX', exact: true }).click();
  await inspector.getByRole('button', { name: '选择 XLSX 保存位置' }).click();
  await page.waitForFunction(path => document.querySelector('input[aria-label="文件路径"]')?.value === path, output);
  assert.equal(await inspector.getByLabel('文件路径', { exact: true }).inputValue(), output);
  const calls = await app.evaluate(() => globalThis.xlsxPicker.calls);
  assert.deepEqual(calls.map(call => call.mode), ['open', 'open', 'open', 'open', 'save']);
  assert.ok(calls.every(call => call.options.filters?.[0]?.extensions?.includes('xlsx')), '文件窗口仅选择 XLSX');
  assert.deepEqual(calls[0].options.properties, ['openFile']);
  await mkdir(qa, { recursive: true });
  await page.screenshot({ path: join(qa, 'xlsx-picker-success.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', zip64Loop: true, rowVariable: true, nativeFilePicker: true, cancelPreservesPath: true, saveAsPicker: true, screenshot: join(qa, 'xlsx-picker-success.png') }));
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-xlsx-desktop-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
