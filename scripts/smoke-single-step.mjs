import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-single-step-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const terminal = ['succeeded', 'failed', 'stopped', 'interrupted'];
let app;
let page;

async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }

async function singleStep(buttonName, stepId) {
  const from = await page.evaluate(() => window.singleStepSmokeEvents.length);
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  await page.waitForFunction(({ stepId, from }) => window.singleStepSmokeEvents.slice(from).some(event =>
    event.type === 'step' && event.stepId === stepId && ['succeeded', 'failed'].includes(event.status)),
  { stepId, from }, { timeout: 30_000 });
  const events = await page.evaluate(from => window.singleStepSmokeEvents.slice(from), from);
  const finished = events.find(event => event.type === 'step' && event.stepId === stepId && ['succeeded', 'failed'].includes(event.status));
  assert.equal(finished.status, 'succeeded', finished.message);
  assert.deepEqual([...new Set(events.filter(event => event.type === 'step').map(event => event.stepId))], [stepId], '单独运行不得执行相邻指令');
  const deadline = Date.now() + 10_000;
  let run;
  do {
    run = (await bootstrap()).runs.find(item => item.runId === finished.runId);
    if (run && terminal.includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run?.status, 'succeeded', run?.error);
  assert.equal(run.browserOpen, true, '单条运行后应保留对应浏览器');
  assert.equal(run.variables.neighborRan, undefined, '相邻的哨兵指令不可执行');
  return run;
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
    name: '单条运行验收',
    variables: {},
    elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: true, popupPolicy: 'smart' },
    steps: [
      { stepId: 'open', name: '打开验收网页', actionType: 'browser.open', params: { url: initial.demoUrl } },
      { stepId: 'fill', name: '填写验收客户', actionType: 'browser.fill', params: { selector: '#customer', value: '保存的客户' } },
      { stepId: 'query', name: '查询验收客户', actionType: 'browser.response', params: { selector: '#query', urlIncludes: '/api/orders', method: 'GET' }, output: 'queryResponse' },
      { stepId: 'read', name: '读取验收状态', actionType: 'browser.text', params: { selector: '#status' }, output: 'pageStatus' },
      { stepId: 'neighbor', name: '不应自动运行', actionType: 'variables.set', params: { name: 'neighborRan', value: true } },
    ],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();

  // All three policies must survive the same save/reload path used by ordinary workflows.
  for (const policy of ['strict', 'off', 'smart']) {
    await page.getByRole('button', { name: '运行设置', exact: true }).click();
    await page.getByLabel('智能屏蔽弹窗', { exact: true }).selectOption(policy);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId).settings.popupPolicy, policy);
    await page.reload();
    await page.getByRole('button', { name: '运行设置', exact: true }).click();
    assert.equal(await page.getByLabel('智能屏蔽弹窗', { exact: true }).inputValue(), policy);
    await page.getByRole('button', { name: '返回流程编辑器', exact: true }).click();
  }
  const savedFlow = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  await page.getByLabel('搜索指令', { exact: true }).fill('智能屏蔽弹窗');
  assert.equal(await page.getByRole('complementary', { name: '指令库', exact: true }).getByRole('button', { name: '智能屏蔽弹窗', exact: true }).isEnabled(), true);
  await page.getByLabel('搜索指令', { exact: true }).fill('');
  await page.evaluate(() => {
    window.singleStepSmokeEvents = [];
    window.rpa.onEvent(event => window.singleStepSmokeEvents.push(event));
  });

  const browserTarget = page.getByLabel('单条运行的目标浏览器', { exact: true });
  assert.equal(await browserTarget.inputValue(), 'auto');
  // A page operation without a browser must explain the missing prerequisite in the UI.
  await page.getByRole('button', { name: '单独运行 填写验收客户', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /浏览器|打开网页/);
  assert.equal((await bootstrap()).runs.length, 0, '缺少浏览器时不得创建无法使用的运行');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();

  const opened = await singleStep('单独运行 打开验收网页', 'open');
  assert.equal(opened.variables.queryResponse, undefined);
  assert.equal(opened.variables.pageStatus, undefined);
  const runId = opened.runId;
  await page.getByRole('button', { name: '步骤 2：填写验收客户', exact: true }).click();
  await page.getByRole('complementary', { name: '参数与设置', exact: true }).getByLabel(/^输入内容/).fill('单步未保存参数');
  await page.getByText('未保存', { exact: true }).waitFor();
  const filled = await singleStep('运行选中指令', 'fill');
  assert.equal(filled.runId, runId, '自动选择应复用当前流程的闲置浏览器');
  assert.equal(filled.variables.queryResponse, undefined, '填写不能顺带执行查询');

  await browserTarget.selectOption(runId);
  const queried = await singleStep('单独运行 查询验收客户', 'query');
  assert.equal(queried.runId, runId, '显式选择应使用指定的保留浏览器');
  assert.match(JSON.stringify(queried.variables.queryResponse), /单步未保存参数/, '应在原页面查询未保存的输入内容');
  assert.equal(queried.variables.pageStatus, undefined, '查询不能顺带执行读取');
  const read = await singleStep('单独运行 读取验收状态', 'read');
  assert.equal(read.runId, runId);
  assert.match(read.variables.pageStatus, /查询完成：单步未保存参数/);
  const after = await bootstrap();
  assert.equal(after.runs.length, 1, '多条指令应共用一个浏览器会话');
  assert.deepEqual(after.workflows.find(item => item.workflowId === flow.workflowId), savedFlow, '单条运行不得自动保存编辑中的流程');
  await page.getByText('未保存', { exact: true }).waitFor();
  await page.screenshot({ path: join(qa, 'single-step-success.png'), fullPage: true });

  await page.getByRole('button', { name: '关闭所选运行浏览器', exact: true }).click();
  await page.waitForFunction(async runId => (await window.rpa.bootstrap()).runs.find(run => run.runId === runId)?.browserOpen === false, runId);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', runId, isolatedSteps: true, retainedBrowserReuse: true, explicitBrowserSelection: true, unsavedParameters: true, persistedWorkflowUnchanged: true, missingBrowserError: true, popupPoliciesPersisted: ['strict', 'off', 'smart'], popupActionAvailable: true, screenshot: join(qa, 'single-step-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'single-step-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-single-step-')) throw new Error('拒绝清理非验收临时目录');
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
