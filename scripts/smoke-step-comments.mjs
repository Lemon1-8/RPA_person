import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-step-comments-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const node = id => page.locator(`.step-node[data-step-id="${id}"]`).first();
const card = id => node(id).locator('> .step-node-heading > .step-card');
const step = id => card(id).locator('.step-main');
const bootstrap = () => page.evaluate(() => window.rpa.bootstrap());
async function selected(ids) {
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.step-main[aria-pressed="true"]')]
    .map(element => element.closest('.step-node').dataset.stepId)) === JSON.stringify(expected), ids);
  const actual = await page.locator('.step-main[aria-pressed="true"]').evaluateAll(elements => elements.map(element => element.closest('.step-node').dataset.stepId));
  assert.deepEqual(actual, ids, '多选集合应符合 Ctrl / Shift 点击语义');
}
async function commented(ids) {
  const actual = await page.locator('.step-card.step-disabled').evaluateAll(elements => elements.map(element => element.closest('.step-node').dataset.stepId));
  assert.deepEqual(actual, ids, '已注释的节点与容器子步骤应明确标识');
}
async function save() {
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
}

try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0], name: '指令多选与注释验收', variables: {}, elements: {},
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: false },
    steps: [
      { stepId: 'a', name: '准备数据', actionType: 'variables.set', params: { name: 'started', value: true } },
      { stepId: 'b', name: '等待页面稳定', actionType: 'core.wait', params: { durationSeconds: 0 } },
      { stepId: 'c', name: '记录处理进度', actionType: 'core.log', params: { message: '准备完成，开始处理', level: 'info' } },
      { stepId: 'group', name: '检查处理条件', actionType: 'control.if', params: { left: true, operator: 'equals', right: true }, children: [
        { stepId: 'child1', name: '处理当前数据', actionType: 'variables.set', params: { name: 'childRan', value: true } },
        { stepId: 'child2', name: '可选数据处理', actionType: 'variables.set', params: { name: 'optionalRan', value: true } },
      ] },
      { stepId: 'tail', name: '结束并保存结果', actionType: 'variables.set', params: { name: 'finished', value: true } },
      { stepId: 'invalid', name: '待配置的网页', actionType: 'browser.open', params: { url: '' }, disabled: true },
    ],
  };
  await page.evaluate(value => window.rpa.saveWorkflow(value), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  assert.equal(await page.locator('.step-selection-bar').count(), 0, '画布不再渲染多选提示与批量操作栏');
  assert.equal(await page.getByRole('group', { name: '指令批量操作', exact: true }).count(), 0);
  await step('b').click();
  await step('c').click({ modifiers: ['Control'] });
  await selected(['b', 'c']);
  await page.keyboard.press('Control+/');
  await commented(['b', 'c', 'invalid']);
  await page.keyboard.press('Control+/');
  await commented(['invalid']);
  await step('a').click({ modifiers: ['Control'] });
  await selected(['a', 'b', 'c']);
  await step('b').click({ modifiers: ['Control'] });
  await selected(['a', 'c']);
  await step('a').click();
  await step('c').click({ modifiers: ['Shift'] });
  await selected(['a', 'b', 'c']);
  await step('tail').click({ modifiers: ['Control', 'Shift'] });
  await selected(['a', 'b', 'c', 'group', 'child1', 'child2', 'tail']);

  await step('c').click();
  await page.keyboard.press('Control+/');
  await commented(['c', 'invalid']);
  await step('c').dispatchEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, repeat: true, bubbles: true });
  await commented(['c', 'invalid']);
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await inspector.getByLabel('步骤名称', { exact: true }).focus();
  await page.keyboard.press('Control+/');
  await commented(['c', 'invalid']);
  await save();
  await page.reload();
  await step('c').waitFor();
  await commented(['c', 'invalid']);
  await step('c').click();
  await page.keyboard.press('Control+/');

  await step('child2').click();
  await page.keyboard.press('Control+/');
  await step('group').click();
  await page.keyboard.press('Control+/');
  await commented(['group', 'child1', 'child2', 'invalid']);
  assert.equal(await card('child1').getByRole('button', { name: '单独运行 处理当前数据', exact: true }).isEnabled(), false);
  await step('child1').click();
  assert.equal(await page.getByRole('button', { name: '运行选中指令', exact: true }).isEnabled(), false);
  await step('group').click();
  await page.keyboard.press('Control+/');
  await commented(['child2', 'invalid']);

  await step('a').click();
  await page.getByRole('button', { name: '折叠 检查处理条件', exact: true }).click();
  await step('tail').click({ modifiers: ['Shift'] });
  await selected(['a', 'b', 'c', 'group', 'tail']);
  await page.keyboard.press('Control+/');
  await save();
  const persisted = (await bootstrap()).workflows.find(item => item.workflowId === flow.workflowId);
  assert.equal(persisted.steps[3].children[0].disabled, undefined, '范围选择不能修改折叠容器内不可见步骤自身的注释状态');
  assert.equal(persisted.steps[3].children[1].disabled, true, '容器注释不覆盖子步骤自己的注释标记');
  await page.keyboard.press('Control+/'); // Focus is on Save: must not alter the canvas.
  await commented(['a', 'b', 'c', 'group', 'child1', 'child2', 'tail', 'invalid']);
  await step('tail').focus();
  await selected(['a', 'b', 'c', 'group', 'tail']);
  await page.keyboard.press('Control+/');
  await selected(['a', 'b', 'c', 'group', 'tail']);
  await page.getByRole('button', { name: '展开 检查处理条件', exact: true }).click();
  await commented(['child2', 'invalid']);

  await step('child1').click();
  await step('tail').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: '折叠 检查处理条件', exact: true }).click();
  await step('a').click({ modifiers: ['Shift'] });
  await selected(['a', 'b', 'c', 'group', 'tail']);
  await page.getByRole('button', { name: '展开 检查处理条件', exact: true }).click();

  await step('b').click();
  await step('c').click({ modifiers: ['Control'] });
  await page.keyboard.press('Control+/');
  await selected(['b', 'c']);
  await page.getByRole('button', { name: '删除 记录处理进度', exact: true }).click();
  await selected([]);
  await step('b').click();
  await page.keyboard.press('Control+/');
  await step('invalid').click();
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true, '已注释步骤的未配置参数不能阻止保存');
  assert.match(await step('a').innerText(), /变量/);
  assert.doesNotMatch(await step('a').innerText(), /name:|value:/);
  assert.match(await step('b').innerText(), /秒/);
  await save();
  await page.getByRole('button', { name: '运行', exact: true }).click();
  let run;
  const deadline = Date.now() + 30_000;
  do {
    run = (await bootstrap()).runs.find(item => item.workflowId === flow.workflowId);
    if (run && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(run?.status, 'succeeded', run?.error);
  assert.equal(run.variables.started, true);
  assert.equal(run.variables.childRan, true);
  assert.equal(run.variables.finished, true);
  assert.equal(run.variables.optionalRan, undefined);
  assert.equal(run.browserOpen, false);
  await page.getByRole('button', { name: '步骤编辑', exact: true }).click();
  await step('group').click();
  await page.locator('.step-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(qa, 'step-comments-success.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', multiSelection: true, rangeSelection: true, batchComments: true, editorShortcutIsolation: true, nestedComments: true, persisted: true, skippedAtRuntime: true, chineseDetails: true, screenshot: join(qa, 'step-comments-success.png') }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'step-comments-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { if (app) await app.close(); }
  finally {
    const target = resolve(data);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-step-comments-')) throw new Error('拒绝清理非验收临时目录');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
