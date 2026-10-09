import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-logging-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;

async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }
function stepButton(name) { return page.getByRole('button', { name: new RegExp(`^步骤 \\d+：${name}$`) }); }

async function insertCurrentItem() {
  await page.getByRole('button', { name: '为日志内容插入变量', exact: true }).click();
  await page.getByRole('group', { name: '为日志内容插入变量列表', exact: true })
    .getByRole('button', { name: '插入 {{item}}', exact: true }).click();
}

async function save() {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
}

async function runLoop(workflowId, expectedStatus = 'succeeded') {
  const previous = new Set((await bootstrap()).runs.map(run => run.runId));
  await page.getByRole('button', { name: '单独运行 日志验收循环', exact: true }).click();
  const deadline = Date.now() + 30_000;
  let run;
  do {
    run = (await bootstrap()).runs.find(item => item.workflowId === workflowId && !previous.has(item.runId));
    if (run && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run?.status, expectedStatus, run?.error);
  assert.equal(run.stepId, 'loop', '应通过循环的单独运行入口执行');
  assert.equal(run.browserOpen, false, '打印日志无需启动浏览器');
  assert.equal(await page.getByRole('button', { name: '显示所选运行浏览器', exact: true }).isEnabled(), false);
  const events = await page.evaluate(() => window.loggingSmokeEvents);
  assert.equal(events.some(event => event.runId === run.runId && event.run?.browserOpen), false, '执行过程中也不应打开浏览器');
  return { run, events: events.filter(event => event.runId === run.runId) };
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0],
    name: '打印日志验收',
    variables: {},
    elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [{ stepId: 'loop', name: '日志验收循环', actionType: 'control.forEach', params: { items: [1, 2, 3, 4], itemVariable: 'item' }, children: [] }],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await page.getByRole('group', { name: '日志验收循环：循环体', exact: true })
    .getByRole('button', { name: '添加到循环体', exact: true }).click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true })
    .getByRole('button', { name: '打印日志', exact: true }).click();
  await inspector.getByLabel('步骤名称', { exact: true }).fill('打印当前项');
  await inspector.getByLabel(/^日志内容/).fill('当前项：');
  await insertCurrentItem();
  assert.equal(await inspector.getByLabel(/^日志内容/).inputValue(), '当前项：{{item}}', '变量选择应保留已有日志前缀');
  await save();
  const saved = (await bootstrap()).workflows.find(workflow => workflow.workflowId === flow.workflowId);
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].children.length, 1);
  const logStep = saved.steps[0].children[0];
  assert.equal(logStep.actionType, 'core.log');
  assert.equal(logStep.params.message, '当前项：{{item}}');
  await page.reload();
  await stepButton('打印当前项').click();
  assert.equal(await inspector.getByLabel(/^日志内容/).inputValue(), '当前项：{{item}}');
  await page.evaluate(() => {
    window.loggingSmokeEvents = [];
    window.rpa.onEvent(event => window.loggingSmokeEvents.push(event));
  });

  const first = await runLoop(flow.workflowId);
  const logs = first.events.filter(event => event.type === 'log');
  assert.deepEqual(logs.map(event => event.message), ['当前项：1', '当前项：2', '当前项：3', '当前项：4']);
  assert.ok(logs.every(event => event.stepId === logStep.stepId), '每条日志必须关联循环内的打印步骤');
  assert.equal(first.run.variables.item, undefined, '循环结束后当前项变量应恢复作用域');
  const monitor = page.getByRole('region', { name: '运行监控', exact: true });
  const detailToggle = monitor.getByRole('switch', { name: '显示指令执行信息', exact: true });
  assert.equal(await detailToggle.getAttribute('aria-checked'), 'false', '指令执行信息应默认关闭');
  assert.equal(await monitor.locator('.log-line-step').count(), 0, '所有指令默认隐藏执行中、完成和跳过提示');
  for (let item = 1; item <= 4; item++) {
    const row = monitor.locator('.log-line').filter({ hasText: `当前项：${item}` });
    assert.equal(await row.count(), 1, `日志面板应显示当前项 ${item}`);
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.isVisible(), true);
    assert.equal(await row.getByRole('button', { name: '打印当前项', exact: true }).count(), 1);
  }
  const logSearch = monitor.getByRole('textbox', { name: '搜索运行日志' });
  await logSearch.fill('当前项：2');
  assert.equal(await monitor.locator('.log-line').count(), 1, '搜索应定位日志正文');
  await logSearch.fill('');
  await monitor.getByRole('button', { name: '输出与文件', exact: true }).click();
  assert.equal(await monitor.locator('.log-line').count(), 4, '输出筛选应隐藏步骤和运行状态');
  await monitor.getByRole('button', { name: '失败', exact: true }).click();
  assert.equal(await monitor.locator('.log-line').count(), 0, '成功运行不应出现失败日志');
  await monitor.getByRole('button', { name: '全部', exact: true }).click();
  await detailToggle.click();
  assert.equal(await monitor.locator('.log-line-step').count(), 5, '主动开启后显示循环和四次打印的完成信息');
  const loopCompletion = monitor.locator('.log-line-step').filter({ hasText: '日志验收循环' });
  assert.match(await loopCompletion.textContent(), /已完成 · .*毫秒|已完成 · .*秒/);
  await detailToggle.click();
  assert.equal(await monitor.locator('.log-line-step').count(), 0, '关闭后重新隐藏所有普通执行信息');
  await monitor.getByRole('button', { name: '步骤', exact: true }).click();
  assert.equal(await detailToggle.getAttribute('aria-checked'), 'true', '主动选择步骤筛选应开启执行信息');
  assert.equal(await monitor.locator('.log-line').count(), 5);
  await detailToggle.click();
  assert.equal(await monitor.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed'), 'true', '关闭执行信息时退出步骤筛选');
  assert.equal(await monitor.locator('.log-line-step').count(), 0);
  await page.setViewportSize({ width: 1464, height: 1200 });
  await stepButton('打印当前项').click();
  await stepButton('日志验收循环').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'logging-success.png'), fullPage: true });
  await monitor.locator('.log-line').filter({ hasText: '当前项：1' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'logging-first-items.png'), fullPage: true });

  // A complete variable reference retains object values, including fields named path.
  const objectValue = { path: join(data, 'log-data-only.txt'), status: '对象日志验收' };
  await stepButton('日志验收循环').click();
  await inspector.getByLabel('循环列表', { exact: true }).fill(JSON.stringify([objectValue]));
  await stepButton('打印当前项').click();
  await inspector.getByLabel(/^日志内容/).fill('');
  await insertCurrentItem();
  assert.equal(await inspector.getByLabel(/^日志内容/).inputValue(), '{{item}}');
  await save();
  const second = await runLoop(flow.workflowId);
  const objectLogs = second.events.filter(event => event.type === 'log');
  assert.equal(objectLogs.length, 1);
  assert.equal(objectLogs[0].stepId, logStep.stepId);
  assert.deepEqual(JSON.parse(objectLogs[0].message), objectValue);
  assert.deepEqual(objectLogs[0].data, { value: objectValue });
  const objectRow = monitor.locator('.log-line').filter({ hasText: '对象日志验收' });
  await objectRow.waitFor();
  assert.deepEqual(await objectRow.locator('dt').allTextContents(), ['path', 'status']);
  assert.deepEqual(await objectRow.locator('dd').allTextContents(), [objectValue.path, objectValue.status]);
  assert.equal(await monitor.getByRole('button', { name: '打开文件', exact: true }).count(), 0, '日志对象的 path 字段不能被当成下载产物入口');
  await stepButton('打印当前项').click();
  await page.screenshot({ path: join(qa, 'logging-object-success.png'), fullPage: true });

  await detailToggle.click();
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  assert.equal(await detailToggle.getAttribute('aria-checked'), 'true', '重新打开页面后保留主动开启的选择');
  await detailToggle.click();
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  assert.equal(await detailToggle.getAttribute('aria-checked'), 'false', '关闭选择也应持久保存');
  await page.evaluate(() => { window.loggingSmokeEvents = []; window.rpa.onEvent(event => window.loggingSmokeEvents.push(event)); });
  await stepButton('打印当前项').click();
  await inspector.getByLabel(/^日志内容/).fill('{{missing}}');
  await save();
  const failed = await runLoop(flow.workflowId, 'failed');
  assert.ok(failed.run.error.includes('missing'));
  assert.equal(await monitor.locator('.log-line-step.log-error').count(), 2, '关闭执行信息时仍显示打印和循环的失败');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', addedInsideLoop: true, variablePickerPreservesPrefix: true, savedAndReloaded: true, singleStepLoopMessages: logs.map(event => event.message), stepAttribution: true, browserNotRequired: true, objectValueLogged: true, objectPathNotOpenedAsFile: true, screenshot: join(qa, 'logging-success.png'), objectScreenshot: join(qa, 'logging-object-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'logging-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-logging-')) throw new Error('拒绝清理非验收临时目录');
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
