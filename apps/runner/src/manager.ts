import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { FileStore, normalizeWorkflowForStorage } from '../../../packages/persistence/src/index.js';
import { validateActions } from '../../../packages/actions/src/index.js';
import { findStepPath, scheduleIdentifier, scheduleSchema, workflowSchema, type BrowserPageInfo, type RunCommand, type RunEvent, type RunSnapshot, type WorkflowDefinition, type WorkflowSchedule } from '../../../packages/contracts/src/index.js';
import { nextScheduleTime } from './schedule.js';

const terminal = (status: RunSnapshot['status']) => ['succeeded', 'failed', 'stopped', 'interrupted'].includes(status);
interface PendingControl { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface PendingPages { resolve: (pages: BrowserPageInfo[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface Job { workflow: WorkflowDefinition; run: RunSnapshot; child?: ChildProcess; stopping?: NodeJS.Timeout; finished?: Promise<void>; exit?: () => void; controls?: Map<string, PendingControl>; pageQueries?: Map<string, PendingPages> }
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
  readonly store: FileStore;
  private jobs = new Map<string, Job>();
  private pending: string[] = [];
  private shuttingDown = false;
  private startQueue: Promise<unknown> = Promise.resolve();
  private schedules = new Map<string, WorkflowSchedule>();
  private scheduleTimer?: NodeJS.Timeout;
  private checkingSchedules = false;
  constructor(private options: ManagerOptions) {
    super();
    const concurrency = options.maxConcurrent ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('并发数须为 1–16 的整数');
    this.store = new FileStore(options.dataDir);
  }
  async initialize() {
    await this.store.initialize();
    for (const run of await this.store.listRuns()) {
      const browserWasOpen = run.browserOpen;
      run.browserOpen = false;
      if (!terminal(run.status)) {
        run.status = 'interrupted'; run.endedAt = new Date().toISOString(); run.error = '运行器曾退出，原浏览器现场不可恢复。';
        await this.store.saveRun(run);
      } else if (browserWasOpen) await this.store.saveRun(run);
      this.jobs.set(run.runId, { run, workflow: undefined as unknown as WorkflowDefinition });
    }
    const workflows = await this.listWorkflows();
    const now = this.now();
    for (const schedule of await this.store.listSchedules()) {
      if (!workflows.some(workflow => workflow.workflowId === schedule.workflowId)) {
        schedule.enabled = false; schedule.nextRunAt = undefined; schedule.lastError = '关联流程已不存在，定时计划已停用。';
      } else if (schedule.enabled && (!schedule.nextRunAt || Date.parse(schedule.nextRunAt) <= now.getTime())) {
        if (schedule.kind === 'once' && Date.parse(schedule.at!) <= now.getTime()) {
          schedule.enabled = false; schedule.nextRunAt = undefined;
          schedule.lastError = '工作台未运行时错过执行时间，单次计划已停用，请重新选择时间。';
        } else {
          const missed = Boolean(schedule.nextRunAt);
          schedule.nextRunAt = nextScheduleTime(schedule, now);
          if (missed) schedule.lastError = '工作台未运行时错过的执行已跳过，将从下一次开始。';
        }
      }
      await this.store.saveSchedule(schedule);
      this.schedules.set(schedule.scheduleId, schedule);
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
  listRuns() { return [...this.jobs.values()].map(j => structuredClone(j.run)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
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
      }
      await this.store.deleteWorkflow(id);
    });
  }
  listSchedules(): WorkflowSchedule[] { return [...this.schedules.values()].map(schedule => structuredClone(schedule)); }
  saveSchedule(input: WorkflowSchedule): Promise<WorkflowSchedule> {
    const parsed = scheduleSchema.parse(input);
    return this.serialize(async () => {
      if (!(await this.listWorkflows()).some(workflow => workflow.workflowId === parsed.workflowId)) throw new Error('请先保存要定时运行的流程');
      const now = this.now();
      if (parsed.enabled && parsed.kind === 'once' && Date.parse(parsed.at!) <= now.getTime()) throw new Error('单次运行时间必须晚于当前时间');
      const previous = this.schedules.get(parsed.scheduleId);
      const sameWorkflow = previous?.workflowId === parsed.workflowId;
      const sameTrigger = sameWorkflow && previous?.kind === parsed.kind && (
        parsed.kind === 'once' ? previous.at === parsed.at : parsed.kind === 'daily' ? previous.time === parsed.time : previous.intervalMinutes === parsed.intervalMinutes
      );
      const saved: WorkflowSchedule = {
        scheduleId: parsed.scheduleId, workflowId: parsed.workflowId, name: parsed.name, enabled: parsed.enabled,
        kind: parsed.kind, at: parsed.kind === 'once' ? parsed.at : undefined,
        time: parsed.kind === 'daily' ? parsed.time : undefined, intervalMinutes: parsed.kind === 'interval' ? parsed.intervalMinutes : undefined,
        lastRunAt: sameWorkflow ? previous?.lastRunAt : undefined, lastRunId: sameWorkflow ? previous?.lastRunId : undefined,
        lastError: sameTrigger ? previous?.lastError : undefined,
        nextRunAt: parsed.enabled ? (sameTrigger && previous.enabled && previous.nextRunAt ? previous.nextRunAt : nextScheduleTime(parsed, now)) : undefined,
      };
      await this.store.saveSchedule(saved); this.schedules.set(saved.scheduleId, saved); return structuredClone(saved);
    });
  }
  deleteSchedule(scheduleId: string): Promise<void> {
    const id = scheduleIdentifier.parse(scheduleId);
    return this.serialize(async () => {
      if (!this.schedules.has(id)) throw new Error('定时计划不存在');
      await this.store.deleteSchedule(id); this.schedules.delete(id);
    });
  }
  checkSchedules(): Promise<void> {
    return this.serialize(async () => {
      const now = this.now();
      for (const schedule of this.schedules.values()) {
        if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now.getTime()) continue;
        const scheduledFor = schedule.nextRunAt;
        const claimed: WorkflowSchedule = { ...schedule, lastRunAt: now.toISOString(), lastRunId: undefined, lastError: undefined };
        if (claimed.kind === 'once') { claimed.enabled = false; claimed.nextRunAt = undefined; }
        else claimed.nextRunAt = nextScheduleTime(claimed, now);
        // Persist the occurrence before creating a run so restarting cannot execute it twice.
        await this.store.saveSchedule(claimed); this.schedules.set(claimed.scheduleId, claimed);
        try {
          const workflow = (await this.listWorkflows()).find(item => item.workflowId === claimed.workflowId);
          if (!workflow) throw new Error('关联流程已不存在');
          const run = await this.startWorkflow(workflow, { scheduleId: claimed.scheduleId, scheduledFor });
          claimed.lastRunId = run.runId;
        } catch (error) { claimed.lastError = error instanceof Error ? error.message : String(error); }
        await this.store.saveSchedule(claimed);
      }
    });
  }
  runWorkflow(input: WorkflowDefinition): Promise<RunSnapshot> {
    const workflow = normalizeWorkflowForStorage(input); validateActions(workflow);
    return this.serialize(() => this.startWorkflow(workflow));
  }
  runStep(input: WorkflowDefinition, stepId: string, browserRunId?: string): Promise<RunSnapshot> {
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
      if (!terminal(job.run.status) || job.controls?.size || job.stopping) throw new Error('该浏览器正在执行任务或操作，请等待完成');
      if ((workflow.settings.profileId ?? workflow.workflowId) !== (job.workflow.settings.profileId ?? job.workflow.workflowId)
        || workflow.settings.headless !== job.workflow.settings.headless) throw new Error('浏览器配置已改变，请关闭原浏览器后重新运行');
      const previousRun = job.run;
      const previousWorkflow = job.workflow;
      const queued: RunSnapshot = { ...job.run, workflowName: workflow.name, revision: workflow.revision, stepId, status: 'queued' };
      delete queued.endedAt; delete queued.error; delete queued.currentStepId;
      job.run = queued; job.workflow = workflow;
      try {
        await this.store.createRun(workflow, queued);
        if (!job.child?.connected || !job.run.browserOpen) throw new Error('所选浏览器已关闭，请重新选择');
        this.publish({ type: 'run', runId: browserRunId, at: new Date().toISOString(), status: 'queued', run: structuredClone(queued), data: { stepId, workflow } });
        await this.sendRequest(job, { type: 'run-step', workflow, stepId });
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
  private async startWorkflow(workflow: WorkflowDefinition, schedule?: { scheduleId: string; scheduledFor: string }, stepId?: string): Promise<RunSnapshot> {
    if (this.shuttingDown) throw new Error('运行器正在退出');
    if (!stepId) {
      const saved = (await this.listWorkflows()).find(w => w.workflowId === workflow.workflowId);
      if (!saved || !isDeepStrictEqual(saved, workflow)) throw new Error('请先保存当前流程，再运行该修订版本。');
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
    };
    await this.store.createRun(workflow, run);
    this.jobs.set(run.runId, { workflow: structuredClone(workflow), run }); this.pending.push(run.runId);
    this.publish({ type: 'run', runId: run.runId, at: new Date().toISOString(), status: 'queued', run: structuredClone(run), ...(stepId ? { data: { stepId, workflow } } : {}) });
    this.drain(); return structuredClone(run);
  }
  private async closeRetainedBrowsersFor(workflow: WorkflowDefinition): Promise<void> {
    const profileId = workflow.settings.profileId ?? workflow.workflowId;
    const retained = [...this.jobs.values()].filter(job => job.child && terminal(job.run.status) && job.run.browserOpen && (
      job.run.workflowId === workflow.workflowId || (job.workflow.settings.profileId ?? job.workflow.workflowId) === profileId
    ));
    for (const job of retained) await this.applyControlRun(job.run.runId, 'closeBrowser');
  }
  private publish(event: RunEvent) {
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
    child.on('message', (message: { type: string; event?: RunEvent; message?: string; requestId?: string; error?: string; pages?: BrowserPageInfo[] }) => {
      if (message.type === 'event' && message.event) {
        if (message.event.run) {
          job.run = message.event.run;
          this.store.saveRun(job.run).catch(error => this.emit('storage-error', error));
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
      job.exit?.(); this.drain();
    });
    child.send({ type: 'start', workflow: job.workflow, stepId: job.run.stepId, options: { dataDir: this.options.dataDir, runId: job.run.runId, scheduleId: job.run.scheduleId, scheduledFor: job.run.scheduledFor } }, error => { if (error) job.run.error = error.message; });
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
      this.publish({ type: 'run', runId, at: new Date().toISOString(), run: structuredClone(job.run), status: 'stopped' }); return;
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
    await this.store.flush(); return structuredClone(job.run);
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
  }
}
