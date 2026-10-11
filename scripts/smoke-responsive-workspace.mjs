import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-responsive-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height]);
  return page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, bottom: rect.bottom, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    const scrollStyle = getComputedStyle(document.querySelector('.step-scroll'));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      shell: box('.app-shell'), editor: box('.editor'), scroll: box('.step-scroll'), list: box('.step-list'),
      console: box('.console'), inspector: box('.inspector'), library: box('.library'), workspace: box('.workspace'), status: box('.statusbar'),
      padding: parseFloat(scrollStyle.paddingLeft) + parseFloat(scrollStyle.paddingRight),
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}
function fits(metrics) {
  assert.equal(metrics.documentWidth, metrics.viewport.width, '窗口不应出现整体横向溢出');
  assert.ok(metrics.status.bottom <= metrics.viewport.height + 1, '底部状态栏应跟随窗口底边');
  assert.ok(metrics.inspector.right <= metrics.viewport.width + 1, '右侧参数栏不能被窗口裁切');
  assert.ok(metrics.scroll.height >= 100, '较小窗口也应保留可用的步骤编排空间');
  assert.ok(Math.abs(metrics.inspector.height - metrics.workspace.height) <= 1, '右栏应使用工作区完整高度');
  assert.ok(Math.abs(metrics.library.height - metrics.workspace.height) <= 1, '指令库应使用工作区完整高度');
  assert.ok(Math.abs(metrics.workspace.bottom - metrics.status.bottom + metrics.status.height) <= 1, '工作区底边应紧邻状态栏');
  assert.ok(metrics.scroll.scrollWidth <= metrics.scroll.clientWidth + 1, '步骤编排不应横向溢出');
  const expected = metrics.scroll.clientWidth - metrics.padding;
  assert.ok(Math.abs(metrics.list.width - expected) <= 1, `步骤应填满工作区可用宽度：实际 ${metrics.list.width}，可用 ${expected}`);
}
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  let initial = await page.evaluate(() => window.rpa.bootstrap());
  assert.deepEqual(initial.workflows[0].variables, {}, '新建工作空间不得带入演示变量');
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), {
    ...initial.workflows[0], variables: { demoUrl: initial.demoUrl, customer: '跨语言订单', actualInput: '用户变量' },
    steps: [{ stepId: 'edited-open', name: '打开网页', actionType: 'browser.open', params: { url: '{{customer}}{{demoUrl}}' } }],
  });
  await app.close();
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  initial = await page.evaluate(() => window.rpa.bootstrap());
  assert.deepEqual(initial.workflows[0].variables, { actualInput: '用户变量' }, '旧存档必须删除两个默认声明并保留用户变量');
  assert.equal(initial.workflows[0].steps[0].params.url, `跨语言订单${initial.demoUrl}`, '旧模板引用应替换为具体值');
  await page.getByRole('button', { name: '为网页地址插入变量', exact: true }).click();
  const picker = page.getByRole('group', { name: '为网页地址插入变量列表', exact: true });
  assert.equal(await picker.getByRole('button', { name: '插入 {{demoUrl}}', exact: true }).count(), 0);
  assert.equal(await picker.getByRole('button', { name: '插入 {{customer}}', exact: true }).count(), 0);
  assert.equal(await picker.getByRole('button', { name: '插入 {{actualInput}}', exact: true }).count(), 1);
  const flow = { ...initial.workflows[0], name: '工作区自适应验收', steps: [
    { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: initial.demoUrl } },
    { stepId: 'branch', name: '条件分支', actionType: 'control.if', params: { left: true, operator: 'equals', right: true }, children: [
      { stepId: 'nested', name: '嵌套分支', actionType: 'control.if', params: { left: true, operator: 'equals', right: true }, children: [
        { stepId: 'log', name: '打印日志', actionType: 'core.log', params: { message: '检查嵌套步骤随宽度伸缩' } },
      ] },
    ] },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), flow);
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  await page.evaluate(() => { localStorage.setItem('rpa.consoleHeight', '360'); localStorage.setItem('rpa.rightPane', 'step'); });
  await page.reload();
  await page.getByRole('heading', { name: flow.name, exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: '运行监控', exact: true }).isVisible(), false, '默认编辑时应显示参数，旧底栏高度不应留下空白');
  const large = await resize(1800, 1000);
  const small = await resize(1040, 650);
  fits(large);
  fits(small);
  assert.ok(large.list.width > small.list.width + 500, '工作区宽度应随窗口显著增大');
  assert.ok(large.scroll.height > small.scroll.height + 100, '工作区高度应随窗口增大');
  await page.screenshot({ path: join(qa, 'workspace-responsive-small.png'), fullPage: true });
  await page.getByRole('button', { name: '运行结果', exact: true }).click();
  const monitoring = await resize(1040, 650);
  fits(monitoring);
  assert.ok(Math.abs(monitoring.scroll.height - small.scroll.height) <= 1, '查看运行结果不应占用流程高度');
  assert.ok(monitoring.console.left >= monitoring.inspector.left, '运行结果应留在右栏');
  assert.ok(monitoring.console.height >= 400, '右栏日志应有完整的阅读高度');
  const monitor = page.getByRole('region', { name: '运行监控', exact: true });
  for (const name of ['运行日志', '变量', '下载产物', '全部运行']) {
    await monitor.getByRole('tab', { name, exact: true }).click();
    await monitor.getByRole('tabpanel', { name, exact: true }).waitFor();
    assert.equal(await monitor.getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true');
  }
  await monitor.getByRole('tab', { name: '运行日志', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await monitor.getByRole('tab', { name: '变量', exact: true }).getAttribute('aria-selected'), 'true');
  await monitor.getByRole('tab', { name: '运行日志', exact: true }).click();
  await page.screenshot({ path: join(qa, 'three-column-results-small.png'), fullPage: true });
  for (const area of ['左侧栏', '右侧栏']) await page.getByRole('button', { name: `收起${area}`, exact: true }).click();
  const expanded = await resize(1040, 650);
  assert.ok(expanded.list.width > small.list.width + 400, '收起侧栏后流程应使用释放的宽度');
  assert.ok(Math.abs(expanded.scroll.height - small.scroll.height) <= 1, '侧栏显示与否不应改变流程高度');
  await page.getByRole('button', { name: '查看运行结果', exact: true }).click();
  await monitor.waitFor();
  await page.getByRole('button', { name: '展开左侧栏', exact: true }).click();
  await page.getByRole('button', { name: '步骤编辑', exact: true }).click();
  fits(await resize(1800, 1000));
  await page.screenshot({ path: join(qa, 'workspace-responsive-large.png'), fullPage: true });
  fits(await resize(1464, 902));
  await page.screenshot({ path: join(qa, 'three-column-editor.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', legacyDefaultsRemoved: true, responsiveWorkspace: true, panelsReclaimSpace: true, fullHeightColumns: true, resultTabsAndKeyboard: true,
    large: { width: large.list.width, height: large.scroll.height }, small: { width: small.list.width, height: small.scroll.height } }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(qa, 'workspace-responsive-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  const target = resolve(data);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-responsive-')) throw new Error('拒绝清理非验收临时目录');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
