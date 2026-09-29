import { _electron as electron, chromium } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-coordinate-desktop-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app, page, peer;
async function waitForRun(runId, stepId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await page.evaluate(async id => (await window.rpa.bootstrap()).runs.find(run => run.runId === id), runId);
    if (run?.stepId === stepId && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) {
      assert.equal(run.status, 'succeeded', run.error);
      return run;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`等待步骤 ${stepId} 完成超时`);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const flow = { ...initial.workflows[0], name: '键盘鼠标与坐标验收', variables: {}, elements: {},
    settings: { headless: false, keepBrowserOpen: true, downloadDir: join(data, 'downloads'), popupPolicy: 'strict' },
    steps: [
      { stepId: 'start', name: '准备浏览器', actionType: 'browser.start', params: {}, output: 'connection' },
      { stepId: 'click', name: '取点点击', actionType: 'browser.mouseClick', params: { pageId: '$current', x: 0, y: 0, button: 'left', clickCount: 1 } },
      { stepId: 'type', name: '输入测试', actionType: 'browser.keyboardType', params: { text: '后台输入成功' } },
    ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const group = page.locator('.action-group').filter({ has: page.getByRole('heading', { name: '键盘和鼠标操作', exact: true }) });
  for (const name of ['鼠标点击', '鼠标移动', '鼠标滚轮', '按下键盘', '键盘输入']) {
    assert.equal(await group.getByRole('button', { name, exact: true }).count(), 1, `${name}应归入键盘和鼠标操作`);
  }
  assert.match(await group.locator('.action-group-notice').innerText(), /会抢夺鼠标和键盘.*任意软件或网页/);
  const webGroup = page.locator('.action-group').filter({ has: page.getByRole('heading', { name: '网页操作', exact: true }) });
  assert.equal(await webGroup.getByRole('button', { name: '网页鼠标点击', exact: true }).count(), 1);
  await page.getByRole('button', { name: '步骤 2：取点点击', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '获取坐标', exact: true }).isDisabled(), true);
  const queued = await page.evaluate(flow => window.rpa.runStep(flow, 'start'), flow);
  const started = await waitForRun(queued.runId, 'start');
  assert.ok(started.variables.connection, JSON.stringify(started));
  peer = await chromium.connectOverCDP(`http://127.0.0.1:${started.variables.connection.debugPort}`);
  const target = peer.contexts()[0].pages()[0];
  await target.setContent('<title>取坐标测试页</title><input id="target" style="position:fixed;left:20px;top:20px;width:200px;height:45px" onclick="document.body.dataset.clicked=1"><div style="height:2200px"></div>');
  await page.getByRole('button', { name: '获取坐标', exact: true }).click();
  await target.locator('[data-rpa-coordinate-picker]').waitFor();
  await target.mouse.click(40, 40);
  assert.equal(await target.evaluate(() => document.body.dataset.clicked), undefined);
  await target.keyboard.down('Control'); await target.keyboard.down('Alt');
  await target.mouse.click(40, 40);
  await target.keyboard.up('Alt'); await target.keyboard.up('Control');
  await page.getByText('已填入 X: 40，Y: 40', { exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  assert.equal(await inspector.getByLabel(/^横坐标 X/).inputValue(), '40');
  assert.equal(await inspector.getByLabel(/^纵坐标 Y/).inputValue(), '40');
  assert.equal(await target.evaluate(() => document.body.dataset.clicked), undefined);
  await page.getByRole('button', { name: '获取坐标', exact: true }).click();
  await target.locator('[data-rpa-coordinate-picker]').waitFor();
  await target.keyboard.press('Escape');
  await page.getByText('取点已取消或超时，原坐标保留。', { exact: true }).waitFor();
  assert.equal(await inspector.getByLabel(/^横坐标 X/).inputValue(), '40');
  await page.getByRole('button', { name: '单独运行 取点点击', exact: true }).click();
  await waitForRun(queued.runId, 'click');
  assert.equal(await target.evaluate(() => document.body.dataset.clicked), '1');
  await page.getByRole('button', { name: '单独运行 输入测试', exact: true }).click();
  await waitForRun(queued.runId, 'type');
  assert.equal(await target.locator('#target').inputValue(), '后台输入成功');
  await page.getByRole('button', { name: '步骤 2：取点点击', exact: true }).click();
  await group.scrollIntoViewIfNeeded();
  await inspector.getByLabel(/^纵坐标 Y/).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'coordinate-picker-success.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', category: true, hotkeyPick: true, ordinaryClickBlocked: true, cancelPreservesCoordinates: true, executePickedPoint: true, keyboardInput: true, screenshot: join(qa, 'coordinate-picker-success.png') }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'coordinate-picker-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try { await peer?.close(); await app?.close(); }
  finally {
    if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-coordinate-desktop-')) throw new Error('拒绝清理非验收临时目录');
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
