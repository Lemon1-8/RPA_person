import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { RunManager } from '../apps/runner/src/manager.js';
import { readdir,stat } from 'node:fs/promises';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';
const data = await mkdtemp(join(tmpdir(),'rpa-runtime-benchmark-'));
const label = process.argv[2] ?? 'after'; if (!['before','after'].includes(label)) throw new Error('参数只能为 before 或 after');
let events = 0, ipcBytes = 0, snapshotPayloadBytes = 0, peakRss = process.memoryUsage().rss;
const started = performance.now(); const monitor = setInterval(() => { peakRss = Math.max(peakRss,process.memoryUsage().rss); },20);
try {
  const workflow: WorkflowDefinition = { schemaVersion:1,workflowId:'benchmark',name:'万行三步',revision:1,variables:{ rows:Array.from({length:10000},(_,id) => ({id})) },elements:{},settings:{ downloadDir:data,headless:true,keepBrowserOpen:false },steps:[{ stepId:'loop',name:'逐行',actionType:'control.forEach',params:{items:'{{rows}}',itemVariable:'item'},timeoutMs:600000,children:[
    { stepId:'one',name:'读取',actionType:'variables.set',params:{name:'last',value:'{{item.id}}'} },
    { stepId:'two',name:'校验',actionType:'core.assert',params:{actual:'{{last}}',expected:'{{item.id}}'} },
    { stepId:'three',name:'输出',actionType:'variables.set',params:{name:'output',value:'{{last}}'} },
  ]}] };
  const results = await Promise.all([1,2].map(id => new WorkflowEngine(workflow,{dataDir:data,runId:`bench-${id}`,onEvent:event => { events++; ipcBytes += Buffer.byteLength(JSON.stringify(event)); if(event.run) snapshotPayloadBytes += Buffer.byteLength(JSON.stringify(event.run,null,2)); }}).run()));
  if (results.some(result => result.status !== 'succeeded' || result.variables.last !== 9999)) throw new Error(JSON.stringify(results.map(result => ({status:result.status,error:result.error}))));
  const metrics = { label, rows:10000,stepsPerRow:3,concurrentFlows:2,execution:'两个并发执行器，共用 Node 进程',durationMs:Math.round(performance.now()-started),peakRssBytes:peakRss,events,ipcBytes,snapshotPayloadBytes,diskMeasurement:'载荷计数基线，不向磁盘写入重复大快照；物理落盘由存储行为测试验证',resultHashes:results.map(result => createHash('sha256').update(JSON.stringify(result.variables)).digest('hex')) };
  if(label==='after' && process.argv.includes('--physical')) {
    const manager=new RunManager({dataDir:data,maxConcurrent:2,schedulePollMs:0});await manager.initialize();let snapshotWrites=0,snapshotWriteBytes=0,actualIpcBytes=0;
    const save=manager.store.saveRun.bind(manager.store);manager.store.saveRun=async run=>{snapshotWrites++;snapshotWriteBytes+=2*Buffer.byteLength(JSON.stringify(run,null,2)+'\n');return save(run);};
    manager.on('event',event=>{actualIpcBytes+=Buffer.byteLength(JSON.stringify(event));});const physicalStarted=performance.now();
    try {
      const flows=await Promise.all([1,2].map(id=>manager.saveWorkflow({...workflow,workflowId:`physical-${id}`,revision:0})));
      const runs=await Promise.all(flows.map(flow=>manager.runWorkflow(flow)));const final=await Promise.all(runs.map(run=>manager.waitForRun(run.runId)));
      if(final.some(run=>run.status!=='succeeded' || run.variables.last!==9999)) throw new Error('实际落盘性能流程失败');
      const bytes=async(path:string):Promise<number>=>{let size=0;for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())size+=await bytes(file);else size+=(await stat(file)).size;}return size;};
      Object.assign(metrics,{physical:{execution:'两个独立任务进程，真实 JSON/JSONL 存储',durationMs:Math.round(performance.now()-physicalStarted),actualIpcBytes,snapshotWrites,snapshotWriteBytes,finalFileBytes:await bytes(data),resultHashes:final.map(run=>createHash('sha256').update(JSON.stringify(run.variables)).digest('hex'))}});
    }finally{await manager.shutdown();}
  }
  await mkdir(resolve('.rpa/qa'),{recursive:true}); await writeFile(resolve(`.rpa/qa/performance-${label}.json`),JSON.stringify(metrics,null,2)); console.log(JSON.stringify(metrics));
} finally {
  clearInterval(monitor); if(dirname(resolve(data))!==resolve(tmpdir()) || !basename(data).startsWith('rpa-runtime-benchmark-')) throw new Error('拒绝清理非性能测试目录');
  await rm(data,{recursive:true,force:true});
}
