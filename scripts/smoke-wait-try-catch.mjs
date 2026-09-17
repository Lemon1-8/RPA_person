import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-wait-try-catch-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;

async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }
function stepButton(name) { return page.getByRole('button', { name: new RegExp(`^步骤 \\d+：${name}$`) }); }
function branch(parent, name) { return page.getByRole('group', { name: `${parent}：${name}`, exact: true }); }
function variableOption(panel, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return panel.getByRole('button', { name: new RegExp(`^插入 \\{\\{${escaped}\\}\\}(?:，可能未产生)?$`) });
}

async function assertSaveEnabled(enabled, message) {
  const save = page.getByRole('button', { name: '保存', exact: true });
  await page.waitForFunction(({ button, enabled }) => button.disabled === !enabled, { button: await save.elementHandle(), enabled });
  assert.equal(await save.isEnabled(), enabled, message);
}

async function variablePanel(label) {
  const trigger = `为${label}插入变量`;
  await page.getByRole('button', { name: trigger, exact: true }).click();
  return page.getByRole('group', { name: `${trigger}列表`, exact: true });
}

async function addChild(parent, branchName, action, name) {
  const addLabel = branchName === '循环体' ? '添加到循环体' : `添加到 ${branchName}`;
  await branch(parent, branchName).getByRole('button', { name: addLabel, exact: true }).click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true }).getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('complementary', { name: '参数与设置', exact: true }).getByLabel('步骤名称', { exact: true }).fill(name);
  await stepButton(name).waitFor();
}

async function save() {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
}

async function watchEvents() {
  await page.evaluate(() => {
    window.waitTryCatchSmokeEvents = [];
    window.rpa.onEvent(event => window.waitTryCatchSmokeEvents.push(event));
  });
}

