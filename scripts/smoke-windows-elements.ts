import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { desktopInteractionAvailable, startWindowsFixture } from '../tests/fixtures/windows.js';
import { runDesktopInput as sendDesktopInput } from '../packages/engine/src/desktop-input.js';
import { WindowsSession } from '../packages/windows/src/index.js';
import type { DesktopApi, WorkflowDefinition } from '../packages/contracts/src/index.js';

declare global { interface Window { rpa: DesktopApi } }
const runDesktopInput = (action: string, params: Record<string, unknown>) => sendDesktopInput(action, params, 30_000, undefined, { idleMs: 0, waitMs: 10_000 });
const data = await mkdtemp(join(tmpdir(), 'rpa-windows-smoke-'));
const qa = resolve('.rpa/qa'); await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: process.cwd(), RPA_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let fixture: Awaited<ReturnType<typeof startWindowsFixture>> | undefined;
async function waitForStep(page: Page, stepId: string, excluded: string[] = []) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const run = (await page.evaluate(() => window.rpa.bootstrap())).runs.find(run => !excluded.includes(run.runId) && run.stepId === stepId && ['succeeded', 'failed', 'interrupted', 'stopped'].includes(run.status));
    if (run) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const state = await page.evaluate(() => window.rpa.bootstrap());
  throw new Error(`等待桌面步骤 ${stepId} 完成超时；运行：${JSON.stringify(state.runs.map(run => ({ runId: run.runId, stepId: run.stepId, status: run.status, error: run.error })))}；界面提示：${await page.locator('[role="alert"]').allTextContents()}`);
}
try {
  const interactive = await desktopInteractionAvailable();
  if (!interactive) console.warn('环境跳过：真实 F8 捕获和 Esc 取消（SetCursorPos 被拒绝）。继续验收原生 UIA 定位、元素编辑与执行。');
  fixture = await startWindowsFixture();
  const native = new WindowsSession();
  const captured = interactive ? undefined : await native.inspect(fixture.x, fixture.y);
  native.close();
  if (!interactive) assert.equal(captured?.attributes.Name, '输入', 'UIA 点位捕获应得到测试输入框');
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: process.cwd(), env });
  const page = await app.firstWindow(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const flow: WorkflowDefinition = { ...initial.workflows[0], name: 'Windows 元素验收', variables: {}, elements: {}, desktopElements: captured ? { 待命名元素: captured.element } : {}, steps: [
    { stepId: 'fill', name: '填写软件', actionType: 'windows.fill', params: { selector: captured ? '@待命名元素' : '', value: '界面验收成功', mode: 'api', append: false } },
    { stepId: 'read', name: '读取软件', actionType: 'windows.text', params: { selector: '' }, output: 'softwareText' },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow); await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：填写软件', exact: true }).click();
  await page.getByRole('complementary', { name: '参数与设置', exact: true }).getByRole('button', { name: '步骤参数', exact: true }).click();
  await page.getByRole('button', { name: '捕获或编辑桌面元素', exact: true }).click();
  await page.getByLabel('桌面元素保存范围').selectOption('workflow');
  if (interactive) {
    await page.getByRole('button', { name: '捕获新软件元素', exact: true }).click();
    await runDesktopInput('desktop.mouseMove', { x: fixture.x, y: fixture.y, humanLike: false });
    await runDesktopInput('desktop.keyPress', { key: 'F8' });
  } else await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('桌面元素名称').waitFor();
  await page.getByLabel('桌面元素名称').fill('验收输入框');
  await page.getByRole('button', { name: '校验桌面元素', exact: true }).click();
  await page.getByText(/校验结果：匹配 1 个元素/).waitFor();
  await page.getByRole('button', { name: '保存桌面元素', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  await page.reload(); await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const saved = (await page.evaluate(() => window.rpa.bootstrap())).workflows.find(item => item.workflowId === flow.workflowId)!;
  assert.ok(saved.desktopElements?.['验收输入框']); assert.equal(saved.steps[0].params.selector, '@验收输入框');
  await page.getByRole('button', { name: '步骤 1：填写软件', exact: true }).click();
  const oldRuns = (await page.evaluate(() => window.rpa.bootstrap())).runs.map(run => run.runId);
  await page.getByRole('button', { name: '单独运行 填写软件', exact: true }).click();
  const first = await waitForStep(page, 'fill', oldRuns); assert.equal(first.status, 'succeeded', first.error);
  assert.equal((await fixture.call('state')).text, '界面验收成功');
  await page.getByRole('button', { name: '步骤 2：读取软件', exact: true }).click();
  await page.getByLabel('桌面目标元素', { exact: true }).selectOption('@验收输入框');
  await page.getByRole('button', { name: '单独运行 读取软件', exact: true }).click();
  const read = await waitForStep(page, 'read');
  assert.equal(read.status, 'succeeded', read.error); assert.equal(read.variables.softwareText, '界面验收成功');
  await page.getByRole('button', { name: '步骤编辑', exact: true }).click();
  await page.getByRole('button', { name: '捕获或编辑桌面元素', exact: true }).click();
  await page.getByLabel('桌面元素保存范围').selectOption('workflow');
  if (interactive) {
    await page.getByRole('button', { name: '捕获新软件元素', exact: true }).click();
    await runDesktopInput('desktop.keyPress', { key: 'Escape' });
    await page.getByText('捕获已取消，原配置保留。', { exact: true }).waitFor();
  } else {
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('桌面元素名称').fill('取消编辑不应保存');
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  }
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const preserved = (await page.evaluate(() => window.rpa.bootstrap())).workflows.find(item => item.workflowId === flow.workflowId)!;
  assert.deepEqual(preserved.desktopElements, saved.desktopElements);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('button', { name: '校验桌面元素', exact: true }).click();
  await page.getByText(/校验结果：匹配 1 个元素/).waitFor();
  await page.getByLabel('桌面元素名称').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'desktop-success.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(interactive ? 'Windows 元素捕获、编辑、校验、保存、重载、单步与取消冒烟测试通过' : 'Windows 原生点位定位、元素编辑、校验、保存、重载、单步及取消编辑冒烟测试通过；真实快捷键捕获取消因环境跳过');
} finally {
  await app?.close(); await fixture?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-windows-smoke-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
