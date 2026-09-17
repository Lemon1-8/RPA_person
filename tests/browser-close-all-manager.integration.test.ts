import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
import { startPagesServer } from './fixtures/pages-server.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('多个真实自动化任务并存时，关闭全部只影响选中任务的浏览器', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-close-all-manager-'));
  cleanups.push(async () => {
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-close-all-manager-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  });
  const site = await startPagesServer(); cleanups.push(() => site.close());
  const manager = new RunManager({ dataDir, autoStartSchedules: false });
  await manager.initialize(); cleanups.push(() => manager.shutdown());
  const workflow = (workflowId: string): WorkflowDefinition => ({
    schemaVersion: 1, workflowId, name: workflowId, revision: 0, variables: {}, elements: {},
    settings: { downloadDir: dataDir, headless: true },
    steps: [
      { stepId: 'open', name: '打开列表', actionType: 'browser.open', params: { url: site.url, browserChannel: 'chromium' } },
      { stepId: 'extra', name: '打开第二个网页', actionType: 'browser.open', params: { url: `${site.url}/detail`, openMode: 'new', pageId: 'detail' } },
      { stepId: 'close-all', name: '关闭所有网页', actionType: 'browser.closePage', params: { closeMode: 'all' }, output: 'closed' },
      { stepId: 'click', name: '继续点击', actionType: 'browser.click', params: { selector: '#nothing', pageId: 'main' } },
      { stepId: 'read', name: '读取点击结果', actionType: 'script.run', params: { language: 'javascript', code: 'await rpa.output(await rpa.call("browser.evaluate", { pageId: "main", expression: "document.body.dataset.clicked" }));' }, output: 'clicked' },
    ],
  });
  const first = workflow('automation-a');
  const second = workflow('automation-b');
  async function runStep(flow: WorkflowDefinition, stepId: string, runId?: string) {
    const queued = await manager.runStep(flow, stepId, runId);
    const result = await manager.waitForRun(queued.runId);
    expect(result.status, result.error).toBe('succeeded');
    return result;
  }
  const a = await runStep(first, 'open');
  await runStep(first, 'extra', a.runId);
  const b = await runStep(second, 'open');
  await runStep(second, 'extra', b.runId);
  const otherPages = await manager.listBrowserPages(b.runId);
  expect(otherPages).toHaveLength(2);
  await expect(manager.runStep(first, 'close-all', b.runId)).rejects.toThrow('只能复用当前流程的浏览器');
  const closed = await runStep(first, 'close-all', a.runId);
  expect(closed.runId).toBe(a.runId);
  expect(closed.browserOpen).toBe(false);
  expect(closed.variables.closed).toEqual({ ok: true, closedPageIds: ['main', 'detail'] });
  expect(await manager.listBrowserPages(a.runId)).toEqual([]);
  expect(await manager.listBrowserPages(b.runId)).toEqual(otherPages);
  expect(manager.listRuns().find(run => run.runId === b.runId)?.browserOpen).toBe(true);
  await runStep(second, 'click', b.runId);
  expect((await runStep(second, 'read', b.runId)).variables.clicked).toBe('true');

  // With no bound session, closing is a no-op even while another task owns a browser.
  const empty = await runStep(workflow('automation-empty'), 'close-all');
  expect(empty.browserOpen).toBe(false);
  expect(empty.variables.closed).toEqual({ ok: true, closedPageIds: [] });
  expect(await manager.listBrowserPages(b.runId)).toEqual(otherPages);
  await manager.controlRun(b.runId, 'closeBrowser');
});
