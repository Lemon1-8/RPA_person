import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-keypress-record-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const workflow = { ...initial.workflows[0], name: '按键录制验收', variables: { shortcut: 'Control+A' }, steps: [
    { stepId: 'desktop-key', name: '桌面按键', actionType: 'desktop.keyPress', params: { key: 'Enter' } },
    { stepId: 'browser-key', name: '网页按键', actionType: 'browser.keyPress', params: { pageId: '$current', key: 'Enter' } },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), workflow);
  await page.reload();
  await page.getByRole('heading', { name: '按键录制验收', exact: true }).waitFor();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  const shortcutInput = inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}');

  await page.getByRole('button', { name: '步骤 1：桌面按键', exact: true }).click();
  await inspector.getByLabel(/^按键或快捷键/).selectOption('custom');
  await inspector.getByText('请按下要录制的按键或组合键').waitFor();
  assert.equal(await shortcutInput.evaluate(input => document.activeElement === input), true);
  await page.keyboard.press('Control+Alt+K');
  assert.equal(await shortcutInput.inputValue(), 'Control+Alt+K');
  await inspector.getByRole('button', { name: '重新录制' }).click();
  await inspector.getByText('请按下要录制的按键或组合键').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '自定义按键或变量');
  await page.keyboard.press('Shift+F8');
  assert.equal(await shortcutInput.inputValue(), 'Shift+F8');
  await shortcutInput.fill('Control+S');
  assert.equal(await shortcutInput.inputValue(), 'Control+S');
  await inspector.getByRole('button', { name: '为按键插入变量', exact: true }).click();
  await inspector.getByRole('group', { name: '为按键插入变量列表', exact: true })
    .getByRole('button', { name: '插入 {{shortcut}}', exact: true }).click();
  assert.equal(await shortcutInput.inputValue(), '{{shortcut}}');

  await page.getByRole('button', { name: '步骤 2：网页按键', exact: true }).click();
  await inspector.getByLabel(/^按键或快捷键/).selectOption('custom');
  await inspector.getByText('请按下要录制的按键或组合键').waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '自定义按键或变量');
  await page.keyboard.press('Control+Enter');
  assert.equal(await shortcutInput.inputValue(), 'Control+Enter');
  await page.screenshot({ path: join(qa, 'keypress-record-success.png'), fullPage: true });
  console.log('键盘快捷键录制冒烟测试通过');
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-keypress-record-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
