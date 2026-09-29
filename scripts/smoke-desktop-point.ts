import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { runDesktopInput } from '../packages/engine/src/desktop-input.js';

if (process.platform !== 'win32') throw new Error('此冒烟测试需要 Windows 桌面会话');
const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-desktop-point-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>> | undefined;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const initial = await page.evaluate(() => window.rpa.bootstrap());
  const workflow = { ...initial.workflows[0], name: '桌面坐标验收', variables: { shortcut: 'Control+A' }, steps: [
    { stepId: 'desktop-point', name: '桌面取点', actionType: 'desktop.mouseClick', params: { x: 0, y: 0, button: 'left', clickCount: 1, humanLike: true } },
    { stepId: 'desktop-key', name: '桌面按键', actionType: 'desktop.keyPress', params: { key: 'Enter' } },
    { stepId: 'desktop-type', name: '桌面输入', actionType: 'desktop.keyboardType', params: { text: '正确文本', inputMode: 'type', simulateTypo: false, typoText: '错' } },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), workflow);
  await page.reload();
  await page.getByRole('heading', { name: '桌面坐标验收', exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：桌面取点', exact: true }).click();
  const inspector = page.getByRole('complementary', { name: '参数与设置', exact: true });
  await inspector.getByRole('button', { name: '获取屏幕坐标', exact: true }).click();
  await inspector.getByText('将鼠标移到目标位置，按 F8 取点；30 秒后自动取消。').waitFor();
  const target = { x: 120, y: 140 };
  await runDesktopInput('desktop.mouseMove', { ...target, humanLike: false });
  await runDesktopInput('desktop.keyPress', { key: 'F8' });
  await inspector.getByText(`已填入 X: ${target.x}，Y: ${target.y}`, { exact: true }).waitFor();
  assert.equal(await inspector.getByLabel(/^横坐标 X/).inputValue(), String(target.x));
  assert.equal(await inspector.getByLabel(/^纵坐标 Y/).inputValue(), String(target.y));
  assert.equal(await page.getByText('屏幕坐标', { exact: true }).count(), 1);
  await page.screenshot({ path: join(qa, 'desktop-point-coordinate.png'), fullPage: true });
  await page.getByRole('button', { name: '步骤 2：桌面按键', exact: true }).click();
  assert.equal(await inspector.getByLabel(/^按键或快捷键/).count(), 1);
  await inspector.getByLabel(/^按键或快捷键/).selectOption('custom');
  assert.equal(await inspector.getByLabel(/^按键或快捷键/).inputValue(), 'custom');
  assert.equal(await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').count(), 1);
  assert.equal(await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').evaluate(input => document.activeElement === input), true);
  await page.keyboard.press('Control+Alt+K');
  assert.equal(await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').inputValue(), 'Control+Alt+K');
  await page.screenshot({ path: join(qa, 'key-custom-input.png'), fullPage: true });
  await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').fill('Control+S');
  assert.equal(await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').inputValue(), 'Control+S');
  await inspector.getByRole('button', { name: '为按键插入变量', exact: true }).click();
  await inspector.getByRole('group', { name: '为按键插入变量列表', exact: true })
    .getByRole('button', { name: '插入 {{shortcut}}', exact: true }).click();
  assert.equal(await inspector.getByPlaceholder('如 Control+S 或 {{shortcut}}').inputValue(), '{{shortcut}}');
  await page.getByRole('button', { name: '步骤 3：桌面输入', exact: true }).click();
  assert.equal(await inspector.getByLabel(/^输入方式/).locator('option[value=""]').count(), 0);
  await inspector.getByLabel(/^输入方式/).selectOption('paste');
  await inspector.getByLabel('先输错字并删除').check();
  assert.equal(await inspector.getByLabel(/^先输入的错字/).inputValue(), '错');
  await page.screenshot({ path: join(qa, 'desktop-point-success.png'), fullPage: true });
  console.log('桌面取点及 X/Y 展示冒烟测试通过');
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-desktop-point-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
