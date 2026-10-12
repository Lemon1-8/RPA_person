import { isDeepStrictEqual } from 'node:util';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import xlsx from 'xlsx';
import { readXlsxArrayRows, readXlsxColumnValues, readXlsxRows } from './xlsx-file.js';
import { progressPath, readProgress, saveProgress,forgetProgress, type BusinessProgress } from './progress.js';
import { runDesktopInput } from './desktop-input.js';
import { WindowsSession } from '../../windows/src/index.js';
import type { DesktopElementRef } from '../../contracts/src/index.js';
import { BrowserSession, type BrowserSessionOptions } from '../../browser/src/index.js';
import { runScript } from '../../scripts/src/index.js';
import { actionDefinitions, getAction, validateActionParams, validateActions } from '../../actions/src/index.js';
import { findStepPath, workflowSchema, type Artifact, type BrowserPageInfo, type BrowserPoint, type ElementRef, type RunCommand, type RunEvent, type RunSnapshot, type StepDefinition, type WorkflowDefinition } from '../../contracts/src/index.js';

const { utils: xlsxUtils, write: writeWorkbook } = xlsx;
const browserTimeoutErrorGraceMs = 1_000;

export interface EngineOptions { dataDir: string; runId: string; onEvent?: (event: RunEvent) => void; scheduleId?: string; scheduledFor?: string; attemptId?: string; debug?: { breakpoints: string[]; fromStepId?: string }; resumeFromRunId?: string; resumeFromAttemptId?: string; demoUrl?: string; workflowDependencies?:Record<string,WorkflowDefinition> }
interface ExecutionDeadline { expiresAt: number; stepName: string }
class ContainerTimeoutError extends Error {
  constructor(readonly deadline: ExecutionDeadline) { super(`容器步骤超时：${deadline.stepName}`); }
}
class StepExecutionError extends Error {
  readonly failure: { message: string; stepId: string; stepName: string; actionType: string };
  readonly deadline?: ExecutionDeadline;
  constructor(step: StepDefinition, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`步骤“${step.name}”失败：${message}`, { cause });
    this.failure = cause instanceof StepExecutionError ? cause.failure : { message, stepId: step.stepId, stepName: step.name, actionType: step.actionType };
    this.deadline = cause instanceof StepExecutionError || cause instanceof ContainerTimeoutError ? cause.deadline : undefined;
  }
}
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
function validateName(name: string) {
  if (!name || reserved.has(name)) throw new Error(`不可写入变量：${name}`);
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
function readIndexedVariable(variables: Record<string, unknown>, path: string, indexText: string): unknown {
  const value = readVariable(variables, path);
  const index = Number(indexText);
  if (!Array.isArray(value)) throw new Error(`变量不是列表，无法按下标读取：${path}`);
  if (!Number.isSafeInteger(index) || !Object.hasOwn(value, index)) throw new Error(`列表下标超出范围：${path}[${indexText}]`);
  return value[index];
}
export function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const indexedEntire = value.match(/^\{\{\s*([^{}]+?)\s*\}\}\[(\d+)\]$/);
    if (indexedEntire) return jsonClone(readIndexedVariable(variables, indexedEntire[1].trim(), indexedEntire[2]));
    const entire = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (entire) return jsonClone(readVariable(variables, entire[1].trim()));
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}\[(\d+)\]|\{\{\s*([^{}]+?)\s*\}\}/g, (_, indexedPath: string | undefined, indexText: string | undefined, path: string | undefined) => {
      const result = indexedPath && indexText !== undefined
        ? readIndexedVariable(variables, indexedPath.trim(), indexText)
        : readVariable(variables, path!.trim());
      return typeof result === 'object' ? JSON.stringify(result) : String(result);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveValue(v, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, variables)]));
  return value;
}

