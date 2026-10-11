import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-ui-recovery-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }
async function selectFlow(id) { await page.getByLabel('当前流程', { exact: true }).selectOption(id); }
async function showResults() { await page.getByRole('button', { name: '查看运行结果', exact: true }).click(); }
async function awaitRun(workflowId, status, previous = []) {
  const deadline = Date.now() + 30000;
  do {
    const runs = (await bootstrap()).runs;
    const result = runs.find(run => run.workflowId === workflowId && !previous.includes(run.runId) && run.status === status);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`未等到 ${workflowId} 的 ${status} 状态`);
}
async function capture(name) { await page.screenshot({ path: join(qa, `ui-${name}.png`), fullPage: true }); }
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1040, 650));
  await page.waitForFunction(() => innerWidth === 1040 && innerHeight === 650);
  await showResults();
  const logHeight = await page.locator('.log-scroll').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(logHeight >= 56, `小窗口日志正文应至少容纳两行，实际 ${logHeight}px`);
  const initial = await bootstrap();
  const a = { ...initial.workflows[0], name: '上下文与撤销验收', variables: {}, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: false, keepBrowserOpen: true },
    steps: [{ stepId: 'container', name: '可撤销容器', actionType: 'control.if', params: { left: true, operator: 'truthy' },
      children: [{ stepId: 'child', name: '运行时步骤名称', actionType: 'core.log', params: { message: '确认历史上下文' } }],
      elseSteps: [{ stepId: 'otherwise', name: '否则指令', actionType: 'core.log', params: { message: '备用' } }] }] };
  const b = { ...a, workflowId: 'ui-empty', name: '空流程起步', revision: 0, steps: [] };
  await page.evaluate(async ({ a, b }) => { await window.rpa.saveWorkflow(a); await window.rpa.saveWorkflow(b); }, { a, b });
  await page.reload();
  await page.getByLabel('当前流程', { exact: true }).waitFor();
  await selectFlow(a.workflowId);
  await page.getByRole('button', { name: '步骤 2：运行时步骤名称', exact: true }).click();
  await page.getByRole('button', { name: '删除 可撤销容器', exact: true }).click();
  assert.equal(await page.locator('[data-step-id="child"]').count(), 0);
  await page.getByRole('button', { name: '撤销删除', exact: true }).click();
  assert.equal(await page.locator('[data-step-id="child"]').count(), 1);
  assert.equal(await page.locator('[data-step-id="otherwise"]').count(), 1);
  assert.equal(await page.getByLabel('步骤名称', { exact: true }).inputValue(), '运行时步骤名称');
  await page.getByRole('button', { name: '重做编辑', exact: true }).click();
  assert.equal(await page.locator('[data-step-id="child"]').count(), 0);
  await page.getByRole('button', { name: '撤销编辑', exact: true }).focus();
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('[data-step-id="child"]').count(), 1);
  await selectFlow(b.workflowId);
  assert.equal(await page.getByRole('button', { name: '撤销编辑', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '添加打开网页', exact: true }).click();
  assert.equal(await page.getByLabel(/^网页地址/).count(), 1);
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  await capture('empty-small');
  await page.getByRole('button', { name: '使用可运行示例', exact: true }).click();
  assert.equal(await page.locator('.step-node').count(), 2);
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  await page.getByRole('button', { name: '浏览软件指令', exact: true }).click();
  assert.equal(await page.getByRole('group', { name: '指令类别' }).getByRole('button', { name: '软件', exact: true }).getAttribute('aria-pressed'), 'true');
  await selectFlow(a.workflowId);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const succeeded = await awaitRun(a.workflowId, 'succeeded');
  const monitor = page.getByRole('region', { name: '运行监控', exact: true });
  await monitor.getByRole('button', { name: '运行时步骤名称', exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 2：运行时步骤名称', exact: true }).click();
  await page.getByLabel('步骤名称', { exact: true }).fill('草稿中的新名称');
  await showResults();
  assert.equal(await monitor.getByRole('button', { name: '运行时步骤名称', exact: true }).count(), 1);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const current = (await bootstrap()).workflows.find(flow => flow.workflowId === a.workflowId);
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await bootstrap()).workflows.find(flow => flow.workflowId === a.workflowId).revision, current.revision + 1);
  await selectFlow(b.workflowId);
  await showResults();
  assert.match(await page.getByLabel('所选运行上下文').innerText(), /尚无运行记录/);
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), false);
  await page.getByLabel('运行查看范围', { exact: true }).selectOption('all');
  await page.getByLabel('当前查看的运行', { exact: true }).selectOption(succeeded.runId);
  await monitor.getByRole('button', { name: '运行时步骤名称', exact: true }).click();
  assert.equal(await page.getByLabel('当前流程', { exact: true }).inputValue(), a.workflowId);
  assert.equal(await page.getByLabel('步骤名称', { exact: true }).inputValue(), '运行时步骤名称');
  await page.getByRole('button', { name: '删除 可撤销容器', exact: true }).click();
  await showResults();
  await monitor.getByRole('button', { name: '运行时步骤名称', exact: true }).click();
  await page.getByText(/已不在当前草稿中/).waitFor();
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click();
  await page.reload();
  await page.getByLabel('当前流程', { exact: true }).waitFor();
  await selectFlow(a.workflowId);
  const historical = await page.evaluate(id => window.rpa.getRunWorkflow(id), succeeded.runId);
  assert.equal(historical.steps[0].children[0].name, '运行时步骤名称');
  await capture('normal-small');
  const normalStepHeight = await page.locator('.step-scroll').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(normalStepHeight >= 100, `常规步骤区域为 ${normalStepHeight}px`);

  const beforeManual = (await bootstrap()).runs.map(run => run.runId);
  const saved = (await bootstrap()).workflows.find(flow => flow.workflowId === a.workflowId);
  const manual = { ...saved, steps: [
    { stepId: 'open', name: '打开受控网页', actionType: 'browser.open', params: { url: initial.demoUrl } },
    { stepId: 'missing', name: '等待人工处理', actionType: 'browser.wait', params: { selector: '#ui-recovery-missing' }, timeoutMs: 200, onError: 'pause' },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), manual);
  await page.reload();
  await page.getByLabel('当前流程', { exact: true }).waitFor();
  await selectFlow(a.workflowId);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const waiting = await awaitRun(a.workflowId, 'waiting_manual', beforeManual);
  const recovery = page.getByRole('region', { name: '运行恢复', exact: true });
  await recovery.getByRole('button', { name: '处理后继续', exact: true }).waitFor();
  await recovery.getByRole('button', { name: '定位失败步骤', exact: true }).click();
  assert.equal(await page.getByLabel('步骤名称', { exact: true }).inputValue(), '等待人工处理');
  await showResults();
  assert.equal(await recovery.getByRole('button', { name: '显示浏览器', exact: true }).isEnabled(), true);
  const manualLogHeight = await page.locator('.log-scroll').evaluate(element => element.getBoundingClientRect().height);
  const manualStepHeight = await page.locator('.step-scroll').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(manualLogHeight >= 56, `人工处理时日志正文为 ${manualLogHeight}px`);
  assert.ok(manualStepHeight >= 100, `人工处理时步骤区域为 ${manualStepHeight}px`);
  await capture('manual-small');
  await recovery.getByRole('button', { name: '处理后继续', exact: true }).click();
  await awaitRun(a.workflowId, 'waiting_manual', beforeManual);
  await selectFlow(b.workflowId);
  await showResults();
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), false);
  await page.getByLabel('运行查看范围', { exact: true }).selectOption('all');
  await page.getByLabel('当前查看的运行', { exact: true }).selectOption(waiting.runId);
  assert.match(await page.getByLabel('所选运行上下文').innerText(), /正在查看其他流程/);
  assert.equal(await page.getByRole('button', { name: '停止', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '停止所选运行', exact: true }).click();
  await awaitRun(a.workflowId, 'stopped', beforeManual);
  await recovery.waitFor({ state: 'hidden' });
  await selectFlow(a.workflowId);
  const latest = (await bootstrap()).workflows.find(flow => flow.workflowId === a.workflowId);
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), { ...latest, steps: [{ stepId: 'fail', name: '失败指令', actionType: 'core.wait', params: { durationSeconds: '{{notDefined}}' }, onError: 'fail' }] });
  await page.reload();
  await page.getByLabel('当前流程', { exact: true }).waitFor();
  await selectFlow(a.workflowId);
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await awaitRun(a.workflowId, 'failed');
  await recovery.getByRole('button', { name: '编辑后重新运行', exact: true }).waitFor();
  assert.equal(await recovery.getByRole('button', { name: '处理后继续', exact: true }).count(), 0);
  await recovery.getByRole('button', { name: '定位失败步骤', exact: true }).click();
  assert.equal(await page.getByLabel('步骤名称', { exact: true }).inputValue(), '失败指令');
  await showResults();
  const failedStepHeight = await page.locator('.step-scroll').evaluate(element => element.getBoundingClientRect().height);
  assert.ok(failedStepHeight >= 100, `失败时步骤区域为 ${failedStepHeight}px`);
  await capture('failed-small');
  const conflict = (await bootstrap()).workflows.find(flow => flow.workflowId === a.workflowId);
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), conflict);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const alert = page.locator('.alert[role="alert"]');
  await alert.waitFor();
  assert.match(await alert.locator('span').innerText(), /流程版本已改变/);
  assert.doesNotMatch(await alert.locator('span').innerText(), /Error invoking remote method/);
  await alert.getByText('技术详情', { exact: true }).click();
  assert.match(await alert.locator('pre').innerText(), /rpa:save/);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1464, 902));
  await page.waitForFunction(() => innerWidth === 1464 && innerHeight === 902);
  await capture('failed-desktop');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', logHeight, normalStepHeight, manualLogHeight, manualStepHeight, failedStepHeight, subtreeUndoRedo: true, independentHistories: true,
    savedRevisionUndo: true, historicalNames: true, runContext: true, recoveryAndCancellation: true, emptyStart: true }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'ui-recovery-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  const target = resolve(data);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-ui-recovery-')) throw new Error('拒绝清理非验收临时目录');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
