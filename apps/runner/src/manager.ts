import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cp, stat, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { normalizeWorkflowForStorage } from '../../../packages/persistence/src/index.js';
import { WorkbenchStore } from '../../../packages/persistence/src/workbench.js';
import { validateActions } from '../../../packages/actions/src/index.js';
import { preflight } from '../../../packages/actions/src/preflight.js';
import { findStepPath, scheduleIdentifier, scheduleSchema, workflowSchema, type BrowserPageInfo, type BrowserPoint, type RunCommand, type RunEvent, type RunSnapshot, type WorkflowDefinition, type WorkflowSchedule } from '../../../packages/contracts/src/index.js';
import { nextScheduleTime, latestScheduleTime } from './schedule.js';
import type { EngineOptions } from '../../../packages/engine/src/index.js';
import { mergeRunEvent } from '../../../packages/contracts/src/run-events.js';
import { workflowDependencies } from './dependencies.js';
import { runMetadataFiles } from './history.js';
import type { CleanupPreview,RunHistoryQuery,ScheduleOccurrence } from '../../../packages/contracts/src/index.js';

const terminal = (status: RunSnapshot['status']) => ['succeeded', 'failed', 'stopped', 'interrupted'].includes(status);
interface PendingControl { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface PendingPages { resolve: (pages: BrowserPageInfo[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface PendingPoint { id: string; resolve: (point: BrowserPoint | null) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Job { workflow: WorkflowDefinition; run: RunSnapshot; child?: ChildProcess; stopping?: NodeJS.Timeout; finished?: Promise<void>; exit?: () => void; controls?: Map<string, PendingControl>; pageQueries?: Map<string, PendingPages>; pointPick?: PendingPoint; executionOptions?: Partial<EngineOptions>;persistent?:boolean }
async function killOwnedTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') await new Promise<void>(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); resolve(); }); killer.on('close', () => resolve());
  });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
export interface ManagerOptions { dataDir: string; maxConcurrent?: number; rootDir?: string; workerPath?: string; now?: () => Date; schedulePollMs?: number; autoStartSchedules?: boolean }
export class RunManager extends EventEmitter {
  readonly store: WorkbenchStore;
  private jobs = new Map<string, Job>();
  private pending: string[] = [];
  private shuttingDown = false;
  private startQueue: Promise<unknown> = Promise.resolve();
  private schedules = new Map<string, WorkflowSchedule>();
  private pendingOccurrences = new Map<string, ScheduleOccurrence>();
  private scheduleTimer?: NodeJS.Timeout;
  private checkingSchedules = false;
  private emergencyStopping = false;
  private demoUrl?: string;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private persistState(job: Job) {
    const id = job.run.runId;
    if (!['running','queued'].includes(job.run.status)) {
      clearTimeout(this.saveTimers.get(id)); this.saveTimers.delete(id);
      void this.store.saveRun(job.run).catch(error => this.emit('storage-error',error));
    } else if (!this.saveTimers.has(id)) this.saveTimers.set(id,setTimeout(() => {
      this.saveTimers.delete(id); void this.store.saveRun(job.run).catch(error => this.emit('storage-error',error));
    },500));
  }
  async getRunVariables(runId: string) { const job = this.jobs.get(scheduleIdentifier.parse(runId)); if (!job) throw new Error('运行不存在'); return job.persistent ? (await this.store.readRunSnapshot(runId)).variables : structuredClone(job.run.variables); }
  queryRuns(query:RunHistoryQuery={}) {
    const matches=[...this.jobs.values()].map(job=>job.run).filter(run=>(!query.workflowId || query.workflowId===run.workflowId) && (!query.status || query.status===run.status) && (!query.from || run.startedAt>=query.from) && (!query.to || run.startedAt<=query.to) && (query.archived===undefined || !!run.archived===query.archived)).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
    const offset=Math.max(0,Math.floor(query.offset ?? 0)),limit=Math.max(1,Math.min(100,Math.floor(query.limit ?? 20)));
    return {total:matches.length,runs:matches.slice(offset,offset+limit).map(run=>({...run,variables:{}}))};
  }
  archiveRun(runId:string,archived:boolean) { return this.serialize(async()=>{const job=this.jobs.get(scheduleIdentifier.parse(runId));if(!job || !terminal(job.run.status) || job.run.browserOpen) throw new Error('只能归档已结束且关闭会话的运行');if(typeof archived!=='boolean') throw new Error('归档状态无效');job.run.archived=archived;await this.store.saveRun(job.persistent?{...await this.store.readRunSnapshot(runId),archived}:job.run);}); }
  private cleanups=new Map<string,{preview:CleanupPreview;at:number}>();
  private async protectedRevisions() {
    const keys=new Set<string>();const workflows=await this.listWorkflows();
    const visited=new Set<string>();const visit=async(flow:WorkflowDefinition)=>{const key=`${flow.workflowId}@${flow.revision}`;keys.add(key);if(visited.has(key)) return;visited.add(key);const steps=[...flow.steps];while(steps.length){const step=steps.shift()!;steps.push(...step.children ?? [],...step.elseSteps ?? []);if(step.actionType==='workflow.call' && typeof step.params.workflowId==='string' && Number.isSafeInteger(step.params.revision)){const key=`${step.params.workflowId}@${step.params.revision}`;keys.add(key);const child=await this.store.getRevision(step.params.workflowId,Number(step.params.revision)).catch(()=>null);if(child) await visit(child);}}};
    for(const flow of workflows) await visit(flow);
    for(const plan of this.schedules.values()) if(plan.revision) {keys.add(`${plan.workflowId}@${plan.revision}`);const flow=await this.store.getRevision(plan.workflowId,plan.revision).catch(()=>null);if(flow) await visit(flow);}
    return keys;
  }
  async previewCleanup(runIds:string[],revisions:{workflowId:string;revision:number}[]) {
    if(this.store.issues().length) throw new Error('请先修复保存失败，再预览清理历史。');
    if(!Array.isArray(runIds) || !Array.isArray(revisions) || runIds.length+revisions.length>1000) throw new Error('清理选择无效');
    await this.store.flush();const protectedKeys=await this.protectedRevisions();const preview:CleanupPreview={token:randomUUID(),runIds:[],revisions:[],files:[],bytes:0,protected:[]};
    const artifacts = [...this.jobs.values()].flatMap(job => job.run.artifacts.map(artifact => artifact.path));
    for(const id of new Set(runIds.map(id=>scheduleIdentifier.parse(id)))) {const job=this.jobs.get(id);if(!job?.run.archived || !terminal(job.run.status) || job.run.browserOpen || this.pendingOccurrences.has(id) || [...this.jobs.values()].some(other=>!terminal(other.run.status) && other.run.resumedFromRunId===id)) {preview.protected.push(`运行 ${id} 未归档、仍占用会话或正在被续跑、触发账本引用`);continue;}preview.runIds.push(id);preview.files.push(...await runMetadataFiles(this.options.dataDir,id,artifacts));}
    for(const ref of revisions) {const id=scheduleIdentifier.parse(ref.workflowId);if(!Number.isSafeInteger(ref.revision) || ref.revision<1) throw new Error('清理修订无效');const key=`${id}@${ref.revision}`;if(protectedKeys.has(key)){preview.protected.push(`修订 ${key} 被保存流程或固定计划引用`);continue;}const path=join(this.options.dataDir,'revisions',id,`${ref.revision}.json`);try{await stat(path);preview.files.push(path);preview.revisions.push({workflowId:id,revision:ref.revision});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}}
    preview.files=[...new Set(preview.files)];for(const path of preview.files) preview.bytes+=(await stat(path)).size;
    if(this.cleanups.size>=10) this.cleanups.delete(this.cleanups.keys().next().value!);this.cleanups.set(preview.token,{preview,at:Date.now()});return structuredClone(preview);
  }
  applyCleanup(token:string) {return this.serialize(async()=>{const selected=this.cleanups.get(scheduleIdentifier.parse(token));if(!selected || Date.now()-selected.at>900000) throw new Error('清理预览已失效，请重新预览');const current=await this.previewCleanup(selected.preview.runIds,selected.preview.revisions);this.cleanups.delete(current.token);if(current.protected.length || current.files.some(path=>!selected.preview.files.includes(path))) throw new Error('清理引用或文件已变化，请重新预览');for(const path of current.files) await unlink(path).catch(error=>{if(error.code!=='ENOENT') throw error;});for(const id of current.runIds) {this.jobs.delete(id);this.store.forgetRun(id);}this.cleanups.delete(token);});}
  setDemoUrl(value: string) { this.demoUrl = new URL(value).href; }
  async stopAll() {
    this.emergencyStopping = true; this.pending = [];
    try { const results=await Promise.allSettled([...this.jobs.values()].filter(job => !terminal(job.run.status) || job.run.browserOpen).map(job => this.controlRun(job.run.runId, terminal(job.run.status) ? 'closeBrowser' : 'stop')));const errors=results.filter(result=>result.status==='rejected');if(errors.length)throw new AggregateError(errors.map(result=>(result as PromiseRejectedResult).reason),'部分任务紧急停止失败'); }
    finally { this.emergencyStopping = false; }
  }
  private tools = new Map<string, { runId: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  queryBrowserTool(runId: string, method: 'pickElement' | 'cancelElement' | 'validateElement', params: Record<string, unknown>): Promise<unknown> {
    const job = this.jobs.get(scheduleIdentifier.parse(runId)); if (!job?.child?.connected) return Promise.reject(new Error('浏览器会话不存在'));
    if (method !== 'cancelElement' && !terminal(job.run.status)) return Promise.reject(new Error('任务执行中不能拾取或校验元素'));
    if (method !== 'cancelElement' && [...this.tools.values()].some(tool => tool.runId === runId)) return Promise.reject(new Error('浏览器工具正在操作'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.tools.delete(requestId); reject(new Error('浏览器工具超时')); }, method === 'pickElement' ? 125000 : 10000);
      this.tools.set(requestId, { runId, resolve, reject, timer });
      job.child!.send({ type: 'browser-tool', method, params, requestId }, error => { if (error) { clearTimeout(timer); this.tools.delete(requestId); reject(error); } });
    });
  }
  constructor(private options: ManagerOptions) {
    super();
    const concurrency = options.maxConcurrent ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('并发数须为 1–16 的整数');
    this.store = new WorkbenchStore(options.dataDir);
    this.store.health.on('change', () => { for (const job of this.jobs.values()) if (!job.persistent) this.compactJob(job); });
  }
  async initialize() {
    await this.store.initialize();
    for (const run of await this.store.listRunHeaders()) {
      const browserWasOpen = run.browserOpen;
      run.browserOpen = false;
      if (!terminal(run.status)) {
        run.status = 'interrupted'; run.endedAt = new Date().toISOString(); run.error = '运行器曾退出，原浏览器现场不可恢复。';
        const persisted=await this.store.readRunSnapshot(run.runId);await this.store.saveRun({...persisted,...run,variables:persisted.variables});
      } else if (browserWasOpen) await this.store.saveRun({...await this.store.readRunSnapshot(run.runId),browserOpen:false});
      this.jobs.set(run.runId, { run, workflow: undefined as unknown as WorkflowDefinition,persistent:true });
    }
    const workflows = await this.listWorkflows();
    const now = this.now();
    for (const schedule of await this.store.listSchedules()) {
      if (!workflows.some(workflow => workflow.workflowId === schedule.workflowId)) {
        schedule.enabled = false; schedule.nextRunAt = undefined; schedule.lastError = '关联流程已不存在，定时计划已停用。';
      } else if (schedule.enabled && schedule.revision && !await this.store.getRevision(schedule.workflowId, schedule.revision).catch(() => null)) {
        schedule.enabled = false; schedule.nextRunAt = undefined; schedule.lastError = `固定修订 v${schedule.revision} 不存在，计划已停用。`;
      } else if (schedule.enabled && !schedule.nextRunAt) {
        if (schedule.kind === 'once' && Date.parse(schedule.at!) <= now.getTime()) {
          schedule.enabled = false; schedule.nextRunAt = undefined;
          schedule.lastError = '缺少可识别的历史触发时间，单次计划已停用，请重新选择时间。';
        } else {
          schedule.nextRunAt = nextScheduleTime(schedule, now);
        }
      }
      await this.store.saveSchedule(schedule);
      this.schedules.set(schedule.scheduleId, schedule);
      for (const occurrence of await this.store.listOccurrences(schedule.scheduleId)) if (occurrence.outcome === 'claimed') this.pendingOccurrences.set(occurrence.runId, occurrence);
    }
    if (this.options.autoStartSchedules !== false) this.startScheduling();
  }
  startScheduling() {
    if (this.shuttingDown) throw new Error('运行器正在退出');
    if (this.scheduleTimer) return;
    const pollMs = this.options.schedulePollMs ?? 1_000;
    if (pollMs > 0) {
      this.scheduleTimer = setInterval(() => {
        if (this.checkingSchedules) return;
        this.checkingSchedules = true;
        void this.checkSchedules().catch(error => this.emit('storage-error', error)).finally(() => { this.checkingSchedules = false; });
      }, pollMs);
      this.scheduleTimer.unref();
    }
  }
  private now() { return this.options.now?.() ?? new Date(); }
  private serialize<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.startQueue.then(async () => {
      if (this.shuttingDown) throw new Error('运行器正在退出');
      return callback();
    });
    this.startQueue = operation.catch(() => {}); return operation;
  }
  listRuns() { return [...this.jobs.values()].map(job=>{if(!job.persistent)return structuredClone(job.run);const saved=this.store.readRunSnapshotSync(job.run.runId);return {...saved,...job.run,variables:saved.variables};}).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  listRunHeaders() { return [...this.jobs.values()].map(job => structuredClone({ ...job.run, variables: {} })); }
  private compactJob(job: Job) {
    if (job.child || !terminal(job.run.status) || job.run.browserOpen || this.store.issues().some(issue => issue.id === `run:${job.run.runId}`)) return;
    job.run = { ...job.run, variables: {} }; job.persistent = true;
    job.workflow = undefined as unknown as WorkflowDefinition; job.executionOptions = undefined;
  }
  bootstrapRuns() {return [...this.jobs.values()].sort((a,b)=>b.run.startedAt.localeCompare(a.run.startedAt)).filter((job,index)=>index<50 || !terminal(job.run.status) || job.run.browserOpen).map(job=>job.persistent?this.store.readRunSnapshotSync(job.run.runId):structuredClone(job.run));}
  concurrencyLimit() { return this.options.maxConcurrent ?? 2; }
  async preflightWorkflow(flow:WorkflowDefinition) {
    const issues=await preflight(flow);
    let dependencies:Record<string,WorkflowDefinition>;try{dependencies=await workflowDependencies(this.store,workflowSchema.parse(flow));}catch(error){issues.push({level:'error',message:String(error)});return issues;}
    for(const input of flow.inputs ?? []) if(!Object.hasOwn(flow.variables,input)) issues.push({level:'error',message:`单独运行需要流程输入变量：${input}，请在默认变量中填写。`});
    const visit=async(workflow:WorkflowDefinition,owner?:string)=>{const steps=[...workflow.steps];while(steps.length){const step=steps.shift()!;if(step.disabled)continue;steps.push(...step.children ?? [],...step.elseSteps ?? []);if(step.actionType!=='workflow.call')continue;const child=dependencies[`${step.params.workflowId}@${step.params.revision}`];if(!child)continue;const stepId=owner ?? step.stepId;const input=step.params.inputs;
      if(input && typeof input==='object' && !Array.isArray(input)){for(const name of Object.keys(input)) if(!child.inputs?.includes(name)) issues.push({level:'error',stepId,message:`子流程 ${child.name} 未声明输入：${name}`});for(const name of child.inputs ?? []) if(!Object.hasOwn(input,name)) issues.push({level:'error',stepId,message:`子流程 ${child.name} 缺少输入：${name}`});}
      const fields=Object.fromEntries((child.inputs ?? []).map(name=>[name,null]));for(const issue of await preflight({...child,variables:{...child.variables,...fields}})) issues.push({...issue,stepId,message:`子流程 ${child.name} v${child.revision}：${issue.message}`});await visit(child,stepId);
    }};await visit(flow);return issues;
  }
  async getRunWorkflow(runId: string): Promise<WorkflowDefinition | null> {
    const id = scheduleIdentifier.parse(runId);
    const workflow = this.jobs.get(id)?.workflow;
    return workflow ? structuredClone(workflow) : this.store.readRunWorkflow(id);
  }
  async listBrowserPages(runId: string): Promise<BrowserPageInfo[]> {
    if (typeof runId !== 'string' || !runId) throw new Error('浏览器运行标识无效');
    if (this.shuttingDown) throw new Error('运行器正在退出');
    const job = this.jobs.get(runId);
    if (!job?.child?.connected) return [];
    const child = job.child;
    const requestId = randomUUID();
    return new Promise<BrowserPageInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        job.pageQueries?.delete(requestId); reject(new Error('查询浏览器网页超时'));
      }, 10_000);
      job.pageQueries!.set(requestId, { resolve, reject, timer });
      const fail = (error: Error) => { clearTimeout(timer); job.pageQueries?.delete(requestId); reject(error); };
      try { child.send({ type: 'list-browser-pages', requestId }, error => { if (error) fail(error); }); }
      catch (error) { fail(error as Error); }
    });
  }
  private rejectPageQueries(job: Job, error: Error) {
    for (const pending of job.pageQueries?.values() ?? []) { clearTimeout(pending.timer); pending.reject(error); }
    job.pageQueries?.clear();
    this.finishPointPick(job, undefined, error);
  }
  pickBrowserPoint(runId: string, pageId: string, requestId: string): Promise<BrowserPoint | null> {
    return this.serialize(async () => {
      scheduleIdentifier.parse(requestId);
      if (typeof runId !== 'string' || typeof pageId !== 'string' || !pageId.trim() || pageId.includes('{{')) throw new Error('请选择已打开的目标网页');
      const job = this.jobs.get(runId);
      if (!job?.child?.connected || !job.run.browserOpen) throw new Error('浏览器已关闭，请先打开网页');
      if (!terminal(job.run.status) || job.controls?.size || job.stopping) throw new Error('该浏览器正在执行任务或操作，请等待完成');
      if (job.workflow.settings.headless) throw new Error('无头浏览器无法取点，请使用有界面浏览器');
      if (job.pointPick) throw new Error('浏览器正在获取坐标');
      const result = new Promise<BrowserPoint | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          void this.cancelBrowserPoint(runId, requestId).catch(async () => {
            if (job.child) await killOwnedTree(job.child);
          }).finally(() => {
            if (job.pointPick?.id === requestId) this.finishPointPick(job, undefined, new Error('获取坐标超时'));
          });
        }, 130_000);
        job.pointPick = { id: requestId, resolve, reject, timer };
        try {
          job.child!.send({ type: 'pick-browser-point', requestId, pageId }, error => {
            if (error && job.pointPick?.id === requestId) this.finishPointPick(job, undefined, error);
          });
        } catch (error) { this.finishPointPick(job, undefined, error as Error); }
      });
      // Do not hold the submission queue while waiting for the user's click.
      void result.catch(() => undefined);
      return { result };
    }).then(({ result }) => result);
  }
  async cancelBrowserPoint(runId: string, requestId: string): Promise<void> {
    await this.startQueue;
    const job = this.jobs.get(runId);
    if (!job?.pointPick || job.pointPick.id !== requestId) return;
    await this.sendRequest(job, { type: 'cancel-browser-point', pickId: requestId });
  }
  private finishPointPick(job: Job, point?: BrowserPoint | null, error?: Error): void {
    const pending = job.pointPick;
    if (!pending) return;
    job.pointPick = undefined;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else if (point === null || (point && typeof point.pageId === 'string' && Number.isFinite(point.x) && point.x >= 0 && Number.isFinite(point.y) && point.y >= 0)) pending.resolve(point);
    else pending.reject(new Error('获取坐标返回了无效结果'));
  }
  listWorkflows() { return this.store.listWorkflows(); }
  saveWorkflow(workflow: WorkflowDefinition) { return this.serialize(() => this.store.saveWorkflow(workflow)); }
  deleteWorkflow(workflowId: string): Promise<void> {
    const id = scheduleIdentifier.parse(workflowId);
    return this.serialize(async () => {
      if ([...this.jobs.values()].some(job => job.run.workflowId === id && (!terminal(job.run.status) || job.child))) throw new Error('该流程仍有任务或浏览器正在运行，请先停止任务并关闭浏览器。');
      if (!(await this.listWorkflows()).some(workflow => workflow.workflowId === id)) throw new Error('流程不存在');
      for (const schedule of this.schedules.values()) if (schedule.workflowId === id) {
        await this.store.deleteSchedule(schedule.scheduleId); this.schedules.delete(schedule.scheduleId);
        for (const [runId, occurrence] of this.pendingOccurrences) if (occurrence.scheduleId === schedule.scheduleId) this.pendingOccurrences.delete(runId);
      }
      await this.store.deleteWorkflow(id);
    });
  }
  listSchedules(): WorkflowSchedule[] { return [...this.schedules.values()].map(schedule => structuredClone(schedule)); }
  saveSchedule(input: WorkflowSchedule): Promise<WorkflowSchedule> {
    const parsed = scheduleSchema.parse(input);
    return this.serialize(async () => {
      const workflow = (await this.listWorkflows()).find(workflow => workflow.workflowId === parsed.workflowId);
      if (!workflow) throw new Error('请先保存要定时运行的流程');
      const now = this.now();
      if (parsed.enabled && parsed.kind === 'once' && Date.parse(parsed.at!) <= now.getTime()) throw new Error('单次运行时间必须晚于当前时间');
      const previous = this.schedules.get(parsed.scheduleId);
      const sameWorkflow = previous?.workflowId === parsed.workflowId;
      const sameTrigger = sameWorkflow && previous?.kind === parsed.kind && (
        parsed.kind === 'once' ? previous.at === parsed.at : parsed.kind === 'interval' ? previous.intervalMinutes === parsed.intervalMinutes : previous.time === parsed.time && previous.day === parsed.day && JSON.stringify(previous.weekdays) === JSON.stringify(parsed.weekdays) && previous.startDate === parsed.startDate && previous.intervalDays === parsed.intervalDays
      );
      const saved: WorkflowSchedule = {
        scheduleId: parsed.scheduleId, workflowId: parsed.workflowId, name: parsed.name, enabled: parsed.enabled,
        kind: parsed.kind, at: parsed.kind === 'once' ? parsed.at : undefined,
        time: ['daily','weekly','monthly','intervalDays'].includes(parsed.kind) ? parsed.time : undefined, intervalMinutes: parsed.kind === 'interval' ? parsed.intervalMinutes : undefined,
        weekdays: parsed.kind === 'weekly' ? [...new Set(parsed.weekdays)].sort() : undefined, day: parsed.kind === 'monthly' ? parsed.day : undefined,
        startDate: parsed.kind === 'intervalDays' ? parsed.startDate : undefined, intervalDays: parsed.kind === 'intervalDays' ? parsed.intervalDays : undefined,
        revision: parsed.followLatest ? undefined : parsed.revision ?? (!previous || !sameWorkflow ? workflow.revision : previous.revision), followLatest: parsed.followLatest,
        lastRunAt: sameWorkflow ? previous?.lastRunAt : undefined, lastRunId: sameWorkflow ? previous?.lastRunId : undefined,
        lastError: sameTrigger ? previous?.lastError : undefined,
        nextRunAt: parsed.enabled ? (sameTrigger && previous.enabled && previous.nextRunAt ? previous.nextRunAt : nextScheduleTime({ ...parsed, nextRunAt: undefined }, now)) : undefined,
      };
      if (saved.revision) await this.store.getRevision(saved.workflowId, saved.revision);
      await this.store.saveSchedule(saved); this.schedules.set(saved.scheduleId, saved); return structuredClone(saved);
    });
  }
  deleteSchedule(scheduleId: string): Promise<void> {
    const id = scheduleIdentifier.parse(scheduleId);
    return this.serialize(async () => {
      if (!this.schedules.has(id)) throw new Error('定时计划不存在');
      await this.store.deleteSchedule(id); this.schedules.delete(id);
      for (const [runId, occurrence] of this.pendingOccurrences) if (occurrence.scheduleId === id) this.pendingOccurrences.delete(runId);
    });
  }
  checkSchedules(): Promise<void> {
    return this.serialize(async () => {
      const now = this.now();
      for (const schedule of this.schedules.values()) {
        for (const occurrence of [...this.pendingOccurrences.values()]) if (occurrence.scheduleId === schedule.scheduleId) await this.finishOccurrence(schedule, structuredClone(occurrence));
        if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now.getTime()) continue;
        const scheduledFor = latestScheduleTime(schedule, now);
        const claimed: WorkflowSchedule = { ...schedule, lastRunAt: now.toISOString(), lastRunId: undefined, lastError: undefined };
        let occurrence = await this.store.readOccurrence(schedule.scheduleId, scheduledFor);
        if (!occurrence) {
          const workflow = (await this.listWorkflows()).find(flow => flow.workflowId === schedule.workflowId);
          occurrence = { scheduleId: schedule.scheduleId, scheduledFor, runId: randomUUID(), outcome: 'claimed', workflowId: schedule.workflowId, revision: schedule.revision ?? workflow?.revision };
          await this.store.saveOccurrence(occurrence);
          this.pendingOccurrences.set(occurrence.runId, structuredClone(occurrence));
        }
        await this.finishOccurrence(claimed, occurrence);
        claimed.lastRunId = occurrence.outcome === 'started' ? occurrence.runId : undefined;
        claimed.lastError = occurrence.reason;
        if (claimed.kind === 'once') { claimed.enabled = false; claimed.nextRunAt = undefined; }
        else claimed.nextRunAt = nextScheduleTime(claimed, now);
        await this.store.saveSchedule(claimed); this.schedules.set(claimed.scheduleId, claimed);
      }
    });
  }
  private async finishOccurrence(schedule: WorkflowSchedule, occurrence: import('../../../packages/contracts/src/index.js').ScheduleOccurrence) {
    if (occurrence.outcome !== 'claimed') return;
    if (this.jobs.has(occurrence.runId)) occurrence.outcome = 'started';
    else if ([...this.jobs.values()].some(job => job.run.workflowId === schedule.workflowId && !terminal(job.run.status))) {
      occurrence.outcome = 'skipped'; occurrence.reason = '主动跳过：同一流程正在运行或等待人工，不进入补跑队列。';
    } else {
      try {
        const workflow = occurrence.revision ? await this.store.getRevision(occurrence.workflowId ?? schedule.workflowId, occurrence.revision) : (await this.listWorkflows()).find(flow => flow.workflowId === schedule.workflowId);
        if (!workflow) throw new Error('关联流程已不存在');
        await this.startWorkflow(workflow, { scheduleId: schedule.scheduleId, scheduledFor: occurrence.scheduledFor, runId: occurrence.runId });
        occurrence.outcome = 'started';
      } catch (error) {
        occurrence.outcome = 'skipped'; occurrence.reason = error instanceof Error ? error.message : String(error);
        if (schedule.revision) { schedule.enabled = false; schedule.nextRunAt = undefined; }
      }
    }
    schedule.lastRunAt = this.now().toISOString(); schedule.lastRunId = occurrence.outcome === 'started' ? occurrence.runId : undefined; schedule.lastError = occurrence.reason;
    await this.store.saveOccurrence(occurrence); this.pendingOccurrences.delete(occurrence.runId); await this.store.saveSchedule(schedule);
  }
  runWorkflow(input: WorkflowDefinition): Promise<RunSnapshot> {
    const workflow = normalizeWorkflowForStorage(input); validateActions(workflow);
    return this.serialize(() => this.startWorkflow(workflow));
  }
  runStep(input: WorkflowDefinition, stepId: string, browserRunId?: string, debug?: EngineOptions['debug']): Promise<RunSnapshot> {
    const workflow = workflowSchema.parse(input); validateActions(workflow);
    const path = findStepPath(workflow, scheduleIdentifier.parse(stepId));
    const selected = path?.at(-1);
    if (!selected) throw new Error('指令不存在，请重新选择');
    if (path?.some(step => step.disabled)) throw new Error('指令或所属容器已注释，请取消注释后再运行');
    if (browserRunId !== undefined && (typeof browserRunId !== 'string' || !browserRunId)) throw new Error('浏览器运行标识无效');
    const closeAllPages = selected.actionType === 'browser.closePage' && selected.params.closeMode === 'all';
    if (!browserRunId && !closeAllPages && selected.actionType.startsWith('browser.') && !['browser.start', 'browser.open', 'browser.popupGuard'].includes(selected.actionType)) {
      throw new Error('此指令需要已打开的浏览器，请先单独运行“打开网页”，再选择对应浏览器');
    }
    return this.serialize(async () => {
      if (!browserRunId) return this.startWorkflow(workflow, undefined, stepId);
      const job = this.jobs.get(browserRunId);
      if (!job || !job.child?.connected || !job.run.browserOpen) throw new Error('所选浏览器已关闭或不存在，请重新选择');
      if (job.run.workflowId !== workflow.workflowId) throw new Error('只能复用当前流程的浏览器');
      if (!terminal(job.run.status) || job.controls?.size || job.stopping || job.pointPick) throw new Error('该浏览器正在执行任务或操作，请等待完成或取消取点');
      if ([...this.tools.values()].some(tool => tool.runId === browserRunId)) throw new Error('请先结束浏览器工具操作');
      if ((workflow.settings.profileId ?? workflow.workflowId) !== (job.workflow.settings.profileId ?? job.workflow.workflowId)
        || workflow.settings.headless !== job.workflow.settings.headless) throw new Error('浏览器配置已改变，请关闭原浏览器后重新运行');
      const previousRun = job.run;
      const previousWorkflow = job.workflow;
      const queued: RunSnapshot = { ...job.run, workflowName: workflow.name, revision: workflow.revision, stepId, status: 'queued', attemptId: randomUUID(), startedAt: new Date().toISOString(), warnings: [], warningCount: 0, debug };
      delete queued.endedAt; delete queued.error; delete queued.currentStepId;
      job.run = queued; job.workflow = workflow;
      try {
        await this.store.createRun(workflow, queued);
        const dependencies=await workflowDependencies(this.store,workflow); await this.store.saveDependencies(queued,dependencies);
        if (!job.child?.connected || !job.run.browserOpen) throw new Error('所选浏览器已关闭，请重新选择');
        this.publish({ type: 'run', runId: browserRunId, at: new Date().toISOString(), status: 'queued', run: structuredClone(queued), data: { stepId } });
        await this.sendRequest(job, { type: 'run-step', workflow, stepId, attemptId: queued.attemptId, debug,workflowDependencies:dependencies });
      } catch (error) {
        job.workflow = previousWorkflow;
        job.run = { ...previousRun, browserOpen: Boolean(job.child?.connected && job.run.browserOpen) };
        await this.store.createRun(previousWorkflow, job.run);
        this.publish({ type: 'run', runId: browserRunId, at: new Date().toISOString(), status: job.run.status, run: structuredClone(job.run) });
        throw error;
      }
      return structuredClone(job.run);
    });
  }
  debugRun(input: WorkflowDefinition, breakpoints: string[], fromStepId?: string): Promise<RunSnapshot> {
    const workflow = normalizeWorkflowForStorage(input); validateActions(workflow);
    const debug = { breakpoints: breakpoints.map(id => scheduleIdentifier.parse(id)), fromStepId };
    if (fromStepId) {
      if (!workflow.steps.some(step => step.stepId === fromStepId)) return Promise.reject(new Error('调试起点必须是顶层步骤'));
      const existing = [...this.jobs.values()].find(job => job.run.workflowId === workflow.workflowId && terminal(job.run.status) && job.run.browserOpen);
      if (!existing) return Promise.reject(new Error('从指定步骤调试需要已保留的浏览器会话，请先单条打开网页并准备变量'));
      return this.runStep(workflow, fromStepId, existing.run.runId, debug);
    }
    return this.serialize(() => this.startWorkflow(workflow, undefined, undefined, { debug }));
  }
  async recoverRun(runId: string): Promise<RunSnapshot> {
    const id = scheduleIdentifier.parse(runId); const job = this.jobs.get(id);
    if (!job || !terminal(job.run.status)) throw new Error('请先结束原运行，再建立数据续跑');
    const workflow = await this.getRunWorkflow(id); if (!workflow) throw new Error('原流程快照不存在，不能续跑');
    const hasProgress = (steps: typeof workflow.steps): boolean => steps.some(step => ['control.forEach','control.forEachXlsx'].includes(step.actionType) && Boolean(step.params.progressKey) || hasProgress(step.children ?? []) || hasProgress(step.elseSteps ?? []));
    if (!hasProgress(workflow.steps) || !job.run.attemptId) throw new Error('该运行没有配置业务键和进度记录，不能自动跳到中间步骤');
    const dependencies = await this.store.readDependencies(job.run);
    return this.serialize(() => this.startWorkflow(workflow, undefined, undefined, { resumeFromRunId: id, resumeFromAttemptId: job.run.attemptId,workflowDependencies:dependencies }));
  }
  private async startWorkflow(workflow: WorkflowDefinition, schedule?: { scheduleId: string; scheduledFor: string; runId?: string }, stepId?: string, executionOptions?: Partial<EngineOptions>): Promise<RunSnapshot> {
    if (this.emergencyStopping) throw new Error('紧急停止正在处理，请稍后再启动任务');
    if (this.shuttingDown) throw new Error('运行器正在退出');
    executionOptions = { ...executionOptions,workflowDependencies:executionOptions?.workflowDependencies ?? await workflowDependencies(this.store,workflow) };
    if (!stepId) {
      if (!executionOptions.resumeFromRunId) {
        const saved = await this.store.getRevision(workflow.workflowId, workflow.revision).catch(() => undefined);
        if (!saved || !isDeepStrictEqual(saved, workflow)) throw new Error('请先保存当前流程，再运行该修订版本。');
      }
      await this.closeRetainedBrowsersFor(workflow);
    }
    const sameWorkflow = [...this.jobs.values()].find(j => j.run.workflowId === workflow.workflowId && (!terminal(j.run.status) || j.child));
    if (sameWorkflow?.run.browserOpen && terminal(sameWorkflow.run.status)) throw new Error('同一流程的浏览器仍保留，请在运行记录中关闭该浏览器后再运行。');
    if (sameWorkflow) throw new Error('同一流程已有未结束的任务，请先完成或停止。');
    const profileId = workflow.settings.profileId ?? workflow.workflowId;
    if ([...this.jobs.values()].some(j => j.child && terminal(j.run.status) && j.run.browserOpen && (j.workflow.settings.profileId ?? j.workflow.workflowId) === profileId)) throw new Error('浏览器配置仍被已结束的任务保留，请先关闭该浏览器。');
    const run: RunSnapshot = {
      runId: randomUUID(), workflowId: workflow.workflowId, workflowName: workflow.name, revision: workflow.revision,
      status: 'queued', startedAt: new Date().toISOString(), variables: structuredClone(workflow.variables), artifacts: [], browserOpen: false,
      ...schedule, stepId,
      attemptId: randomUUID(), warnings: [], warningCount: 0,
      debug: executionOptions?.debug, resumedFromRunId: executionOptions?.resumeFromRunId,
    };
    await this.store.createRun(workflow, run);
    await this.store.saveDependencies(run,executionOptions.workflowDependencies!);
    if (executionOptions?.resumeFromRunId && executionOptions.resumeFromAttemptId) {
      const source = join(this.options.dataDir, 'runs', scheduleIdentifier.parse(executionOptions.resumeFromRunId), 'attempts', scheduleIdentifier.parse(executionOptions.resumeFromAttemptId), 'progress');
      const target = join(this.options.dataDir, 'runs', run.runId, 'attempts', run.attemptId!, 'progress');
      await cp(source, target, { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    this.jobs.set(run.runId, { workflow: structuredClone(workflow), run, executionOptions: { demoUrl: this.demoUrl, ...executionOptions } }); this.pending.push(run.runId);
    this.publish({ type: 'run', runId: run.runId, at: new Date().toISOString(), status: 'queued', run: structuredClone(run), ...(stepId ? { data: { stepId } } : {}) });
    this.drain(); return structuredClone(run);
  }
  private async closeRetainedBrowsersFor(workflow: WorkflowDefinition): Promise<void> {
    const profileId = workflow.settings.profileId ?? workflow.workflowId;
    const retained = [...this.jobs.values()].filter(job => job.child && terminal(job.run.status) && job.run.browserOpen && (
      job.run.workflowId === workflow.workflowId || (job.workflow.settings.profileId ?? job.workflow.workflowId) === profileId
    ));
    if (retained.some(job => job.pointPick)) throw new Error('请先完成或取消取点，再运行流程');
    if (retained.some(job => [...this.tools.values()].some(tool => tool.runId === job.run.runId))) throw new Error('请先结束浏览器工具操作');
    for (const job of retained) await this.applyControlRun(job.run.runId, 'closeBrowser');
  }
  private publish(event: RunEvent) {
    event.eventId ??= randomUUID();
    event.attemptId ??= this.jobs.get(event.runId)?.run.attemptId;
    this.store.prepareEvent(event);
    this.store.recordEvent(event).catch(error => this.emit('storage-error', error));
    this.emit('event', structuredClone(event));
  }
  private drain() {
    if (this.shuttingDown) return;
    const limit = Math.max(1, this.options.maxConcurrent ?? 2);
    while ([...this.jobs.values()].filter(j => j.child).length < limit && this.pending.length) {
      const job = this.jobs.get(this.pending.shift()!)!;
      if (job.run.status !== 'queued') continue;
      this.launch(job);
    }
    const occupied = [...this.jobs.values()].filter(job => job.child).map(job => `${job.run.workflowName}${terminal(job.run.status) ? '（保留浏览器）' : ''}`);
    for (const id of this.pending) { const run = this.jobs.get(id)?.run; if (run?.status === 'queued') { const reason = `并发上限 ${limit}，占用者：${occupied.join('、') || '正在准备资源'}`; if (run.waitingReason !== reason) { run.waitingReason = reason; this.publish({ type: 'run', runId: id, at: new Date().toISOString(), run: structuredClone(run), status: 'queued' }); } } }
  }
  private launch(job: Job) {
    const root = this.options.rootDir ?? process.env.RPA_ROOT ?? process.cwd();
    const bundled = join(root, 'dist', 'runner', 'worker.cjs');
    const entry = this.options.workerPath ?? (typeof __filename !== 'undefined' && __filename.endsWith('.cjs') ? bundled : join(root, 'apps', 'runner', 'src', 'worker.ts'));
    const child = spawn(process.execPath, [...(entry.endsWith('.ts') ? ['--import', 'tsx'] : []), resolve(entry)], {
      cwd: root, detached: process.platform !== 'win32',
      env: { ...process.env, RPA_ROOT: root, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    job.child = child; job.controls = new Map(); job.pageQueries = new Map(); job.finished = new Promise(resolve => { job.exit = resolve; });
    child.stdout?.on('data', d => this.publish({ type: 'log', runId: job.run.runId, at: new Date().toISOString(), message: String(d).trim() }));
    child.stderr?.on('data', d => this.publish({ type: 'log', runId: job.run.runId, at: new Date().toISOString(), message: String(d).trim() }));
    child.on('message', (message: { type: string; event?: RunEvent; message?: string; requestId?: string; error?: string; pages?: BrowserPageInfo[]; point?: BrowserPoint | null; value?: unknown }) => {
      if (message.type === 'tool-result' && message.requestId) {
        const pending = this.tools.get(message.requestId); if (pending) { clearTimeout(pending.timer); this.tools.delete(message.requestId); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value); }
      }
      if (message.type === 'point-result' && message.requestId === job.pointPick?.id) {
        this.finishPointPick(job, message.point, message.error ? new Error(message.error) : undefined);
      }
      if (message.type === 'event' && message.event) {
        if (message.event.run) {
          job.run = mergeRunEvent(job.run,message.event)!;
          this.persistState(job);
        }
        this.publish(message.event);
      }
      if (message.type === 'control-result' && message.requestId) {
        const pending = job.controls?.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer); job.controls!.delete(message.requestId);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve();
        }
      }
      if (message.type === 'pages-result' && message.requestId) {
        const pending = job.pageQueries?.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timer); job.pageQueries!.delete(message.requestId);
          if (message.error) pending.reject(new Error(message.error));
          else if (Array.isArray(message.pages)) pending.resolve(message.pages);
          else pending.reject(new Error('浏览器网页查询返回无效结果'));
        }
      }
      if (message.type === 'control-error') this.publish({ type: 'log', runId: job.run.runId, at: new Date().toISOString(), message: message.message });
    });
    child.on('error', error => { job.run.error = error.message; });
    child.once('disconnect', () => { this.rejectPageQueries(job, new Error('任务进程已断开连接')); });
    child.once('close', (code, signal) => {
      for (const [id, tool] of this.tools) if (tool.runId === job.run.runId) { clearTimeout(tool.timer); this.tools.delete(id); tool.reject(new Error('浏览器工具进程已退出')); }
      clearTimeout(job.stopping); job.child = undefined;
      for (const pending of job.controls?.values() ?? []) { clearTimeout(pending.timer); pending.reject(new Error('任务进程已退出')); }
      job.controls?.clear();
      this.rejectPageQueries(job, new Error('任务进程已退出'));
      const browserWasOpen = job.run.browserOpen; job.run.browserOpen = false;
      if (!terminal(job.run.status)) {
        job.run.status = job.stopping ? 'stopped' : 'interrupted'; job.run.endedAt = new Date().toISOString();
        job.run.error ||= `任务进程意外退出（${code ?? signal}）`;
        this.store.saveRun(job.run).catch(error => this.emit('storage-error', error));
        this.publish({ type: 'run', runId: job.run.runId, at: new Date().toISOString(), run: structuredClone(job.run), status: job.run.status });
      } else if (browserWasOpen) {
        this.store.saveRun(job.run).catch(error => this.emit('storage-error', error));
        this.publish({ type: 'run', runId: job.run.runId, at: new Date().toISOString(), run: structuredClone(job.run), status: job.run.status, message: '浏览器已关闭' });
      }
      void this.store.flush().then(() => this.compactJob(job), error => this.emit('storage-error', error)).finally(() => job.exit?.());
      this.drain();
    });
    child.send({ type: 'start', workflow: job.workflow, stepId: job.run.stepId, options: { ...job.executionOptions, dataDir: this.options.dataDir, runId: job.run.runId, scheduleId: job.run.scheduleId, scheduledFor: job.run.scheduledFor, attemptId: job.run.attemptId } }, error => { if (error) job.run.error = error.message; });
  }
  private async sendRequest(job: Job, message: Record<string, unknown>): Promise<void> {
    if (!job.child?.connected) throw new Error('任务进程未连接');
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { job.controls?.delete(requestId); reject(new Error('任务操作确认超时')); }, 10_000);
      job.controls!.set(requestId, { resolve, reject, timer });
      const fail = (error: Error) => { clearTimeout(timer); job.controls?.delete(requestId); reject(error); };
      try { job.child!.send({ ...message, requestId }, error => { if (error) fail(error); }); }
      catch (error) { fail(error as Error); }
    });
  }
  controlRun(runId: string, command: RunCommand): Promise<void> {
    // A stop arriving while a single step is being persisted must target the
    // submitted execution, not close the previous idle session underneath it.
    return this.startQueue.then(() => this.applyControlRun(runId, command));
  }
  private async applyControlRun(runId: string, command: RunCommand) {
    const job = this.jobs.get(runId); if (!job) throw new Error('任务不存在');
    if (terminal(job.run.status)) {
      if (command === 'closeBrowser' && !job.run.browserOpen) { await job.finished; return; }
      if (!job.run.browserOpen || !['show', 'hide', 'closeBrowser'].includes(command)) throw new Error('任务已结束');
    } else if (command === 'closeBrowser') throw new Error('任务执行中，请先停止任务再关闭浏览器');
    if (job.run.status === 'queued' && !job.child) {
      if (command !== 'stop') throw new Error('任务正在排队，可停止或等待开始');
      job.run.status = 'stopped'; job.run.endedAt = new Date().toISOString(); await this.store.saveRun(job.run);
      this.publish({ type: 'run', runId, at: new Date().toISOString(), run: structuredClone(job.run), status: 'stopped' }); this.compactJob(job); return;
    }
    if (!job.child?.connected) throw new Error('任务进程未连接');
    if (command === 'stop' || command === 'closeBrowser') {
      job.stopping ??= setTimeout(() => { if (job.child) void killOwnedTree(job.child); }, 8_000);
    }
    await this.sendRequest(job, { type: 'control', command });
    if (command === 'closeBrowser') { await job.finished; await this.store.flush(); }
  }
  async waitForRun(runId: string): Promise<RunSnapshot> {
    const job = this.jobs.get(runId); if (!job) throw new Error('任务不存在');
    if (!terminal(job.run.status)) await new Promise<void>(resolve => {
      const listener = (event: RunEvent) => { if (event.runId === runId && event.run && terminal(event.run.status)) { this.off('event', listener); resolve(); } };
      this.on('event', listener);
    });
    if (!job.run.browserOpen) await job.finished;
    await this.store.flush().catch(error=>this.emit('storage-error',error)); return job.persistent?{...await this.store.readRunSnapshot(runId),...job.run,variables:await this.getRunVariables(runId)}:structuredClone(job.run);
  }
  async waitForBrowserClosed(runId: string): Promise<void> {
    const job = this.jobs.get(runId); if (!job) throw new Error('任务不存在');
    await job.finished; await this.store.flush();
  }
  async shutdown() {
    this.shuttingDown = true;
    for (const job of this.jobs.values()) this.rejectPageQueries(job, new Error('运行器正在退出'));
    clearInterval(this.scheduleTimer); this.scheduleTimer = undefined;
    await this.startQueue;
    await Promise.all([...this.jobs.values()].map(async job => {
      try {
        if (!terminal(job.run.status)) await this.controlRun(job.run.runId, 'stop');
        else if (job.child && job.run.browserOpen) await this.controlRun(job.run.runId, 'closeBrowser');
      } catch (error) { if (job.child) await killOwnedTree(job.child); }
    }));
    await Promise.all([...this.jobs.values()].map(j => j.finished)); await this.store.flush();
    for (const [id,timer] of this.saveTimers) { clearTimeout(timer); const job = this.jobs.get(id); if (job) await this.store.saveRun(job.run); } this.saveTimers.clear(); await this.store.flush();
  }
}