export class WorkflowEngine {
  workflow: WorkflowDefinition;
  private snapshot: RunSnapshot;
  private browser?: BrowserSession;
  private windows?: WindowsSession;
  private stopped = false;
  private pauseRequested = false;
  private resumeWaiter?: () => void;
  private stepAbort?: AbortController;
  private activeBrowserCalls = 0;
  private rpcQueue: Promise<unknown> = Promise.resolve();
  private consumed = false;
  private executionFinished = false;
  private pointPick?: { id: string; abort: AbortController; done: Promise<BrowserPoint | null> };
  private reuseBrowserOnly = false;
  private deadlines: ExecutionDeadline[] = [];
  private errorBoundaryDepth = 0;
  private scopedElements: Record<string, ElementRef>;
  private scopedDesktopElements: Record<string, DesktopElementRef>;
  private scopedSettings: NonNullable<StepDefinition['settings']>;
  private stepNumbers = new Map<string, number>();
  private stepNames = new Map<string, string>();
  private elementPick?: { id: string; abort: AbortController };
  private manualStep?: StepDefinition;
  private manualDecision?: 'retry' | 'skip' | 'confirm';
  private checkingRecovery = false;
  private stepBudget = Infinity;
  private progressScope: string[] = [];
  private calls: { workflowId:string;stepId:string }[] = [];
  private inputPolicy() {
    return { idleMs: this.workflow.settings.foregroundIdleMs ?? 3000, waitMs: this.workflow.settings.foregroundWaitMs ?? 900000,
      onWaiting: (waiting: boolean, elapsed: number) => {
        if (waiting) this.snapshot.waitingReason = '等待前台资源及用户键鼠空闲';
        else { delete this.snapshot.waitingReason; for (const deadline of this.deadlines) deadline.expiresAt += elapsed; }
        this.state(this.snapshot.status);
      } };
  }
  private debug?: EngineOptions['debug'];
  private warn(step: StepDefinition, message: string) {
    this.snapshot.warnings ??= []; this.snapshot.warnings.push({ stepId: this.calls[0]?.stepId ?? step.stepId, stepName: step.name, message, at: new Date().toISOString() }); this.snapshot.warningCount = this.snapshot.warnings.length;
  }
  private async waitManual(step: StepDefinition, message: string): Promise<'retry' | 'skip' | 'confirm'> {
    this.manualStep = step; this.manualDecision = undefined; this.snapshot.currentStepId = step.stepId; this.snapshot.error = message;
    this.snapshot.manualDecisionRequired = !getAction(step.actionType).metadata.safeToRetry || message.includes('INPUT_INTERRUPTED');
    try { await this.waitForResume(true); return this.manualDecision ?? 'retry'; }
    finally { this.manualStep = undefined; this.manualDecision = undefined; delete this.snapshot.manualDecisionRequired; }
  }
  async browserTool(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'cancelElement') { const pick = this.elementPick; if (pick && pick.id === params.requestId) pick.abort.abort(); return null; }
    if (!this.executionFinished || !this.browser?.isOpen()) throw new Error('请先结束运行并保留浏览器');
    if (method === 'validateElement') return this.browser.validateElement(params.element as ElementRef);
    if (method !== 'pickElement') throw new Error('不支持的浏览器工具');
    if (this.elementPick || this.pointPick) throw new Error('浏览器已在拾取目标');
    const abort = new AbortController(); this.elementPick = { id: String(params.requestId), abort };
    try { return await this.browser.pickElement(String(params.pageId), abort.signal); }
    finally { if (this.elementPick?.abort === abort) this.elementPick = undefined; }
  }
  constructor(workflow: WorkflowDefinition, private options: EngineOptions) {
    this.debug = options.debug;
    this.workflow = workflowSchema.parse(workflow);
    validateActions(this.workflow);
    this.rebuildStepNumbers();
    this.scopedElements = this.workflow.elements;
    this.scopedDesktopElements = this.workflow.desktopElements ?? {};
    this.scopedSettings = this.workflow.settings;
    this.snapshot = {
      runId: options.runId, workflowId: workflow.workflowId, workflowName: workflow.name, revision: workflow.revision,
      status: 'queued', startedAt: new Date().toISOString(), artifacts: [], browserOpen: false,
      scheduleId: options.scheduleId, scheduledFor: options.scheduledFor,
      variables: structuredClone(workflow.variables),
      attemptId: options.attemptId ?? randomUUID(), warnings: [], warningCount: 0,
      resumedFromRunId: options.resumeFromRunId, debug: options.debug,
    };
  }
  getSnapshot(): RunSnapshot { return structuredClone(this.snapshot); }
  setDependencies(dependencies:Record<string,WorkflowDefinition>) { if(!this.executionFinished) throw new Error('执行中不能替换子流程快照'); this.options.workflowDependencies=dependencies; }
  async listBrowserPages(): Promise<BrowserPageInfo[]> {
    const browser = this.browser;
    if (!browser?.isOpen()) return [];
    return browser.listPages();
  }
  pickBrowserPoint(pageId: string, id: string): Promise<BrowserPoint | null> {
    if (!this.executionFinished) throw new Error('任务仍在运行，请结束后再获取坐标');
    if (!this.browser?.isOpen()) throw new Error('浏览器已关闭，请先打开网页');
    if (this.pointPick) throw new Error('浏览器正在获取坐标');
    const abort = new AbortController();
    const done = this.browser.pickPoint(pageId, abort.signal).finally(() => {
      if (this.pointPick?.id === id) this.pointPick = undefined;
    });
    this.pointPick = { id, abort, done };
    return done;
  }
  async cancelBrowserPoint(id: string): Promise<void> {
    const pick = this.pointPick;
    if (!pick || pick.id !== id) return;
    pick.abort.abort();
    await pick.done.catch(() => undefined);
  }
  private emit(event: Omit<RunEvent, 'runId' | 'at'>) {
    this.options.onEvent?.({ ...event, eventId: randomUUID(), attemptId: this.snapshot.attemptId, ...(event.stepId ? { stepName: this.stepNames.get(event.stepId) } : {}), ...(this.calls.length ? {callStepId:this.calls[0].stepId,sourceWorkflowId:this.calls.at(-1)!.workflowId} : {}), runId: this.snapshot.runId, at: new Date().toISOString() });
  }
  private rebuildStepNumbers() {
    const numbers = new Map<string, number>();
    const names = new Map<string, string>();
    const visit = (steps: StepDefinition[]) => {
      for (const step of steps) {
        numbers.set(step.stepId, numbers.size + 1);
        names.set(step.stepId, step.name);
        visit(step.children ?? []);
        visit(step.elseSteps ?? []);
      }
    };
    visit(this.workflow.steps);
    this.stepNumbers = numbers;
    this.stepNames = names;
  }
  private stepData(step: StepDefinition, data?: unknown): unknown {
    const stepNumber = this.stepNumbers.get(step.stepId);
    return data && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), stepNumber }
      : { stepNumber, ...(data === undefined ? {} : { value: data }) };
  }
  private state(status: RunSnapshot['status'], error?: string) {
    this.snapshot.status = status;
    if (error !== undefined) this.snapshot.error = error;
    if (['succeeded', 'failed', 'stopped'].includes(status)) this.snapshot.endedAt = new Date().toISOString();
    const complete = ['queued','succeeded','failed','stopped','interrupted'].includes(status);
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.snapshot.variables)) if (!Object.is(this.publishedVariables.get(key), value) || !this.publishedVariables.has(key)) changes[key] = value;
    const deletedVariables = [...this.publishedVariables.keys()].filter(key => !Object.hasOwn(this.snapshot.variables,key));
    this.publishedVariables = new Map(Object.entries(this.snapshot.variables));
    const warningChanges=this.snapshot.warnings?.slice(this.publishedWarnings) ?? [];this.publishedWarnings=this.snapshot.warningCount ?? 0;
    this.emit({ type: 'run', run: structuredClone({ ...this.snapshot, variables: complete ? this.snapshot.variables : {},warnings:complete?this.snapshot.warnings:[] }), status, variablesComplete: complete, ...(!complete ? { variableChanges:structuredClone(changes), deletedVariables,...(warningChanges.length?{warningChanges:structuredClone(warningChanges)}:{}) } : {}) });
  }
  private publishedVariables = new Map<string, unknown>();
  private publishedWarnings=0;
  async control(command: RunCommand): Promise<void> {
    if (this.elementPick) { if (['stop', 'closeBrowser'].includes(command)) this.elementPick.abort.abort(); else throw new Error('请先结束元素拾取'); }
    if (this.pointPick) {
      if (command === 'stop' || command === 'closeBrowser') await this.cancelBrowserPoint(this.pointPick.id);
      else throw new Error('请先完成或取消取点');
    }
    if (command === 'check') {
      const step = this.manualStep; if (!step) throw new Error('当前没有待处理的失败指令');
      if(this.checkingRecovery) throw new Error('恢复检查正在执行');
      this.checkingRecovery=true; const priorAbort=this.stepAbort; this.stepAbort=new AbortController();
      const failedId = this.snapshot.currentStepId;
      try { for (const check of step.recoveryChecks ?? []) { const result = await this.withinStepScope(check, () => this.execute(check, validateActionParams(check.actionType, resolveValue(check.params, this.snapshot.variables) as Record<string, unknown>))); if (check.output) this.setVariable(check.output, result ?? null); this.emit({ type: 'log', stepId: step.stepId, message: `恢复检查：${check.name}`, data: result }); } }
      finally { this.stepAbort=priorAbort;this.checkingRecovery=false;this.snapshot.currentStepId = failedId;if(!this.stopped) this.state('waiting_manual'); }
      return;
    }
    if (['retry', 'skip', 'confirm'].includes(command)) {
      if(this.checkingRecovery) throw new Error('请等待恢复检查结束');
      if (!this.manualStep) throw new Error('当前没有等待人工的指令');
      this.manualDecision = command as 'retry' | 'skip' | 'confirm'; this.pauseRequested = false; this.resumeWaiter?.(); return;
    }
    if (command === 'step') {
      if (this.manualStep || this.snapshot.status !== 'paused') throw new Error('单步只能用于调试暂停');
      this.stepBudget = 1; this.pauseRequested = false; this.resumeWaiter?.(); return;
    }
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
      if (this.snapshot.manualDecisionRequired) throw new Error('请明确选择重新执行、确认完成或跳过，不能直接重试有外部效果的指令');
      this.stepBudget = Infinity;
      this.pauseRequested = false; this.resumeWaiter?.();
    } else {
      if (!this.browser?.isOpen()) throw new Error('当前任务没有打开的浏览器');
      await this.browser.call(`browser.${command}`, {});
    }
  }
  private checkStop() { if (this.stopped) throw new Error('用户停止运行'); }
  private remainingTimeout(configured: number) {
    const now = Date.now();
    const expired = this.deadlines.find(deadline => deadline.expiresAt <= now);
    if (expired) throw new ContainerTimeoutError(expired);
    return Math.min(configured, ...this.deadlines.map(deadline => deadline.expiresAt - now));
  }
  private checkDeadline(error?: unknown) {
    const deadline = error instanceof StepExecutionError || error instanceof ContainerTimeoutError ? error.deadline : undefined;
    if (deadline && this.deadlines.includes(deadline)) throw error;
    this.remainingTimeout(30_000);
  }
  private async waitForDuration(durationMs: number, timeoutMs: number, signal: AbortSignal) {
    const deadline = this.deadlines.reduce<ExecutionDeadline | undefined>((earliest, current) => !earliest || current.expiresAt < earliest.expiresAt ? current : earliest, undefined);
    const containerLimited = deadline && deadline.expiresAt <= Date.now() + timeoutMs;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error !== undefined) reject(error); else resolve();
      };
      const abort = () => finish(signal.reason ?? new Error('等待已取消'));
      const timer = setTimeout(() => {
        if (durationMs > timeoutMs) finish(containerLimited ? new ContainerTimeoutError(deadline) : new Error(`等待超时（${timeoutMs / 1000} 秒）`));
        else finish();
      }, Math.min(durationMs, timeoutMs));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
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
    const parentDesktopElements = this.scopedDesktopElements;
    const parentSettings = this.scopedSettings;
    for (const [name, value] of locals) this.snapshot.variables[name] = value;
    this.scopedElements = { ...parentElements, ...step.elements };
    this.scopedDesktopElements = { ...parentDesktopElements, ...step.desktopElements };
    this.scopedSettings = { ...parentSettings, ...Object.fromEntries(Object.entries(step.settings ?? {}).filter(([, value]) => value !== undefined)) };
    try { return await run(); }
    finally {
      for (const { name, had, value } of previous) {
        if (had) this.snapshot.variables[name] = value;
        else delete this.snapshot.variables[name];
      }
      this.scopedElements = parentElements;
      this.scopedDesktopElements = parentDesktopElements;
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
      if (this.reuseBrowserOnly) throw new Error('所选浏览器已关闭，请重新选择');
      browser = new BrowserSession({
        profileDir: join(this.options.dataDir, 'profiles', this.workflow.settings.profileId ?? this.workflow.workflowId),
        downloadDir: this.scopedSettings.downloadDir ?? this.workflow.settings.downloadDir, headless: this.workflow.settings.headless, runId: this.snapshot.runId,
        browserChannel: startParams.browserChannel as BrowserSessionOptions['browserChannel'],
        debugPort: startParams.debugPort as number | undefined,
        popupPolicy: this.workflow.settings.popupPolicy ?? 'smart',
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
    let graceTimer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    this.activeBrowserCalls++;
    const closeAllPages = method === 'browser.closePage' && params.closeMode === 'all';
    const timeoutError = () => new Error(`浏览器动作超时（${timeoutMs} ms）`);
    const operation = (async () => {
      // Closing every page only targets the session already bound to this run.
      // An empty or closed session must never cause a replacement browser to start.
      const browser = closeAllPages ? this.browser : await this.ensureBrowser(['browser.start', 'browser.open'].includes(method) ? params : {});
      this.checkStop(); signal?.throwIfAborted();
      if (expired) throw timeoutError();
      if (!browser || (closeAllPages && !browser.isOpen())) return { ok: true, closedPageIds: [] };
      return method === 'browser.start' ? browser.getInfo() : browser.call(method, params);
    })();
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let finished = false;
        const finish = (callback: () => void) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer); clearTimeout(graceTimer);
          if (abort) signal?.removeEventListener('abort', abort);
          callback();
        };
        operation.then(
          value => finish(() => expired ? reject(timeoutError()) : resolve(value)),
          error => finish(() => reject(error)),
        );
        timer = setTimeout(() => {
          expired = true;
          graceTimer = setTimeout(() => finish(() => reject(timeoutError())), browserTimeoutErrorGraceMs);
        }, timeoutMs);
        abort = () => finish(() => reject(signal?.reason ?? new Error('浏览器动作已取消')));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    } catch (error) {
      if (expired || signal?.aborted) {
        // User stops and explicit "close all" actions must terminate the owned session.
        // Ordinary action timeouts keep the browser visible so the failed page state can be inspected or reused.
        if (signal?.aborted || closeAllPages) {
          await this.browser?.close();
          await operation.catch(() => {});
        } else {
          void operation.catch(() => {});
        }
      }
      throw error;
    } finally {
      clearTimeout(timer); clearTimeout(graceTimer); if (abort) signal?.removeEventListener('abort', abort);
      this.activeBrowserCalls--;
    }
  }
  private async dispatch(method: string, rawParams: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    this.checkStop(); signal?.throwIfAborted();
    if (method === 'core.runContext') return { runId: this.snapshot.runId, attemptId: this.snapshot.attemptId, scheduleId: this.snapshot.scheduleId ?? null, scheduledFor: this.snapshot.scheduledFor ?? null, startedAt: this.snapshot.startedAt, actualTime: new Date().toISOString() };
    if (method === 'browser.listPages') return this.listBrowserPages();
    if (method === 'variables.get') {
      if (typeof rawParams.name !== 'string' || !rawParams.name) throw new Error('变量名称必须是非空文本');
      return jsonClone(readVariable(this.snapshot.variables, rawParams.name));
    }
    if (method === 'variables.set') {
      const input = validateActionParams(method, rawParams);
      return this.setVariable(String(input.name), input.value);
    }
    if (method.startsWith('windows.')) {
      const input = { ...rawParams };
      if (typeof input.selector === 'string' && input.selector.startsWith('@')) {
        const name = input.selector.slice(1);
        const element = this.scopedDesktopElements[name];
        if (!element) throw new Error(`桌面元素库不存在：${name}`);
        input.element = resolveValue(element, this.snapshot.variables);
        delete input.selector;
      }
      const params = validateActionParams(method, input);
      this.windows ??= new WindowsSession(this.inputPolicy());
      return this.windows.call(method, params, timeoutMs, signal);
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
    if (method === 'browser.download' || method === 'browser.screenshot') {
      params.directory ||= this.scopedSettings.downloadDir ?? this.workflow.settings.downloadDir;
      if (!params.filename) delete params.filename;
    }
    {
      const value = await this.callBrowser(method, params, timeoutMs, signal);
      this.checkStop(); signal?.throwIfAborted();
      if (method === 'browser.download' || method === 'browser.screenshot') {
        const artifact = { ...(value as Artifact), stepId: this.snapshot.currentStepId };
        this.snapshot.artifacts.push(artifact);
        this.emit({ type: 'artifact', stepId: this.snapshot.currentStepId, data: artifact });
      }
      return value;
    }
  }
  private async execute(step: StepDefinition, params: Record<string, unknown>): Promise<unknown> {
    const timeout = this.remainingTimeout(step.timeoutMs ?? (step.actionType === 'core.wait' ? Number(params.durationSeconds) * 1000 + 1000 : 30_000));
    const signal = this.stepAbort!.signal;
    if(step.actionType==='workflow.call') return this.callWorkflow(step,params);
    if (step.actionType === 'core.runContext') return this.dispatch(step.actionType, params, timeout, signal);
    if (step.actionType === 'browser.open' && (params.url === 'rpa://demo' || this.options.demoUrl && this.workflow.workflowId === 'order-export-demo' && step.stepId === 'open' && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(String(params.url)))) {
      if (!this.options.demoUrl) throw new Error('内置示例网页尚未启动，请从桌面工作台运行');
      params = { ...params, url: this.options.demoUrl };
    }
    if (step.actionType.startsWith('browser.')) return this.dispatch(step.actionType, params, timeout, signal);
    if (step.actionType.startsWith('windows.')) return this.dispatch(step.actionType, params, timeout, signal);
    if (step.actionType.startsWith('desktop.')) return runDesktopInput(step.actionType, params, timeout, signal, this.inputPolicy());
    if (step.actionType === 'variables.set') return this.setVariable(String(params.name), params.value);
    if (step.actionType === 'core.note') return null;
    if (step.actionType === 'core.wait') {
      await this.waitForDuration(Number(params.durationSeconds) * 1000, timeout, signal);
      return { durationSeconds: Number(params.durationSeconds) };
    }
    if (step.actionType === 'core.log') {
      const message = typeof params.message === 'string' ? params.message : JSON.stringify(params.message);
      this.emit({ type: 'log', stepId: step.stepId, message: message === '' ? '（空文本）' : message, data: { value: params.message } });
      return params.message;
    }
    if (step.actionType === 'file.xlsxRead') {
      return jsonClone(readXlsxRows(String(params.path), String(params.sheetName ?? '')));
    }
    if (step.actionType === 'file.xlsxWrite') {
      const target = String(params.path);
      const sheetName = typeof params.sheetName === 'string' && params.sheetName.trim() ? params.sheetName : 'Sheet1';
      const rows = params.rows as Record<string, unknown>[];
      await mkdir(dirname(target), { recursive: true });
      const worksheet = xlsxUtils.json_to_sheet(rows);
      const workbook = xlsxUtils.book_new();
      xlsxUtils.book_append_sheet(workbook, worksheet, sheetName);
      await writeFile(target, writeWorkbook(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }));
      const file = await stat(target);
      const artifact: Artifact = { path: target, name: basename(target), size: file.size, stepId: this.snapshot.currentStepId };
      this.snapshot.artifacts.push(artifact);
      this.emit({ type: 'artifact', stepId: this.snapshot.currentStepId, data: artifact });
      return artifact;
    }
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
    if (step.actionType === 'control.tryCatch') {
      const name = String(params.errorVariable); validateName(name);
      return this.withinDeadline(step, async () => {
        this.errorBoundaryDepth++;
        try {
          try {
            await this.executeSteps(step.children ?? []);
            return { caught: false };
          } catch (error) {
            this.checkStop(); this.checkDeadline(error);
            const failure = error instanceof StepExecutionError ? error.failure : {
              message: error instanceof Error ? error.message : String(error), stepId: step.stepId, stepName: step.name, actionType: step.actionType,
            };
            const had = Object.hasOwn(this.snapshot.variables, name); const previous = this.snapshot.variables[name];
            this.setVariable(name, failure);
            delete this.snapshot.error;
            try { await this.executeSteps(step.elseSteps ?? []); }
            finally {
              if (had) this.snapshot.variables[name] = previous; else delete this.snapshot.variables[name];
            }
            return { caught: true };
          }
        } finally { this.errorBoundaryDepth--; }
      });
    }
    if (step.actionType === 'control.forEach' || step.actionType === 'control.forEachXlsx') {
      const name = String(params.itemVariable); validateName(name);
      let progress: BusinessProgress | undefined; let progressFile: string | undefined;
      const progressKey = typeof params.progressKey === 'string' ? params.progressKey.trim() : '';
      if(progressKey){const scope=[...this.progressScope,step.stepId];progressFile=progressPath(this.options.dataDir,this.snapshot.runId,this.snapshot.attemptId!,scope);if(this.options.resumeFromRunId && this.options.resumeFromAttemptId)progress=await readProgress(progressPath(this.options.dataDir,this.options.resumeFromRunId,this.options.resumeFromAttemptId,scope));}
      let items: unknown[];
      if(progress)items=progress.items;
      else if (step.actionType === 'control.forEachXlsx') {
        items = params.valueMode === 'column'
          ? readXlsxColumnValues(String(params.path), String(params.sheetName ?? ''), Number(params.columnIndex)).values
          : params.valueMode === 'array'
            ? readXlsxArrayRows(String(params.path), String(params.sheetName ?? '')).rows
            : readXlsxRows(String(params.path), String(params.sheetName ?? '')).rows;
      } else items = params.items as unknown[];
      if (progressKey) {
        const keys = items.map(item => { const value = resolveValue(progressKey, { ...this.snapshot.variables, [name]: item }); if (!['string','number'].includes(typeof value) || String(value).trim() === '') throw new Error('续跑业务键必须是非空文本或数字'); return String(value); });
        if (new Set(keys).size !== keys.length) throw new Error('续跑业务键重复，不能可靠识别已处理项目');
        if (progress && JSON.stringify(keys) !== JSON.stringify(progress.keys)) throw new Error('业务键模板与原输入不一致，禁止续跑');
        progress ??= { items, keys, completed: [], pending: [] }; await saveProgress(progressFile!, progress);
      }
      if (items.length > 10_000) throw new Error('循环最多支持 10000 行，请缩小工作表范围');
      const had = Object.hasOwn(this.snapshot.variables, name); const previous = this.snapshot.variables[name];
      let count = 0;
      try {
        await this.withinDeadline(step, async () => {
          for (const [index, item] of items.entries()) {
            await yieldLoop(); this.checkStop(); this.remainingTimeout(timeout);
            this.setVariable(name, item);
            const key = progress?.keys[index];
            if (key && progress?.completed.includes(key)) { this.emit({ type: 'log', stepId: step.stepId, message: `续跑跳过已完成项目：${key}` }); count++; continue; }
            if (key && progress?.pending.includes(key)) {
              const decision = await this.waitManual(step, `业务项 ${key} 可能部分完成，请检查后确认完成、明确重做或停止。`);
              if (decision === 'confirm') { progress.completed.push(key); progress.pending = progress.pending.filter(value => value !== key); await saveProgress(progressFile!, progress); count++; continue; }
              if (decision === 'skip') { this.warn(step, `人工跳过未确认项目：${key}`); continue; }
            }
            const warnings = this.snapshot.warningCount ?? 0;
            if (key && progress) { progress.pending = [...new Set([...progress.pending, key])]; await saveProgress(progressFile!, progress); this.progressScope.push(`${step.stepId}:${key}`); }
            try { await this.executeSteps(step.children ?? []); count++; }
            finally { if (key) this.progressScope.pop(); }
            if (key && progress && warnings === this.snapshot.warningCount) { progress.completed.push(key); progress.pending = progress.pending.filter(value => value !== key); await saveProgress(progressFile!, progress); }
          }
        });
      } finally {
        if (had) this.snapshot.variables[name] = previous; else delete this.snapshot.variables[name];
      }
      return { count };
    }
    throw new Error(`未实现动作：${step.actionType}`);
  }
  private async callWorkflow(step:StepDefinition,params:Record<string,unknown>) {
    const id=String(params.workflowId); const key=`${id}@${params.revision}`; const child=this.options.workflowDependencies?.[key];
    if(!child) throw new Error(`子流程固定修订不存在：${key}`);
    if(id===this.workflow.workflowId || this.calls.some(call=>call.workflowId===id) || this.calls.length>=20) throw new Error('子流程存在循环调用或超过深度上限');
    const input=params.inputs as Record<string,unknown>;
    for(const name of Object.keys(input)) if(!child.inputs?.includes(name)) throw new Error(`子流程未声明输入：${name}`);
    for(const name of child.inputs ?? []) { validateName(name); if(!Object.hasOwn(input,name)) throw new Error(`缺少子流程输入：${name}`); }
    const parent={variables:this.snapshot.variables,elements:this.scopedElements,desktopElements:this.scopedDesktopElements,settings:this.scopedSettings,numbers:this.stepNumbers,names:this.stepNames,stepId:this.snapshot.currentStepId};
    this.snapshot.variables={...structuredClone(child.variables),...structuredClone(input)};
    this.scopedElements=child.elements; this.scopedDesktopElements=child.desktopElements ?? {}; this.scopedSettings={downloadDir:child.settings.downloadDir,pythonExecutable:child.settings.pythonExecutable ?? parent.settings.pythonExecutable};
    this.stepNumbers=new Map(); this.stepNames=new Map();
    const visit=(steps:StepDefinition[])=>{for(const entry of steps) { this.stepNumbers.set(entry.stepId,this.stepNumbers.size+1);this.stepNames.set(entry.stepId,entry.name);visit(entry.children ?? []);visit(entry.elseSteps ?? []);}};visit(child.steps);
    this.calls.push({workflowId:id,stepId:step.stepId}); this.progressScope.push(`call:${step.stepId}:${key}`);
    try { return await this.withinDeadline(step,async()=>{ await this.executeSteps(child.steps);return Object.fromEntries((child.outputs ?? []).map(name=>[name,jsonClone(readVariable(this.snapshot.variables,name))])); }); }
    finally { this.calls.pop();this.progressScope.pop();this.snapshot.variables=parent.variables;this.scopedElements=parent.elements;this.scopedDesktopElements=parent.desktopElements;this.scopedSettings=parent.settings;this.stepNumbers=parent.numbers;this.stepNames=parent.names;this.snapshot.currentStepId=parent.stepId; }
  }
  private async executeSteps(steps: StepDefinition[]) {
    for (const step of steps) {
      await yieldLoop();
      if (!step.disabled && !this.calls.length && this.debug?.breakpoints.includes(step.stepId)) this.pauseRequested = true;
      this.checkStop(); await this.waitForResume();
      this.remainingTimeout(30_000);
      if (step.disabled) {
        this.emit({ type: 'step', stepId: step.stepId, status: 'skipped', message: `已注释：${step.name}`, data: this.stepData(step) });
        continue;
      }
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
              this.emit({ type: 'step', stepId: step.stepId, status: 'running', message: step.name, data: this.stepData(step, { attempt }) });
              const input = { ...step.params };
              const progressKey = input.progressKey; delete input.progressKey;
              if (step.actionType === 'browser.closePage' && input.closeMode === 'all') delete input.pageId;
              // Scripts use the SDK for variables; notes preserve all text literally.
              const raw = ['script.run', 'core.note'].includes(step.actionType) ? input : resolveValue(input, this.snapshot.variables) as Record<string, unknown>;
              const params = validateActionParams(step.actionType, raw);
              if (progressKey !== undefined) params.progressKey = progressKey;
              if (Number.isFinite(this.stepBudget)) { this.stepBudget--; if (this.stepBudget === 0) this.pauseRequested = true; }
              return this.execute(step, params);
            });
            this.checkStop();
            // Publish only after restoring local declarations, including same-name outputs.
            if (step.output && step.actionType !== 'core.note') this.setVariable(step.output, result ?? null);
            this.snapshot.currentStepId = step.stepId;
            this.emit({ type: 'step', stepId: step.stepId, status: 'succeeded', message: step.name, data: this.stepData(step, { durationMs: Date.now() - started, result }) });
            this.state('running'); completed = true; break;
          } catch (caught) {
            error = caught; this.checkStop();
            try { this.checkDeadline(caught); }
            catch (expired) { error = expired; break; }
            if (String(caught).includes('INPUT_INTERRUPTED')) break;
            if (attempt < attempts) {
              this.emit({ type: 'log', stepId: step.stepId, message: `步骤失败，准备第 ${attempt + 1} 次尝试：${String(caught)}` });
              const delay = step.retry?.delayMs ?? 500;
              try { await this.waitForDuration(delay, this.remainingTimeout(delay + 1), attemptAbort.signal); }
              catch (expired) { error = expired; this.checkStop(); break; }
            }
          } finally {
            this.stepAbort = parentAbort;
          }
        }
        if (!completed) {
          const message = error instanceof Error ? error.message : String(error);
          this.snapshot.error = message;
          this.emit({ type: 'step', stepId: step.stepId, status: 'failed', message, data: this.stepData(step) });
          const screenshotPath = join(this.options.dataDir, 'runs', this.snapshot.runId, `${step.stepId}.png`);
          if (this.browser) {
            await mkdir(join(this.options.dataDir, 'runs', this.snapshot.runId), { recursive: true });
            try {
              const path = await this.browser.screenshot(screenshotPath);
              if (path) this.emit({ type: 'log', stepId: step.stepId, message: '已保存失败截图', data: { path } });
            } catch { /* Capture failure must not replace the action error. */ }
          }
          if (step.onError === 'continue' && !message.includes('INPUT_INTERRUPTED')) {
            this.warn(step, message);
            this.emit({ type: 'log', stepId: step.stepId, message: '已忽略失败，继续执行后续指令。', data: this.stepData(step) });
            delete this.snapshot.error;
            this.state('running');
            completed = true;
            break;
          }
          if (message.includes('INPUT_INTERRUPTED') || !this.errorBoundaryDepth && (step.onError === 'manual' || step.onError === 'pause' && getAction(step.actionType).metadata.safeToRetry)) {
            this.checkDeadline(error);
            const decision = await this.waitManual(step, message);
            if (decision !== 'retry') { if (decision === 'skip') this.warn(step, `人工跳过：${message}`); this.emit({ type: 'step', stepId: step.stepId, status: 'succeeded', message: decision === 'confirm' ? '人工确认已完成' : '人工跳过（有警告）', data: this.stepData(step) }); completed = true; }
          } else throw new StepExecutionError(step, error);
        }
      }
    }
  }
  run(): Promise<RunSnapshot> {
    if (this.consumed) throw new Error('每个执行器只能运行一次');
    this.consumed = true;
    const start = this.debug?.fromStepId ? this.workflow.steps.findIndex(step => step.stepId === this.debug!.fromStepId) : 0;
    if (start < 0) throw new Error('从指定位置运行只支持顶层步骤');
    return this.runExecution(() => this.executeSteps(this.workflow.steps.slice(start)), false);
  }
  runSingleStep(stepId: string, input: WorkflowDefinition = this.workflow, attemptId?: string, debug?: EngineOptions['debug']): Promise<RunSnapshot> {
    if (this.pointPick) throw new Error('请先完成或取消取点');
    const workflow = workflowSchema.parse(input);
    validateActions(workflow);
    const path = findStepPath(workflow, stepId);
    if (!path) throw new Error('指令不存在，请重新选择');
    if (path.some(step => step.disabled)) throw new Error('指令或所属容器已注释，请取消注释后再运行');
    const reusing = this.consumed;
    const popupPolicyChanged = (workflow.settings.popupPolicy ?? 'smart') !== (this.workflow.settings.popupPolicy ?? 'smart');
    if (this.consumed) {
      if (!this.executionFinished) throw new Error('该浏览器正在执行任务，请等待完成或停止');
      if (!this.browser?.isOpen()) throw new Error('所选浏览器已关闭，请新建单步运行');
      if (workflow.workflowId !== this.workflow.workflowId) throw new Error('只能复用当前流程的浏览器');
      if ((workflow.settings.profileId ?? workflow.workflowId) !== (this.workflow.settings.profileId ?? this.workflow.workflowId)
        || workflow.settings.headless !== this.workflow.settings.headless) throw new Error('浏览器配置已改变，请关闭原浏览器后重新运行');
      // Keep computed values; explicitly edited declarations take effect immediately.
      for (const [name, value] of Object.entries(workflow.variables)) {
        if (!Object.hasOwn(this.workflow.variables, name) || !isDeepStrictEqual(value, this.workflow.variables[name])) {
          this.snapshot.variables[name] = structuredClone(value);
        }
      }
      for (const [name, value] of Object.entries(this.workflow.variables)) {
        if (!Object.hasOwn(workflow.variables, name) && isDeepStrictEqual(this.snapshot.variables[name], value)) delete this.snapshot.variables[name];
      }
    }
    this.workflow = workflow;
    this.rebuildStepNumbers();
    this.reuseBrowserOnly = reusing;
    this.scopedElements = workflow.elements;
    this.scopedDesktopElements = workflow.desktopElements ?? {};
    this.scopedSettings = workflow.settings;
    this.snapshot.workflowName = workflow.name;
    this.snapshot.revision = workflow.revision;
    this.snapshot.stepId = stepId;
    delete this.options.resumeFromRunId; delete this.options.resumeFromAttemptId; delete this.snapshot.resumedFromRunId;
    this.debug = debug; this.snapshot.debug = debug;
    if (attemptId || reusing) this.snapshot.attemptId = attemptId ?? randomUUID();
    this.consumed = true;
    const executeAt = (index: number): Promise<void> => index === path.length - 1
      ? this.executeSteps([path[index]])
      : this.withinStepScope(path[index], () => executeAt(index + 1));
    return this.runExecution(async () => {
      if (this.browser && popupPolicyChanged) await this.browser.call('browser.popupGuard', { mode: workflow.settings.popupPolicy ?? 'smart' });
      if (debug?.fromStepId) { const start = workflow.steps.findIndex(step => step.stepId === debug.fromStepId); if (start < 0) throw new Error('调试起点必须是顶层步骤'); await this.executeSteps(workflow.steps.slice(start)); }
      else await executeAt(0);
    }, true);
  }
  private async runExecution(execute: () => Promise<void>, keepBrowserOpen: boolean): Promise<RunSnapshot> {
    this.executionFinished = false;
    this.stopped = false;
    this.pauseRequested = false;
    this.snapshot.startedAt = new Date().toISOString(); this.snapshot.warnings = []; this.snapshot.warningCount = 0;this.publishedWarnings=0;
    delete this.snapshot.endedAt;
    delete this.snapshot.error;
    delete this.snapshot.currentStepId;
    this.state('running');
    let finalStatus: RunSnapshot['status'] = 'succeeded'; let finalError: string | undefined;
    try { await execute(); this.checkStop(); }
    catch (error) { finalStatus = this.stopped ? 'stopped' : 'failed'; finalError = error instanceof Error ? error.message : String(error); }
    this.windows?.close(); this.windows = undefined;
    try { if (this.stopped || (finalStatus === 'succeeded' && !keepBrowserOpen && this.workflow.settings.keepBrowserOpen === false)) await this.browser?.close(); }
    catch (error) { finalStatus = this.stopped ? 'stopped' : 'failed'; finalError ??= `浏览器清理失败：${String(error)}`; }
    this.snapshot.browserOpen = this.browser?.isOpen() ?? false;
    this.executionFinished = true;
    this.state(finalStatus, finalError);
    forgetProgress(join(this.options.dataDir,'runs',this.snapshot.runId,'attempts',this.snapshot.attemptId!,'progress'));
    return this.getSnapshot();
  }
}
