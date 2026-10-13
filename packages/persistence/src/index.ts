import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { scheduleIdentifier, scheduleSchema, workflowSchema, type RunEvent, type RunSnapshot, type WorkflowDefinition, type WorkflowSchedule } from '../../contracts/src/index.js';
import { validateActions } from '../../actions/src/index.js';

export function normalizeWorkflowForStorage(input: WorkflowDefinition): WorkflowDefinition {
  // IPC 会保留可选字段的 undefined，JSON 文件则会省略；先校验再统一为落盘形态。
  const workflow = workflowSchema.parse(input);
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}

export async function writeFileAtomic(path: string, value: string | Uint8Array) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 5) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function writeJsonAtomic(path: string, value: unknown) {
  await writeFileAtomic(path, JSON.stringify(value, null, 2));
}
export class FileStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  async initialize() {
    await mkdir(join(this.directory, 'workflows'), { recursive: true });
    await mkdir(join(this.directory, 'runs'), { recursive: true });
    await mkdir(join(this.directory, 'schedules'), { recursive: true });
  }
  async listWorkflows(): Promise<WorkflowDefinition[]> {
    const files = (await readdir(join(this.directory, 'workflows'))).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(async f => workflowSchema.parse(JSON.parse(await readFile(join(this.directory, 'workflows', f), 'utf8')))));
  }
  saveWorkflow(input: WorkflowDefinition): Promise<WorkflowDefinition> {
    const workflow = normalizeWorkflowForStorage(input); validateActions(workflow);
    const operation = this.queue.then(async () => {
      const path = join(this.directory, 'workflows', `${workflow.workflowId}.json`);
      let revision = 0;
      try { revision = workflowSchema.parse(JSON.parse(await readFile(path, 'utf8'))).revision; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (workflow.revision !== revision) throw new Error(`流程版本已改变（当前 ${revision}），请重新加载后保存。`);
      const saved = { ...workflow, revision: revision + 1 };
      await writeJsonAtomic(path, saved); return saved;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  deleteWorkflow(workflowId: string): Promise<void> {
    const id = scheduleIdentifier.parse(workflowId);
    const operation = this.queue.then(() => unlink(join(this.directory, 'workflows', `${id}.json`)));
    this.queue = operation.catch(() => {}); return operation;
  }
  async listSchedules(): Promise<WorkflowSchedule[]> {
    const files = (await readdir(join(this.directory, 'schedules'))).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(async file => scheduleSchema.parse(JSON.parse(await readFile(join(this.directory, 'schedules', file), 'utf8')))));
  }
  saveSchedule(input: WorkflowSchedule): Promise<void> {
    const schedule = scheduleSchema.parse(input);
    const operation = this.queue.then(() => writeJsonAtomic(join(this.directory, 'schedules', `${schedule.scheduleId}.json`), schedule));
    this.queue = operation.catch(() => {}); return operation;
  }
  deleteSchedule(scheduleId: string): Promise<void> {
    const id = scheduleIdentifier.parse(scheduleId);
    const operation = this.queue.then(() => unlink(join(this.directory, 'schedules', `${id}.json`)));
    this.queue = operation.catch(() => {}); return operation;
  }
  async createRun(workflow: WorkflowDefinition, run: RunSnapshot) {
    const path = join(this.directory, 'runs', run.runId); await mkdir(path, { recursive: true });
    await writeJsonAtomic(join(path, 'workflow.json'), workflow);
    await this.saveRun(run);
  }
  async readRunWorkflow(runId: string): Promise<WorkflowDefinition | null> {
    const id = scheduleIdentifier.parse(runId);
    try {
      return workflowSchema.parse(JSON.parse(await readFile(join(this.directory, 'runs', id, 'workflow.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  saveRun(run: RunSnapshot): Promise<void> {
    const snapshot = structuredClone(run);
    const operation = this.queue.then(() => writeJsonAtomic(join(this.directory, 'runs', snapshot.runId, 'run.json'), snapshot));
    this.queue = operation.catch(() => {}); return operation;
  }
  async listRuns(): Promise<RunSnapshot[]> {
    const dirs = await readdir(join(this.directory, 'runs'), { withFileTypes: true });
    const runs: RunSnapshot[] = [];
    for (const dir of dirs.filter(d => d.isDirectory())) {
      try { runs.push(JSON.parse(await readFile(join(this.directory, 'runs', dir.name, 'run.json'), 'utf8')) as RunSnapshot); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return runs;
  }
  recordEvent(event: RunEvent): Promise<void> {
    const serialized = JSON.stringify(event) + '\n';
    const operation = this.queue.then(() => writeFile(join(this.directory, 'runs', event.runId, 'events.jsonl'), serialized, { flag: 'a' }));
    this.queue = operation.catch(() => {}); return operation;
  }
  async flush() { await this.queue; }
}
