import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore } from '../packages/persistence/src/workbench.js';
import { makeWorkflow } from './engine.test.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'rpa-workbench-')); dirs.push(dir); const store = new WorkbenchStore(dir); await store.initialize(); return store; }
describe('工作空间可靠存储', () => {
  it('草稿保存未发布的流程和无效字段文本，重启可读取并明确放弃', async () => {
    const store = await setup(); const flow = { ...makeWorkflow([]), revision: 0 };
    await store.saveDraft({ workflowId: flow.workflowId, baseRevision: 0, updatedAt: new Date().toISOString(), workflow: flow, selectedId: 'new', fieldTexts: { json: '{未完成' } });
    const restarted = new WorkbenchStore(store.directory); await restarted.initialize();
    expect((await restarted.listDrafts())[0].fieldTexts.json).toBe('{未完成'); expect(await store.listWorkflows()).toEqual([]);
    await restarted.discardDraft(flow.workflowId); expect(await restarted.listDrafts()).toEqual([]);
  });
  it('归档旧修订，恢复为新修订，拒绝并发版本冲突', async () => {
    const store = await setup(); const first = await store.saveWorkflow({ ...makeWorkflow([]), revision: 0 });
    const second = await store.saveWorkflow({ ...first, name: '新名称' });
    expect((await store.getRevision(first.workflowId, 1)).name).toBe(first.name);
    const restored = await store.restoreRevision(first.workflowId, 1, second.revision);
    expect(restored).toMatchObject({ name: first.name, revision: 3 });
    await expect(store.restoreRevision(first.workflowId, 1, 2)).rejects.toThrow('版本已改变');
    expect((await store.listRevisions(first.workflowId)).map(value => value.revision)).toEqual([3, 2, 1]);
  });
  it('读取超过4000条日志，支持分页、搜索、旧事件和损坏行', async () => {
    const store = await setup(); const dir = join(store.directory, 'runs', 'history'); await mkdir(dir);
    const events = Array.from({ length: 5001 }, (_, index) => JSON.stringify({ type: 'log', runId: 'history', at: new Date().toISOString(), message: `日志${index}` }));
    await writeFile(join(dir, 'events.jsonl'), events.join('\n') + '\n坏行\n');
    const latest = await store.getRunEvents('history'); expect(latest.events).toHaveLength(200); expect(latest.hasMore).toBe(true); expect(latest.damagedLines).toBe(1);
    const earlier = await store.getRunEvents('history', { before: latest.before, limit: 200 }); expect(earlier.events.at(-1)!.sequence).toBeLessThan(latest.events[0].sequence!);
    expect((await store.getRunEvents('history', { query: '日志0' })).events).toHaveLength(1);
    expect((await store.getRunEvents('history')).events.at(-1)!.eventId).toBe('history:legacy:5001');
  });
  it('保存失败保留重试项，修复目录后重试成功', async () => {
    const store = await setup(); const flow = { ...makeWorkflow([]), revision: 0 };
    await rm(join(store.directory, 'drafts'), { recursive: true });
    await expect(store.saveDraft({ workflowId: flow.workflowId, baseRevision: 0, updatedAt: new Date().toISOString(), workflow: flow, selectedId: '', fieldTexts: {} })).rejects.toThrow();
    expect(store.issues()).toHaveLength(1); await mkdir(join(store.directory, 'drafts')); expect(await store.retryFailed()).toEqual([]);
    expect(await readFile(join(store.directory, 'drafts', `${flow.workflowId}.json`), 'utf8')).toContain(flow.workflowId);
  });
});
