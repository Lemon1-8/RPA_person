import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { actionDefinitions, getAction } from '../../../packages/actions/src/index.js';
import { workflowSchema, type WorkflowDefinition, type RunEvent, type RunSnapshot, type AgentResponse } from '../../../packages/contracts/src/index.js';
import { WorkbenchStore } from '../../../packages/persistence/src/workbench.js';
import { writeJsonAtomic } from '../../../packages/persistence/src/index.js';
import { resolveBrowser } from '../../../packages/browser/src/native-browser.js';
import { RunManager, killOwnedTree } from './manager.js';

export interface AgentContext { runtimeRoot: string; callerDirectory: string; onLog?: (message: string) => void; signal?: AbortSignal }
class CommandError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
interface StopReason { code: string; message: string; stepId?: string }
interface AgentMetadata { script: boolean; reason?: StopReason }
const scriptLanguages: Record<string,string> = { '.py': 'python', '.js': 'javascript', '.ts': 'typescript' };
const scriptOutput = '__rpaAgentResult';
export const supportsScriptRpc = (type: string) => type.startsWith('browser.') || type.startsWith('windows.') || type.startsWith('desktop.') || ['file.xlsxRead', 'file.xlsxWrite', 'variables.set', 'core.runContext'].includes(type);
const inputSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
const readJson = async (path: string): Promise<unknown> => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/,''), (key,value) => {
  if (['__proto__','constructor','prototype'].includes(key)) throw new CommandError('INVALID_INPUT',`JSON 不允许保留属性：${key}`);
  return value;
});
const optionalJson = async <T>(path: string): Promise<T | undefined> => readJson(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; }) as Promise<T | undefined>;
function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) throw new CommandError('INVALID_INPUT', `${name} 必须为 1–2147483647 的整数`);
  return number;
}
function normalizeScriptPaths(flow: WorkflowDefinition, directory: string) {
  const visit = (steps: WorkflowDefinition['steps']) => {
    for (const step of steps) {
      if (step.actionType === 'script.run' && typeof step.params.filePath === 'string') step.params.filePath = resolve(directory, step.params.filePath);
      visit(step.children ?? []); visit(step.elseSteps ?? []); visit(step.recoveryChecks ?? []);
    }
  };
  visit(flow.steps);
  return flow;
}
async function environmentCheck(context: AgentContext, python = 'python') {
  const browser = async (headless: boolean) => resolveBrowser('auto', headless).catch(error => ({ error: error.message.replace('npm run browser:install', 'rpa-agent setup-browser') }));
  const version = await new Promise<string | null>(resolve => {
    const child = spawn(python, ['--version'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0 ? output.trim() : null); });
  });
  const [headed, headless] = await Promise.all([browser(false),browser(true)]);
  const nodeParts = process.versions.node.split('.').map(Number);
  return { platform: process.platform, supported: process.platform === 'win32' && (nodeParts[0] > 22 || nodeParts[0] === 22 && nodeParts[1] >= 13), node: process.versions.node, runtimeRoot: context.runtimeRoot, browsers: { headed, headless }, python: { executable: python, version, optional: true, supported: !!version && /^Python (?:3\.(?:1[0-9]|[2-9][0-9])|[4-9]\.)/.test(version) }, browserInstallCommand: 'rpa-agent setup-browser' };
}
async function installBrowser(context: AgentContext) {
  if (context.signal?.aborted) throw new CommandError('CANCELLED','浏览器安装已取消');
  const require = createRequire(join(context.runtimeRoot, 'package.json'));
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { windowsHide: true, stdio: ['ignore','pipe','pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let cancelled = false;
    const abort = () => {cancelled = true;void killOwnedTree(child).catch(reject);};
    context.signal?.addEventListener('abort',abort,{once:true});
    if (context.signal?.aborted) abort();
    child.stdout.on('data', chunk => context.onLog?.(String(chunk))); child.stderr.on('data', chunk => context.onLog?.(String(chunk)));
    child.once('error', reject); child.once('close', code => {
      context.signal?.removeEventListener('abort',abort);
      if (cancelled) reject(new CommandError('CANCELLED','浏览器安装已取消'));
      else if (code === 0) resolve();
      else reject(new CommandError('BROWSER_INSTALL_FAILED', `浏览器安装退出码：${code}`));
    });
  });
  return { installed: 'chromium' };
}
async function runResult(store: WorkbenchStore, runId: string) {
  const run = await store.readRunSnapshot(runId);
  const workflow = await store.readRunWorkflow(runId);
  const metadata = await optionalJson<AgentMetadata>(join(store.directory,'runs',runId,'agent.json'));
  const result = metadata?.script ? run.variables[scriptOutput] ?? null : Object.fromEntries((workflow?.outputs ?? []).filter(name => Object.hasOwn(run.variables,name)).map(name => [name,run.variables[name]]));
  return { run, result, reason: metadata?.reason, paths: { data: store.directory, run: join(store.directory,'runs',runId), logs: join(store.directory,'runs',runId,'events.jsonl') } };
}
async function executeRun(manager: RunManager, workflow: WorkflowDefinition, dependencies: Record<string,WorkflowDefinition>, script: boolean, timeoutMs: number, workingDirectory: string, context: AgentContext): Promise<{ exitCode: number; response: AgentResponse }> {
  let run: RunSnapshot | undefined;
  let reason: StopReason | undefined;
  let stopping: Promise<void> | undefined;
  let cleanupError: unknown;
  let executionError: unknown;
  let timer: NodeJS.Timeout | undefined;
  const stop = (value: StopReason) => {
    reason ??= value;
    if (run && !['succeeded','failed','stopped','interrupted'].includes(run.status) && !stopping) stopping = manager.controlRun(run.runId,'stop').catch(error => {
      if (!run || !['succeeded','failed','stopped','interrupted'].includes(run.status)) cleanupError ??= error;
    });
  };
  const listener = (event: RunEvent) => {
    if (event.type === 'log' && event.message) context.onLog?.(event.message);
    if (event.runId === run?.runId && event.run) {
      run = event.run;
      if (['paused','waiting_manual'].includes(run.status)) stop({ code: 'MANUAL_REQUIRED', message: run.error ?? run.waitingReason ?? '运行需要人工处理', stepId: run.currentStepId });
    }
  };
  const abort = () => stop({code:'CANCELLED',message:'调用者已取消运行'});
  manager.on('event',listener);
  try {
    await manager.initialize();
    if (context.signal?.aborted) throw new CommandError('CANCELLED','调用者已取消运行');
    run = await manager.runWorkflowSnapshot(workflow,dependencies,{ workingDirectory,agentMode:true });
    context.signal?.addEventListener('abort',abort,{once:true});
    if (context.signal?.aborted) abort();
    timer = setTimeout(() => stop({code:'TIMEOUT',message:`运行总超时（${timeoutMs} ms）`}),timeoutMs);
    await writeJsonAtomic(join(manager.store.directory,'runs',run.runId,'agent.json'),{script} satisfies AgentMetadata);
    await manager.waitForRun(run.runId);
    clearTimeout(timer);
    await stopping;
    if (reason) {
      await manager.store.recordEvent({type:'log',runId:run.runId,at:new Date().toISOString(),stepId:reason.stepId,message:reason.message,data:{code:reason.code}});
      await writeJsonAtomic(join(manager.store.directory,'runs',run.runId,'agent.json'),{script,reason} satisfies AgentMetadata);
    }
  } catch (error) {
    if (!run) throw error;
    executionError = error;
  } finally {
    clearTimeout(timer); context.signal?.removeEventListener('abort',abort); manager.off('event',listener);
    try { await manager.shutdown(); } catch (error) { cleanupError ??= error; }
  }
  const data = await runResult(manager.store,run!.runId);
  const error = cleanupError || executionError || manager.store.issues().length ? {code:'CLEANUP_FAILED',message:`运行清理或记录保存失败：${String(cleanupError ?? executionError ?? manager.store.issues()[0].message)}`} : reason ?? (data.run.status !== 'succeeded' ? {code:'EXECUTION_FAILED',message:data.run.error ?? data.run.status} : undefined);
  return {exitCode:error ? 1 : 0,response:{apiVersion:1,ok:!error,data,...(error ? {error} : {})}};
}

