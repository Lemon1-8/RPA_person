import { afterEach, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import type { RunEvent, WorkflowDefinition } from '../packages/contracts/src/index.js';
const managers: RunManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.shutdown())); });

function nextEvent(manager: RunManager, predicate: (event: RunEvent) => boolean): Promise<RunEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { manager.off('event', listener); reject(new Error('等待运行事件超时')); }, 10_000);
    const listener = (event: RunEvent) => {
      if (!predicate(event)) return;
      clearTimeout(timer); manager.off('event', listener); resolve(event);
    };
    manager.on('event', listener);
  });
}

function scriptWorkflow(workflowId: string, dataDir: string, code: string): WorkflowDefinition {
  return {
    schemaVersion: 1, workflowId, name: workflowId, revision: 0, variables: {}, elements: {},
    settings: { downloadDir: dataDir, headless: true },
    steps: [{ stepId: 'script', name: '执行脚本', actionType: 'script.run', params: { language: 'javascript', code }, timeoutMs: 20_000 }],
  };
}
it('通过独立任务进程执行已保存版本，并在重启后读取运行结果', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 2 }); managers.push(manager);
  await manager.initialize();
  const definition: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'manager-demo', name: '进程测试', revision: 0, variables: {}, elements: {},
    settings: { downloadDir: dataDir, headless: true },
    steps: [{ stepId: 'set', name: '设置', actionType: 'variables.set', params: { name: 'value', value: 42 } }],
  };
  const saved = await manager.saveWorkflow(definition);
  const queued = await manager.runWorkflow(saved);
  definition.steps[0].params.value = 999;
  const result = await manager.waitForRun(queued.runId);
  expect(result.status).toBe('succeeded');
  expect(result.variables.value).toBe(42);
  expect(result.revision).toBe(1);
  await manager.shutdown();
  const reopened = new RunManager({ dataDir }); managers.push(reopened); await reopened.initialize();
  expect(reopened.listRuns()[0].status).toBe('succeeded');
});

it('任务进程启动失败时保留父运行器并完成排队任务及退出清理', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-spawn-failure-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 1, rootDir: join(dataDir, 'missing-project-root') });
  managers.push(manager);
  await manager.initialize();
  const definition: WorkflowDefinition = {
    schemaVersion: 1, workflowId: 'spawn-failure-first', name: '启动失败回归', revision: 0, variables: {}, elements: {},
    settings: { downloadDir: dataDir, headless: true },
    steps: [{ stepId: 'set', name: '不应执行', actionType: 'variables.set', params: { name: 'value', value: 42 } }],
  };
  const first = await manager.saveWorkflow(definition);
  const second = await manager.saveWorkflow({ ...definition, workflowId: 'spawn-failure-second' });
  const queued = await Promise.all([manager.runWorkflow(first), manager.runWorkflow(second)]);
  const results = await Promise.all(queued.map(run => manager.waitForRun(run.runId)));

  expect(results.map(run => run.status)).toEqual(['interrupted', 'interrupted']);
  for (const result of results) {
    expect(result.error).toMatch(/ENOENT|EPIPE/i);
    expect(result.endedAt).toBeTruthy();
    expect(result.variables).not.toHaveProperty('value');
  }
  await expect(manager.shutdown()).resolves.toBeUndefined();
  expect(manager.listRuns()).toHaveLength(2);
});

it('两个不同流程可同时运行且同流程在活动期间保持互斥', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-concurrent-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 2 }); managers.push(manager);
  await manager.initialize();
  const first = await manager.saveWorkflow(scriptWorkflow('parallel-first', dataDir, `console.log('FIRST_READY'); await new Promise(() => {});`));
  const second = await manager.saveWorkflow(scriptWorkflow('parallel-second', dataDir, `console.log('SECOND_READY'); await new Promise(() => {});`));
  const firstReady = nextEvent(manager, event => event.type === 'log' && event.message === 'FIRST_READY');
  const secondReady = nextEvent(manager, event => event.type === 'log' && event.message === 'SECOND_READY');
  const runs = await Promise.all([manager.runWorkflow(first), manager.runWorkflow(second)]);
  await Promise.all([firstReady, secondReady]);

  expect(manager.listRuns().map(run => run.status)).toEqual(['running', 'running']);
  await expect(manager.runWorkflow(first)).rejects.toThrow('同一流程');
  await Promise.all(runs.map(run => manager.controlRun(run.runId, 'stop')));
  const results = await Promise.all(runs.map(run => manager.waitForRun(run.runId)));
  expect(results.map(run => run.status)).toEqual(['stopped', 'stopped']);
});

