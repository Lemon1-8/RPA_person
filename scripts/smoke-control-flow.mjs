import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-control-flow-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;

async function bootstrap() { return page.evaluate(() => window.rpa.bootstrap()); }
async function assertSaveEnabled(enabled, message) {
  const save = page.getByRole('button', { name: '保存', exact: true });
  await page.waitForFunction(({ button, enabled }) => button.disabled === !enabled, { button: await save.elementHandle(), enabled });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await save.isEnabled(), enabled, message);
}
async function waitForJsonValue(value) {
  await page.waitForFunction(expected => {
    const field = document.querySelector('textarea[aria-label="变量值（JSON）"]');
    return field && field.value === JSON.stringify(expected, null, 2);
  }, value);
}

function stepButton(name) { return page.getByRole('button', { name: new RegExp(`^步骤 \\d+：${name}$`) }); }
function branch(parent, name) { return page.getByRole('group', { name: `${parent}：${name}`, exact: true }); }
function variableOption(panel, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return panel.getByRole('button', { name: new RegExp(`^插入 \\{\\{${escaped}\\}\\}(?:，可能未产生)?$`) });
}

async function insertVariable(label, name, forbidden = []) {
  const trigger = `为${label}插入变量`;
  await page.getByRole('button', { name: trigger, exact: true }).click();
  const panel = page.getByRole('group', { name: `${trigger}列表`, exact: true });
  for (const unavailable of [...forbidden, 'demoUrl', 'customer', 'runId', 'scheduledFor']) {
    assert.equal(await variableOption(panel, unavailable).count(), 0, `${unavailable} 不应出现在当前步骤的变量候选中`);
  }
  await variableOption(panel, name).click();
}

async function addChild(parent, branchName, action, name) {
  const labels = { 循环体: '添加到循环体', 满足条件: '添加到满足条件', 否则: '添加到否则分支' };
  await branch(parent, branchName).getByRole('button', { name: labels[branchName], exact: true }).click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true }).getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('complementary', { name: '参数与设置', exact: true }).getByLabel('步骤名称', { exact: true }).fill(name);
  await stepButton(name).waitFor();
}

async function setVariable(name, value) {
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await inspector.getByLabel(/^变量名称/).fill(name);
  const reference = typeof value === 'string' && value.match(/^\{\{(.+)\}\}$/);
  if (reference) await insertVariable('变量值（JSON）', reference[1]);
  else await inspector.getByLabel('变量值（JSON）', { exact: true }).fill(JSON.stringify(value));
  await waitForJsonValue(value);
  assert.equal(JSON.parse(await inspector.getByLabel('变量值（JSON）', { exact: true }).inputValue()), value);
}

async function setCondition(variable, expected) {
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await insertVariable('判断对象', variable);
  assert.equal(await inspector.getByLabel('判断对象类型', { exact: true }).inputValue(), 'variable');
  assert.equal(await inspector.getByLabel('判断对象', { exact: true }).inputValue(), variable);
  await inspector.getByLabel('比较方式', { exact: true }).selectOption('truthy');
  assert.equal(await inspector.getByLabel('比较值', { exact: true }).isVisible(), false, '为真判断不应要求填写比较值');
  await inspector.getByLabel('比较方式', { exact: true }).selectOption('equals');
  await inspector.getByLabel('比较值类型', { exact: true }).selectOption('number');
  await inspector.getByLabel('比较值', { exact: true }).fill(String(expected));
}

