import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

// Controlled IPC peer exercises reply matching, disconnect and missing replies
// without depending on Chromium timing or manipulating manager internals.
const workerSource = `
let run;
let mode;
function publish() {
  process.send({ type: 'event', event: { type: 'run', runId: run.runId, at: new Date().toISOString(), status: run.status, run } });
}
process.on('message', message => {
  if (message.type === 'start') {
    mode = message.workflow.variables.mode;
    run = {
      runId: message.options.runId, workflowId: message.workflow.workflowId,
      workflowName: message.workflow.name, revision: message.workflow.revision,
      status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      variables: message.workflow.variables, artifacts: [], browserOpen: true,
    };
    publish();
  }
  if (message.type === 'list-browser-pages') {
    if (mode === 'exit') return process.exit(3);
    if (mode === 'hang') return;
    if (mode === 'error') return process.send({ type: 'pages-result', requestId: message.requestId, error: '网页列表查询失败' });
    if (mode === 'invalid') return process.send({ type: 'pages-result', requestId: message.requestId });
    setTimeout(() => process.send({ type: 'pages-result', requestId: message.requestId, pages: [
      { pageId: run.workflowId, title: run.workflowName, url: 'https://example.com/' + run.workflowId, current: true },
    ] }), 30);
  }
  if (message.type === 'control') {
    run.browserOpen = false; publish();
    process.send({ type: 'control-result', requestId: message.requestId }, () => process.disconnect());
  }
});
`;

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-pages-manager-'));
  cleanup.push(async () => {
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-pages-manager-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  });
  const workerPath = join(dataDir, 'worker.cjs'); await writeFile(workerPath, workerSource);
  const manager = new RunManager({ dataDir, workerPath, maxConcurrent: 2, autoStartSchedules: false });
  await manager.initialize(); cleanup.push(() => manager.shutdown());
  async function start(workflowId: string, mode = 'pages') {
    const flow: WorkflowDefinition = {
      schemaVersion: 1, workflowId, name: workflowId, revision: 0,
      variables: { mode }, elements: {}, settings: { downloadDir: dataDir, headless: true }, steps: [],
    };
    const queued = await manager.runWorkflow(await manager.saveWorkflow(flow));
    return manager.waitForRun(queued.runId);
  }
  return { manager, start };
}

it('网页查询按运行和请求隔离，重复查询不创建运行、不改变变量或运行状态', async () => {
  const { manager, start } = await harness();
  expect(await manager.listBrowserPages('missing')).toEqual([]);
  await expect(manager.listBrowserPages('')).rejects.toThrow('标识无效');
  const [first, second] = await Promise.all([start('first'), start('second')]);
  const before = manager.listRuns();
  const pages = await Promise.all([
    manager.listBrowserPages(first.runId), manager.listBrowserPages(second.runId), manager.listBrowserPages(first.runId),
  ]);
  expect(pages.map(items => items.map(page => page.pageId))).toEqual([['first'], ['second'], ['first']]);
  expect(manager.listRuns()).toEqual(before);
  await manager.controlRun(first.runId, 'closeBrowser');
  expect(await manager.listBrowserPages(first.runId)).toEqual([]);
  expect((await manager.listBrowserPages(second.runId))[0].pageId).toBe('second');
});

it.each(['error', 'invalid'])('网页查询的 %s 响应明确失败且不改变成功运行结果', async mode => {
  const { manager, start } = await harness();
  const run = await start('failed-query', mode);
  const before = manager.listRuns();
  await expect(manager.listBrowserPages(run.runId)).rejects.toThrow(mode === 'error' ? '网页列表查询失败' : '无效结果');
  expect(manager.listRuns()).toEqual(before);
  await manager.controlRun(run.runId, 'closeBrowser');
});

it('网页查询等待期间任务进程退出会结束请求并清理会话', async () => {
  const { manager, start } = await harness();
  const run = await start('exit-query', 'exit');
  await expect(manager.listBrowserPages(run.runId)).rejects.toThrow(/断开连接|已退出/);
  await manager.waitForBrowserClosed(run.runId);
  expect(await manager.listBrowserPages(run.runId)).toEqual([]);
  expect(manager.listRuns()[0].status).toBe('succeeded');
});

it('没有回复的网页查询有明确超时，且不阻止之后关闭浏览器', async () => {
  const { manager, start } = await harness();
  const run = await start('timeout-query', 'hang');
  await expect(manager.listBrowserPages(run.runId)).rejects.toThrow('查询浏览器网页超时');
  expect(manager.listRuns()[0]).toEqual(run);
  await manager.controlRun(run.runId, 'closeBrowser');
});

it('退出运行器会立即结束未完成的网页查询并拒绝新查询', async () => {
  const { manager, start } = await harness();
  const run = await start('shutdown-query', 'hang');
  const rejection = expect(manager.listBrowserPages(run.runId)).rejects.toThrow('运行器正在退出');
  await manager.shutdown(); await rejection;
  await expect(manager.listBrowserPages(run.runId)).rejects.toThrow('运行器正在退出');
});
