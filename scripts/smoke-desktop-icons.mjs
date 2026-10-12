import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'rpa-desktop-icons-'));
const qa = resolve('.rpa/qa');
await mkdir(qa, { recursive: true });
const require = createRequire(import.meta.url);
let app;
try {
  const module = join(temporary, 'icons.cjs');
  await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/icons.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: module, external: ['electron'] });
  await cp(join(root, 'apps/desktop/assets'), join(temporary, 'assets'), { recursive: true });
  const fixture = join(temporary, 'main.cjs');
  await writeFile(fixture, `const { app, BrowserWindow, Tray } = require('electron');
const { createApplicationIcon } = require('./icons.cjs');
app.whenReady().then(() => {
  const icon = createApplicationIcon();
  const windowIcon = createApplicationIcon('window');
  globalThis.iconFixture = { icon, windowIcon, tray: new Tray(icon), window: new BrowserWindow({ show: false, icon: windowIcon }), createApplicationIcon, assets: require('node:path').join(__dirname, 'assets'), fs: require('node:fs'), path: require('node:path') };
  globalThis.iconFixture.window.loadURL('about:blank');
});
app.on('before-quit', () => globalThis.iconFixture?.tray.destroy());
`, 'utf8');
  const env = { ...process.env, RPA_ROOT: root, RPA_DATA_DIR: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require('electron'), args: [fixture], cwd: root, env, timeout: 15000 });
  await app.firstWindow({ timeout: 10000 });
  const result = await app.evaluate(({ app }, qa) => {
    const { icon, windowIcon, fs, path } = globalThis.iconFixture;
    const images = [...icon.getScaleFactors().map(scaleFactor => ({ image: icon, scaleFactor })), { image: windowIcon, scaleFactor: 1 }];
    return {
      empty: icon.isEmpty(),
      sourceSize: icon.getSize(),
      scaleFactors: icon.getScaleFactors(),
      windowIcon: { empty: windowIcon.isEmpty(), size: windowIcon.getSize() },
      samples: images.map(({ image, scaleFactor }) => {
        const size = Math.round(image.getSize(scaleFactor).width * scaleFactor);
        const bitmap = image.toBitmap({ scaleFactor });
        let opaque = 0; let colored = 0; let light = 0;
        for (let index = 0; index < bitmap.length; index += 4) {
          const channels = [bitmap[index], bitmap[index + 1], bitmap[index + 2]];
          if (bitmap[index + 3] >= 200) {
            opaque++;
            if (Math.max(...channels) - Math.min(...channels) >= 45 && Math.min(...channels) <= 180) colored++;
            // 小尺寸白色描边有抗锯齿，按与青绿色底色的亮度差判断可见标记。
            if (Math.min(...channels) >= 180) light++;
          }
        }
        fs.writeFileSync(path.join(qa, `app-icon-${size}.png`), image.toPNG({ scaleFactor }));
        return { size, bytes: bitmap.length, opaque, colored, light };
      }),
      ready: app.isReady(),
    };
  }, qa);
  assert.equal(result.empty, false, '托盘图标解码为空，Windows 托盘显示空白');
  assert.deepEqual(result.scaleFactors, [1, 1.25, 1.5, 2, 3, 4], '托盘图标必须包含 Windows 不同缩放对应的图片');
  assert.deepEqual(result.windowIcon, { empty: false, size: { width: 256, height: 256 } }, '窗口和任务栏必须使用有效的高清图标');
  for (const sample of result.samples) {
    assert.equal(sample.bytes, sample.size * sample.size * 4, `${sample.size}px 图标没有有效位图`);
    assert.ok(sample.opaque >= sample.size ** 2 * 0.5, `${sample.size}px 图标有效像素过少`);
    assert.ok(sample.colored >= sample.size ** 2 * 0.3, `${sample.size}px 图标在浅色托盘上不可辨识`);
    assert.ok(sample.light >= sample.size ** 2 * 0.05, `${sample.size}px 图标缺少可辨识的标记：${JSON.stringify(sample)}`);
  }
  const failurePaths = await app.evaluate(() => {
    const { assets, createApplicationIcon, fs, path } = globalThis.iconFixture;
    const target = path.join(assets, 'icon-20.png');
    const original = fs.readFileSync(target);
    const messages = {};
    try {
      fs.writeFileSync(target, original.subarray(0, 24));
      try { createApplicationIcon(); } catch (error) { messages.corrupt = error.message; }
      fs.unlinkSync(target);
      try { createApplicationIcon(); } catch (error) { messages.missing = error.message; }
    } finally { fs.writeFileSync(target, original); }
    return messages;
  });
  assert.match(failurePaths.corrupt ?? '', /应用图标无效.*icon-20\.png/, '损坏图片必须阻止创建空白托盘图标');
  assert.match(failurePaths.missing ?? '', /ENOENT.*icon-20\.png/, '缺失资源必须报告错误');
  console.log(JSON.stringify({ status: 'passed', ...result, corruptResourceRejected: true, missingResourceRejected: true }, null, 2));
} finally {
  await app?.close();
  const target = resolve(temporary);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-desktop-icons-')) throw new Error('拒绝清理测试目录之外的路径');
  await rm(target, { recursive: true, force: true });
}