it('排队中的流程停止后不会在名额释放时执行', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-queued-stop-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 1 }); managers.push(manager);
  await manager.initialize();
  const first = await manager.saveWorkflow(scriptWorkflow('queue-blocker', dataDir, `console.log('BLOCKER_READY'); await new Promise(() => {});`));
  const second = await manager.saveWorkflow(scriptWorkflow('queue-stopped', dataDir, `await rpa.set('executed', true);`));
  const ready = nextEvent(manager, event => event.type === 'log' && event.message === 'BLOCKER_READY');
  const blocker = await manager.runWorkflow(first); await ready;
  const queued = await manager.runWorkflow(second);
  expect(manager.listRuns().find(run => run.runId === queued.runId)?.status).toBe('queued');

  await manager.controlRun(queued.runId, 'stop');
  const stopped = await manager.waitForRun(queued.runId);
  expect(stopped.status).toBe('stopped');
  expect(stopped.variables).not.toHaveProperty('executed');
  await manager.controlRun(blocker.runId, 'stop');
  await manager.waitForRun(blocker.runId);
  expect(manager.listRuns().find(run => run.runId === queued.runId)?.status).toBe('stopped');
});

it('运行中暂停会停在步骤边界，继续后只执行剩余步骤', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-pause-resume-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 1 }); managers.push(manager);
  await manager.initialize();
  const workflow = scriptWorkflow('pause-resume', dataDir, `await rpa.set('firstCompleted', true);`);
  workflow.steps.push({ stepId: 'last', name: '剩余步骤', actionType: 'variables.set', params: { name: 'lastCompleted', value: true } });
  const saved = await manager.saveWorkflow(workflow);
  const started = nextEvent(manager, event => event.type === 'step' && event.stepId === 'script' && event.status === 'running');
  const paused = nextEvent(manager, event => event.run?.workflowId === workflow.workflowId && event.status === 'paused');
  const run = await manager.runWorkflow(saved); await started;
  await manager.controlRun(run.runId, 'pause');
  const pausedEvent = await paused;
  expect(pausedEvent.run?.variables.firstCompleted).toBe(true);
  expect(pausedEvent.run?.variables).not.toHaveProperty('lastCompleted');
  await expect(manager.runWorkflow(saved)).rejects.toThrow('同一流程');

  await manager.controlRun(run.runId, 'resume');
  const result = await manager.waitForRun(run.runId);
  expect(result.status).toBe('succeeded');
  expect(result.variables.lastCompleted).toBe(true);
});

it('脚本正在运行时停止任务会结束进程且不执行后续步骤', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-manager-running-stop-'));
  const manager = new RunManager({ dataDir, maxConcurrent: 1 }); managers.push(manager);
  await manager.initialize();
  const workflow = scriptWorkflow('running-stop', dataDir, `console.log('STOP_READY'); await new Promise(() => {});`);
  workflow.steps.push({ stepId: 'never', name: '不可执行', actionType: 'variables.set', params: { name: 'executed', value: true } });
  const saved = await manager.saveWorkflow(workflow);
  const ready = nextEvent(manager, event => event.type === 'log' && event.message === 'STOP_READY');
  const run = await manager.runWorkflow(saved); await ready;

  await manager.controlRun(run.runId, 'stop');
  const result = await manager.waitForRun(run.runId);
  expect(result.status).toBe('stopped');
  expect(result.variables).not.toHaveProperty('executed');
  await expect(manager.shutdown()).resolves.toBeUndefined();
});
