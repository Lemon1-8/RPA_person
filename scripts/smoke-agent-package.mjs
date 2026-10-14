import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const version = JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const tgz = join(root,'dist','releases',`personal-rpa-runtime-${version}.tgz`);
await stat(tgz);
const directory = await mkdtemp(join(tmpdir(),'rpa-agent-package-'));
const prefix = join(directory,'installed');
const project = join(directory,'中文 项目');
const env = {...process.env};
for (const key of ['RPA_ROOT','RPA_DATA_DIR','RPA_SCRIPT_CHILD','NODE_PATH','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) delete env[key];
const execute = (command,args,cwd=project) => new Promise((resolve,reject) => {
  const child = spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout = ''; let stderr = '';
  child.stdout.on('data',chunk => {stdout += String(chunk);}); child.stderr.on('data',chunk => {stderr += String(chunk);});
  child.once('error',reject); child.once('close',code => code === 0 ? resolve({stdout,stderr}) : reject(new Error(`退出码 ${code}\n${stdout.slice(-6000)}\n${stderr.slice(-6000)}`)));
});
const server = createServer((_request,response) => {response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<div id="status">安装包验证成功</div>');});
try {
  await mkdir(project,{recursive:true});
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请通过 npm run test:agent-package 执行');
  console.log('正在仓库外安装运行时（联网获取依赖）');
  await execute(process.execPath,[npm,'install','-g','--prefix',prefix,'--no-audit','--no-fund',tgz]);
  const installed = join(prefix,'node_modules','personal-rpa-runtime');
  const cli = join(installed,'dist','runner','agent.cjs');
  const call = async (...args) => {
    const output = await execute(process.execPath,[cli,...args]);
    assert.equal(output.stdout.trim().split('\n').length,1,'stdout 必须是唯一 JSON');
    const response = JSON.parse(output.stdout);assert.equal(response.apiVersion,1);assert.equal(response.ok,true,JSON.stringify(response));return response.data;
  };
  const manifest = JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
  for (const name of ['electron','react','vite','typescript']) assert.ok(!manifest.dependencies[name],`${name} 不应是运行依赖`);
  assert.equal(await stat(join(installed,'node_modules','electron')).then(()=>true,()=>false),false);
  const quote = text => `'${text.replaceAll("'","''")}'`;
  const shim = join(prefix,'rpa-agent.cmd');
  const shimDoctor = await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(`& ${quote(shim)} doctor`,'utf16le').toString('base64')]);
  assert.equal(JSON.parse(shimDoctor.stdout).ok,true,'npm 命令 shim 必须可用');
  assert.ok((await call('doctor')).runtimeRoot.toLowerCase() === installed.toLowerCase());
  await call('setup-browser');
  assert.equal((await call('actions','desktop.mouseMove')).scriptRpc,true);
  await call('schema'); assert.deepEqual(await call('runs'),[]);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(project,'package.json'),JSON.stringify({type:'module'}));
  for (const extension of ['json','js','ts','py']) {
    const asset = extension === 'json' ? 'workflow.json' : `web-export.${extension}`;
    const entry = join(installed,'skills','personal-rpa','assets',asset);
    const variables = {url,selector:'#status',reportFile:join(project,`report-${extension}.xlsx`)};
    const inputs = join(project,'inputs.json'); await writeFile(inputs,JSON.stringify(variables));
    await call('check',entry,'--variables',inputs);
    const data = await call('run',entry,'--variables',inputs,'--headless','--output',join(project,'downloads'));
    assert.equal(data.run.status,'succeeded');assert.equal(data.run.browserOpen,false);assert.equal(data.result.text,'安装包验证成功');
    assert.ok((await stat(variables.reportFile)).size>0);
    assert.equal((await call('result',data.run.runId)).result.text,'安装包验证成功');
    assert.ok((await call('logs',data.run.runId,'--limit','2')).events.length>0);
    console.log(`安装包 ${extension} 入口、浏览器、XLSX、产物与查询通过`);
  }
  await mkdir(join(project,'node_modules','project-value'),{recursive:true});
  await writeFile(join(project,'node_modules','project-value','package.json'),JSON.stringify({main:'index.js'}));
  await writeFile(join(project,'node_modules','project-value','index.js'),'module.exports = 41;');
  await writeFile(join(project,'sibling.ts'),'export const value: number = 1;');
  await writeFile(join(project,'module.ts'),"import value from 'project-value';import {value as extra} from './sibling.ts';export async function main(rpa: any){await new Promise(r=>setTimeout(r,25));await rpa.output(value+extra);}");
  assert.equal((await call('run','module.ts')).result,42);
  const skill = await readFile(join(installed,'skills','personal-rpa','SKILL.md'),'utf8');assert.ok(skill.includes('name: personal-rpa'));
  const zip = join(root,'dist','releases',`personal-rpa-plugin-${version}.zip`);
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead(${quote(zip)});try {ConvertTo-Json -InputObject @($zip.Entries | ForEach-Object {$_.FullName})} finally {$zip.Dispose()}`;
  const files = JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')])).stdout).map(file=>file.replaceAll('\\','/'));
  assert.ok(files.includes('plugin.json'));assert.ok(files.includes('skills/personal-rpa/SKILL.md'));
  console.log('仓库外安装、命令 shim、项目模块、Skill 与插件 ZIP 验证通过；未启动 Electron');
} finally {
  await new Promise(resolve => server.close(resolve));
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-agent-package-')) throw new Error('拒绝清理验收目录以外的路径');
  await rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
