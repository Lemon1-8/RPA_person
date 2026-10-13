import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchStore } from '../packages/persistence/src/workbench.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { progressPath, readProgress, saveProgress, forgetProgress } from '../packages/engine/src/progress.js';
import { preflight } from '../packages/actions/src/preflight.js';
import { RunManager } from '../apps/runner/src/manager.js';
import type { RunSnapshot, WorkflowDefinition } from '../packages/contracts/src/index.js';

const writeFault = vi.hoisted(() => ({ target: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    const path = String(args[0]);
    if (writeFault.target && (path === writeFault.target || path.startsWith(writeFault.target + '.'))) {
      await actual.writeFile(args[0], 'partial');
      throw Object.assign(new Error('模拟磁盘写入失败'), { code: 'ENOSPC' });
    }
    return actual.writeFile(...args);
  } };
});
const dirs: string[] = [];
const managers: RunManager[] = [];
afterEach(async () => {
  writeFault.target = '';
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
  for (const dir of dirs.splice(0)) {
    if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('rpa-audit-test-')) throw new Error('拒绝清理非测试目录');
    forgetProgress(join(dir, 'runs'));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'rpa-audit-test-')); dirs.push(dir); return dir; }
function flow(dir: string, steps: WorkflowDefinition['steps'] = []): WorkflowDefinition {
  return { schemaVersion: 1, workflowId: 'audit', name: '可靠性回归', revision: 0, variables: {}, elements: {}, settings: { downloadDir: dir, headless: true, keepBrowserOpen: false }, steps };
}
async function manager(dir?: string) {
  const result = new RunManager({ dataDir: dir ?? await directory(), autoStartSchedules: false }); managers.push(result); await result.initialize(); return result;
}

