import { _electron as electron, chromium } from 'playwright';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-browser-pages-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const title = request.url === '/detail' ? '订单详情' : request.url === '/report' ? '统计报表' : request.url === '/manual' ? '手动新网页' : '订单列表';
  response.end(`<!doctype html><title>${title}</title><h1>${title}</h1><a id="detail" href="/detail" target="_blank">查看订单</a><button id="mark-current" onclick="document.querySelector('h1').textContent += ' · 已点击'">标记当前页</button>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const manualPort = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
let app;
let unrelatedBrowser;
let page;
let runId;
const bootstrap = () => page.evaluate(() => window.rpa.bootstrap());
const pageList = () => page.evaluate(id => window.rpa.listBrowserPages(id), runId);
const stepButton = name => page.getByRole('button', { name: new RegExp(`^步骤 \\d+：${name}$`) });
async function waitForBrowserPage(predicate, message) {
  const deadline = Date.now() + 10000;
  do {
    const match = (await pageList()).find(predicate);
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(message);
}
async function runStep(name, expected = 'succeeded') {
  const from = await page.evaluate(() => window.pageSmokeEvents.length);
  await page.getByRole('button', { name: `单独运行 ${name}`, exact: true }).click();
  await page.waitForFunction(from => window.pageSmokeEvents.slice(from).some(event => event.type === 'run' && ['succeeded', 'failed', 'stopped'].includes(event.status)), from);
  const event = await page.evaluate(from => window.pageSmokeEvents.slice(from).find(event => event.type === 'run' && ['succeeded', 'failed', 'stopped'].includes(event.status)), from);
  assert.equal(event.status, expected, event.run?.error);
  if (runId) assert.equal(event.runId, runId, '多网页步骤必须复用同一会话');
  runId = event.runId;
  await page.getByRole('button', { name: '步骤编辑', exact: true }).click();
  return event.run;
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const library = page.getByRole('complementary', { name: '指令库' });
  assert.equal(await library.getByRole('button', { name: '启动浏览器', exact: true }).count(), 0);
  assert.equal(await library.getByRole('button', { name: '切换网页', exact: true }).count(), 0, '目标网页统一由步骤右侧参数选择');
  for (const name of ['打开网页', '关闭网页']) assert.equal(await library.getByRole('button', { name, exact: true }).count(), 1);
  const initial = await bootstrap();
  const flow = {
    ...initial.workflows[0], name: '多网页验收', variables: { dynamicSelector: '@heading' }, elements: { heading: { selector: 'h1', pageRef: 'orders' } },
    settings: { downloadDir: join(data, 'downloads'), headless: true, keepBrowserOpen: true, popupPolicy: 'off' },
    steps: [
      { stepId: 'orders', name: '打开订单页', actionType: 'browser.open', params: { url: origin, pageId: 'orders', browserChannel: 'chromium' }, output: 'openedOrders' },
      { stepId: 'detail', name: '点击打开详情', actionType: 'browser.click', params: { selector: '#detail', pageId: 'orders' }, output: 'clickResult' },
      { stepId: 'click-target', name: '点击目标网页', actionType: 'browser.click', params: { selector: '#mark-current' } },
      { stepId: 'read-current', name: '读取当前网页', actionType: 'browser.text', params: { selector: 'h1' }, output: 'currentText' },
      { stepId: 'read', name: '读取详情', actionType: 'browser.text', params: { selector: 'h1', pageId: 'orders' }, output: 'pageText' },
      { stepId: 'report', name: '打开报表页', actionType: 'browser.open', params: { url: `${origin}/report` } },
      { stepId: 'close', name: '关闭详情页', actionType: 'browser.closePage', params: { pageId: 'orders' }, output: 'closeResult' },
      { stepId: 'manual', name: '模拟手动新建标签页', actionType: 'script.run', params: { language: 'javascript', code: `await rpa.call('browser.evaluate', { pageId: 'orders', expression: ${JSON.stringify(`void window.open('${origin}/manual')`)} });` } },
      { stepId: 'inherited', name: '继承元素目标', actionType: 'browser.text', params: { selector: '@heading' }, output: 'inheritedText' },
      { stepId: 'dynamic-inherited', name: '动态元素目标', actionType: 'browser.text', params: { selector: '{{dynamicSelector}}' }, output: 'dynamicText' },
    ],
  };
  const initialSaved = await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow);
  // Seed an actual legacy file, so both loading and saving must discard retired fields.
  const workflowPath = join(data, 'workflows', `${initialSaved.workflowId}.json`);
  initialSaved.steps.find(step => step.stepId === 'detail').params = {
    selector: '#detail', pageId: 'orders', waitForNewPage: true, newPageId: { pageId: 'orders' },
  };
  await writeFile(workflowPath, JSON.stringify(initialSaved, null, 2));
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  const loadedClick = (await bootstrap()).workflows[0].steps.find(step => step.stepId === 'detail');
  assert.equal(Object.hasOwn(loadedClick.params, 'waitForNewPage'), false, '加载旧流程时必须移除弹页开关');
  assert.equal(Object.hasOwn(loadedClick.params, 'newPageId'), false, '加载旧流程时必须移除无效的新网页名称');
  const inspector = page.getByRole('complementary', { name: '参数与设置' });
  await stepButton('打开订单页').click();
  await inspector.getByText('浏览器高级设置', { exact: true }).click();
  assert.equal(await inspector.getByLabel('浏览器', { exact: true }).inputValue(), 'chromium');
  const portMode = inspector.getByLabel('浏览器端口分配', { exact: true });
  const portInput = inspector.getByLabel('浏览器端口', { exact: true });
  assert.equal(await portMode.inputValue(), 'auto');
  assert.equal(await portInput.count(), 0, '自动模式无需填写端口');
  await portMode.selectOption('manual');
  assert.equal(await portInput.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), false, '手动模式必须填写端口');
  await portInput.fill('1023');
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), false, '端口范围错误应禁止保存');
  await portInput.fill(String(manualPort));
  await portMode.selectOption('auto');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(Object.hasOwn((await bootstrap()).workflows[0].steps[0].params, 'debugPort'), false, '自动模式必须清除之前的手动值');
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await stepButton('打开订单页').click();
  await inspector.getByText('浏览器高级设置', { exact: true }).click();
  assert.equal(await portMode.inputValue(), 'auto');
  await portMode.selectOption('manual');
  await portInput.fill(String(manualPort));
  await portInput.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(qa, 'browser-port-settings.png'), fullPage: true });
  await stepButton('点击打开详情').click();
  assert.equal(await inspector.getByLabel('点击后切换到新标签页', { exact: true }).count(), 0, '点击元素不再显示弹页开关');
  assert.equal(await inspector.getByLabel('新网页名称', { exact: true }).count(), 0, '点击元素不再要求新网页名称');
  assert.equal(await inspector.getByRole('button', { name: '为新网页别名插入变量', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), true, '旧流程中无效的新网页名称不能阻止保存');
  await stepButton('打开报表页').click();
  await inspector.getByLabel('打开方式', { exact: true }).selectOption('new');
  await inspector.getByLabel('新网页别名', { exact: true }).fill('reports');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const saved = (await bootstrap()).workflows[0];
  assert.equal(saved.steps[0].params.debugPort, manualPort, '手动端口应保存为数字');
  const savedClick = saved.steps.find(step => step.stepId === 'detail');
  const storedClick = JSON.parse(await readFile(workflowPath, 'utf8')).steps.find(step => step.stepId === 'detail');
  for (const click of [savedClick, storedClick]) {
    assert.equal(Object.hasOwn(click.params, 'waitForNewPage'), false, '旧点击步骤必须移除弹页开关');
    assert.equal(Object.hasOwn(click.params, 'newPageId'), false, '旧点击步骤必须移除新网页名称');
  }
  assert.equal(saved.steps.find(step => step.stepId === 'report').params.openMode, 'new');
  assert.equal(saved.steps.find(step => step.stepId === 'report').params.pageId, 'reports');
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await stepButton('打开订单页').click();
  assert.equal(await portMode.inputValue(), 'manual', '重新加载后保持手动端口');
  assert.equal(await portInput.inputValue(), String(manualPort));
  await page.evaluate(() => { window.pageSmokeEvents = []; window.rpa.onEvent(event => window.pageSmokeEvents.push(event)); });
  await runStep('打开订单页');
  const debugPages = await (await fetch(`http://127.0.0.1:${manualPort}/json/list`)).json();
  assert.ok(debugPages.some(item => item.title === '订单列表' && item.url === `${origin}/`), '浏览器必须实际监听界面指定的端口');
  const clicked = await runStep('点击打开详情');
  assert.deepEqual(clicked.variables.clickResult, { ok: true }, '普通点击只返回点击结果');
  const detail = await waitForBrowserPage(item => item.title === '订单详情', '点击产生的新标签页应自动登记');
  assert.match(detail.pageId, /^page-\d+$/);
  assert.equal(detail.current, false, '点击打开新标签页不得隐式切换流程当前网页');
  assert.ok((await pageList()).some(item => item.pageId === 'orders' && item.current));
  await runStep('点击目标网页');
  assert.equal((await runStep('读取当前网页')).variables.currentText, '订单列表 · 已点击', '默认当前的点击和读取必须继续操作原网页');
  const target = inspector.getByLabel('目标网页', { exact: true });
  const pageChoice = inspector.getByLabel('选择网页', { exact: true });
  await stepButton('点击目标网页').click();
  assert.equal(await target.inputValue(), 'current');
  await target.selectOption('page');
  await pageChoice.selectOption(detail.pageId);
  await runStep('点击目标网页');
  await stepButton('读取详情').click();
  assert.equal(await target.inputValue(), 'page');
  assert.deepEqual(await target.locator('option').allTextContents(), ['当前网页', '指定网页', '填写名称或变量']);
  await page.waitForFunction(id => [...document.querySelectorAll('select option')].some(option => option.value === id && option.textContent.includes('订单详情')), detail.pageId);
  await pageChoice.selectOption(detail.pageId);
  assert.equal((await runStep('读取详情')).variables.pageText, '订单详情 · 已点击', '右侧指定弹出的网页后，点击与读取必须直接命中新页');
  assert.ok((await pageList()).some(item => item.pageId === 'orders' && item.current), '指定目标执行不能改写流程当前网页');
  await stepButton('点击目标网页').click();
  await pageChoice.selectOption('orders');
  await runStep('点击目标网页');
  const ordersText = '订单列表 · 已点击 · 已点击';
  await stepButton('读取详情').click();
  await pageChoice.selectOption('orders');
  assert.equal((await runStep('读取详情')).variables.pageText, ordersText, '同一点击步骤改选原网页后必须命中原页');
  assert.equal((await runStep('读取当前网页')).variables.currentText, ordersText, '指定其他网页执行后，默认当前仍指向原页');
  assert.ok((await pageList()).some(item => item.pageId === 'orders' && item.current));
  await stepButton('点击目标网页').click();
  await target.selectOption('current');
  assert.equal(await pageChoice.count(), 0, '默认当前网页不混列全部网页');
  assert.equal(await inspector.getByRole('button', { name: '为目标网页插入变量', exact: true }).count(), 0, '变量入口仅在填写名称模式出现');
  await inspector.getByLabel('目标网页详情').getByText('当前指向 · orders', { exact: true }).waitFor();
  await page.screenshot({ path: join(qa, 'browser-current-page.png'), fullPage: true });
  await runStep('打开报表页');
  assert.ok((await pageList()).some(item => item.pageId === 'reports' && item.current));
  await stepButton('继承元素目标').click();
  const inheritedTarget = inspector.getByLabel('目标网页', { exact: true });
  assert.equal(await inheritedTarget.inputValue(), 'element');
  assert.equal((await runStep('继承元素目标')).variables.inheritedText, ordersText, '隐式目标继承元素网页，不能误称强制当前网页');
  await inheritedTarget.selectOption('current');
  assert.equal((await runStep('继承元素目标')).variables.inheritedText, '统计报表', '显式当前网页应覆盖元素继承');
  await inheritedTarget.selectOption('element');
  assert.equal((await runStep('继承元素目标')).variables.inheritedText, ordersText, '覆盖当前网页后仍能恢复真实元素绑定');
  await stepButton('动态元素目标').click();
  assert.equal(await inheritedTarget.inputValue(), 'element', '运行时解析的元素不能误显示为明确当前网页');
  assert.equal((await runStep('动态元素目标')).variables.dynamicText, ordersText);
  await inheritedTarget.selectOption('current');
  assert.equal((await runStep('动态元素目标')).variables.dynamicText, '统计报表', '动态元素同样支持显式覆盖当前网页');
  await runStep('模拟手动新建标签页');
  const manual = await waitForBrowserPage(item => item.title === '手动新网页', '手动打开的标签页应自动登记');
  assert.ok(manual && !manual.current, '手动打开网页不得改变流程当前目标');
  await stepButton('读取详情').click();
  await page.waitForFunction(id => [...document.querySelectorAll('select option')].some(option => option.value === id), manual.pageId);
  await pageChoice.selectOption(manual.pageId);
  assert.equal((await runStep('读取详情')).variables.pageText, '手动新网页');
  await page.setViewportSize({ width: 1464, height: 1100 });
  await page.screenshot({ path: join(qa, 'browser-pages-success.png'), fullPage: true });
  await target.selectOption('custom');
  await inspector.getByRole('button', { name: '为目标网页插入变量', exact: true }).click();
  await page.getByRole('button', { name: '插入 {{openedOrders.pageId}}', exact: true }).click();
  assert.equal((await runStep('读取详情')).variables.pageText, ordersText, '从打开网页的输出选择 pageId 属性可直接定位网页');
  await target.selectOption('page');
  await pageChoice.selectOption(detail.pageId);
  await stepButton('关闭详情页').click();
  await pageChoice.selectOption(detail.pageId);
  await runStep('关闭详情页');
  assert.equal((await pageList()).some(item => item.pageId === detail.pageId), false);
  await stepButton('读取详情').click();
  const failed = await runStep('读取详情', 'failed');
  assert.match(failed.error, /不存在|关闭/);
  assert.ok((await pageList()).some(item => item.pageId === 'reports' && item.current), '关闭其他网页或读取失败不得误切换目标');
  await stepButton('关闭详情页').click();
  const closeMode = inspector.getByLabel('关闭范围', { exact: true });
  assert.equal(await closeMode.inputValue(), 'page', '旧关闭步骤默认保持关闭指定网页');
  assert.equal(await target.count(), 1, '关闭单个网页时应显示目标网页');
  await closeMode.selectOption('all');
  assert.equal(await target.count(), 0, '关闭所有网页时不能选择单个目标网页');
  await inspector.getByText(/仅关闭本次使用的自动化浏览器中的所有网页/).waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const allSaved = (await bootstrap()).workflows[0].steps.find(step => step.stepId === 'close');
  assert.equal(allSaved.params.closeMode, 'all');
  assert.equal(Object.hasOwn(allSaved.params, 'pageId'), false, '关闭所有网页必须清除之前的单页目标');
  await closeMode.selectOption('page');
  assert.equal(await target.inputValue(), 'current', '切回单页关闭应使用当前网页');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await bootstrap()).workflows[0].steps.find(step => step.stepId === 'close').params.pageId, '$current');
  await closeMode.selectOption('all');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await stepButton('关闭详情页').click();
  assert.equal(await closeMode.inputValue(), 'all', '重新加载后应保留关闭所有网页模式');
  assert.equal(await target.count(), 0);
  const allStored = JSON.parse(await readFile(workflowPath, 'utf8')).steps.find(step => step.stepId === 'close');
  assert.equal(allStored.params.closeMode, 'all');
  assert.equal(Object.hasOwn(allStored.params, 'pageId'), false);
  await page.evaluate(() => { window.pageSmokeEvents = []; window.rpa.onEvent(event => window.pageSmokeEvents.push(event)); });
  const remainingPages = await pageList();
  assert.ok(remainingPages.length >= 3, '关闭全部前应保留原网页、新建网页和手动弹出网页');
  unrelatedBrowser = await chromium.launch({ headless: true });
  const unrelatedPage = await unrelatedBrowser.newPage();
  await unrelatedPage.goto(`${origin}/manual`);
  const closedAll = await runStep('关闭详情页');
  assert.deepEqual(closedAll.variables.closeResult, { ok: true, closedPageIds: remainingPages.map(item => item.pageId) });
  assert.equal(closedAll.browserOpen, false, '关闭所有网页后不应继续保留浏览器');
  assert.deepEqual(await pageList(), [], '本次任务所有网页应被清空');
  assert.equal((await bootstrap()).runs.find(item => item.runId === runId).browserOpen, false);
  assert.equal(unrelatedBrowser.isConnected(), true, '关闭本次浏览器不得关闭其他浏览器进程');
  assert.equal(await unrelatedPage.title(), '手动新网页', '其他浏览器的网页必须仍可访问');
  await unrelatedPage.locator('#mark-current').click();
  assert.equal(await unrelatedPage.locator('h1').textContent(), '手动新网页 · 已点击', '其他浏览器应保持正常交互');
  await page.screenshot({ path: join(qa, 'browser-close-all-success.png'), fullPage: true });
  assert.equal((await bootstrap()).runs.length, 1);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: 'passed', mergedOpen: true, automaticAndManualPort: true, manualPortApplied: true, legacyClickFieldsRemoved: true, noSwitchCommand: true, popupKeepsCurrentPage: true, targetPickerClickAcrossPages: true, livePagePicker: true, manualPageRegistered: true, sameBrowser: true, closedTargetRejected: true, closeAllPersists: true, closeAllClearsBrowser: true, unrelatedBrowserPreserved: true, screenshot: join(qa, 'browser-pages-success.png'), closeAllScreenshot: join(qa, 'browser-close-all-success.png') }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'browser-pages-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  try {
    try { if (unrelatedBrowser) await unrelatedBrowser.close(); }
    finally { if (app) await app.close(); }
  }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const target = resolve(data);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-browser-pages-')) throw new Error('拒绝清理非验收临时目录');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