async function assertIndented(parent, child) {
  const outer = await stepButton(parent).boundingBox();
  const inner = await stepButton(child).boundingBox();
  assert.ok(outer && inner && inner.x >= outer.x + 16, `${child} 应比 ${parent} 多一级缩进`);
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
    name: '控制流编辑验收',
    variables: {},
    elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [
      { stepId: 'loop', name: '验收循环', actionType: 'control.forEach', params: { items: [1, 2], itemVariable: 'item' }, children: [] },
      { stepId: 'condition', name: '验收条件', actionType: 'control.if', params: { left: true, operator: 'truthy' }, children: [], elseSteps: [] },
    ],
  };
  await page.evaluate(workflow => window.rpa.saveWorkflow(workflow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const required = [
    ['循环体', page.getByRole('group', { name: '验收循环：循环体', exact: true })],
    ['满足条件', page.getByRole('group', { name: '验收条件：满足条件', exact: true })],
    ['否则', page.getByRole('group', { name: '验收条件：否则', exact: true })],
    ['结束循环', page.getByText('结束循环', { exact: true })],
    ['结束条件', page.getByText('结束条件', { exact: true })],
    ...['添加到循环体', '添加到满足条件', '添加到否则分支'].map(name => [name, page.getByRole('button', { name, exact: true })]),
  ];
  const missing = [];
  for (const [name, locator] of required) if (!await locator.isVisible()) missing.push(name);
  await page.screenshot({ path: join(qa, 'control-flow-empty.png'), fullPage: true });
  await writeFile(join(qa, 'control-flow-empty-check.json'), JSON.stringify({ missing, visible: required.map(([name]) => name).filter(name => !missing.includes(name)) }, null, 2));
  assert.deepEqual(missing, [], `空控制块必须默认展示分支、闭合标记和添加入口；缺少：${missing.join('、')}`);
  const addLoopChild = branch('验收循环', '循环体').getByRole('button', { name: '添加到循环体', exact: true });
  await addLoopChild.click();
  await page.getByRole('group', { name: '选择要添加的指令', exact: true }).waitFor();
  await addLoopChild.click();
  assert.equal(await page.getByRole('group', { name: '选择要添加的指令', exact: true }).isVisible(), false, '重复点击添加入口应关闭指令菜单');

  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await stepButton('验收循环').click();
  await inspector.getByLabel('循环列表', { exact: true }).fill('[1,2,3]');
  await inspector.getByLabel('当前项变量', { exact: true }).fill('');
  await assertSaveEnabled(false);
  await stepButton('验收条件').click();
  await stepButton('验收循环').click();
  assert.equal(await inspector.getByLabel('当前项变量', { exact: true }).inputValue(), '');
  await assertSaveEnabled(false, '切换步骤再返回不能清除当前项变量的必填校验');
  await inspector.getByLabel('当前项变量', { exact: true }).fill(' item ');
  await assertSaveEnabled(false, '首尾含空格的当前项名称无法被变量引用，应阻止保存');
  for (const name of ['runId', 'scheduledFor']) {
    await inspector.getByLabel('当前项变量', { exact: true }).fill(name);
    await assertSaveEnabled(true, '已移除的系统变量名称可作为普通当前项变量使用');
  }
  await inspector.getByLabel(/^当前项变量/).fill('item');
  await addChild('验收循环', '循环体', '设置变量', '保存当前项');
  await setVariable('lastItem', '{{item}}');
  await inspector.getByLabel('变量值（JSON）', { exact: true }).fill('{{item}}');
  await assertSaveEnabled(false);
  await insertVariable('变量值（JSON）', 'item');
  await waitForJsonValue('{{item}}');
  await assertSaveEnabled(true, '重新选择同一变量应恢复合法 JSON 并清除错误');
  await addChild('验收循环', '循环体', '条件分支', '循环内条件');
  await setCondition('item', 2);
  await addChild('循环内条件', '满足条件', '设置变量', '记录满足条件');
  await setVariable('thenItem', '{{item}}');
  await addChild('循环内条件', '否则', '设置变量', '记录否则分支');
  await setVariable('elseItem', '{{item}}');
  await assertIndented('验收循环', '保存当前项');
  await assertIndented('验收循环', '循环内条件');
  await assertIndented('循环内条件', '记录满足条件');
  await assertIndented('循环内条件', '记录否则分支');

  await stepButton('验收条件').click();
  await setCondition('lastItem', 3);
  // The hidden comparison value must not be resolved when testing truthiness.
  await inspector.getByLabel('比较值类型', { exact: true }).selectOption('variable');
  await inspector.getByLabel('比较值', { exact: true }).fill('missingReference');
  await inspector.getByLabel('比较方式', { exact: true }).selectOption('truthy');
  assert.equal(await inspector.getByLabel('比较值', { exact: true }).isVisible(), false);
  await inspector.getByLabel('比较方式', { exact: true }).selectOption('equals');
  assert.equal(await inspector.getByLabel('比较值', { exact: true }).inputValue(), 'missingReference', '切回比较模式应恢复用户已输入的值');
  await inspector.getByLabel('比较方式', { exact: true }).selectOption('truthy');
  await addChild('验收条件', '满足条件', '设置变量', '最终满足条件');
  await setVariable('finalBranch', 'matched');
  await addChild('验收条件', '否则', '设置变量', '最终否则分支');
  await setVariable('finalBranch', 'otherwise');
  await assertIndented('验收条件', '最终满足条件');
  await assertIndented('验收条件', '最终否则分支');

  // Candidate lists must follow execution order and must not leak loop-local variables.
  await stepButton('保存当前项').click();
  await insertVariable('变量值（JSON）', 'item', ['lastItem', 'thenItem', 'elseItem', 'finalBranch']);
  await stepButton('验收条件').click();
  await insertVariable('判断对象', 'lastItem', ['item', 'finalBranch']);

  // Collapsing a container must hide exactly its descendants; expanding restores editing.
  await page.getByRole('button', { name: '折叠 循环内条件', exact: true }).click();
  assert.equal(await stepButton('记录满足条件').isVisible(), false);
  assert.equal(await stepButton('记录否则分支').isVisible(), false);
  assert.equal(await stepButton('保存当前项').isVisible(), true);
  await page.getByRole('button', { name: '展开 循环内条件', exact: true }).click();
  await stepButton('记录满足条件').waitFor();
  await page.getByRole('button', { name: '折叠 验收循环', exact: true }).click();
  assert.equal(await stepButton('循环内条件').isVisible(), false);
  assert.equal(await stepButton('验收条件').isVisible(), true);
  await page.getByRole('button', { name: '展开 验收循环', exact: true }).click();
  await stepButton('记录否则分支').waitFor();
  await page.getByRole('button', { name: '折叠 验收条件', exact: true }).click();
  assert.equal(await stepButton('最终满足条件').isVisible(), false);
  await page.getByRole('button', { name: '展开 验收条件', exact: true }).click();
  await stepButton('最终满足条件').waitFor();

  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const saved = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  assert.deepEqual(saved.steps.map(step => step.name), ['验收循环', '验收条件']);
  const [loop, condition] = saved.steps;
  assert.deepEqual(loop.params, { items: [1, 2, 3], itemVariable: 'item' });
  assert.deepEqual(loop.children.map(step => step.name), ['保存当前项', '循环内条件']);
  assert.equal(loop.children[0].params.value, '{{item}}', '普通 JSON 参数选择变量后应保存完整引用');
  const nested = loop.children[1];
  assert.deepEqual(nested.params, { left: '{{item}}', operator: 'equals', right: 2 });
  assert.deepEqual(nested.children.map(step => step.name), ['记录满足条件']);
  assert.deepEqual(nested.elseSteps.map(step => step.name), ['记录否则分支']);
  assert.deepEqual(condition.children.map(step => step.name), ['最终满足条件']);
  assert.deepEqual(condition.elseSteps.map(step => step.name), ['最终否则分支']);
  assert.equal(condition.params.left, '{{lastItem}}', '后续条件应引用前序步骤产生的值');
  assert.equal(condition.params.operator, 'truthy');
  assert.equal(Object.hasOwn(condition.params, 'right'), false, '为真判断保存时应移除不参与执行的右值');
  await page.reload();
  await stepButton('记录否则分支').waitFor();
  assert.deepEqual((await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId), saved);
  await stepButton('循环内条件').click();
  assert.equal(await inspector.getByLabel('判断对象类型', { exact: true }).inputValue(), 'variable');
  assert.equal(await inspector.getByLabel('判断对象', { exact: true }).inputValue(), 'item');
  assert.equal(await inspector.getByLabel('比较方式', { exact: true }).inputValue(), 'equals');
  assert.equal(await inspector.getByLabel('比较值类型', { exact: true }).inputValue(), 'number');
  assert.equal(await inspector.getByLabel('比较值', { exact: true }).inputValue(), '2');

  await page.evaluate(() => {
    window.controlFlowSmokeEvents = [];
    window.rpa.onEvent(event => window.controlFlowSmokeEvents.push(event));
  });
  await page.getByRole('button', { name: '运行', exact: true }).click();
  const deadline = Date.now() + 30_000;
  let run;
  do {
    run = (await bootstrap()).runs.find(item => item.workflowId === flow.workflowId);
    if (run && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run?.status, 'succeeded', run?.error);
  assert.equal(run.variables.lastItem, 3);
  assert.equal(run.variables.thenItem, 2);
  assert.equal(run.variables.elseItem, 3);
  assert.equal(run.variables.finalBranch, 'matched');
  assert.equal(run.variables.item, undefined, '循环结束应恢复当前项变量作用域');
  const events = await page.evaluate(() => window.controlFlowSmokeEvents);
  const executions = stepId => events.filter(event => event.runId === run.runId && event.type === 'step' && event.status === 'succeeded' && event.stepId === stepId).length;
  for (const [step, count] of [[loop.children[0], 3], [nested, 3], [nested.children[0], 1], [nested.elseSteps[0], 2], [condition.children[0], 1], [condition.elseSteps[0], 0]]) {
    assert.equal(executions(step.stepId), count, `${step.name} 执行次数应符合嵌套分支`);
  }
  await page.getByRole('button', { name: '收起底部栏', exact: true }).click();
  await page.setViewportSize({ width: 1464, height: 1200 });
  await stepButton('验收循环').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'control-flow-success.png'), fullPage: true });
  await inspector.getByRole('button', { name: '为判断对象插入变量', exact: true }).click();
  await page.screenshot({ path: join(qa, 'variable-picker-success.png'), fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  console.log(JSON.stringify({ status: 'passed', emptyBranchesVisible: true, nestedInsertion: true, branchIndentation: true, collapseExpand: true, editableParameters: true, invalidParametersBlockedAfterReselection: true, truthyIgnoresHiddenComparison: true, variablePicker: true, sameVariableRepairsInvalidJson: true, variableScopeAndOrder: true, savedAndReloaded: true, branchExecutions: { loop: 3, nestedThen: 1, nestedElse: 2, finalThen: 1, finalElse: 0 }, screenshot: join(qa, 'control-flow-success.png'), variableScreenshot: join(qa, 'variable-picker-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'control-flow-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-control-flow-')) throw new Error('拒绝清理非验收临时目录');
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
