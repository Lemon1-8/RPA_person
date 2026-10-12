import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,dirname,basename } from 'node:path';
import assert from 'node:assert/strict';
import { WorkbenchStore } from '../packages/persistence/src/workbench.js';
const data=await mkdtemp(join(tmpdir(),'rpa-history-ui-'));const root=process.cwd();const env={...process.env,RPA_ROOT:root,RPA_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;let app;
try{
  const store=new WorkbenchStore(data);await store.initialize();const workflow=await store.saveWorkflow({schemaVersion:1,workflowId:'history',name:'历史日志验收',revision:0,variables:{},elements:{},settings:{downloadDir:data,headless:true,keepBrowserOpen:false},steps:[]});
  await store.createRun(workflow,{runId:'historic',workflowId:'history',workflowName:workflow.name,revision:1,startedAt:new Date().toISOString(),status:'succeeded',variables:{value:true},artifacts:[],browserOpen:false});
  for(let index=0;index<5001;index++)await store.recordEvent({type:'log',runId:'historic',eventId:`log-${index}`,at:new Date().toISOString(),message:`历史日志 ${index}`});await store.flush();
  app=await electron.launch({executablePath:createRequire(import.meta.url)('electron'),args:['.'],cwd:root,env});const page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.getByRole('heading',{name:workflow.name,exact:true}).waitFor();await page.getByRole('button',{name:'查看运行结果',exact:true}).click();
  const monitor=page.getByRole('region',{name:'运行监控',exact:true});await monitor.locator('.log-count').filter({hasText:'200'}).waitFor();
  await monitor.getByText('历史',{exact:true}).click();for(let index=0;index<2;index++){await page.getByRole('button',{name:'加载更早日志',exact:true}).click();await monitor.locator('.log-count').filter({hasText:String(400+200*index)}).waitFor({state:'attached'});}
  assert.ok(await monitor.locator('.log-line').count()<100,'历史日志应窗口化渲染');await monitor.getByRole('textbox',{name:'搜索运行日志'}).fill('历史日志 0');await monitor.locator('.log-line').filter({hasText:'历史日志 0'}).waitFor();
  await monitor.getByRole('textbox',{name:'搜索运行日志'}).fill('');await monitor.getByRole('tab',{name:'变量',exact:true}).click();await monitor.locator('.value-viewer').getByText('value',{exact:true}).waitFor();
  await mkdir(resolve('.rpa/qa'),{recursive:true});await page.screenshot({path:resolve('.rpa/qa/history-normal.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1000,760));await page.screenshot({path:resolve('.rpa/qa/history-minimum.png')});await monitor.getByRole('tab',{name:'运行日志',exact:true}).click();await monitor.getByText('历史',{exact:true}).click();const menu=page.getByRole('region',{name:'历史日志工具',exact:true});await menu.waitFor();const bounds=await menu.boundingBox();assert.ok(bounds && bounds.y>=0 && bounds.y+bounds.height<=await page.evaluate(()=>innerHeight));await page.screenshot({path:resolve('.rpa/qa/log-menu-minimum.png')});assert.deepEqual(errors,[]);console.log('5001 条历史日志分页、搜索、窗口化及变量查询验收通过');
  const maintained = { ...workflow, elements: { 旧元素: { selector: '#old' } }, steps: [
    { stepId: 'reader', name: '读取文本', actionType: 'browser.text', params: { selector: '@旧元素' }, recoveryChecks: [{ stepId: 'verify', name: '恢复核查', actionType: 'browser.text', params: { selector: '@旧元素' } }] },
    { stepId: 'script', name: '脚本位置', actionType: 'script.run', params: { language: 'javascript', code: 'rpa.call("browser.text", {selector:"@旧元素"})' } },
  ] };
  await page.evaluate(flow => window.rpa.saveWorkflow(flow), maintained); await page.reload();
  await page.getByRole('heading', { name: workflow.name, exact: true }).waitFor();
  await page.getByRole('button', { name: '步骤 1：读取文本', exact: true }).click();
  await page.getByRole('button', { name: '元素', exact: true }).click();
  const library = page.getByRole('region', { name: '网页元素库', exact: true });
  await library.getByLabel('网页元素保存范围').selectOption('workflow');
  await library.getByText('旧元素', { exact: true }).waitFor(); await library.getByRole('button', { name: '编辑', exact: true }).click();
  await library.getByLabel('元素名称').fill('新元素'); await library.getByRole('button', { name: '保存网页元素', exact: true }).click();
  await library.getByText(/脚本中的旧名称需人工更新：脚本位置/).waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click(); await page.getByText('未保存', { exact: true }).waitFor({ state: 'hidden' });
  const saved = (await page.evaluate(() => window.rpa.bootstrap())).workflows.find(flow => flow.workflowId === workflow.workflowId)!;
  assert.ok(saved.elements.新元素); assert.equal(saved.steps[0].params.selector, '@新元素'); assert.equal(saved.steps[0].recoveryChecks?.[0].params.selector, '@新元素'); assert.equal(saved.steps[1].params.code, maintained.steps[1].params.code);
  assert.deepEqual(errors, []); console.log('全局网页元素重命名、恢复检查引用及脚本人工检查提示验收通过');
}finally{await app?.close();if(dirname(resolve(data))!==resolve(tmpdir()) || !basename(data).startsWith('rpa-history-ui-'))throw new Error('拒绝清理非验收目录');await rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
