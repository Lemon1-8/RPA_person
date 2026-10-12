import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-workspace-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
try {
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  for (const area of ['左侧栏', '右侧栏']) {
    await page.getByRole('button', { name: `收起${area}`, exact: true }).click();
    await page.getByRole('button', { name: `展开${area}`, exact: true }).waitFor();
  }
  assert.equal(await page.getByRole('complementary', { name: '指令库' }).isVisible(), false);
  assert.equal(await page.getByRole('complementary', { name: '参数与设置' }).isVisible(), false);
  assert.equal(await page.getByRole('region', { name: '运行监控' }).isVisible(), false);
  await page.reload();
  await page.getByRole('button', { name: '展开左侧栏', exact: true }).waitFor();
  for (const area of ['左侧栏', '右侧栏']) await page.getByRole('button', { name: `展开${area}`, exact: true }).click();

  await page.getByRole('button', { name: /^流程管理/ }).click();
  const management = page.getByRole('main', { name: '流程管理', exact: true });
  await management.getByRole('button', { name: '新建流程', exact: true }).click();
  await page.getByLabel('流程名称', { exact: true }).fill('工作空间验收');
  await page.getByRole('combobox', { name: /^流程结束后的浏览器/ }).selectOption('close');
  await page.getByRole('button', { name: '返回流程编辑器', exact: true }).click();
  const library = page.getByRole('complementary', { name: '指令库' });
  await library.getByRole('button', { name: '设置变量', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '参数与设置' });
  await inspector.getByLabel('步骤名称', { exact: true }).fill('局部配置 A');
  await inspector.getByRole('button', { name: '变量', exact: true }).click();
  await inspector.getByLabel('变量 JSON', { exact: true }).fill('{"localValue":"A"}');
  await inspector.getByRole('button', { name: '元素', exact: true }).click();
  await inspector.getByLabel('元素库 JSON', { exact: true }).fill('{"target":{"selector":"#a"}}');
  await inspector.getByRole('button', { name: '设置', exact: true }).click();
  await inspector.getByLabel('步骤超时（毫秒）', { exact: true }).fill('12345');
  await inspector.getByLabel(/^指令下载目录/).fill(join(data, 'local-a'));
  await library.getByRole('button', { name: '设置变量', exact: true }).click();
  await inspector.getByLabel('步骤名称', { exact: true }).fill('局部配置 B');
  await inspector.getByRole('button', { name: '变量', exact: true }).click();
  assert.equal(await inspector.getByLabel('变量 JSON', { exact: true }).inputValue(), '{}');
  await inspector.getByLabel('变量 JSON', { exact: true }).fill('{"localValue":"B"}');
  await page.getByRole('button', { name: '步骤 1：局部配置 A', exact: true }).click();
  await inspector.getByRole('button', { name: '变量', exact: true }).click();
  assert.equal(JSON.parse(await inspector.getByLabel('变量 JSON', { exact: true }).inputValue()).localValue, 'A');
  // Insertion follows the selected step; drag and click share the same placement rule.
  await library.getByRole('button', { name: '设置变量', exact: true }).dragTo(page.getByRole('button', { name: '步骤 1：局部配置 A', exact: true }));
  await inspector.getByLabel('步骤名称', { exact: true }).fill('拖拽插入');
  await page.getByRole('button', { name: '步骤 2：拖拽插入', exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 3：局部配置 B', exact: true }).waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  let state = await page.evaluate(() => window.rpa.bootstrap());
  const flow = state.workflows.find(flow => flow.name === '工作空间验收');
  assert.equal(flow.steps[0].variables.localValue, 'A');
  assert.equal(flow.steps[0].settings.downloadDir, join(data, 'local-a'));
  assert.equal(flow.steps[0].timeoutMs, 12345);
  assert.equal(flow.steps[0].elements.target.selector, '#a');
  assert.equal(flow.steps[2].variables.localValue, 'B');
  await page.screenshot({ path: join(qa, 'workspace-editor.png'), fullPage: true });

  await page.getByRole('button', { name: /^流程管理/ }).click();
  await page.getByLabel('搜索流程', { exact: true }).fill('工作空间验收');
  assert.equal(await management.locator('tbody tr').count(), 1);
  await management.getByRole('button', { name: '复制流程 工作空间验收', exact: true }).click();
  await page.getByLabel('流程名称', { exact: true }).fill('工作空间副本');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^流程管理/ }).click();
  await page.screenshot({ path: join(qa, 'workspace-flows.png'), fullPage: true });
  await management.getByRole('button', { name: '删除流程 工作空间副本', exact: true }).click();
  await management.getByRole('button', { name: '确认删除', exact: true }).click();
  await management.getByRole('button', { name: '删除流程 工作空间副本', exact: true }).waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: '定时运行', exact: true }).click();
  await page.getByRole('button', { name: '新建定时任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('每日验收');
  await page.getByLabel('执行流程', { exact: true }).selectOption(flow.workflowId);
  await page.getByLabel('运行时间', { exact: true }).fill('23:59');
  await page.getByRole('button', { name: '保存定时任务', exact: true }).click();
  await page.getByRole('button', { name: '编辑定时任务 每日验收', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑定时任务 每日验收', exact: true }).click();
  await page.getByLabel('触发方式', { exact: true }).selectOption('interval');
  await page.getByRole('button', { name: '保存定时任务', exact: true }).click();
  await page.getByRole('cell').filter({ hasText: '每 60 分钟' }).waitFor();
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '启用', exact: true }).waitFor();
  await page.screenshot({ path: join(qa, 'workspace-schedules.png'), fullPage: true });
  await page.getByRole('button', { name: '删除定时任务 每日验收', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('还没有定时任务', { exact: true }).waitFor();
  // Exercise the real scheduler without waiting for the minute-resolution UI control.
  await page.evaluate(async workflowId => window.rpa.saveSchedule({ scheduleId: 'smoke-once', workflowId, name: '自动触发验收', enabled: true, kind: 'once', at: new Date(Date.now() + 1500).toISOString() }), flow.workflowId);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const deadline = Date.now() + 20000;
  do {
    state = await page.evaluate(() => window.rpa.bootstrap());
    if (state.runs.some(run => run.scheduleId === 'smoke-once' && ['succeeded', 'failed'].includes(run.status))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const scheduledRun = state.runs.find(run => run.scheduleId === 'smoke-once');
  assert.ok(scheduledRun, '托盘定时任务应自动触发');
  assert.equal(scheduledRun.status, 'succeeded', scheduledRun.error);
  assert.equal(scheduledRun.variables.localValue, undefined);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.reload();
  state = await page.evaluate(() => window.rpa.bootstrap());
  assert.equal(state.workflows.some(flow => flow.name === '工作空间副本'), false);
  assert.equal(state.schedules.find(plan => plan.scheduleId === 'smoke-once').enabled, false);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', workflowCrud: true, scopeIsolation: true, dragPlacement: true, panelsRemembered: true, scheduleCrud: true, scheduledWhileInTray: true, screenshots: qa }, null, 2));
} finally {
  await app.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-workspace-')) throw new Error('拒绝清理非验收临时目录');
  await rm(data, { recursive: true, force: true });
}
