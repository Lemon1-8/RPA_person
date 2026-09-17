import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { FileStore } from '../packages/persistence/src/index.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-persistence-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

it('保存返回值与落盘及重新加载的流程完全一致，并保留有效的空值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-persistence-optional-fields-'));
  directories.push(directory);
  const store = new FileStore(directory); await store.initialize();
  const workflow: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'cleared-fields', name: '清空字段', revision: 0,
    variables: { flag: false, count: 0, text: '', empty: null, list: [false, 0, '', null] },
    elements: { target: { selector: '#target', pageRef: undefined } },
    settings: { downloadDir: directory, headless: true, profileId: undefined, pythonExecutable: undefined },
    steps: [{
      stepId: 'condition', name: '条件', actionType: 'control.if', params: { left: true, operator: 'truthy' },
      output: undefined,
      settings: { downloadDir: undefined, pythonExecutable: undefined },
      children: [{ stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'value', value: 42 }, output: undefined }],
    }],
  };
  const saved = await store.saveWorkflow(workflow);
  const disk = JSON.parse(await readFile(join(directory, 'workflows', 'cleared-fields.json'), 'utf8'));
  const reloaded = (await store.listWorkflows())[0];
  expect(saved).toStrictEqual(disk);
  expect(saved).toStrictEqual(reloaded);
  expect(saved.variables).toStrictEqual(workflow.variables);
  expect(saved.revision).toBe(1);
});

it('保存时仍拒绝不能写入流程 JSON 的变量值', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-persistence-invalid-json-'));
  directories.push(directory);
  const store = new FileStore(directory); await store.initialize();
  const workflow = {
    schemaVersion: 1, workflowId: 'invalid-json', name: '无效变量', revision: 0, variables: { invalid: undefined }, elements: {},
    settings: { downloadDir: directory, headless: true }, steps: [],
  } as unknown as WorkflowDefinition;
  expect(() => store.saveWorkflow(workflow)).toThrow();
  expect(await store.listWorkflows()).toHaveLength(0);
});

it('保存和重新加载保留各层指令的注释状态及参数，旧步骤不添加注释标记', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-persistence-disabled-'));
  directories.push(directory);
  const store = new FileStore(directory); await store.initialize();
  const workflow: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'disabled-steps', name: '已注释指令', revision: 0, variables: {}, elements: {},
    settings: { downloadDir: directory, headless: true },
    steps: [{
      stepId: 'container', name: '注释容器', actionType: 'control.if', disabled: true,
      params: { left: '{{missing}}', operator: 'truthy' },
      children: [{ stepId: 'child', name: '子步骤', actionType: 'core.wait', disabled: false, params: { durationSeconds: 3 } }],
      elseSteps: [{ stepId: 'otherwise', name: '旧步骤', actionType: 'core.wait', params: { durationSeconds: 1 } }],
    }],
  };
  const saved = await store.saveWorkflow(workflow);
  expect(saved.steps).toEqual(workflow.steps);
  expect(saved).toStrictEqual(JSON.parse(await readFile(join(directory, 'workflows', 'disabled-steps.json'), 'utf8')));
  expect(saved).toStrictEqual((await store.listWorkflows())[0]);
  expect(saved.steps[0].elseSteps?.[0]).not.toHaveProperty('disabled');
});

it('加载和保存旧流程时递归清除点击新网页选项，保留目标网页和其他动作参数', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-persistence-retired-click-'));
  directories.push(directory);
  const store = new FileStore(directory); await store.initialize();
  const workflow: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'retired-click', name: '旧点击选项', revision: 3, variables: {}, elements: {},
    settings: { downloadDir: directory, headless: true },
    steps: [{
      stepId: 'condition', name: '条件', actionType: 'control.if', params: { left: true, operator: 'truthy', newPageId: 'keep' },
      children: [{ stepId: 'click', name: '点击', actionType: 'browser.click', params: { selector: '#target', pageId: 'main', waitForNewPage: true, newPageId: '{{missing.pageId}}' } }],
      elseSteps: [{ stepId: 'other', name: '另一个点击', actionType: 'browser.click', params: { selector: '#other', waitForNewPage: true, newPageId: { pageId: 'main' } } }],
    }],
  };
  const path = join(directory, 'workflows', 'retired-click.json');
  await writeFile(path, JSON.stringify(workflow));
  const [loaded] = await store.listWorkflows();
  expect(loaded.steps[0].children?.[0].params).toEqual({ selector: '#target', pageId: 'main' });
  expect(loaded.steps[0].elseSteps?.[0].params).toEqual({ selector: '#other' });
  expect(loaded.steps[0].params.newPageId).toBe('keep');
  const saved = await store.saveWorkflow(workflow);
  expect(saved).toStrictEqual(JSON.parse(await readFile(path, 'utf8')));
  expect(saved).toStrictEqual((await store.listWorkflows())[0]);
  expect(saved.steps).toStrictEqual(loaded.steps);
  expect(saved.revision).toBe(4);
  expect(workflow.steps[0].children?.[0].params).toHaveProperty('waitForNewPage', true);
});
