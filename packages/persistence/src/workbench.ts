import { EventEmitter } from 'node:events';
import { createReadStream,readFileSync } from 'node:fs';
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
  private latestAttempts = new Map<string,RunSnapshot>();
  private attemptsQueue:Promise<unknown>=Promise.resolve();
  private eventSequence = new Map<string, number>();
  private eventQueue: Promise<unknown> = Promise.resolve();
  private results = new Map<string, { path: string; value: unknown }>();
  private logBuffers = new Map<string,string[]>();
  private logTimer?:NodeJS.Timeout;
  private logWrites:Promise<unknown>=Promise.resolve();
  private flushEvents() {
    clearTimeout(this.logTimer);this.logTimer=undefined;const buffers=this.logBuffers;this.logBuffers=new Map();
    const operation=this.logWrites.then(async()=>{for(const [id,lines] of buffers) await this.guarded(`event-batch:${id}:${randomUUID()}`,()=>writeFile(join(this.directory,'runs',scheduleIdentifier.parse(id),'events.jsonl'),lines.join(''),{flag:'a'}));});
    this.logWrites=operation.catch(()=>{});return operation;
  }
  prepareEvent(event: RunEvent) {
    if (event.type !== 'step' || !event.data || typeof event.data !== 'object' || !('result' in event.data)) return;
    const data = event.data as Record<string, unknown>; const bytes = Buffer.byteLength(JSON.stringify(data.result) ?? '');
    if (bytes <= 32768) return;
    const resultId = randomUUID(); this.results.set(event.eventId!, { path:join(this.directory,'runs',scheduleIdentifier.parse(event.runId),'results',`${resultId}.json`),value:data.result });
    const value = data.result;
    event.data = { ...data,result:undefined,resultId,resultBytes:bytes,resultSummary:Array.isArray(value) ? `列表 · ${value.length} 项` : typeof value === 'string' ? `文本 · ${value.length} 字符` : '大型对象' };
  }
  async getStepResult(runId: string,resultId: string) {
    await this.eventQueue; return JSON.parse(await readFile(join(this.directory,'runs',scheduleIdentifier.parse(runId),'results',`${scheduleIdentifier.parse(resultId)}.json`),'utf8'));
  }

  async initialize() {
    await super.initialize();
    for (const name of ['drafts', 'revisions', 'occurrences']) await mkdir(join(this.directory, name), { recursive: true });
  }
  async listRunHeaders():Promise<RunSnapshot[]> { const rows:RunSnapshot[]=[];for(const entry of await readdir(join(this.directory,'runs'),{withFileTypes:true})) if(entry.isDirectory()) {try{const run=await this.readRunSnapshot(entry.name);rows.push({...run,variables:{}});}catch(error){if(!missing(error)) throw error;}}return rows; }
  async readRunSnapshot(runId:string):Promise<RunSnapshot> {return JSON.parse(await readFile(join(this.directory,'runs',scheduleIdentifier.parse(runId),'run.json'),'utf8'));}
  readRunSnapshotSync(runId:string):RunSnapshot {return JSON.parse(readFileSync(join(this.directory,'runs',scheduleIdentifier.parse(runId),'run.json'),'utf8'));}
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
    // Retrying a formal save remains explicit so a newer editor version is never overwritten.
    return operation.then(value=>{if(this.failed.delete(`workflow:${input.workflowId}`)) this.health.emit('change',this.issues());return value;},error=>{
      if((error as NodeJS.ErrnoException).code) {this.failed.set(`workflow:${input.workflowId}`,{issue:{id:`workflow:${input.workflowId}`,message:`流程保存失败：${String(error)}。请重新点击保存。`,at:new Date().toISOString()},retry:async()=>{throw new Error('流程保存需重新点击保存，以检查当前修订。');}});this.health.emit('change',this.issues());}throw error;
    });
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
  async deleteWorkflow(workflowId:string) {
    const id=scheduleIdentifier.parse(workflowId);const current=(await this.listWorkflows()).find(flow=>flow.workflowId===id);
    if(current){const dir=join(this.directory,'revisions',id);await mkdir(dir,{recursive:true});await writeJsonAtomic(join(dir,`${current.revision}.json`),current);}
    await super.deleteWorkflow(id);
  }
  async listDrafts(): Promise<WorkflowDraft[]> {
    const result: WorkflowDraft[] = [];
    for (const file of (await readdir(join(this.directory, 'drafts'))).filter(file => file.endsWith('.json'))) {
      try { result.push(draftSchema.parse(JSON.parse(await readFile(join(this.directory, 'drafts', file), 'utf8'))) as unknown as WorkflowDraft);if(this.failed.delete(`draft-read:${file}`))this.health.emit('change',this.issues()); }
      catch (error) { this.failed.set(`draft-read:${file}`, { issue: { id: `draft-read:${file}`, message: `草稿无法读取：${file}，原文件已保留`, at: new Date().toISOString() }, retry: async()=>draftSchema.parse(JSON.parse(await readFile(join(this.directory,'drafts',file),'utf8'))) }); }
    }
    if([...this.failed.keys()].some(key=>key.startsWith('draft-read:')))this.health.emit('change',this.issues());
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
    const snapshot=structuredClone(run);this.latestRuns.set(run.runId,snapshot);
    const root=this.guarded(`run:${run.runId}`, async () => {
      const latest = this.latestRuns.get(run.runId)!;
      await super.saveRun(latest);
    });
    if(!run.attemptId) return root;
    const key=`${run.runId}:${run.attemptId}`;this.latestAttempts.set(key,snapshot);
    const attempt=this.guarded(`attempt:${key}`,()=>{const operation=this.attemptsQueue.then(async()=>{const latest=this.latestAttempts.get(key)!;const dir=join(this.directory,'runs',latest.runId,'attempts',latest.attemptId!);await mkdir(dir,{recursive:true});await writeJsonAtomic(join(dir,'run.json'),latest);});this.attemptsQueue=operation.catch(()=>{});return operation;});
    return Promise.all([root,attempt]).then(()=>{});
  }
  async createRun(workflow: WorkflowDefinition, run: RunSnapshot) {
    await super.createRun(workflow, run);
    for(const key of this.latestAttempts.keys()) if(key.startsWith(`${run.runId}:`) && key!==`${run.runId}:${run.attemptId}` && !this.failed.has(`attempt:${key}`)) this.latestAttempts.delete(key);
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
  async saveDependencies(run:RunSnapshot,dependencies:Record<string,WorkflowDefinition>) { await writeJsonAtomic(join(this.directory,'runs',scheduleIdentifier.parse(run.runId),'attempts',scheduleIdentifier.parse(run.attemptId!),'dependencies.json'),dependencies); }
  async readDependencies(run:RunSnapshot):Promise<Record<string,WorkflowDefinition>|undefined> {
    try { return JSON.parse(await readFile(join(this.directory,'runs',scheduleIdentifier.parse(run.runId),'attempts',scheduleIdentifier.parse(run.attemptId!),'dependencies.json'),'utf8')); } catch(error) { if(missing(error)) return undefined; throw error; }
  }
  recordEvent(input: RunEvent): Promise<void> {
    const event = structuredClone(input); event.eventId ??= randomUUID();
    const operation = this.eventQueue.then(()=>this.guarded(`event:${event.eventId}`,async () => {
      const result = this.results.get(event.eventId!);
      if (result) {
        this.results.delete(event.eventId!);
        await this.guarded(`result:${event.eventId}`,async () => { await mkdir(join(result.path,'..'),{recursive:true}); await writeJsonAtomic(result.path,result.value); }).catch(() => {});
      }
      if (!this.eventSequence.has(event.runId)) {
        const previous = await this.getRunEvents(event.runId, { limit: 1 },false);
        this.eventSequence.set(event.runId, previous.events[0]?.sequence ?? 0);
      }
      event.sequence ??= (this.eventSequence.get(event.runId) ?? 0) + 1;
      this.eventSequence.set(event.runId, event.sequence);
      input.sequence = event.sequence;
      const buffer=this.logBuffers.get(event.runId) ?? [];buffer.push(JSON.stringify(event)+'\n');this.logBuffers.set(event.runId,buffer);
      if(event.run && !['running','queued'].includes(event.run.status)) await this.flushEvents();
      else if(!this.logTimer) {this.logTimer=setTimeout(()=>{void this.flushEvents().catch(()=>{});},500);this.logTimer.unref();}
    }));
    this.eventQueue = operation.catch(() => {}); return operation;
  }
  async getRunEvents(runId: string, query: EventQuery = {},waitForQueue=true): Promise<EventPage> {
    if(waitForQueue)await this.eventQueue;
    await this.flushEvents().catch(()=>{});
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
    await this.flush();
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
  async flush() { await this.eventQueue; await this.flushEvents();await this.logWrites;await this.attemptsQueue; await this.revisionsQueue; await super.flush(); }
}
