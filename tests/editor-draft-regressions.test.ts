import { afterEach, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WorkbenchStore } from '../packages/persistence/src/workbench.js';
import { actionDefinitions } from '../packages/actions/src/index.js';
import { preflight } from '../packages/actions/src/preflight.js';
import type { DesktopApi, WorkflowDefinition, WorkflowDraft } from '../packages/contracts/src/index.js';

let bundle: string, css: string;
let browser: Browser | undefined, server: Server | undefined, directory: string | undefined;
beforeAll(async () => {
  const result = await build({ stdin: { contents: 'import { createRoot } from "react-dom/client"; import { App } from "./apps/desktop/src/renderer/App.tsx"; createRoot(document.getElementById("root")).render(<App/>);', loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles[0].text;
  css = await readFile(join(process.cwd(), 'apps/desktop/src/renderer/styles.css'), 'utf8');
});
afterEach(async () => {
  await browser?.close(); browser = undefined;
  if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  if (directory) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-editor-regression-')) throw new Error('拒绝清理非测试目录');
    await rm(target, { recursive: true, force: true }); directory = undefined;
  }
});
async function setup(damagedDraft = false) {
  directory = await mkdtemp(join(tmpdir(), 'rpa-editor-regression-'));
  const store = new WorkbenchStore(directory); await store.initialize();
  let workflow = await store.saveWorkflow({ schemaVersion: 1, workflowId: 'editor', name: '编辑回归', revision: 0, variables: {}, elements: {}, settings: { downloadDir: directory, headless: true }, steps: [
    { stepId: 'first', name: '设置一', actionType: 'variables.set', params: { name: 'one', value: {} } },
    { stepId: 'second', name: '设置二', actionType: 'variables.set', params: { name: 'two', value: {} } },
  ] });
  if (damagedDraft) await writeFile(join(directory, 'drafts', 'editor.json'), '{"broken":');
  server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); }
    else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  await page.exposeFunction('auditInvoke', async (method: string, args: unknown[]) => {
    if (method === 'bootstrap') return { workflows: [workflow], actions: actionDefinitions, runs: [], schedules: [], demoUrl: '', dataDir: directory, defaultDownloadDir: directory };
    if (method === 'saveWorkflow') { workflow = await store.saveWorkflow(args[0] as WorkflowDefinition); return workflow; }
    if (method === 'restoreRevision') { workflow = await store.restoreRevision(String(args[0]), Number(args[1]), Number(args[2])); return workflow; }
    if (method === 'preflight') return preflight(args[0] as WorkflowDefinition);
    if (method === 'saveDraft') return store.saveDraft(args[0] as WorkflowDraft);
    if (method === 'discardDraft') return store.discardDraft(String(args[0]));
    if (method === 'listDrafts') return store.listDrafts();
    if (method === 'listRevisions') return store.listRevisions(String(args[0]));
    if (method === 'getRevision') return store.getRevision(String(args[0]), Number(args[1]));
    if (method === 'getStorageIssues' || method === 'listSchedules') return [];
    throw new Error(`未预期的编辑器调用：${method}`);
  });
  await page.addInitScript(() => {
    const scope = window as unknown as { rpa: DesktopApi; auditInvoke(method: string, args: unknown[]): Promise<unknown> };
    scope.rpa = new Proxy({} as DesktopApi, { get: (_target, key) => String(key).startsWith('on') ? () => () => {} : (...args: unknown[]) => scope.auditInvoke(String(key), args) });
  });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少测试端口');
  await page.goto(`http://127.0.0.1:${address.port}`); await page.getByLabel('当前流程', { exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：设置一', exact: true }).click();
  return { page, store };
}

it('启动后的自动草稿清理保留无法读取的旧文件', async () => {
  const { page, store } = await setup(true);
  await page.waitForTimeout(1300);
  expect(await readFile(join(store.directory, 'drafts', 'editor.json'), 'utf8')).toBe('{"broken":');
  expect(store.issues().some(issue => issue.id === 'draft-read:editor.json')).toBe(true);
});

it('跨步骤保留未完成 JSON，阻止保存、快捷键保存及调试，修正后可保存', async () => {
  const { page, store } = await setup(); const field = page.getByRole('textbox', { name: '变量值（JSON）', exact: true });
  await field.fill('{"unfinished":');
  await expect.poll(async () => Object.values((await store.listDrafts())[0]?.fieldTexts ?? {}), { timeout: 10000 }).toContain('{"unfinished":');
  await page.getByRole('button', { name: '步骤 2：设置二', exact: true }).click();
  expect(await page.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true);
  await page.keyboard.press('Control+s'); expect((await store.listWorkflows())[0].revision).toBe(1);
  await page.locator('.debug-tools summary').click();
  expect(await page.getByRole('button', { name: '按断点调试', exact: true }).isDisabled()).toBe(true);
  await page.getByRole('button', { name: '步骤 1：设置一', exact: true }).click(); expect(await field.inputValue()).toBe('{"unfinished":');
  await field.fill('{"fixed":true}'); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.toast').filter({ hasText: '流程已保存' }).waitFor();
  expect((await store.listWorkflows())[0].steps[0].params.value).toEqual({ fixed: true }); expect(await store.listDrafts()).toEqual([]);
});

it('撤销回保存内容后清除旧草稿，重做仍能保存草稿，重启不恢复已撤销编辑', async () => {
  const { page, store } = await setup(); const name = page.getByLabel('步骤名称', { exact: true });
  await name.fill('已撤销的编辑'); await expect.poll(async () => (await store.listDrafts())[0]?.workflow.steps[0].name, { timeout: 10000 }).toBe('已撤销的编辑');
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); expect(await name.inputValue()).toBe('设置一');
  await expect.poll(() => store.listDrafts(), { timeout: 10000 }).toEqual([]);
  await page.getByRole('button', { name: '重做编辑', exact: true }).click();
  await expect.poll(async () => (await store.listDrafts())[0]?.workflow.steps[0].name, { timeout: 10000 }).toBe('已撤销的编辑');
  await page.getByRole('button', { name: '撤销编辑', exact: true }).click(); await expect.poll(() => store.listDrafts(), { timeout: 10000 }).toEqual([]);
  await page.reload(); await page.getByLabel('当前流程', { exact: true }).waitFor();
  expect(await page.getByRole('button', { name: '恢复草稿', exact: true }).count()).toBe(0);
});

it('恢复旧修订时保留原未保存编辑，重启后的待恢复草稿不被自动清理', async () => {
  const { page, store } = await setup();
  await page.evaluate(async () => {
    const api = (window as unknown as { rpa: DesktopApi }).rpa; const state = await api.bootstrap();
    await api.saveWorkflow({ ...state.workflows[0], name: '新版' });
  });
  await page.reload(); await page.getByLabel('当前流程', { exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：设置一', exact: true }).click(); await page.getByLabel('步骤名称', { exact: true }).fill('要保留的编辑');
  await page.getByRole('button', { name: '运行设置', exact: true }).click();
  await page.getByText('版本历史 · 当前 v2', { exact: true }).click(); await page.getByLabel('查看流程修订').selectOption('1');
  await page.getByRole('button', { name: '恢复为新修订（当前未保存编辑由草稿保留）', exact: true }).click();
  await page.locator('.toast').filter({ hasText: '已恢复为 v3' }).waitFor(); await page.waitForTimeout(1300);
  expect((await store.listDrafts())[0]?.workflow.steps[0].name).toBe('要保留的编辑');
  await page.reload(); await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor(); await page.waitForTimeout(1300);
  expect((await store.listDrafts())[0]?.workflow.steps[0].name).toBe('要保留的编辑');
});
