import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'apps/desktop/assets');
const svg = await readFile(join(assets, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 20, 24, 32, 48, 64, 256]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await writeFile(join(assets, `icon-${size}.png`), await page.screenshot({ omitBackground: true }));
  }
} finally { await browser.close(); }
