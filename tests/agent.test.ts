import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { agentCommand, type AgentContext } from '../apps/runner/src/agent.js';
import { RunManager } from '../apps/runner/src/manager.js';
import { WorkbenchStore } from '../packages/persistence/src/workbench.js';
import { startFixtureServer } from './fixtures/server.js';
import type { AgentResponse, RunSnapshot, WorkflowDefinition } from '../packages/contracts/src/index.js';

const root = process.cwd();
let directory: string;
let context: AgentContext;
const managers: RunManager[] = [];
const payload = <T>(response: AgentResponse) => response.data as T;
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
const flow = (steps: WorkflowDefinition['steps'] = []): WorkflowDefinition => ({schemaVersion:1,workflowId:'agent-test',revision:0,name:'Agent 验证',variables:{},elements:{},settings:{headless:true,downloadDir:directory},steps});
const command = (...args: string[]) => agentCommand(args,context);
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(),'rpa-agent-')); context = {runtimeRoot:root,callerDirectory:directory}; });
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('rpa-agent-')) throw new Error('拒绝清理测试目录以外的路径');
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

describe('Agent 发现与只读检查', () => {
  it('输出真实参数、RPC 支持及流程 schema，不创建运行数据目录', async () => {
    const action = await command('actions','file.xlsxWrite');
    expect(action.response.ok).toBe(true);
    expect(payload<{scriptRpc:boolean;parameters:{properties:object}}>(action.response)).toMatchObject({scriptRpc:true,parameters:{properties:{path:{type:'string'}}}});
    expect(payload<{scriptRpc:boolean}>((await command('actions','control.if')).response).scriptRpc).toBe(false);
    expect((await command('schema')).response.ok).toBe(true);
    expect((await command('runs')).response).toMatchObject({ok:true,data:[]});
    expect((await command('runs','missing')).response.error?.code).toBe('NOT_FOUND');
    await expect(stat(join(directory,'.rpa'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('外部参数浅合并，拒绝非法值，检查不会保存新修订或运行代码', async () => {
    const definition = {...flow(),variables:{obj:{old:true}},inputs:['obj'],steps:[{stepId:'script',name:'仅检查',actionType:'script.run',params:{language:'javascript',code:'throw new Error("不得执行")'}}]};
    await json(join(directory,'flow.json'),definition); await json(join(directory,'vars.json'),{obj:{next:true}});
    expect((await command('check','flow.json','--variables','vars.json')).response.ok).toBe(true);
    expect(JSON.parse(await readFile(join(directory,'flow.json'),'utf8'))).toEqual(definition);
    await json(join(directory,'vars.json'),[]);
    expect((await command('check','flow.json','--variables','vars.json')).response.error?.code).toBe('INVALID_INPUT');
    await writeFile(join(directory,'vars.json'),'{"__proto__":{}}');
    expect((await command('check','flow.json','--variables','vars.json')).exitCode).toBe(2);
    await expect(stat(join(directory,'.rpa'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('脚本二选一与语法错误在启动前报告', async () => {
    const definition = flow([{stepId:'script',name:'非法',actionType:'script.run',params:{language:'javascript',code:'const =',filePath:join(directory,'file.js')}}]);
    await json(join(directory,'flow.json'),definition);
    expect((await command('check','flow.json')).response.error?.code).toBe('VALIDATION_FAILED');
    await writeFile(join(directory,'bad.ts'),'export async function main( {');
    expect((await command('check','bad.ts')).response.error?.code).toBe('VALIDATION_FAILED');
  });
  it('接受 Windows UTF-8 BOM 文件，极短总超时不破坏步骤格式', async () => {
    await writeFile(join(directory,'task.js'),'exports.main = async rpa => rpa.output(await rpa.get("value"));');
    await writeFile(join(directory,'vars.json'),'\uFEFF{"value":42}');
    expect((await command('check','task.js','--variables','vars.json','--timeout-ms','1')).response.ok).toBe(true);
    expect(payload<{result:unknown}>((await command('run','task.js','--variables','vars.json')).response).result).toBe(42);
  });
});

describe('Agent 流程和文件执行', () => {
  it('执行未保存 JSON、返回声明输出，关闭会话并可只读查询', async () => {
    const definition = {...flow([{stepId:'set',name:'输入',actionType:'variables.set',params:{name:'actual',value:'{{obj}}'}}]),variables:{obj:{old:true}},outputs:['actual']};
    await json(join(directory,'flow.json'),definition); await json(join(directory,'vars.json'),{obj:{new:true}});
    const result = await command('run','flow.json','--variables','vars.json');
    expect(result.exitCode).toBe(0);
    const data = payload<{run:RunSnapshot;result:unknown}>(result.response);
    expect(data.run).toMatchObject({status:'succeeded',revision:0,browserOpen:false});
    expect(data.result).toEqual({actual:{new:true}});
    const saved = await command('result',data.run.runId);
    expect(payload<{result:unknown}>(saved.response).result).toEqual(data.result);
    expect((await command('logs',data.run.runId,'--limit','2')).response.ok).toBe(true);
    expect(await readdir(join(directory,'.rpa','agent','workflows'))).toEqual([]);
    expect(JSON.parse(await readFile(join(directory,'flow.json'),'utf8'))).toEqual(definition);
  });
  it.each(['js','ts','py'])('执行 %s 文件，保留来源、工作目录、相邻模块及异步完成', async extension => {
    const source = join(directory,'中文 空格'); await mkdir(source);
    await json(join(source,'package.json'),{type:extension === 'js' ? 'module' : 'commonjs'});
    await mkdir(join(source,'node_modules','project-value'),{recursive:true});
    await json(join(source,'node_modules','project-value','package.json'),{name:'project-value',main:'index.js'});
    await writeFile(join(source,'node_modules','project-value','index.js'),'module.exports = { amount: 7 };');
    await json(join(directory,'vars.json'),{name:'订单'});
    if (extension === 'py') {
      await writeFile(join(source,'sibling.py'),'amount = 7\n');
      await writeFile(join(source,'task.py'),"from rpa_sdk import rpa\nimport sibling, os, sys\nrpa.output({'name': rpa.get('name'), 'amount': sibling.amount, 'cwd': os.getcwd(), 'entry': sys.argv[0]})\n");
    } else {
      await writeFile(join(source,`sibling.${extension}`),'export const extra = 1;');
      await writeFile(join(source,`task.${extension}`),`import { extra } from './sibling.${extension}';\nimport project from 'project-value';\nexport async function main(rpa${extension === 'ts' ? ': any' : ''}) { await new Promise(resolve => setTimeout(resolve, 50)); await rpa.output({name:await rpa.get('name'),amount:project.amount + extra - 1,cwd:process.cwd(),entry:process.argv[1]}); return 'ignored'; }`);
    }
    const result = await command('run',join(source,`task.${extension}`),'--variables','vars.json');
    expect(result.response.error).toBeUndefined();
    expect(payload<{result:unknown}>(result.response).result).toEqual({name:'订单',amount:7,cwd:directory,entry:join(source,`task.${extension}`)});
  });
  it('CommonJS 文件执行 main，XLSX RPC 登记产物并读取', async () => {
    await writeFile(join(directory,'task.js'),`exports.main = async function(rpa) { const path = require('node:path').resolve('report.xlsx'); await rpa.call('file.xlsxWrite',{path,rows:[{value:42}]}); await rpa.output(await rpa.call('file.xlsxRead',{path})); };`);
    const result = await command('run','task.js');
    expect(result.response.error).toBeUndefined();
    const data = payload<{run:RunSnapshot;result:unknown}>(result.response);
    expect(data.run.artifacts).toMatchObject([{path:join(directory,'report.xlsx')}]);
    expect(data.result).toEqual({sheetName:'Sheet1',rows:[{value:42}]});
  });
  it('通过相对路径选择项目 Python 虚拟环境，cwd 可与解释器目录不同', async () => {
    await new Promise<void>((resolve,reject) => {
      const child = spawn('python',['-m','venv','--without-pip',join(directory,'.venv')],{windowsHide:true,stdio:'ignore'});
      child.once('error',reject);child.once('close',code=>code===0 ? resolve() : reject(new Error(`创建虚拟环境失败：${code}`)));
    });
    await mkdir(join(directory,'business'));
    await writeFile(join(directory,'task.py'),'from rpa_sdk import rpa\nimport sys\nrpa.output(sys.prefix)\n');
    const executable = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    const result = await command('run','task.py','--python',executable,'--cwd','business');
    expect(result.response.error).toBeUndefined();
    expect(payload<{result:unknown}>(result.response).result).toBe(join(directory,'.venv'));
  });
  it('JSON 文件中的相对脚本按流程目录定位，cwd 可单独指定', async () => {
    await mkdir(join(directory,'flows')); await mkdir(join(directory,'business'));
    await writeFile(join(directory,'flows','task.js'),"exports.main = async rpa => rpa.output(process.cwd());");
    await json(join(directory,'flows','flow.json'),{...flow([{stepId:'code',name:'代码',actionType:'script.run',params:{language:'javascript',filePath:'./task.js'},output:'value'}]),outputs:['value']});
    const result = await command('run','flows/flow.json','--cwd','business');
    expect(result.response.error).toBeUndefined();
    expect(payload<{result:unknown}>(result.response).result).toEqual({value:join(directory,'business')});
  });
  it('显式依赖执行固定修订，缺失、重复和循环在启动前拒绝', async () => {
    const child = {...flow([{stepId:'set',name:'子输出',actionType:'variables.set',params:{name:'value',value:'{{input}}'}}]),workflowId:'child',revision:1,inputs:['input'],outputs:['value']};
    const parent = {...flow([{stepId:'call',name:'调用',actionType:'workflow.call',params:{workflowId:'child',revision:1,inputs:{input:42}},output:'childResult'}]),revision:1,outputs:['childResult']};
    await json(join(directory,'parent.json'),parent); await json(join(directory,'child.json'),child);
    expect((await command('check','parent.json')).response.error?.code).toBe('VALIDATION_FAILED');
    expect((await command('check','parent.json','--dependency','child.json','--dependency','child.json')).response.error?.code).toBe('INVALID_INPUT');
    const result = await command('run','parent.json','--dependency','child.json');
    expect(result.response.error).toBeUndefined();
    expect(payload<{result:unknown}>(result.response).result).toEqual({childResult:{value:42}});
    await json(join(directory,'child.json'),{...child,steps:[{stepId:'cycle',name:'循环',actionType:'workflow.call',params:{workflowId:'agent-test',revision:1,inputs:{}}}]});
    expect((await command('check','parent.json','--dependency','child.json','--dependency','parent.json')).response.error?.code).toBe('VALIDATION_FAILED');
  });
  it('缺少 main 和脚本异常返回运行失败，结束后目录锁可再次使用', async () => {
    await writeFile(join(directory,'task.js'),'exports.other = 1;');
    const missing = await command('run','task.js');
    expect(missing).toMatchObject({exitCode:1,response:{ok:false,error:{code:'EXECUTION_FAILED'}}});
    await writeFile(join(directory,'task.js'),"exports.main = async () => { throw new Error('业务失败'); };");
    expect((await command('run','task.js')).response.error?.message).toContain('业务失败');
    await writeFile(join(directory,'task.js'),'exports.main = async rpa => rpa.output(1);');
    expect((await command('run','task.js')).exitCode).toBe(0);
  });
});

describe('Agent 收尾与并发保护', () => {
  it('失败的浏览器流程关闭会话后才返回最终快照', async () => {
    const fixture = await startFixtureServer();
    try {
      await json(join(directory,'flow.json'),flow([{stepId:'open',name:'打开',actionType:'browser.open',params:{url:fixture.url}},{stepId:'fail',name:'失败',actionType:'core.assert',params:{actual:1,expected:2}}]));
      const result = await command('run','flow.json');
      expect(result).toMatchObject({exitCode:1,response:{error:{code:'EXECUTION_FAILED'}}});
      expect(payload<{run:RunSnapshot}>(result.response).run).toMatchObject({status:'failed',browserOpen:false});
    } finally {await fixture.close();}
  });
  it('保存或清理失败不能返回成功，失败后仍释放写锁', async () => {
    await json(join(directory,'flow.json'),flow());
    const flush = vi.spyOn(WorkbenchStore.prototype,'flush').mockRejectedValue(new Error('受控写入失败'));
    let result;
    try {result = await command('run','flow.json');} finally {flush.mockRestore();}
    expect(result).toMatchObject({exitCode:1,response:{ok:false,error:{code:'CLEANUP_FAILED'}}});
    expect((await command('run','flow.json')).exitCode).toBe(0);
  });
  it('人工等待停止并保存原始原因', async () => {
    await json(join(directory,'flow.json'),flow([{stepId:'manual',name:'人工',actionType:'core.assert',params:{actual:1,expected:2},onError:'manual'}]));
    const result = await command('run','flow.json');
    expect(result).toMatchObject({exitCode:1,response:{error:{code:'MANUAL_REQUIRED'}}});
    const data = payload<{run:RunSnapshot;reason:{message:string}}>(result.response);
    expect(data.run).toMatchObject({status:'stopped',browserOpen:false});
    expect(data.reason.message).toContain('结果校验失败');
    expect(payload<{reason:unknown}>((await command('result',data.run.runId)).response).reason).toEqual(data.reason);
  });
  it('总超时和调用者取消停止当前任务，不留下活动状态', async () => {
    await json(join(directory,'flow.json'),flow([{stepId:'log',name:'日志',actionType:'core.log',params:{message:'started'}},{stepId:'wait',name:'等待',actionType:'core.wait',params:{durationSeconds:10}}]));
    const timeout = await command('run','flow.json','--timeout-ms','250');
    expect(timeout).toMatchObject({exitCode:1,response:{error:{code:'TIMEOUT'}}});
    expect(payload<{run:RunSnapshot}>(timeout.response).run.status).toBe('stopped');
    const controller = new AbortController(); context.signal = controller.signal; context.onLog = message => { if (message === 'started') controller.abort(); };
    const cancelled = await command('run','flow.json');
    expect(cancelled).toMatchObject({exitCode:1,response:{error:{code:'CANCELLED'}}});
    expect(payload<{run:RunSnapshot}>(cancelled.response).run.status).toBe('stopped');
  });
  it('同目录写入互斥，查询不恢复活动运行，不同目录可执行', async () => {
    const data = join(directory,'shared'); const manager = new RunManager({dataDir:data,rootDir:root,autoStartSchedules:false}); managers.push(manager); await manager.initialize();
    const queued = await manager.runWorkflowSnapshot(flow([{stepId:'wait',name:'等待',actionType:'core.wait',params:{durationSeconds:10}}]),{});
    await json(join(directory,'flow.json'),flow());
    expect((await command('run','flow.json','--data','shared')).response.error?.code).toBe('DATA_DIR_BUSY');
    const query = await command('runs',queued.runId,'--data','shared');
    expect(payload<RunSnapshot>(query.response).status).not.toBe('interrupted');
    expect((await command('run','flow.json','--data','other')).exitCode).toBe(0);
    await manager.shutdown();
    expect((await command('run','flow.json','--data','shared')).exitCode).toBe(0);
  });
  it('独立 CLI 从仓库外输出唯一 JSON，日志仅写 stderr', async () => {
    await json(join(directory,'flow.json'),flow([{stepId:'log',name:'日志',actionType:'core.log',params:{message:'只在 stderr'}}]));
    const require = createRequire(join(root,'package.json'));
    const result = await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject) => {
      const child = spawn(process.execPath,['--import',pathToFileURL(require.resolve('tsx')).href,join(root,'apps','runner','src','agent-cli.ts'),'run','flow.json'],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout = ''; let stderr = '';
      child.stdout.on('data',chunk => {stdout += String(chunk);}); child.stderr.on('data',chunk => {stderr += String(chunk);});
      child.once('error',reject); child.once('close',code => resolve({code,stdout,stderr}));
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({apiVersion:1,ok:true});
    expect(result.stderr).toContain('只在 stderr');
  });
});
