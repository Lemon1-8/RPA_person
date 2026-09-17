import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import { nextScheduleTime } from '../apps/runner/src/schedule.js';
import { FileStore } from '../packages/persistence/src/index.js';
import { refreshDemoUrls, seedDesktopWorkspace } from '../apps/desktop/src/workspace.js';
import { scheduleSchema, type WorkflowDefinition, type WorkflowSchedule } from '../packages/contracts/src/index.js';
import { createDemoWorkflow } from '../examples/demo.js';
import { startFixtureServer } from './fixtures/server.js';

const managers: RunManager[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-schedules-')) throw new Error('拒绝清理非测试目录');
    await rm(target, { recursive: true, force: true });
  }
});

async function setup(schedulePollMs = 0) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-schedules-')); directories.push(dataDir);
  let now = new Date('2030-01-01T00:00:00.000Z');
  const createManager = async () => {
    const manager = new RunManager({ dataDir, now: () => now, schedulePollMs });
    managers.push(manager); await manager.initialize(); return manager;
  };
  const manager = await createManager();
  const workflow = await manager.saveWorkflow({
    schemaVersion: 1, workflowId: 'scheduled-flow', name: '定时测试', revision: 0, variables: {}, elements: {},
    settings: { downloadDir: dataDir, headless: true, keepBrowserOpen: false },
    steps: [{ stepId: 'set', name: '执行', actionType: 'variables.set', params: { name: 'ran', value: true } }],
  } satisfies WorkflowDefinition);
  const schedule: WorkflowSchedule = { scheduleId: 'schedule-1', workflowId: workflow.workflowId, name: '计划', enabled: true, kind: 'once', at: '2030-01-01T00:01:00.000Z' };
  return { manager, workflow, schedule, dataDir, setTime: (value: string) => { now = new Date(value); }, createManager };
}

