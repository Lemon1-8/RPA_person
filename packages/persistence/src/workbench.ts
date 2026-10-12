import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scheduleIdentifier, workflowSchema, type WorkflowDefinition, type WorkflowDraft, type RunSnapshot, type RunEvent, type EventQuery, type EventPage, type StorageIssue, type RunAttempt, type ScheduleOccurrence } from '../../contracts/src/index.js';
import { FileStore, writeJsonAtomic } from './index.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const draftSchema = z.object({ workflowId: scheduleIdentifier, baseRevision: z.number().int().nonnegative(), updatedAt: z.string().datetime(), workflow: z.object({ workflowId: scheduleIdentifier }).passthrough(), selectedId: z.string(), fieldTexts: z.record(z.string(), z.string()) });

export class WorkbenchStore extends FileStore {
  readonly health = new EventEmitter();
  private failed = new Map<string, { issue: StorageIssue; retry: () => Promise<unknown> }>();
  private revisionsQueue: Promise<unknown> = Promise.resolve();
  private latestRuns = new Map<string, RunSnapshot>();
  private eventSequence = new Map<string, number>();
  private eventQueue: Promise<unknown> = Promise.resolve();

  async initialize() {
    await super.initialize();
    for (const name of ['drafts', 'revisions', 'occurrences']) await mkdir(join(this.directory, name), { recursive: true });
  }
  issues() { return [...this.failed.values()].map(item => item.issue); }
  private async guarded<T>(id: string, action: () => Promise<T>): Promise<T> {
    try {
      const value = await action();
      if (this.failed.delete(id)) this.health.emit('change', this.issues());
      return value;
    } catch (error) {
      this.failed.set(id, { issue: { id, message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }, retry: action });
      this.health.emit('change', this.issues()); throw error;
    }
  }
  async retryFailed() {
    for (const [id, failure] of [...this.failed]) await this.guarded(id, failure.retry).catch(() => {});
    return this.issues();
  }
  saveWorkflow(input: WorkflowDefinition): Promise<WorkflowDefinition> {
    const operation = this.revisionsQueue.then(async () => {
      const current = (await super.listWorkflows()).find(flow => flow.workflowId === input.workflowId);
      if (current && current.revision !== input.revision) throw new Error(`流程版本已改变（当前 ${current.revision}），请重新加载后保存。`);
      if (current) {
        const dir = join(this.directory, 'revisions', current.workflowId); await mkdir(dir, { recursive: true });
        await writeJsonAtomic(join(dir, `${current.revision}.json`), current);
      }
      return super.saveWorkflow(input);
    });
    this.revisionsQueue = operation.catch(() => {});
    // Retrying a formal save must remain an explicit user action with its expected revision.
    return operation;
  }
  async getRevision(workflowId: string, revision: number): Promise<WorkflowDefinition> {
    const id = scheduleIdentifier.parse(workflowId); z.number().int().positive().parse(revision);
    const current = (await this.listWorkflows()).find(flow => flow.workflowId === id);
    if (current?.revision === revision) return current;
    try { return workflowSchema.parse(JSON.parse(await readFile(join(this.directory, 'revisions', id, `${revision}.json`), 'utf8'))); }
    catch (error) { if (missing(error)) throw new Error(`流程修订 v${revision} 不存在`); throw error; }
  }
  async listRevisions(workflowId: string) {
    const id = scheduleIdentifier.parse(workflowId);
    let files: string[] = [];
    try { files = await readdir(join(this.directory, 'revisions', id)); } catch (error) { if (!missing(error)) throw error; }
    const revisions = files.filter(file => /^\d+\.json$/.test(file)).map(file => Number(file.slice(0, -5)));
    const current = (await this.listWorkflows()).find(flow => flow.workflowId === id);
    if (current) revisions.push(current.revision);
    return Promise.all([...new Set(revisions)].sort((a, b) => b - a).map(async revision => ({ revision, name: (await this.getRevision(id, revision)).name })));
  }
  async restoreRevision(workflowId: string, revision: number, expectedRevision: number) {
    const flow = await this.getRevision(workflowId, revision);
    return this.saveWorkflow({ ...flow, revision: expectedRevision });
  }
  async listDrafts(): Promise<WorkflowDraft[]> {
    const result: WorkflowDraft[] = [];
    for (const file of (await readdir(join(this.directory, 'drafts'))).filter(file => file.endsWith('.json'))) {
      try { result.push(draftSchema.parse(JSON.parse(await readFile(join(this.directory, 'drafts', file), 'utf8'))) as unknown as WorkflowDraft); }
      catch (error) { this.failed.set(`draft-read:${file}`, { issue: { id: `draft-read:${file}`, message: `草稿无法读取：${file}，原文件已保留`, at: new Date().toISOString() }, retry: () => this.listDrafts() }); }
    }
    return result;
  }
  saveDraft(input: WorkflowDraft) {
    const draft = draftSchema.parse(input); if (draft.workflow.workflowId !== draft.workflowId) throw new Error('草稿流程标识不一致');
    return this.guarded(`draft:${draft.workflowId}`, () => writeJsonAtomic(join(this.directory, 'drafts', `${draft.workflowId}.json`), draft));
  }
  async discardDraft(workflowId: string) {
    const id = scheduleIdentifier.parse(workflowId);
    await unlink(join(this.directory, 'drafts', `${id}.json`)).catch(error => { if (!missing(error)) throw error; });
    this.failed.delete(`draft:${id}`); this.health.emit('change', this.issues());
  }
  saveRun(run: RunSnapshot) {
    this.latestRuns.set(run.runId, structuredClone(run));
    return this.guarded(`run:${run.runId}`, async () => {
      const latest = this.latestRuns.get(run.runId)!;
      await super.saveRun(latest);
      if (latest.attemptId) {
        const dir = join(this.directory, 'runs', latest.runId, 'attempts', latest.attemptId); await mkdir(dir, { recursive: true });
        await writeJsonAtomic(join(dir, 'run.json'), latest);
      }
    });
  }
  async createRun(workflow: WorkflowDefinition, run: RunSnapshot) {
    await super.createRun(workflow, run);
    if (run.attemptId) {
      const dir = join(this.directory, 'runs', run.runId, 'attempts', run.attemptId); await mkdir(dir, { recursive: true });
      const path = join(dir, 'workflow.json');
      try { await readFile(path); } catch (error) { if (!missing(error)) throw error; await writeJsonAtomic(path, workflow); }
    }
  }
  async listAttempts(runId: string): Promise<RunAttempt[]> {
    const id = scheduleIdentifier.parse(runId); const dir = join(this.directory, 'runs', id, 'attempts');
    let files;
    try { files = await readdir(dir, { withFileTypes: true }); } catch (error) { if (missing(error)) return []; throw error; }
    const result: RunAttempt[] = [];
    for (const file of files.filter(file => file.isDirectory())) {
      try { result.push({ attemptId: file.name, run: JSON.parse(await readFile(join(dir, file.name, 'run.json'), 'utf8')), workflow: workflowSchema.parse(JSON.parse(await readFile(join(dir, file.name, 'workflow.json'), 'utf8'))) }); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return result.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
  }
  recordEvent(input: RunEvent): Promise<void> {
    const event = structuredClone(input); event.eventId ??= randomUUID();
    const operation = this.eventQueue.then(async () => {
      if (!this.eventSequence.has(event.runId)) {
        const previous = await this.getRunEvents(event.runId, { limit: 1 });
        this.eventSequence.set(event.runId, previous.events[0]?.sequence ?? 0);
      }
      event.sequence ??= (this.eventSequence.get(event.runId) ?? 0) + 1;
      this.eventSequence.set(event.runId, event.sequence);
      input.sequence = event.sequence;
      await this.guarded(`event:${event.eventId}`, () => super.recordEvent(event));
    });
    this.eventQueue = operation.catch(() => {}); return operation;
  }
  async getRunEvents(runId: string, query: EventQuery = {}): Promise<EventPage> {
    const id = scheduleIdentifier.parse(runId); const limit = Math.max(1, Math.min(1000, query.limit ?? 200));
    const rows: RunEvent[] = []; let damagedLines = 0; let lineNumber = 0;
    const seen = new Set<string>(); const term = query.query?.toLocaleLowerCase();
    const stream = createReadStream(join(this.directory, 'runs', id, 'events.jsonl'), { encoding: 'utf8' });
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        lineNumber++; if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as RunEvent; if (event.runId !== id || !event.type) throw new Error('无效事件');
          event.sequence ??= lineNumber; event.eventId ??= `${id}:legacy:${lineNumber}`;
          if (seen.has(event.eventId)) continue; seen.add(event.eventId);
          if (query.before !== undefined && event.sequence >= query.before || query.attemptId && event.attemptId !== query.attemptId) continue;
          if (term && !JSON.stringify(event).toLocaleLowerCase().includes(term)) continue;
          rows.push(event); rows.sort((a, b) => a.sequence! - b.sequence!);
          if (rows.length > limit + 1) rows.shift();
        } catch { damagedLines++; }
      }
    } catch (error) { if (!missing(error)) throw error; }
    finally { stream.destroy(); }
    const hasMore = rows.length > limit; if (hasMore) rows.shift();
    return { events: rows, before: rows[0]?.sequence, hasMore, damagedLines };
  }
  async exportEvents(runId: string, target: string) {
    const id = scheduleIdentifier.parse(runId); await writeFile(target, await readFile(join(this.directory, 'runs', id, 'events.jsonl')));
  }
  async readOccurrence(scheduleId: string, scheduledFor: string): Promise<ScheduleOccurrence | null> {
    const id = scheduleIdentifier.parse(scheduleId); const key = Date.parse(scheduledFor); if (!Number.isFinite(key)) throw new Error('无效计划时间');
    try { return JSON.parse(await readFile(join(this.directory, 'occurrences', id, `${key}.json`), 'utf8')); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async saveOccurrence(value: ScheduleOccurrence) {
    const id = scheduleIdentifier.parse(value.scheduleId); const key = Date.parse(value.scheduledFor); if (!Number.isFinite(key)) throw new Error('无效计划时间');
    const dir = join(this.directory, 'occurrences', id); await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, `${key}.json`), value);
  }
  async listOccurrences(scheduleId: string): Promise<ScheduleOccurrence[]> {
    const id = scheduleIdentifier.parse(scheduleId); const dir = join(this.directory, 'occurrences', id);
    let files: string[]; try { files = await readdir(dir); } catch (error) { if (missing(error)) return []; throw error; }
    return Promise.all(files.filter(file => /^\d+\.json$/.test(file)).sort().reverse().map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))));
  }
  async flush() { await this.eventQueue; await this.revisionsQueue; await super.flush(); }
}
