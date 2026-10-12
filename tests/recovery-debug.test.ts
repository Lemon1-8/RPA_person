import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowDefinition, StepDefinition } from '../packages/contracts/src/index.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const flow = (steps: StepDefinition[]): WorkflowDefinition => ({ schemaVersion: 1, workflowId: 'recovery-test', name: '恢复测试', revision: 1, variables: {}, elements: {}, steps, settings: { downloadDir: tmpdir(), headless: true, keepBrowserOpen: false } });
async function dir() { const value = await mkdtemp(join(tmpdir(), 'rpa-recovery-')); directories.push(value); return value; }
describe('调试与恢复', () => {
  it('循环断点每次命中，单步执行一条后暂停，继续不丢失循环变量', async () => {
    const engine = new WorkflowEngine(flow([{ stepId: 'loop', name: '循环', actionType: 'control.forEach', params: { items: [1,2], itemVariable: 'item' }, children: [{ stepId: 'leaf', name: '记录', actionType: 'variables.set', params: { name: 'last', value: '{{item}}' } }] }, { stepId: 'after', name: '最后', actionType: 'variables.set', params: { name: 'after', value: true } }]), { dataDir: await dir(), runId: 'debug', debug: { breakpoints: ['leaf'] } });
    const pending = engine.run(); await expect.poll(() => engine.getSnapshot().status).toBe('paused');
    await engine.control('step'); await expect.poll(() => engine.getSnapshot().variables.last).toBe(1); await expect.poll(() => engine.getSnapshot().status).toBe('paused');
    await engine.control('resume'); expect((await pending).variables).toMatchObject({ last: 2, after: true });
  });
  it('有外部效果的失败须明确人工决策，跳过累计警告', async () => {
    const engine = new WorkflowEngine(flow([{ stepId: 'effect', name: '脚本', actionType: 'script.run', params: { language: 'javascript', code: 'throw new Error("需要检查已有结果");' }, onError: 'manual' }, { stepId: 'after', name: '后续', actionType: 'variables.set', params: { name: 'after', value: true } }]), { dataDir: await dir(), runId: 'manual' });
    const pending = engine.run(); await expect.poll(() => engine.getSnapshot().status).toBe('waiting_manual');
    await expect(engine.control('resume')).rejects.toThrow('明确选择'); await engine.control('skip'); const result = await pending; expect(result.warningCount).toBe(1); expect(result.variables.after).toBe(true);
  });
  it('第800项失败后保持前799项完成，重建后检查未知项并继续剩余数据', async () => {
    const dataDir = await dir();
    const workflow = flow([{ stepId: 'loop', name: '订单循环', actionType: 'control.forEach', timeoutMs: 300000, params: { items: Array.from({ length: 802 }, (_, index) => index + 1), itemVariable: 'item', progressKey: '{{item}}' }, children: [{ stepId: 'if', name: '第800项', actionType: 'control.if', params: { left: '{{item}}', operator: 'equals', right: 800 }, children: [{ stepId: 'fail', name: '模拟中断', actionType: 'core.assert', params: { actual: 1, expected: 2 } }] }, { stepId: 'record', name: '记录处理', actionType: 'variables.set', params: { name: 'last', value: '{{item}}' } }] }]);
    const original = new WorkflowEngine(workflow, { dataDir, runId: 'original', attemptId: 'original-attempt' }); expect((await original.run()).status).toBe('failed'); expect(original.getSnapshot().variables.last).toBe(799);
    const resumed = new WorkflowEngine(workflow, { dataDir, runId: 'resumed', attemptId: 'resumed-attempt', resumeFromRunId: 'original', resumeFromAttemptId: 'original-attempt' });
    const pending = resumed.run(); await expect.poll(() => resumed.getSnapshot().status).toBe('waiting_manual'); expect(resumed.getSnapshot().error).toContain('800');
    await resumed.control('confirm'); const result = await pending; expect(result.status).toBe('succeeded'); expect(result.variables.last).toBe(802); expect(result.resumedFromRunId).toBe('original');
  }, 45000);
  it('重复业务键在执行循环体前失败，停止等待人工可结束任务', async () => {
    const engine = new WorkflowEngine(flow([{ stepId: 'loop', name: '重复', actionType: 'control.forEach', params: { items: [1,1], itemVariable: 'item', progressKey: '{{item}}' }, children: [{ stepId: 'write', name: '写入', actionType: 'variables.set', params: { name: 'written', value: true } }] }]), { dataDir: await dir(), runId: 'duplicate' }); const result = await engine.run(); expect(result.status).toBe('failed'); expect(result.error).toContain('重复'); expect(result.variables.written).toBeUndefined();
  });
});
