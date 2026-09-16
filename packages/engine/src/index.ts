import { isDeepStrictEqual } from 'node:util';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSession, type BrowserSessionOptions } from '../../browser/src/index.js';
import { runScript } from '../../scripts/src/index.js';
import { actionDefinitions, getAction, validateActionParams, validateActions } from '../../actions/src/index.js';
import { workflowSchema, type Artifact, type ElementRef, type RunCommand, type RunEvent, type RunSnapshot, type StepDefinition, type WorkflowDefinition } from '../../contracts/src/index.js';

export interface EngineOptions { dataDir: string; runId: string; onEvent?: (event: RunEvent) => void; scheduleId?: string; scheduledFor?: string }
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const systemVariables = new Set(['runId', 'scheduledFor']);
function validateName(name: string) {
  if (!name || reserved.has(name) || systemVariables.has(name)) throw new Error(`不可写入变量：${name}`);
}
function jsonClone(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('跨步骤结果必须是 JSON 值');
  return JSON.parse(serialized);
}
function readVariable(variables: Record<string, unknown>, path: string): unknown {
  if (!reserved.has(path) && Object.hasOwn(variables, path)) return variables[path];
  let value: unknown = variables;
  for (const key of path.split('.')) {
    if (reserved.has(key) || value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`找不到变量：${path}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const entire = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (entire) return jsonClone(readVariable(variables, entire[1].trim()));
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
      const result = readVariable(variables, key.trim());
      return typeof result === 'object' ? JSON.stringify(result) : String(result);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveValue(v, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, variables)]));
  return value;
}

export class WorkflowEngine {
  readonly workflow: WorkflowDefinition;
  private snapshot: RunSnapshot;
  private browser?: BrowserSession;
  private stopped = false;
  private pauseRequested = false;
  private resumeWaiter?: () => void;
  private stepAbort?: AbortController;
  private activeBrowserCalls = 0;
  private rpcQueue: Promise<unknown> = Promise.resolve();
  private consumed = false;
  private executionFinished = false;
  private deadlines: { expiresAt: number; stepName: string }[] = [];
  private scopedElements: Record<string, ElementRef>;
  private scopedSettings: NonNullable<StepDefinition['settings']>;
  constructor(workflow: WorkflowDefinition, private options: EngineOptions) {
    this.workflow = workflowSchema.parse(workflow);
    validateActions(this.workflow);
    this.scopedElements = this.workflow.elements;
    this.scopedSettings = this.workflow.settings;
    this.snapshot = {
      runId: options.runId, workflowId: workflow.workflowId, workflowName: workflow.name, revision: workflow.revision,
      status: 'queued', startedAt: new Date().toISOString(), artifacts: [], browserOpen: false,
      scheduleId: options.scheduleId, scheduledFor: options.scheduledFor,
      variables: { ...structuredClone(workflow.variables), runId: options.runId, scheduledFor: options.scheduledFor ?? new Date().toISOString() },
    };
  }
  getSnapshot(): RunSnapshot { return structuredClone(this.snapshot); }
  private emit(event: Omit<RunEvent, 'runId' | 'at'>) {
    this.options.onEvent?.({ ...event, runId: this.snapshot.runId, at: new Date().toISOString() });
  }
  private state(status: RunSnapshot['status'], error?: string) {
    this.snapshot.status = status;
    if (error !== undefined) this.snapshot.error = error;
    if (['succeeded', 'failed', 'stopped'].includes(status)) this.snapshot.endedAt = new Date().toISOString();
    this.emit({ type: 'run', run: this.getSnapshot(), status });
  }
  async control(command: RunCommand): Promise<void> {
    if (command === 'closeBrowser') {
      if (!this.executionFinished) throw new Error('任务执行中，请先停止任务再关闭浏览器');
      await this.browser?.close();
    } else if (command === 'stop') {
      this.stopped = true; this.pauseRequested = false;
      this.stepAbort?.abort(new Error('用户停止运行'));
      this.resumeWaiter?.();
      await this.browser?.close();
    } else if (command === 'pause') {
      this.pauseRequested = true;
      this.emit({ type: 'log', message: '已请求暂停，将在当前步骤完成后保留现场。' });
    } else if (command === 'resume') {
      this.pauseRequested = false; this.resumeWaiter?.();
    } else {
      if (!this.browser?.isOpen()) throw new Error('当前任务没有打开的浏览器');
      await this.browser.call(`browser.${command}`, {});
    }
  }
  private checkStop() { if (this.stopped) throw new Error('用户停止运行'); }
  private remainingTimeout(configured: number) {
    const limit = Math.min(configured, ...this.deadlines.map(d => d.expiresAt - Date.now()));
    if (limit <= 0) throw new Error(`容器步骤超时：${this.deadlines.find(d => d.expiresAt <= Date.now())?.stepName ?? '流程'}`);
    return limit;
  }
  private async withinDeadline<T>(step: StepDefinition, run: () => Promise<T>): Promise<T> {
    const deadline = { expiresAt: Date.now() + (step.timeoutMs ?? 30_000), stepName: step.name };
    this.deadlines.push(deadline);
    try { const result = await run(); this.remainingTimeout(30_000); return result; }
    finally { this.deadlines.splice(this.deadlines.indexOf(deadline), 1); }
  }
  private async withinStepScope<T>(step: StepDefinition, run: () => Promise<T>): Promise<T> {
    const locals = Object.entries(structuredClone(step.variables ?? {}));
    for (const [name] of locals) validateName(name);
    const previous = locals.map(([name]) => ({ name, had: Object.hasOwn(this.snapshot.variables, name), value: this.snapshot.variables[name] }));
    const parentElements = this.scopedElements;
    const parentSettings = this.scopedSettings;
    for (const [name, value] of locals) this.snapshot.variables[name] = value;
    this.scopedElements = { ...parentElements, ...step.elements };
    this.scopedSettings = { ...parentSettings, ...Object.fromEntries(Object.entries(step.settings ?? {}).filter(([, value]) => value !== undefined)) };
    try { return await run(); }
    finally {
      for (const { name, had, value } of previous) {
        if (had) this.snapshot.variables[name] = value;
        else delete this.snapshot.variables[name];
      }
      this.scopedElements = parentElements;
      this.scopedSettings = parentSettings;
    }
  }
  private async waitForResume(manual = false) {
    if (!this.pauseRequested && !manual) return;
    this.checkStop();
    const pending = new Promise<void>(resolve => { this.resumeWaiter = resolve; });
    const pausedAt = Date.now();
    this.state(manual ? 'waiting_manual' : 'paused');
    await pending;
    for (const deadline of this.deadlines) deadline.expiresAt += Date.now() - pausedAt;
    this.resumeWaiter = undefined; this.checkStop();
    delete this.snapshot.error; this.state('running');
  }
  private async ensureBrowser(startParams: Record<string, unknown> = {}) {
    let browser = this.browser;
    if (!browser) {
      browser = new BrowserSession({
        profileDir: join(this.options.dataDir, 'profiles', this.workflow.settings.profileId ?? this.workflow.workflowId),
        downloadDir: this.scopedSettings.downloadDir ?? this.workflow.settings.downloadDir, headless: this.workflow.settings.headless, runId: this.snapshot.runId,
        browserChannel: startParams.browserChannel as BrowserSessionOptions['browserChannel'],
        debugPort: startParams.debugPort as number | undefined,
      });
      this.browser = browser;
      const session = browser;
      browser.onClosed(() => {
        if (this.browser !== session) return;
        this.browser = undefined;
        this.snapshot.browserOpen = false;
        if (this.executionFinished) this.emit({ type: 'run', run: this.getSnapshot(), status: this.snapshot.status, message: '浏览器已关闭' });
      });
    }
    await browser.start();
    this.snapshot.browserOpen = browser.isOpen();
    const info = browser.getInfo();
    if ((startParams.browserChannel && startParams.browserChannel !== 'auto' && startParams.browserChannel !== info.browserChannel)
      || (startParams.debugPort && startParams.debugPort !== info.debugPort)) {
      throw new Error('当前流程已启动浏览器，不能更改浏览器类型或调试端口；请在首次浏览器指令中配置。');
    }
    return browser;
  }
  private setVariable(name: string, value: unknown) {
    validateName(name); this.snapshot.variables[name] = jsonClone(value);
    return this.snapshot.variables[name];
  }
  private async callBrowser(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    this.activeBrowserCalls++;
    const operation = (async () => {
      const browser = await this.ensureBrowser(method === 'browser.start' ? params : {});
      this.checkStop(); signal?.throwIfAborted();
      if (expired) throw new Error(`浏览器动作超时（${timeoutMs} ms）`);
      return method === 'browser.start' ? browser.getInfo() : browser.call(method, params);
    })();
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error(`浏览器动作超时（${timeoutMs} ms）`)); }, timeoutMs);
        abort = () => reject(signal?.reason ?? new Error('浏览器动作已取消'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } catch (error) {
      if (expired || signal?.aborted) {
        // End the real browser operation before a later step may start.
        if (signal?.aborted || !actionDefinitions.find(action => action.type === method)?.safeToRetry) await this.browser?.close();
        await operation.catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
      this.activeBrowserCalls--;
    }
  }
  private async dispatch(method: string, rawParams: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    this.checkStop(); signal?.throwIfAborted();
    if (method === 'variables.get') {
      if (typeof rawParams.name !== 'string' || !rawParams.name) throw new Error('变量名称必须是非空文本');
      return jsonClone(readVariable(this.snapshot.variables, rawParams.name));
    }
    if (method === 'variables.set') {
      const input = validateActionParams(method, rawParams);
      return this.setVariable(String(input.name), input.value);
    }
    if (!method.startsWith('browser.')) throw new Error(`不支持的 RPC 方法：${method}`);
    const validated = actionDefinitions.some(action => action.type === method) ? validateActionParams(method, rawParams) : rawParams;
    this.checkStop(); signal?.throwIfAborted();
    const params: Record<string, unknown> = { ...validated, timeoutMs };
    if (typeof params.selector === 'string' && params.selector.startsWith('@')) {
      const key = params.selector.slice(1); const element = this.scopedElements[key];
      if (!element) throw new Error(`元素库不存在：${key}`);
      params.element = resolveValue(element, this.snapshot.variables); delete params.selector;
    } else if (params.framePath && typeof params.selector === 'string') {
      params.element = { selector: params.selector, framePath: params.framePath, pageRef: params.pageId };
      delete params.selector; delete params.framePath;
    }
    if (method === 'browser.download') {
      params.directory ||= this.scopedSettings.downloadDir ?? this.workflow.settings.downloadDir;
      if (!params.filename) delete params.filename;
    }
    {
      const value = await this.callBrowser(method, params, timeoutMs, signal);
      this.checkStop(); signal?.throwIfAborted();
      if (method === 'browser.download') {
        const artifact = { ...(value as Artifact), stepId: this.snapshot.currentStepId };
        this.snapshot.artifacts.push(artifact);
        this.emit({ type: 'artifact', stepId: this.snapshot.currentStepId, data: artifact });
      }
      return value;
    }
  }
  private async execute(step: StepDefinition, params: Record<string, unknown>): Promise<unknown> {
    const timeout = this.remainingTimeout(step.timeoutMs ?? 30_000);
    const signal = this.stepAbort!.signal;
    if (step.actionType.startsWith('browser.')) return this.dispatch(step.actionType, params, timeout, signal);
    if (step.actionType === 'variables.set') return this.setVariable(String(params.name), params.value);
    if (step.actionType === 'core.assert') {
      if (!isDeepStrictEqual(params.actual, params.expected)) throw new Error(`结果校验失败：期望 ${JSON.stringify(params.expected)}，实际 ${JSON.stringify(params.actual)}`);
      return { ok: true };
    }
    if (step.actionType === 'script.run') {
      const deadline = Date.now() + timeout;
      try {
        const result = await runScript({
          language: params.language as 'python' | 'javascript' | 'typescript', code: String(params.code),
          variables: this.snapshot.variables, timeoutMs: timeout, signal,
          pythonExecutable: this.scopedSettings.pythonExecutable,
          onLog: message => this.emit({ type: 'log', stepId: step.stepId, message }),
          dispatch: (method, input) => {
            const operation = this.rpcQueue.then(() => {
              signal.throwIfAborted();
              if (Date.now() >= deadline) throw new Error('脚本 RPC 已超时');
              return this.dispatch(method, input, Math.max(100, deadline - Date.now()), signal);
            });
            this.rpcQueue = operation.catch(() => {});
            return operation;
          },
        });
        await this.rpcQueue; return result ?? null;
      } catch (error) {
        this.stepAbort?.abort(error);
        // A timed-out script must not leave a browser operation mutating a later step.
        if (this.activeBrowserCalls) { await this.browser?.close(); this.browser = undefined; }
        await this.rpcQueue; throw error;
      }
    }
    if (step.actionType === 'control.if') {
      const matches = params.operator === 'truthy' ? Boolean(params.left) : params.operator === 'equals' ? isDeepStrictEqual(params.left, params.right) : !isDeepStrictEqual(params.left, params.right);
      await this.withinDeadline(step, () => this.executeSteps(matches ? step.children ?? [] : step.elseSteps ?? []));
      return { matched: matches };
    }
    if (step.actionType === 'control.forEach') {
      const name = String(params.itemVariable); validateName(name);
      const had = Object.hasOwn(this.snapshot.variables, name); const previous = this.snapshot.variables[name];
      let count = 0;
      try {
        await this.withinDeadline(step, async () => {
          for (const item of params.items as unknown[]) {
            await yieldLoop(); this.checkStop(); this.remainingTimeout(timeout);
            this.setVariable(name, item);
            await this.executeSteps(step.children ?? []); count++;
          }
        });
      } finally {
        if (had) this.snapshot.variables[name] = previous; else delete this.snapshot.variables[name];
      }
      return { count };
    }
    throw new Error(`未实现动作：${step.actionType}`);
  }
  private async executeSteps(steps: StepDefinition[]) {
    for (const step of steps) {
      await yieldLoop();
      this.checkStop(); await this.waitForResume();
      this.remainingTimeout(30_000);
      let completed = false;
      while (!completed) {
        const attempts = step.retry?.maxAttempts ?? 1;
        let error: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          this.checkStop();
          this.snapshot.currentStepId = step.stepId;
          const parentAbort = this.stepAbort;
          const attemptAbort = new AbortController();
          this.stepAbort = attemptAbort;
          const started = Date.now();
          try {
            const result = await this.withinStepScope(step, async () => {
              this.emit({ type: 'step', stepId: step.stepId, status: 'running', message: step.name, data: { attempt } });
              // Script source is literal code; it uses the SDK for variable access.
              const raw = step.actionType === 'script.run' ? { ...step.params } : resolveValue(step.params, this.snapshot.variables) as Record<string, unknown>;
              const params = validateActionParams(step.actionType, raw);
              return this.execute(step, params);
            });
            this.checkStop();
            // Publish only after restoring local declarations, including same-name outputs.
            if (step.output) this.setVariable(step.output, result ?? null);
            this.snapshot.currentStepId = step.stepId;
            this.emit({ type: 'step', stepId: step.stepId, status: 'succeeded', message: step.name, data: { durationMs: Date.now() - started, result } });
            this.state('running'); completed = true; break;
          } catch (caught) {
            error = caught; this.checkStop();
            if (attempt < attempts) {
              this.emit({ type: 'log', stepId: step.stepId, message: `步骤失败，准备第 ${attempt + 1} 次尝试：${String(caught)}` });
              await new Promise<void>(resolve => {
                const signal = attemptAbort.signal;
                const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
                const timer = setTimeout(done, step.retry?.delayMs ?? 500); signal.addEventListener('abort', done, { once: true });
                if (signal.aborted) done();
              });
            }
          } finally {
            this.stepAbort = parentAbort;
          }
        }
        if (!completed) {
          const message = error instanceof Error ? error.message : String(error);
          this.snapshot.error = message;
          this.emit({ type: 'step', stepId: step.stepId, status: 'failed', message });
          const screenshotPath = join(this.options.dataDir, 'runs', this.snapshot.runId, `${step.stepId}.png`);
          if (this.browser) {
            await mkdir(join(this.options.dataDir, 'runs', this.snapshot.runId), { recursive: true });
            try {
              const path = await this.browser.screenshot(screenshotPath);
              if (path) this.emit({ type: 'log', stepId: step.stepId, message: '已保存失败截图', data: { path } });
            } catch { /* Capture failure must not replace the action error. */ }
          }
          if (step.onError === 'pause' && getAction(step.actionType).metadata.safeToRetry) await this.waitForResume(true);
          else throw new Error(`步骤“${step.name}”失败：${message}`);
        }
      }
    }
  }
  async run(): Promise<RunSnapshot> {
    if (this.consumed) throw new Error('每个执行器只能运行一次');
    this.consumed = true;
    this.state('running');
    let finalStatus: RunSnapshot['status'] = 'succeeded'; let finalError: string | undefined;
    try { await this.executeSteps(this.workflow.steps); this.checkStop(); }
    catch (error) { finalStatus = this.stopped ? 'stopped' : 'failed'; finalError = error instanceof Error ? error.message : String(error); }
    try { if (this.stopped || this.workflow.settings.keepBrowserOpen === false) await this.browser?.close(); }
    catch (error) { finalStatus = this.stopped ? 'stopped' : 'failed'; finalError ??= `浏览器清理失败：${String(error)}`; }
    this.snapshot.browserOpen = this.browser?.isOpen() ?? false;
    this.executionFinished = true;
    this.state(finalStatus, finalError);
    return this.getSnapshot();
  }
}