describe('审计发现的可靠性回归', () => {
  it.each(['main', '.input.json', '.journal.jsonl'])('已有进度缺少 %s 时拒绝续跑，不当成未执行', async suffix => {
    const dir = await directory(); const path = progressPath(dir, 'original', 'first', ['loop']);
    await saveProgress(path, { items: [1, 2], keys: ['1', '2'], completed: [], pending: [] });
    await saveProgress(path, { items: [1, 2], keys: ['1', '2'], completed: ['1'], pending: ['2'] });
    await unlink(suffix === 'main' ? path : path + suffix);
    await expect(readProgress(path)).rejects.toThrow('业务进度损坏');
  });

  it('尚未执行的循环和旧内联进度保持兼容', async () => {
    const dir = await directory(); const path = progressPath(dir, 'old', 'first', ['loop']);
    expect(await readProgress(path)).toBeUndefined();
    await mkdir(dirname(path), { recursive: true });
    const old = { items: [1], keys: ['1'], completed: ['1'], pending: [] };
    await writeFile(path, JSON.stringify(old));
    expect(await readProgress(path)).toEqual(old);
  });

  it('XLSX 覆盖写入失败保留旧文件，并清除临时文件', async () => {
    const dir = await directory(); const target = join(dir, 'output.xlsx');
    await writeFile(target, 'original workbook'); writeFault.target = target;
    const result = await new WorkflowEngine(flow(dir, [{ stepId: 'write', name: '覆盖', actionType: 'file.xlsxWrite', params: { path: target, rows: [{ id: 1 }] } }]), { dataDir: dir, runId: 'write' }).run();
    expect(result.status).toBe('failed');
    expect(await readFile(target, 'utf8')).toBe('original workbook');
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('一个任务日志写入失败不会丢失另一任务，修复后可完整重试', async () => {
    const dir = await directory(); const store = new WorkbenchStore(dir); await store.initialize();
    const event = (id: string, message: string) => ({ type: 'log' as const, runId: id, eventId: randomUUID(), at: new Date().toISOString(), message });
    for (const id of ['a', 'b']) { await mkdir(join(dir, 'runs', id)); await store.recordEvent(event(id, 'initial')); }
    await store.flush();
    const path = join(dir, 'runs', 'a', 'events.jsonl'); await unlink(path); await mkdir(path);
    await store.recordEvent(event('a', 'buffered-a')); await store.recordEvent(event('b', 'buffered-b'));
    await expect(store.flush()).rejects.toThrow();
    expect(await readFile(join(dir, 'runs', 'b', 'events.jsonl'), 'utf8')).toContain('buffered-b');
    await rmdir(path); expect(await store.retryFailed()).toEqual([]);
    expect(await readFile(path, 'utf8')).toContain('buffered-a'); await store.flush();
  });

  it('动态网址、路径、开关及数字延迟校验，确定的错误仍阻止运行', async () => {
    const dir = await directory(); const definition = flow(dir, [
      { stepId: 'open', name: '打开', actionType: 'browser.open', params: { url: '{{url}}' } },
      { stepId: 'read', name: '读取', actionType: 'file.xlsxRead', params: { path: '{{book}}' } },
      { stepId: 'shot', name: '截图', actionType: 'browser.screenshot', params: { directory: '{{dir}}', fullPage: '{{full}}' } },
      { stepId: 'wait', name: '等待', actionType: 'core.wait', params: { durationSeconds: '{{seconds}}' } },
    ]);
    definition.variables = { url: 'https://example.com', book: join(dir, 'input.xlsx'), dir, full: true, seconds: 2 };
    expect((await preflight(definition)).filter(issue => issue.level === 'error')).toEqual([]);
    definition.steps[0].params.openMode = 'invalid';
    expect((await preflight(definition)).some(issue => issue.level === 'error' && issue.stepId === 'open')).toBe(true);
    definition.steps[0].params.url = '{{undeclared}}';
    expect((await preflight(definition)).some(issue => issue.message.includes('尚未声明'))).toBe(true);
  });

  it('JSON 内的动态值不能掩盖同字段中已知的类型错误', async () => {
    const dir = await directory(); const definition = flow(dir, [
      { stepId: 'write', name: '写入', actionType: 'file.xlsxWrite', params: { path: join(dir, 'output.xlsx'), rows: [{ id: '{{id}}' }, 1] } },
    ]); definition.variables.id = 1;
    expect((await preflight(definition)).some(issue => issue.level === 'error')).toBe(true);
    definition.variables.row = { id: 1 }; definition.steps[0].params.rows = ['{{row}}'];
    expect((await preflight(definition)).filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('嵌套 Python 步骤的环境检查继承父容器设置', async () => {
    const dir = await directory(); const definition = flow(dir, [{ stepId: 'parent', name: '容器', actionType: 'control.if', params: { left: true, operator: 'truthy' }, settings: { pythonExecutable: join(dir, 'missing-python.exe') }, children: [
      { stepId: 'python', name: 'Python', actionType: 'script.run', params: { language: 'python', code: 'pass' } },
    ] }]);
    expect((await preflight(definition)).some(issue => issue.stepId === 'python' && issue.level === 'error' && issue.message.includes('解释器不可用'))).toBe(true);
  });

  it('恢复检查继承失败时的局部值，检查输出发布到父级', async () => {
    const dir = await directory(); const definition = flow(dir, [
      { stepId: 'fail', name: '局部失败', actionType: 'script.run', variables: { orderId: 'initial' }, onError: 'manual',
        params: { language: 'javascript', code: 'await rpa.set("orderId", "changed"); throw new Error("需要检查");' },
        recoveryChecks: [{ stepId: 'check', name: '核查局部值', actionType: 'core.log', params: { message: '{{orderId}}' }, output: 'checkedOrderId' }] },
    ]); definition.variables.orderId = 'global';
    const engine = new WorkflowEngine(definition, { dataDir: dir, runId: 'scope' }); const pending = engine.run();
    try {
      await expect.poll(() => engine.getSnapshot().status, { timeout: 10000 }).toBe('waiting_manual');
      await engine.control('check'); await engine.control('confirm');
      const result = await pending;
      expect(result.variables).toMatchObject({ orderId: 'global', checkedOrderId: 'changed' });
    } finally { await engine.control('stop'); await pending; }
  });

  it('落盘成功后释放完整快照，结束运行的变量仍可按需读取', async () => {
    const runner = await manager(); const definition = flow(runner.store.directory); definition.variables.payload = 'x'.repeat(40000);
    const saved = await runner.saveWorkflow(definition); const run = await runner.runWorkflow(saved); await runner.waitForRun(run.runId);
    const read = vi.spyOn(runner.store, 'readRunSnapshot');
    expect(await runner.getRunVariables(run.runId)).toEqual(saved.variables); expect(read).toHaveBeenCalled();
    expect(runner.store['latestRuns'].size).toBe(0); expect(runner.store['latestAttempts'].size).toBe(0);
    await runner.archiveRun(run.runId, true);
    const preview = await runner.previewCleanup([run.runId], []); await runner.applyCleanup(preview.token);
    expect(runner.store['latestRuns'].size).toBe(0); expect(runner.store['latestAttempts'].size).toBe(0);
  });

  it('运行元数据查询不读取历史完整变量', async () => {
    const runner = await manager(); const saved = await runner.saveWorkflow(flow(runner.store.directory));
    const run = await runner.runWorkflow(saved); await runner.waitForRun(run.runId); await runner.shutdown();
    const restarted = await manager(runner.store.directory); const read = vi.spyOn(restarted.store, 'readRunSnapshotSync');
    expect(restarted.listRunHeaders()[0]).toMatchObject({ runId: run.runId, variables: {} });
    expect(read).not.toHaveBeenCalled();
  });

  it('保存失败仍保留待重试快照，新状态保存成功后不会被旧重试覆盖', async () => {
    const dir = await directory(); const store = new WorkbenchStore(dir); await store.initialize();
    const definition = flow(dir); const run: RunSnapshot = { runId: 'retry-state', attemptId: 'first', workflowId: definition.workflowId, workflowName: definition.name, revision: 0, status: 'succeeded', startedAt: new Date().toISOString(), variables: { value: 'old' }, artifacts: [] };
    await store.createRun(definition, run);
    const target = join(dir, 'runs', run.runId, 'run.json'); await unlink(target); await mkdir(target);
    await expect(store.saveRun(run)).rejects.toThrow(); expect(store['latestRuns'].size).toBe(1);
    await rmdir(target); await store.saveRun({ ...run, variables: { value: 'new' } });
    expect(await store.retryFailed()).toEqual([]); expect((await store.readRunSnapshot(run.runId)).variables.value).toBe('new');
    expect(store['latestRuns'].size).toBe(0); expect(store['latestAttempts'].size).toBe(0);
  });

  it('启动恢复账本之后，停用计划的每轮检查不重扫历史', async () => {
    const runner = await manager(); const saved = await runner.saveWorkflow(flow(runner.store.directory));
    await runner.saveSchedule({ scheduleId: 'disabled', workflowId: saved.workflowId, name: '停用', kind: 'daily', time: '09:00', enabled: false });
    await runner.store.saveOccurrence({ scheduleId: 'disabled', scheduledFor: new Date().toISOString(), runId: 'old', outcome: 'started' });
    await runner.shutdown(); const restarted = await manager(runner.store.directory);
    const list = vi.spyOn(restarted.store, 'listOccurrences');
    await restarted.checkSchedules(); await restarted.checkSchedules(); expect(list).not.toHaveBeenCalled();
  });

  it('触发账本未提交时保护运行记录，修复后不重跑且允许清理', async () => {
    const dir = await directory(); let now = new Date('2030-01-01T00:00:00Z');
    const runner = new RunManager({ dataDir: dir, autoStartSchedules: false, now: () => now }); managers.push(runner); await runner.initialize();
    const saved = await runner.saveWorkflow(flow(dir));
    await runner.saveSchedule({ scheduleId: 'ledger', workflowId: saved.workflowId, name: '领取保护', kind: 'once', at: '2030-01-01T00:01:00Z', enabled: true });
    const original = runner.store.saveOccurrence.bind(runner.store); let fail = true;
    vi.spyOn(runner.store, 'saveOccurrence').mockImplementation(async occurrence => {
      if (fail && occurrence.outcome === 'started') throw new Error('触发账本写入失败');
      await original(occurrence);
    });
    now = new Date('2030-01-01T00:02:00Z'); await expect(runner.checkSchedules()).rejects.toThrow('触发账本写入失败');
    const run = runner.listRuns()[0]; await runner.waitForRun(run.runId); await runner.archiveRun(run.runId, true);
    const protectedPreview = await runner.previewCleanup([run.runId], []);
    expect(protectedPreview.runIds).toEqual([]); expect(protectedPreview.protected[0]).toContain('触发账本');
    fail = false; await runner.checkSchedules(); expect(runner.listRuns()).toHaveLength(1);
    const preview = await runner.previewCleanup([run.runId], []); expect(preview.runIds).toEqual([run.runId]);
    await runner.applyCleanup(preview.token); expect(runner.listRuns()).toEqual([]);
  });
});
