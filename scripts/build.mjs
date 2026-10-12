import { build as bundle } from 'esbuild';
import { build as buildVite } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cp } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entries = {
  'desktop/main': 'apps/desktop/src/main.ts',
  'desktop/preload': 'apps/desktop/src/preload.ts',
  'runner/worker': 'apps/runner/src/worker.ts',
  'runner/cli': 'apps/runner/src/cli.ts',
  'scripts/child': 'packages/scripts/src/child.ts',
};
export async function buildBackend() {
  await bundle({ absWorkingDir: root, entryPoints: entries, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist', outExtension: { '.js': '.cjs' }, packages: 'external', sourcemap: true });
  await cp(resolve(root, 'apps/desktop/assets'), resolve(root, 'dist/desktop/assets'), { recursive: true });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildBackend();
  await buildVite({ root: resolve(root, 'apps/desktop'), base: './', build: { outDir: resolve(root, 'dist/renderer'), emptyOutDir: true } });
}