async function waitForRun(workflowId, previous, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let run;
  do {
    run = (await bootstrap()).runs.find(item => item.workflowId === workflowId && !previous.has(item.runId));
    if (run && predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`等待运行状态超时：${JSON.stringify(run)}`);
}

const terminal = run => ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status);

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0], name: '等待与异常捕获验收',
    variables: { delaySeconds: 0.12, error: '原有错误变量' }, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [
      { stepId: 'loop', name: '异常验收循环', actionType: 'control.forEach', params: { items: [1], itemVariable: 'item' }, children: [] },
      {
        stepId: 'success', name: '成功不捕获', actionType: 'control.tryCatch', params: { errorVariable: 'error' },
        children: [{ stepId: 'zero', name: '零秒等待', actionType: 'core.wait', params: { durationSeconds: 0 } }],
        elseSteps: [{ stepId: 'unexpected', name: '成功时不应执行', actionType: 'variables.set', params: { name: 'unexpectedCatch', value: true } }],
      },
      { stepId: 'after', name: '捕获后继续', actionType: 'variables.set', params: { name: 'continued', value: true } },
    ],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await addChild('异常验收循环', '循环体', 'Try / Catch', '捕获失败');
  assert.equal(await inspector.getByLabel('异常变量', { exact: true }).inputValue(), 'error');
  for (const name of ['', ' caughtError ']) {
    await inspector.getByLabel('异常变量', { exact: true }).fill(name);
    await assertSaveEnabled(false, '空异常变量或首尾空格必须阻止保存');
  }
  await stepButton('成功不捕获').click();
  await stepButton('捕获失败').click();
  await assertSaveEnabled(false, '切换步骤不应清除非法异常变量的校验');
  await inspector.getByLabel('异常变量', { exact: true }).fill('caughtError');
  await assertSaveEnabled(true);
  for (const name of ['Try 执行区', 'Catch 异常区']) {
    assert.equal(await branch('捕获失败', name).isVisible(), true, '空 Try / Catch 必须展示两个分支');
    assert.equal(await branch('捕获失败', name).getByRole('button', { name: `添加到 ${name}`, exact: true }).isVisible(), true);
  }
  assert.equal(await page.getByText('结束 Try / Catch', { exact: true }).count(), 2);

  await addChild('捕获失败', 'Try 执行区', '等待', '等待变量时长');
  assert.equal(await inspector.getByLabel('等待时长（秒）', { exact: true }).inputValue(), '3');
  for (const value of ['-1', '3601', 'abc']) {
    await inspector.getByLabel('等待时长（秒）', { exact: true }).fill(value);
    await assertSaveEnabled(false, `等待时长 ${value} 必须阻止保存`);
  }
  await stepButton('捕获失败').click();
  await stepButton('等待变量时长').click();
  await assertSaveEnabled(false, '切换步骤不应清除非法等待时长的校验');
  await inspector.getByLabel('等待时长（秒）', { exact: true }).fill('0');
  await assertSaveEnabled(true, '零秒应是合法等待时长');
  await inspector.getByLabel('等待时长（秒）', { exact: true }).fill('0.5');
  await assertSaveEnabled(true, '等待时长应支持小数秒');
  await inspector.getByLabel('等待时长来源', { exact: true }).selectOption('variable');
  const waitVariables = await variablePanel('等待时长');
  assert.equal(await variableOption(waitVariables, 'caughtError').count(), 0, 'Try 内不应提前生成 Catch 异常变量');
  await variableOption(waitVariables, 'delaySeconds').click();
  await assertSaveEnabled(true);
  await inspector.getByRole('button', { name: '设置', exact: true }).click();
  const waitTimeout = inspector.getByLabel(/^步骤超时（秒）/);
  assert.equal(await waitTimeout.inputValue(), '', '等待超时应默认按时长自动设置');
  await waitTimeout.fill('0.5');
  await waitTimeout.fill('');
  await inspector.getByRole('button', { name: '步骤参数', exact: true }).click();

  await addChild('捕获失败', 'Try 执行区', '等待', '主动失败');
  await inspector.getByLabel('等待时长来源', { exact: true }).selectOption('variable');
  await inspector.getByLabel('等待时长（秒）', { exact: true }).fill('missingWaitSeconds');
  await inspector.getByRole('button', { name: '设置', exact: true }).click();
  await inspector.getByLabel(/^最多尝试次数/).fill('2');
  await inspector.getByLabel('重试间隔（秒）', { exact: true }).fill('0.01');
  await inspector.getByLabel(/^失败后/).selectOption('pause');

  await addChild('捕获失败', 'Try 执行区', '设置变量', '跳过剩余 Try');
  await inspector.getByLabel(/^变量名称/).fill('skippedTry');
  await inspector.getByLabel('变量值（JSON）', { exact: true }).fill('true');
  await addChild('捕获失败', 'Catch 异常区', '设置变量', '保存异常详情');
  await inspector.getByLabel(/^变量名称/).fill('caughtRecord');
  const catchVariables = await variablePanel('变量值（JSON）');
  for (const name of ['caughtError', 'caughtError.message', 'caughtError.stepId', 'caughtError.stepName', 'caughtError.actionType']) {
    assert.equal(await variableOption(catchVariables, name).count(), 1, `${name} 应在 Catch 分支可用`);
  }
  await variableOption(catchVariables, 'caughtError').click();
  await addChild('捕获失败', 'Catch 异常区', '打印日志', '打印捕获的错误');
  await inspector.getByLabel(/^日志内容/).fill('');
  await variableOption(await variablePanel('日志内容'), 'caughtError.message').click();
  assert.equal(await inspector.getByLabel(/^日志内容/).inputValue(), '{{caughtError.message}}');

  const outerBounds = await stepButton('捕获失败').boundingBox();
  const childBounds = await stepButton('等待变量时长').boundingBox();
  assert.ok(outerBounds && childBounds && childBounds.x >= outerBounds.x + 16, 'Try 子步骤必须逐层缩进');
  await page.getByRole('button', { name: '折叠 捕获失败', exact: true }).click();
  assert.equal(await stepButton('等待变量时长').isVisible(), false);
  assert.equal(await stepButton('保存异常详情').isVisible(), false);
  assert.equal(await stepButton('成功不捕获').isVisible(), true);
  await page.getByRole('button', { name: '展开 捕获失败', exact: true }).click();
  await stepButton('保存异常详情').waitFor();
  await stepButton('捕获后继续').click();
  const afterVariables = await variablePanel('变量值（JSON）');
  assert.equal(await variableOption(afterVariables, 'caughtError').count(), 0, 'Catch 结束后不能泄漏异常变量');
  assert.equal(await variableOption(afterVariables, 'caughtRecord').count(), 1, 'Catch 保存的业务变量应作为可能产生的值保留');
  await page.keyboard.press('Escape');

  await save();
  const saved = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  const container = saved.steps[0].children[0];
  assert.equal(saved.schemaVersion, 1, '新增指令沿用流程 JSON v1');
  assert.equal(container.actionType, 'control.tryCatch');
  assert.deepEqual(container.params, { errorVariable: 'caughtError' });
  assert.deepEqual(container.children.map(step => step.name), ['等待变量时长', '主动失败', '跳过剩余 Try']);
  assert.deepEqual(container.elseSteps.map(step => step.name), ['保存异常详情', '打印捕获的错误']);
  assert.deepEqual(container.children[0].params, { durationSeconds: '{{delaySeconds}}' });
  assert.equal(container.children[0].timeoutMs, undefined, '清空等待超时应恢复自动模式');
  assert.equal(container.children[1].retry.delayMs, 10, '界面秒数应转换为重试计时值');
  assert.equal(container.elseSteps[0].params.value, '{{caughtError}}');
  await page.reload();
  await stepButton('等待变量时长').click();
  assert.equal(await inspector.getByLabel('等待时长来源', { exact: true }).inputValue(), 'variable');
  assert.equal(await inspector.getByLabel('等待时长（秒）', { exact: true }).inputValue(), 'delaySeconds');
  await stepButton('捕获失败').click();
  assert.equal(await inspector.getByLabel('异常变量', { exact: true }).inputValue(), 'caughtError');
  assert.deepEqual((await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId), saved);

  await watchEvents();
  const previous = new Set((await bootstrap()).runs.map(run => run.runId));
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const run = await waitForRun(flow.workflowId, previous, terminal);
  assert.equal(run.status, 'succeeded', run.error);
  assert.equal(run.error, undefined, '已捕获的错误不能残留为流程失败');
  assert.equal(run.browserOpen, false, '等待和异常捕获无需打开浏览器');
  assert.equal(run.variables.continued, true);
  assert.equal(run.variables.unexpectedCatch, undefined, 'Try 成功时必须跳过 Catch');
  assert.equal(run.variables.skippedTry, undefined, 'Try 失败后必须跳过其剩余步骤');
  assert.equal(run.variables.caughtError, undefined, '异常变量必须在 Catch 结束后恢复作用域');
  assert.equal(run.variables.error, '原有错误变量');
  assert.equal(run.variables.caughtRecord.stepId, container.children[1].stepId);
  assert.equal(run.variables.caughtRecord.stepName, '主动失败');
  assert.equal(run.variables.caughtRecord.actionType, 'core.wait');
  assert.equal(typeof run.variables.caughtRecord.message, 'string');
  assert.ok(run.variables.caughtRecord.message.length > 0);
  const events = (await page.evaluate(() => window.waitTryCatchSmokeEvents)).filter(event => event.runId === run.runId);
  const waitFinished = events.find(event => event.type === 'step' && event.stepId === container.children[0].stepId && event.status === 'succeeded');
  assert.ok(waitFinished?.data.durationMs >= 110, `变量等待应实际经过约 0.12 秒：${JSON.stringify(waitFinished)}`);
  assert.deepEqual(waitFinished?.data.result, { durationSeconds: 0.12 });
  assert.equal(events.filter(event => event.type === 'step' && event.stepId === container.children[1].stepId && event.status === 'running').length, 2, '重试耗尽后才进入 Catch');
  assert.equal(events.some(event => event.type === 'run' && event.status === 'waiting_manual'), false, 'Try 内的失败暂停应交给 Catch 处理');
  assert.equal(events.some(event => event.type === 'log' && event.stepId === container.elseSteps[1].stepId && event.message === run.variables.caughtRecord.message), true);
  await page.setViewportSize({ width: 1464, height: 1200 });
  await stepButton('捕获失败').click();
  await page.screenshot({ path: join(qa, 'wait-try-catch-success.png'), fullPage: true });

  // A user stop must interrupt the timer without entering Catch or following steps.
  const currentSaved = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  const stopFlow = {
    ...currentSaved, name: '终止等待验收', variables: {},
    steps: [
      {
        stepId: 'stop-container', name: '终止不捕获', actionType: 'control.tryCatch', params: { errorVariable: 'error' },
        children: [{ stepId: 'stop-wait', name: '等待停止', actionType: 'core.wait', params: { durationSeconds: 10 } }],
        elseSteps: [{ stepId: 'stop-catch', name: '停止时不应捕获', actionType: 'variables.set', params: { name: 'caughtStop', value: true } }],
      },
      { stepId: 'stop-after', name: '停止时不应继续', actionType: 'variables.set', params: { name: 'continuedAfterStop', value: true } },
    ],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), stopFlow);
  await page.reload();
  await page.getByRole('heading', { name: stopFlow.name, exact: true }).waitFor();
  await watchEvents();
  const beforeStop = new Set((await bootstrap()).runs.map(item => item.runId));
  await page.getByRole('button', { name: '运行', exact: true }).click();
  await waitForRun(flow.workflowId, beforeStop, item => item.status === 'running');
  await page.waitForFunction(() => window.waitTryCatchSmokeEvents.some(event => event.type === 'step' && event.stepId === 'stop-wait' && event.status === 'running'));
  const stoppedAt = Date.now();
  await page.getByRole('button', { name: '停止所选运行', exact: true }).click();
  const stopped = await waitForRun(flow.workflowId, beforeStop, terminal, 5000);
  assert.equal(stopped.status, 'stopped', stopped.error);
  assert.ok(Date.now() - stoppedAt < 5000, '停止应及时中断等待计时');
  assert.equal(stopped.variables.caughtStop, undefined);
  assert.equal(stopped.variables.continuedAfterStop, undefined);
  const stopEvents = await page.evaluate(() => window.waitTryCatchSmokeEvents);
  assert.equal(stopEvents.some(event => event.runId === stopped.runId && event.stepId === 'stop-catch' && event.type === 'step'), false);
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', nestedInsertion: true, emptyBranches: true, parameterValidation: true, variableDuration: true, catchVariableScope: true, savedAndReloaded: true, retriesBeforeCatch: true, failureContinues: true, successSkipsCatch: true, stopInterruptsWait: true, screenshot: join(qa, 'wait-try-catch-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'wait-try-catch-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    const target = resolve(data);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-wait-try-catch-')) throw new Error('拒绝清理非验收临时目录');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