export async function agentCommand(argv: string[], context: AgentContext): Promise<{ exitCode: number; response: AgentResponse }> {
  try {
    const {positionals,values} = parseArgs({args:argv,allowPositionals:true,options:{
      variables:{type:'string'},dependency:{type:'string',multiple:true},cwd:{type:'string'},data:{type:'string'},output:{type:'string'},headless:{type:'boolean'},python:{type:'string'},'timeout-ms':{type:'string'},before:{type:'string'},limit:{type:'string'},'result-id':{type:'string'},help:{type:'boolean'},
    }});
    const [command,entry,...extra] = positionals;
    if (extra.length) throw new CommandError('INVALID_INPUT','位置参数过多');
    const python = values.python && /[\\/]|^[a-z]:/i.test(values.python) ? resolve(context.callerDirectory,values.python) : values.python;
    const workingDirectory = resolve(context.callerDirectory,values.cwd ?? '.');
    const dataDir = resolve(context.callerDirectory,values.data ?? process.env.RPA_DATA_DIR ?? join(workingDirectory,'.rpa','agent'));
    const store = new WorkbenchStore(dataDir);
    let data: unknown;
    if (!command || values.help) data = {usage:'rpa-agent <command> [file|runId] [options]',commands:['doctor','setup-browser','actions [type]','schema','check <file>','run <file>','runs [runId]','logs <runId>','result <runId>'],options:['--variables <json>','--dependency <json> (repeatable)','--cwd <directory>','--data <directory>','--output <directory>','--headless','--python <executable>','--timeout-ms <milliseconds>','--before <sequence>','--limit <count>','--result-id <id>']};
    else if (command === 'doctor') data = await environmentCheck(context,python);
    else if (command === 'setup-browser') data = await installBrowser(context);
    else if (command === 'schema') data = inputSchema(workflowSchema);
    else if (command === 'actions') {
      const describe = (type: string) => ({...getAction(type).metadata,workflowAction:true,scriptRpc:supportsScriptRpc(type),parameters:inputSchema(getAction(type).schema)});
      data = entry ? describe(entry) : {actions:actionDefinitions.map(action => describe(action.type)),scriptOnly:[{type:'variables.get',parameters:{type:'object',required:['name'],properties:{name:{type:'string'}}}},{type:'browser.listPages',parameters:{type:'object',properties:{}}}],note:'参数形状不包含全部 refine 约束；check 与执行时校验为准。'};
    } else if (command === 'runs') data = entry ? await store.readRunSnapshot(entry) : await store.listRunHeaders().catch(error => {if(error.code === 'ENOENT')return [];throw error;});
    else if (command === 'logs' || command === 'result') {
      if (!entry) throw new CommandError('INVALID_INPUT','请提供运行 ID');
      await store.readRunSnapshot(entry);
      data = command === 'logs' ? await store.getRunEvents(entry,{before:values.before ? positiveInteger(values.before,1,'before') : undefined,limit:positiveInteger(values.limit,200,'limit')}) : values['result-id'] ? await store.getStepResult(entry,values['result-id']) : await runResult(store,entry);
    } else if (command === 'check' || command === 'run') {
      if (!entry) throw new CommandError('INVALID_INPUT','请提供流程或代码文件路径');
      if (!(await stat(workingDirectory)).isDirectory()) throw new CommandError('INVALID_INPUT','cwd 必须是目录');
      const file = resolve(context.callerDirectory,entry); const extension = extname(file).toLowerCase();
      const script = extension !== '.json';
      if (script && !scriptLanguages[extension]) throw new CommandError('INVALID_INPUT','仅支持 .json、.py、.js、.ts');
      const timeoutMs = positiveInteger(values['timeout-ms'],1_800_000,'timeout-ms');
      const rawVariables = values.variables ? await readJson(resolve(context.callerDirectory,values.variables)) : {};
      if (!rawVariables || typeof rawVariables !== 'object' || Array.isArray(rawVariables)) throw new CommandError('INVALID_INPUT','variables 文件必须是 JSON 对象');
      let workflow: WorkflowDefinition = script ? {
        schemaVersion:1,workflowId:`script-${createHash('sha256').update(file).digest('hex').slice(0,16)}`,revision:0,name:basename(file).slice(0,120),variables:{},elements:{},outputs:[scriptOutput],
        settings:{downloadDir:join(dataDir,'downloads'),headless:false},
        steps:[{stepId:'agent-script',name:basename(file),actionType:'script.run',params:{language:scriptLanguages[extension],filePath:file},output:scriptOutput,timeoutMs:Math.max(100,Math.min(timeoutMs,3_600_000))}],
      } : normalizeScriptPaths(workflowSchema.parse(await readJson(file)),dirname(file));
      workflow = workflowSchema.parse({...workflow,variables:{...workflow.variables,...rawVariables},settings:{...workflow.settings,keepBrowserOpen:false,...(values.output ? {downloadDir:resolve(context.callerDirectory,values.output)} : {}),...(values.headless ? {headless:true} : {}),...(python ? {pythonExecutable:python} : {})}});
      const dependencies: Record<string,WorkflowDefinition> = {};
      for (const dependency of values.dependency ?? []) {
        const path = resolve(context.callerDirectory,dependency);
        const child = normalizeScriptPaths(workflowSchema.parse(await readJson(path)),dirname(path));
        const key = `${child.workflowId}@${child.revision}`;
        if (Object.hasOwn(dependencies,key)) throw new CommandError('INVALID_INPUT',`重复子流程：${key}`);
        dependencies[key] = child;
      }
      const manager = new RunManager({dataDir,rootDir:context.runtimeRoot,autoStartSchedules:false,maxConcurrent:1});
      const issues = await manager.preflightWorkflow(workflow,dependencies);
      if (issues.some(issue => issue.level === 'error')) throw new CommandError('VALIDATION_FAILED','流程或代码检查失败',issues);
      if (command === 'run') return await executeRun(manager,workflow,dependencies,script,timeoutMs,workingDirectory,context);
      data = {valid:true,issues,workflowId:workflow.workflowId,dependencies:Object.keys(dependencies)};
    } else throw new CommandError('INVALID_INPUT',`未知命令：${command}`);
    return {exitCode:0,response:{apiVersion:1,ok:true,data}};
  } catch (error) {
    const value = error as Error & {code?:string};
    const code = value.code === 'ENOENT' ? 'NOT_FOUND' : value.code ?? 'INVALID_INPUT';
    return {exitCode:code === 'CANCELLED' ? 1 : 2,response:{apiVersion:1,ok:false,error:{code,message:value.message ?? String(error),...(error instanceof CommandError && error.details ? {details:error.details} : {})}}};
  }
}