describe('定时运行', () => {
  it('运行已保存版本一次，传递计划时间，并在重复检查与重启时避免重复', async () => {
    const state = await setup();
    const saved = await state.manager.saveSchedule({ ...state.schedule, nextRunAt: '2099-01-01T00:00:00.000Z', lastRunId: 'forged' });
    expect(saved.nextRunAt).toBe(state.schedule.at);
    expect(saved.lastRunId).toBeUndefined();
    await state.manager.saveWorkflow({ ...state.workflow, name: '最新保存版本' });
    state.setTime('2030-01-01T00:01:03.000Z');
    await Promise.all([state.manager.checkSchedules(), state.manager.checkSchedules()]);
    const run = state.manager.listRuns()[0];
    expect(state.manager.listRuns()).toHaveLength(1);
    const result = await state.manager.waitForRun(run.runId);
    expect(result.status).toBe('succeeded');
    expect(result.workflowName).toBe('最新保存版本');
    expect(result.revision).toBe(2);
    expect(result.scheduleId).toBe(saved.scheduleId);
    expect(result.scheduledFor).toBe(state.schedule.at);
    expect(result.variables).toEqual({ ran: true });
    expect(state.manager.listSchedules()[0]).toMatchObject({ enabled: false, lastRunId: run.runId });
    await state.manager.shutdown();
    const restarted = await state.createManager();
    await restarted.checkSchedules();
    expect(restarted.listRuns()).toHaveLength(1);
    expect(restarted.listSchedules()[0].lastRunId).toBe(run.runId);
  });

  it('工作台计时器自动触发到期计划，无需界面发起检查', async () => {
    const state = await setup(20);
    await state.manager.saveSchedule(state.schedule);
    state.setTime('2030-01-01T00:01:00.000Z');
    await expect.poll(() => state.manager.listRuns().length).toBe(1);
    const run = state.manager.listRuns()[0];
    expect((await state.manager.waitForRun(run.runId)).status).toBe('succeeded');
    expect(state.manager.listSchedules()[0].lastRunId).toBe(run.runId);
  });

  it('从睡眠恢复的间隔计划仅触发一次，随后继续下一周期', async () => {
    const state = await setup();
    await state.manager.saveSchedule({ ...state.schedule, kind: 'interval', at: undefined, intervalMinutes: 1 });
    state.setTime('2030-01-01T12:00:00.000Z'); await state.manager.checkSchedules();
    expect(state.manager.listRuns()).toHaveLength(1);
    await state.manager.waitForRun(state.manager.listRuns()[0].runId);
    expect(state.manager.listSchedules()[0].nextRunAt).toBe('2030-01-01T12:01:00.000Z');
    state.setTime('2030-01-01T12:01:00.000Z'); await state.manager.checkSchedules();
    expect(state.manager.listRuns()).toHaveLength(2);
    await state.manager.waitForRun(state.manager.listRuns()[0].runId);
    expect(state.manager.listSchedules()[0].nextRunAt).toBe('2030-01-01T12:02:00.000Z');
  });

  it('停用、重新启用及删除计划立即影响后续触发', async () => {
    const state = await setup();
    const schedule = { ...state.schedule, kind: 'interval' as const, at: undefined, intervalMinutes: 1 };
    const first = await state.manager.saveSchedule(schedule);
    expect(first.nextRunAt).toBe('2030-01-01T00:01:00.000Z');
    await state.manager.saveSchedule({ ...first, enabled: false });
    state.setTime('2030-01-01T00:05:00.000Z'); await state.manager.checkSchedules();
    expect(state.manager.listRuns()).toHaveLength(0);
    const enabled = await state.manager.saveSchedule({ ...first, enabled: true });
    expect(enabled.nextRunAt).toBe('2030-01-01T00:06:00.000Z');
    await state.manager.deleteSchedule(enabled.scheduleId);
    state.setTime('2030-01-01T00:10:00.000Z'); await state.manager.checkSchedules();
    expect(state.manager.listSchedules()).toHaveLength(0);
    expect(state.manager.listRuns()).toHaveLength(0);
    expect(await state.manager.store.listSchedules()).toHaveLength(0);
  });

  it('重命名保留下一时间，改规则重新计时，改流程清除旧运行关联', async () => {
    const state = await setup();
    const first = await state.manager.saveSchedule({ ...state.schedule, kind: 'interval', at: undefined, intervalMinutes: 1 });
    state.setTime('2030-01-01T00:00:30.000Z');
    const renamed = await state.manager.saveSchedule({ ...first, name: '新名称', at: '2099-01-01T00:00:00.000Z' });
    expect(renamed.nextRunAt).toBe(first.nextRunAt);
    const modified = await state.manager.saveSchedule({ ...renamed, intervalMinutes: 2 });
    expect(modified.nextRunAt).toBe('2030-01-01T00:02:30.000Z');
    state.setTime('2030-01-01T00:02:30.000Z'); await state.manager.checkSchedules();
    const latest = state.manager.listSchedules()[0];
    expect(latest.lastRunId).toBeTruthy(); await state.manager.waitForRun(latest.lastRunId!);
    const another = await state.manager.saveWorkflow({ ...state.workflow, workflowId: 'another-flow', revision: 0 });
    const reassigned = await state.manager.saveSchedule({ ...latest, workflowId: another.workflowId });
    expect(reassigned.lastRunId).toBeUndefined(); expect(reassigned.lastRunAt).toBeUndefined();
  });

  it('重启跳过已错过的单次计划及重复计划，不补跑', async () => {
    const state = await setup();
    await state.manager.saveSchedule(state.schedule);
    await state.manager.saveSchedule({ ...state.schedule, scheduleId: 'interval', kind: 'interval', at: undefined, intervalMinutes: 10 });
    await state.manager.shutdown(); state.setTime('2030-01-02T12:00:00.000Z');
    const restarted = await state.createManager(); await restarted.checkSchedules();
    expect(restarted.listRuns()).toHaveLength(0);
    expect(restarted.listSchedules().find(schedule => schedule.scheduleId === 'schedule-1')).toMatchObject({ enabled: false, lastError: expect.stringContaining('错过') });
    expect(restarted.listSchedules().find(schedule => schedule.scheduleId === 'interval')).toMatchObject({ enabled: true, nextRunAt: '2030-01-02T12:10:00.000Z' });
  });

  it('同一流程有活动任务时记录触发失败且不反复重试同一时刻', async () => {
    const state = await setup();
    const blocking = await state.manager.saveWorkflow({ ...state.workflow, steps: [{ stepId: 'wait', name: '等待', actionType: 'script.run', timeoutMs: 20_000, params: { language: 'javascript', code: 'await new Promise(() => {});' } }] });
    const run = await state.manager.runWorkflow(blocking);
    await state.manager.saveSchedule(state.schedule);
    state.setTime('2030-01-01T00:01:00.000Z');
    await state.manager.checkSchedules(); await state.manager.checkSchedules();
    expect(state.manager.listRuns()).toHaveLength(1);
    expect(state.manager.listSchedules()[0]).toMatchObject({ enabled: false, lastError: expect.stringContaining('同一流程') });
    await expect(state.manager.deleteWorkflow(blocking.workflowId)).rejects.toThrow('仍有任务');
    await state.manager.controlRun(run.runId, 'stop'); await state.manager.waitForRun(run.runId);
  });

  it('删除流程同时移除关联计划，保留运行历史和执行时流程快照', async () => {
    const state = await setup();
    await state.manager.saveSchedule(state.schedule);
    const run = await state.manager.runWorkflow(state.workflow); await state.manager.waitForRun(run.runId);
    await state.manager.deleteWorkflow(state.workflow.workflowId);
    expect(await state.manager.listWorkflows()).toHaveLength(0);
    expect(state.manager.listSchedules()).toHaveLength(0);
    expect(state.manager.listRuns()).toHaveLength(1);
    expect(JSON.parse(await readFile(join(state.dataDir, 'runs', run.runId, 'workflow.json'), 'utf8')).workflowId).toBe(state.workflow.workflowId);
    await expect(state.manager.saveSchedule(state.schedule)).rejects.toThrow('请先保存');
  });

  it('首次打开空工作空间提供示例，主动删除全部流程后重启保持为空', async () => {
    const state = await setup();
    await state.manager.deleteWorkflow(state.workflow.workflowId);
    const demo = { ...state.workflow, workflowId: 'demo', revision: 0 };
    await seedDesktopWorkspace(state.manager, demo);
    expect((await state.manager.listWorkflows()).map(workflow => workflow.workflowId)).toEqual(['demo']);
    await state.manager.deleteWorkflow('demo'); await state.manager.shutdown();
    const restarted = await state.createManager();
    await seedDesktopWorkspace(restarted, demo);
    expect(await restarted.listWorkflows()).toHaveLength(0);
  });

  it('启动时刷新示例动作地址并保存，让计划读取本次启动的端口', async () => {
    const state = await setup();
    const fixture = await startFixtureServer();
    try {
      const demo = createDemoWorkflow('http://127.0.0.1:1234', state.dataDir, true);
      demo.steps = demo.steps.slice(0, 1); demo.settings.keepBrowserOpen = false;
      await state.manager.saveWorkflow(demo);
      await refreshDemoUrls(state.manager, fixture.url);
      const saved = (await state.manager.listWorkflows()).find(workflow => workflow.workflowId === demo.workflowId)!;
      expect(saved).toMatchObject({ revision: 2, variables: {}, steps: [{ params: { url: fixture.url } }] });
      await refreshDemoUrls(state.manager, fixture.url);
      expect((await state.manager.listWorkflows()).find(workflow => workflow.workflowId === demo.workflowId)!.revision).toBe(2);
      await state.manager.saveSchedule({ ...state.schedule, workflowId: demo.workflowId });
      state.setTime('2030-01-01T00:01:00.000Z'); await state.manager.checkSchedules();
      const run = await state.manager.waitForRun(state.manager.listRuns()[0].runId);
      expect(run.status, run.error).toBe('succeeded');
      expect(run.variables).toEqual({});
    } finally { await fixture.close(); }
  });

  it('拒绝无效时间、间隔和路径标识，并在退出后禁止新触发', async () => {
    const state = await setup();
    expect(() => scheduleSchema.parse({ ...state.schedule, scheduleId: '../escape' })).toThrow();
    expect(() => scheduleSchema.parse({ ...state.schedule, kind: 'daily', time: '25:61' })).toThrow();
    expect(() => scheduleSchema.parse({ ...state.schedule, kind: 'interval', intervalMinutes: 0 })).toThrow();
    await expect(state.manager.saveSchedule({ ...state.schedule, at: '2029-01-01T00:00:00.000Z' })).rejects.toThrow('晚于当前');
    expect(() => state.manager.deleteWorkflow('../escape')).toThrow();
    await state.manager.saveSchedule(state.schedule); await state.manager.shutdown();
    state.setTime('2030-01-01T00:01:00.000Z');
    await expect(state.manager.checkSchedules()).rejects.toThrow('正在退出');
    expect(state.manager.listRuns()).toHaveLength(0);
  });

  it('每日计划按本机时间计算下一次，孤立计划在重启后停用', async () => {
    const local = new Date(2030, 0, 1, 9, 30);
    const schedule: WorkflowSchedule = { scheduleId: 'daily', workflowId: 'missing', name: '每日', kind: 'daily', enabled: true, time: '09:30' };
    const next = new Date(nextScheduleTime(schedule, local)!);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()]).toEqual([2030, 0, 2, 9, 30]);
    const state = await setup(); await state.manager.shutdown();
    const store = new FileStore(state.dataDir); await store.saveSchedule(schedule);
    const restarted = await state.createManager();
    expect(restarted.listSchedules()[0]).toMatchObject({ enabled: false, lastError: expect.stringContaining('不存在') });
  });
});
