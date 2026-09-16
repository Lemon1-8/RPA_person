import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { RunManager } from './manager.js';
import { createDemoWorkflow } from '../../../examples/demo.js';
import { startFixtureServer } from '../../../tests/fixtures/server.js';
import type { WorkflowDefinition } from '../../../packages/contracts/src/index.js';

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    headless: { type: 'boolean', default: false }, 'close-browser': { type: 'boolean' }, output: { type: 'string' }, data: { type: 'string' },
  } });
  const command = positionals[0];
  if (!['demo', 'run', 'list'].includes(command)) {
    console.log('用法：npm run rpa -- demo [--headless] [--close-browser] [--output 目录]\n      npm run rpa -- run 流程.json [--headless] [--close-browser] [--output 目录]\n      npm run rpa -- list\n可选 --data 指定运行数据目录；默认保留浏览器，--close-browser 选择结束后自动关闭。'); return;
  }
  const manager = new RunManager({ dataDir: resolve(values.data ?? process.env.RPA_DATA_DIR ?? '.rpa'), maxConcurrent: 2, autoStartSchedules: false });
  let server: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
  await manager.initialize();
  process.once('SIGINT', () => { manager.shutdown().catch(console.error); });
  manager.on('event', event => {
    if (event.type === 'step') console.log(`[${event.status}] ${event.stepId}: ${event.message}`);
    if (event.type === 'log' && event.message) console.log(event.message);
  });
  try {
    if (command === 'list') { console.log(JSON.stringify(await manager.listWorkflows(), null, 2)); return; }
    let flow: WorkflowDefinition;
    if (command === 'demo') {
      server = await startFixtureServer(); flow = createDemoWorkflow(server.url, resolve(values.output ?? join(homedir(), 'Desktop')), values.headless);
    } else {
      if (!positionals[1]) throw new Error('请提供流程 JSON 路径');
      flow = JSON.parse(await readFile(resolve(positionals[1]), 'utf8')) as WorkflowDefinition;
      if (values.headless) flow.settings.headless = true;
      if (values.output) flow.settings.downloadDir = resolve(values.output);
    }
    if (values['close-browser']) flow.settings.keepBrowserOpen = false;
    const existing = (await manager.listWorkflows()).find(w => w.workflowId === flow.workflowId);
    flow.revision = existing?.revision ?? 0;
    const saved = await manager.saveWorkflow(flow);
    const run = await manager.runWorkflow(saved);
    const result = await manager.waitForRun(run.runId);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'succeeded') process.exitCode = 1;
    if (result.browserOpen) {
      console.log('流程已结束，浏览器已保留。关闭浏览器窗口或按 Ctrl+C 退出；下次可用 --close-browser 自动关闭。');
      await manager.waitForBrowserClosed(run.runId);
    }
  } finally { await manager.shutdown(); await server?.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
