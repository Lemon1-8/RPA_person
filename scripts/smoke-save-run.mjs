import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-save-run-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const flow = {
    ...initial.workflows[0], name: '保存运行验收', variables: {}, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [{ stepId: 'set', name: '设置验收值', actionType: 'variables.set', params: { name: 'savedValue', value: 42 }, output: 'optionalOutput' }],
  };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置' });
  await page.getByRole('button', { name: '步骤 1：设置验收值', exact: true }).click();
  await inspector.getByRole('textbox', { name: /^输出变量/ }).fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const saved = (await page.evaluate(() => window.rpa.bootstrap())).workflows[0];
  assert.equal(Object.hasOwn(saved.steps[0], 'output'), false, '清空输出变量后，磁盘流程应省略该字段');

  async function runFromToolbar() {
    const prior = (await page.evaluate(() => window.rpa.bootstrap())).runs.map(run => run.runId);
    await page.getByRole('button', { name: '运行', exact: true }).click();
    let state;
    let run;
    const deadline = Date.now() + 15000;
    do {
      state = await page.evaluate(() => window.rpa.bootstrap());
      run = state.runs.find(run => !prior.includes(run.runId));
      if (run && ['succeeded', 'failed', 'stopped'].includes(run.status)
        || await page.locator('.alert[role="alert"]').count()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const alerts = page.locator('.alert[role="alert"]');
    const alertCount = await alerts.count();
    assert.equal(alertCount, 0, alertCount ? await alerts.first().textContent() : '保存后运行不应报错');
    assert.equal(run?.status, 'succeeded', run?.error);
    assert.equal(run.variables.savedValue, 42);
    assert.equal(run.revision, state.workflows[0].revision, '运行必须使用当前已保存修订');
    assert.equal(Object.hasOwn(run.variables, 'optionalOutput'), false);
  }

  await runFromToolbar();
  // Running after another edit uses the same save-and-run path, without a reload workaround.
  await inspector.getByRole('textbox', { name: /^输出变量/ }).fill('anotherOutput');
  await inspector.getByRole('textbox', { name: /^输出变量/ }).fill('');
  await runFromToolbar();
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await runFromToolbar();
  await page.screenshot({ path: join(qa, 'save-run-success.png'), fullPage: true });
  console.log(JSON.stringify({ status: 'passed', clearedOptionalOutput: true, saveThenRun: true, editThenRun: true, reloadThenRun: true, screenshot: join(qa, 'save-run-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'save-run-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  const target = resolve(data);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-save-run-')) throw new Error('拒绝清理非验收临时目录');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
