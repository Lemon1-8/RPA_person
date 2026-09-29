import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { runDesktopInput } from '../packages/engine/src/desktop-input.js';

if (process.platform !== 'win32') throw new Error('此冒烟测试需要 Windows 桌面会话');
const root = process.cwd();
const data = await mkdtemp(join(tmpdir(), 'rpa-native-input-'));
const require = createRequire(import.meta.url);
const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  await page.getByRole('heading', { name: '订单采集与导出', exact: true }).waitFor();
  const bounds = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setAlwaysOnTop(true, 'screen-saver');
    window.show(); window.focus();
    return window.getContentBounds();
  });
  const search = page.getByPlaceholder('搜索指令');
  const box = await search.boundingBox();
  assert.ok(box);
  const x = Math.round(bounds.x + box.x + box.width / 2);
  const y = Math.round(bounds.y + box.y + box.height / 2);
  await runDesktopInput('desktop.mouseClick', { x, y, button: 'left', clickCount: 1 });
  await runDesktopInput('desktop.keyboardType', { text: 'RPA', delayMs: 0 });
  assert.equal(await search.inputValue(), 'RPA');
  await runDesktopInput('desktop.keyPress', { key: 'Control+A' });
  await runDesktopInput('desktop.keyboardType', { text: '键鼠', delayMs: 0 });
  assert.equal(await search.inputValue(), '键鼠');
  await runDesktopInput('desktop.keyPress', { key: 'Control+A' });
  await runDesktopInput('desktop.keyboardType', { text: '粘贴成功', inputMode: 'paste' });
  assert.equal(await search.inputValue(), '粘贴成功');
  await runDesktopInput('desktop.keyPress', { key: 'Control+A' });
  await runDesktopInput('desktop.keyboardType', { text: '纠正', simulateTypo: true, typoText: '错', delayMs: 15 });
  assert.equal(await search.inputValue(), '纠正');
  const destination = { x: x + 420, y: y + 180 };
  const sampling = app.evaluate(({ screen }) => new Promise<Array<{ x: number; y: number }>>(resolveSamples => {
    const points: Array<{ x: number; y: number }> = [];
    const timer = setInterval(() => points.push(screen.dipToScreenPoint(screen.getCursorScreenPoint())), 8);
    setTimeout(() => { clearInterval(timer); resolveSamples(points); }, 1500);
  }));
  await runDesktopInput('desktop.mouseMove', { ...destination, humanLike: true });
  const samples = await sampling;
  const distance = Math.hypot(destination.x - x, destination.y - y);
  const maxArc = Math.max(...samples.map(point =>
    Math.abs((destination.x - x) * (point.y - y) - (destination.y - y) * (point.x - x)) / distance));
  assert.ok(maxArc >= 20, `真人轨迹应有明显弧度，实际最大偏移 ${maxArc.toFixed(1)} 像素`);
  assert.ok(new Set(samples.map(point => `${point.x},${point.y}`)).size >= 12, '移动应有连续的中间位置');
  await runDesktopInput('desktop.mouseWheel', { deltaX: 0, deltaY: -120 });
  console.log(`Windows 前台软件键鼠冒烟测试通过；轨迹最大弧线偏移 ${maxArc.toFixed(1)} 像素`);
} finally {
  await app?.close();
  if (dirname(resolve(data)) !== resolve(tmpdir()) || !basename(data).startsWith('rpa-native-input-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
