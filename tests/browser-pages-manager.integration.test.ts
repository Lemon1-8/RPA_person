import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
import { startPagesServer } from './fixtures/pages-server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('真实任务进程点击打开弹页后可显式切换点击、切回和关闭，并实时返回标题与网址', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-pages-manager-real-'));
  cleanup.push(async () => {
    const target = resolve(dataDir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-pages-manager-real-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  });
  const site = await startPagesServer(); cleanup.push(() => site.close());
  const manager = new RunManager({ dataDir, autoStartSchedules: false });
  await manager.initialize(); cleanup.push(() => manager.shutdown());
  const workflow: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'real-pages', name: '真实多网页流程', revision: 0,
    variables: {}, elements: {}, settings: { downloadDir: dataDir, headless: true, popupPolicy: 'smart' },
    steps: [
      { stepId: 'open', name: '打开订单列表', actionType: 'browser.open', params: { url: site.url, pageId: 'main', browserChannel: 'chromium' } },
      { stepId: 'detail', name: '点击打开详情', actionType: 'browser.click', params: { pageId: 'main', selector: '#detail', waitForNewPage: true, newPageId: '{{missing.pageId}}' } },
      { stepId: 'switchDetail', name: '切换到详情', actionType: 'browser.switchPage', params: { pageId: 'page-2' } },
      { stepId: 'report', name: '详情页跳转报表', actionType: 'browser.click', params: { selector: '#report' } },
      { stepId: 'switch', name: '回到列表', actionType: 'browser.switchPage', params: { pageId: 'main' } },
      { stepId: 'read', name: '读取当前网页', actionType: 'browser.text', params: { selector: '#title' }, output: 'currentTitle' },
      { stepId: 'clickMain', name: '点击列表按钮', actionType: 'browser.click', params: { selector: '#nothing' } },
      { stepId: 'close', name: '关闭详情标签页', actionType: 'browser.closePage', params: { pageId: 'page-2' } },
      { stepId: 'missing', name: '拒绝已关闭网页', actionType: 'browser.switchPage', params: { pageId: 'page-2' } },
    ],
  };
  const first = await manager.waitForRun((await manager.runStep(workflow, 'open')).runId);
  expect(first.status, first.error).toBe('succeeded'); expect(first.browserOpen).toBe(true);
  expect(await manager.listBrowserPages(first.runId)).toEqual([
    { pageId: 'main', title: '订单列表', url: `${site.url}/`, current: true },
  ]);
  async function step(stepId: string) {
    const queued = await manager.runStep(workflow, stepId, first.runId);
    expect(queued.runId).toBe(first.runId);
    const result = await manager.waitForRun(first.runId);
    expect(result.status, result.error).toBe('succeeded');
    return result;
  }
  await step('detail');
  await expect.poll(() => manager.listBrowserPages(first.runId)).toEqual([
    { pageId: 'main', title: '订单列表', url: `${site.url}/`, current: true },
    { pageId: 'page-2', title: '订单详情', url: `${site.url}/detail`, current: false, openerPageId: 'main' },
  ]);
  await step('switchDetail');
  await step('report');
  expect((await manager.listBrowserPages(first.runId)).find(page => page.pageId === 'page-2')).toEqual({
    pageId: 'page-2', title: '报表', url: `${site.url}/report`, current: true, openerPageId: 'main',
  });
  await step('switch');
  expect((await manager.listBrowserPages(first.runId)).find(page => page.current)?.pageId).toBe('main');
  expect((await step('read')).variables.currentTitle).toBe('订单列表');
  await step('clickMain');
  await step('close');
  expect((await manager.listBrowserPages(first.runId)).map(page => page.pageId)).toEqual(['main']);

  const beforeMissingQuery = manager.listRuns();
  expect(await manager.listBrowserPages('missing-run')).toEqual([]);
  expect(manager.listRuns()).toEqual(beforeMissingQuery);
  await manager.runStep(workflow, 'missing', first.runId);
  const failedSwitch = await manager.waitForRun(first.runId);
  expect(failedSwitch.status).toBe('failed'); expect(failedSwitch.error).toContain('不存在或已关闭：page-2');
  expect(failedSwitch.variables.currentTitle).toBe('订单列表');
  expect((await manager.listBrowserPages(first.runId)).find(page => page.current)?.pageId).toBe('main');
  expect(manager.listRuns()).toHaveLength(1);
  await manager.controlRun(first.runId, 'closeBrowser');
  expect(await manager.listBrowserPages(first.runId)).toEqual([]);
});
