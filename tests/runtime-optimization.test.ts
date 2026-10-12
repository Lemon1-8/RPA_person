import { afterEach,describe,it,expect,vi } from 'vitest';
import { mkdir,mkdtemp,rm,readFile,writeFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,basename,dirname,resolve } from 'node:path';
import { RunManager } from '../apps/runner/src/manager.js';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { mergeRunEvent } from '../packages/contracts/src/run-events.js';
import { startFixtureServer } from './fixtures/server.js';
import type { WorkflowDefinition,RunEvent,RunSnapshot } from '../packages/contracts/src/index.js';
const dirs:string[]=[];const managers:RunManager[]=[];
afterEach(async()=>{await Promise.all(managers.splice(0).map(manager=>manager.shutdown()));for(const directory of dirs.splice(0)){if(dirname(resolve(directory))!==resolve(tmpdir()) || !basename(directory).startsWith('rpa-optimization-')) throw new Error('拒绝清理非测试目录');await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
async function setup(){const dataDir=await mkdtemp(join(tmpdir(),'rpa-optimization-'));dirs.push(dataDir);const manager=new RunManager({dataDir,schedulePollMs:0});managers.push(manager);await manager.initialize();return manager;}
const flow=(dataDir:string,id='flow'):WorkflowDefinition=>({schemaVersion:1,workflowId:id,name:id,revision:0,variables:{},elements:{},settings:{downloadDir:dataDir,headless:true,keepBrowserOpen:false},steps:[]});
describe('运行开销与流程复用',()=>{
  it('万行输入仅在初始增量和终态传递，增量可重建完整变量及删除',async()=>{
    const manager=await setup();const definition={...flow(manager.store.directory),variables:{rows:Array.from({length:10000},(_,id)=>({id}))},steps:[{stepId:'loop',name:'循环',actionType:'control.forEach',params:{items:[1,2,3],itemVariable:'item'},children:[{stepId:'set',name:'设置',actionType:'variables.set',params:{name:'last',value:'{{item}}'}}]}]};
    const events:RunEvent[]=[];let merged:RunSnapshot|undefined;
    const engine=new WorkflowEngine(definition,{dataDir:manager.store.directory,runId:'delta',onEvent:event=>{events.push(event);merged=mergeRunEvent(merged,event);}});
    const result=await engine.run();expect(merged?.variables).toEqual(result.variables);expect(result.variables.item).toBeUndefined();
    const running=events.filter(event=>event.run?.status==='running');expect(running.filter(event=>event.variableChanges?.rows)).toHaveLength(1);expect(running.every(event=>Object.keys(event.run!.variables).length===0)).toBe(true);
    expect(running.slice(1).every(event=>JSON.stringify(event).length<2000)).toBe(true);
    const warningEvents:RunEvent[]=[];let warningSnapshot:RunSnapshot|undefined;
    const warningEngine=new WorkflowEngine({...flow(manager.store.directory),steps:[{stepId:'loop',name:'警告循环',actionType:'control.forEach',params:{items:[1,2,3],itemVariable:'item'},children:[{stepId:'fail',name:'校验失败',actionType:'core.assert',params:{actual:1,expected:2},onError:'continue'}]}]},{dataDir:manager.store.directory,runId:'warnings',onEvent:event=>{warningEvents.push(event);warningSnapshot=mergeRunEvent(warningSnapshot,event);}});
    const warned=await warningEngine.run();expect(warningSnapshot?.warnings).toEqual(warned.warnings);expect(warned.warningCount).toBe(3);expect(warningEvents.filter(event=>event.warningChanges).flatMap(event=>event.warningChanges!)).toHaveLength(3);
  });
  it('大结果独立落盘可查询，普通状态合并保存且日志完整有序',async()=>{
    const manager=await setup();const saved=await manager.saveWorkflow({...flow(manager.store.directory),steps:[{stepId:'large',name:'大结果',actionType:'variables.set',params:{name:'large',value:'字'.repeat(40000)}},{stepId:'loop',name:'循环',actionType:'control.forEach',params:{items:Array.from({length:200},(_,id)=>id),itemVariable:'item'},children:[{stepId:'set',name:'设置',actionType:'variables.set',params:{name:'last',value:'{{item}}'}}]}]});
    const save=vi.spyOn(manager.store,'saveRun');const events:RunEvent[]=[];manager.on('event',event=>events.push(event));
    const run=await manager.runWorkflow(saved);const result=await manager.waitForRun(run.runId);expect(result.status,result.error).toBe('succeeded');expect(result.variables.last).toBe(199);
    expect(save.mock.calls.length).toBeLessThan(15);const event=events.find(event=>event.stepId==='large' && event.status==='succeeded')!;const resultId=(event.data as {resultId:string}).resultId;expect(resultId).toBeTruthy();expect((event.data as {result?:unknown}).result).toBeUndefined();expect(await manager.store.getStepResult(run.runId,resultId)).toBe('字'.repeat(40000));
    const rows=await manager.store.getRunEvents(run.runId,{limit:1000});expect(rows.events.length).toBeGreaterThan(600);expect(new Set(rows.events.map(event=>event.sequence)).size).toBe(rows.events.length);expect((await stat(join(manager.store.directory,'runs',run.runId,'events.jsonl'))).size).toBeLessThan(1000000);
  });
  it('子流程共享浏览器，固定修订与局部声明只返回显式输出',async()=>{
    const manager=await setup();const fixture=await startFixtureServer();
    try{
      const child=await manager.saveWorkflow({...flow(manager.store.directory,'child'),inputs:['name'],outputs:['answer'],variables:{local:'私有'},steps:[{stepId:'text',name:'读取页面',actionType:'browser.text',params:{selector:'body'},output:'pageText'},{stepId:'out',name:'输出',actionType:'variables.set',params:{name:'answer',value:'{{name}}'}}]});
      const parent=await manager.saveWorkflow({...flow(manager.store.directory,'parent'),variables:{name:'父变量'},steps:[{stepId:'open',name:'打开',actionType:'browser.open',params:{url:fixture.url}},{stepId:'call',name:'子流程',actionType:'workflow.call',params:{workflowId:child.workflowId,revision:child.revision,inputs:{name:'输入'}},output:'childResult'}]});
      await manager.saveWorkflow({...child,outputs:['changed']});const run=await manager.runWorkflow(parent);const result=await manager.waitForRun(run.runId);expect(result.status,result.error).toBe('succeeded');expect(result.variables).toEqual({name:'父变量',childResult:{answer:'输入'}});expect(Object.keys(await manager.store.readDependencies(result) ?? {})).toEqual(['child@1']);
    }finally{await fixture.close();}
  });
  it('拒绝循环调用、缺失修订和未声明输入，子流程遵守停止与超时',async()=>{
    const manager=await setup();const child=await manager.saveWorkflow({...flow(manager.store.directory,'child'),steps:[{stepId:'wait',name:'等待',actionType:'core.wait',params:{durationSeconds:5}}]});
    const parent=await manager.saveWorkflow({...flow(manager.store.directory,'parent'),steps:[{stepId:'call',name:'调用',actionType:'workflow.call',timeoutMs:100,params:{workflowId:child.workflowId,revision:1,inputs:{}}}]});
    const run=await manager.runWorkflow(parent);expect((await manager.waitForRun(run.runId)).status).toBe('failed');
    const looping=await manager.saveWorkflow({...parent,steps:[{...parent.steps[0],params:{workflowId:'parent',revision:2,inputs:{}}}]});await expect(manager.runWorkflow(looping)).rejects.toThrow('循环调用');
    const missing=await manager.saveWorkflow({...looping,steps:[{...parent.steps[0],params:{workflowId:'child',revision:99,inputs:{}}}]});await expect(manager.runWorkflow(missing)).rejects.toThrow('不存在');
    const badInput=await manager.saveWorkflow({...missing,steps:[{...parent.steps[0],params:{workflowId:'child',revision:1,inputs:{unexpected:true}}}]});const badRun=await manager.runWorkflow(badInput);expect((await manager.waitForRun(badRun.runId)).error).toContain('未声明输入');
    expect((await manager.preflightWorkflow(badInput)).some(issue=>issue.level==='error' && issue.message.includes('未声明输入'))).toBe(true);
    const stoppable=await manager.saveWorkflow({...badInput,steps:[{...parent.steps[0],timeoutMs:10000}]});const stopping=await manager.runWorkflow(stoppable);await expect.poll(()=>manager.listRuns().find(run=>run.runId===stopping.runId)?.status,{timeout:10000}).toBe('running');await manager.controlRun(stopping.runId,'stop');expect((await manager.waitForRun(stopping.runId)).status).toBe('stopped');
  });
  it('清理仅移除归档记录，保留业务文件与固定计划引用修订',async()=>{
    const manager=await setup();const first=await manager.saveWorkflow(flow(manager.store.directory));const second=await manager.saveWorkflow({...first,name:'新版本'});
    await manager.saveSchedule({scheduleId:'pin',workflowId:first.workflowId,name:'固定',kind:'daily',time:'09:00',enabled:false,revision:1});
    const run=await manager.runWorkflow(second);await manager.waitForRun(run.runId);await manager.archiveRun(run.runId,true);
    const artifact=join(manager.store.directory,'runs',run.runId,'business.csv');await writeFile(artifact,'业务产物');
    const jsonArtifact=join(manager.store.directory,'runs',run.runId,'results','business.json');await mkdir(dirname(jsonArtifact),{recursive:true});await writeFile(jsonArtifact,'{"business":true}');
    const snapshot=await manager.store.readRunSnapshot(run.runId);await manager.store.saveRun({...snapshot,artifacts:[{path:jsonArtifact,name:'business.json',size:17}]});await manager.shutdown();
    const reopened=new RunManager({dataDir:manager.store.directory,schedulePollMs:0});managers.push(reopened);await reopened.initialize();
    const preview=await reopened.previewCleanup([run.runId],[{workflowId:first.workflowId,revision:1}]);expect(preview.protected[0]).toContain('固定计划');expect(preview.runIds).toEqual([run.runId]);expect(preview.files).not.toContain(jsonArtifact);await reopened.applyCleanup(preview.token);
    expect(await readFile(artifact,'utf8')).toBe('业务产物');expect(await readFile(jsonArtifact,'utf8')).toBe('{"business":true}');expect((await reopened.store.getRevision(first.workflowId,1)).revision).toBe(1);expect(reopened.listRuns()).toHaveLength(0);
    await reopened.deleteWorkflow(first.workflowId);expect((await reopened.store.getRevision(first.workflowId,2)).revision).toBe(2);
  });
});
