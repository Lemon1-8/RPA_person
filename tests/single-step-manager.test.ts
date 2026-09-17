import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import type { RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
import { startFixtureServer } from './fixtures/server.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function manager() {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-single-manager-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const runner = new RunManager({ dataDir, autoStartSchedules: false });
  await runner.initialize(); cleanup.push(() => runner.shutdown());
  return { runner, dataDir };
}
function flow(directory: string, steps: WorkflowDefinition['steps']): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'single-manager', name: '未保存单步', revision: 0, variables: {}, elements: {}, settings: { downloadDir: directory, headless: true, keepBrowserOpen: false }, steps };
}

it('未保存的当前指令可以独立运行，不执行相邻指令，也不改变保存版本', async () => {
  const { runner, dataDir } = await manager();
  const workflow = flow(dataDir, [
    { stepId: 'before', name: '前置', actionType: 'variables.set', params: { name: 'unexpected', value: true } },
    { stepId: 'selected', name: '选中', actionType: 'variables.set', params: { name: 'result', value: 42 } },
    { stepId: 'after', name: '后置', actionType: 'core.assert', params: { actual: true, expected: false } },
  ]);
  const saved = await runner.saveWorkflow(workflow);
  saved.steps[1].params.value = 99;
  const queued = await runner.runStep(saved, 'selected');
  expect(queued.stepId).toBe('selected');
  const result = await runner.waitForRun(queued.runId);
  expect(result.status).toBe('succeeded'); expect(result.variables.result).toBe(99); expect(result.variables).not.toHaveProperty('unexpected');
  expect((await runner.listWorkflows())[0].steps[1].params.value).toBe(42);
  expect(() => runner.runStep(workflow, 'missing')).toThrow('指令不存在');
  expect(() => runner.runStep(flow(dataDir, [{ stepId: 'click', name: '点击', actionType: 'browser.click', params: { selector: '#button' } }]), 'click')).toThrow('先单独运行');
});

it('单步复用同一真实浏览器、网页现场和变量，记录每次配置并拒绝无效或忙碌会话', async () => {
  const { runner, dataDir } = await manager();
  const site = await startFixtureServer(); cleanup.push(() => site.close());
  const workflow = flow(dataDir, [
    { stepId: 'open', name: '打开网页', actionType: 'browser.open', params: { url: site.url } },
    { stepId: 'fill', name: '填写客户', actionType: 'browser.fill', params: { selector: '#customer', value: 'Alice' } },
    { stepId: 'read', name: '读取现场', actionType: 'script.run', params: { language: 'javascript', code: 'await rpa.output(await rpa.call("browser.evaluate", { expression: "document.getElementById(\'customer\').value" }));' }, output: 'customer' },
    { stepId: 'copy', name: '复用结果', actionType: 'variables.set', params: { name: 'copied', value: '{{customer}}' } },
    { stepId: 'wait', name: '等待停止', actionType: 'script.run', params: { language: 'javascript', code: 'await new Promise(() => {});' } },
  ]);
  const opened = await runner.waitForRun((await runner.runStep(workflow, 'open')).runId);
  expect(opened.status).toBe('succeeded'); expect(opened.browserOpen).toBe(true);
  const filled = await runner.runStep(workflow, 'fill', opened.runId);
  expect(filled.runId).toBe(opened.runId);
  expect((await runner.waitForRun(opened.runId)).status).toBe('succeeded');
  await runner.runStep(workflow, 'read', opened.runId);
  const read = await runner.waitForRun(opened.runId);
  expect(read.status, read.error).toBe('succeeded'); expect(read.variables.customer).toBe('Alice');
  workflow.revision = 7; workflow.name = '修改中的配置'; workflow.settings.popupPolicy = 'off';
  await runner.runStep(workflow, 'copy', opened.runId);
  const copied = await runner.waitForRun(opened.runId);
  expect(copied.variables.copied).toBe('Alice'); expect(copied.revision).toBe(7);
  expect(runner.listRuns()).toHaveLength(1); expect(await runner.listWorkflows()).toHaveLength(0);
  const events = (await readFile(join(dataDir, 'runs', opened.runId, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as RunEvent);
  expect(events.filter(event => event.type === 'step' && event.status === 'running').map(event => event.stepId)).toEqual(['open', 'fill', 'read', 'copy']);
  const configurations = events.filter(event => event.status === 'queued').map(event => event.data as { stepId: string; workflow: WorkflowDefinition });
  expect(configurations.map(config => config.workflow.revision)).toEqual([0, 0, 0, 7]);
  await expect(runner.runStep(workflow, 'copy', 'missing')).rejects.toThrow('不存在');
  await expect(runner.runStep({ ...workflow, workflowId: 'other' }, 'copy', opened.runId)).rejects.toThrow('当前流程');
  await expect(runner.runStep({ ...workflow, settings: { ...workflow.settings, profileId: 'other-profile' } }, 'copy', opened.runId)).rejects.toThrow('配置已改变');
  await expect(runner.runStep(workflow, 'open')).rejects.toThrow('浏览器仍保留');
  const persist = runner.store.createRun.bind(runner.store);
  let releasePersistence!: () => void;
  let enteredPersistence!: () => void;
  const holdPersistence = new Promise<void>(resolve => { releasePersistence = resolve; });
  const persistenceStarted = new Promise<void>(resolve => { enteredPersistence = resolve; });
  vi.spyOn(runner.store, 'createRun').mockImplementationOnce(async (...args) => {
    enteredPersistence(); await holdPersistence; await persist(...args);
  });
  const submission = runner.runStep(workflow, 'wait', opened.runId);
  await persistenceStarted;
  const overlapping = runner.runStep(workflow, 'copy', opened.runId);
  const stopping = runner.controlRun(opened.runId, 'stop');
  releasePersistence();
  const pending = await submission;
  expect(['queued', 'running']).toContain(pending.status);
  await expect(overlapping).rejects.toThrow('正在执行');
  await stopping;
  const stopped = await runner.waitForRun(opened.runId);
  expect(stopped.status).toBe('stopped'); expect(stopped.browserOpen).toBe(false);
  await expect(runner.runStep(workflow, 'copy', opened.runId)).rejects.toThrow('已关闭');
});
