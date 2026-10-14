import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDataLock } from '../apps/runner/src/data-lock.js';
import { RunManager } from '../apps/runner/src/manager.js';

let directory: string;
let owner: ChildProcess | undefined;
const releases: (()=>Promise<void>)[] = [];
beforeEach(async () => {directory = await mkdtemp(join(tmpdir(),'rpa-data-lock-'));});
afterEach(async () => {
  owner?.kill(); owner = undefined;
  for (const release of releases.splice(0)) await release();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('rpa-data-lock-')) throw new Error('拒绝清理非测试目录');
  await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
it('规范化目录互斥，释放后可取得，其他目录不受影响', async () => {
  const release = await acquireDataLock(directory);
  try {
    await expect(acquireDataLock(join(directory,'.'))).rejects.toMatchObject({code:'DATA_DIR_BUSY'});
    releases.push(await acquireDataLock(join(directory,'other')));
  } finally {await release();}
  releases.push(await acquireDataLock(directory));
});
it('初始化恢复失败也释放目录锁', async () => {
  await mkdir(join(directory,'runs','bad'),{recursive:true}); await writeFile(join(directory,'runs','bad','run.json'),'{');
  const manager = new RunManager({dataDir:directory,autoStartSchedules:false});
  await expect(manager.initialize()).rejects.toThrow();
  releases.push(await acquireDataLock(directory));
  await manager.shutdown();
});
it('退出失败后重试仍须取得写锁，不能与新运行器同时刷新', async () => {
  const manager = new RunManager({dataDir:directory,autoStartSchedules:false});await manager.initialize();
  await expect(manager.initialize()).rejects.toThrow('已初始化');
  const flush = vi.spyOn(manager.store,'flush').mockRejectedValueOnce(new Error('受控退出失败'));
  await expect(manager.shutdown()).rejects.toThrow('受控退出失败');flush.mockRestore();
  const release = await acquireDataLock(directory);
  try {await expect(manager.shutdown()).rejects.toMatchObject({code:'DATA_DIR_BUSY'});}
  finally {await release();}
  await manager.shutdown();
});
it.skipIf(process.platform !== 'win32')('持有者进程崩溃后 Windows 自动释放锁，无需清理残留文件', async () => {
  const require = createRequire(join(process.cwd(),'package.json'));
  const module = pathToFileURL(join(process.cwd(),'apps','runner','src','data-lock.ts')).href;
  const entry = join(directory,'owner.mjs');
  await writeFile(entry,`import {acquireDataLock} from ${JSON.stringify(module)};await acquireDataLock(${JSON.stringify(directory)});process.send({ready:true});setInterval(()=>{},1000);`);
  owner = spawn(process.execPath,['--import',pathToFileURL(require.resolve('tsx')).href,entry],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  await new Promise<void>((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('等待锁持有者超时')),10_000);
    owner!.once('message',()=>{clearTimeout(timer);resolve();});owner!.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  await expect(acquireDataLock(directory)).rejects.toMatchObject({code:'DATA_DIR_BUSY'});
  const exited = new Promise(resolve => owner!.once('exit',resolve));owner.kill('SIGKILL');await exited;owner=undefined;
  const deadline = Date.now()+5000;
  for (;;) {
    try {releases.push(await acquireDataLock(directory));break;}
    catch (error) {if((error as {code?:string}).code!=='DATA_DIR_BUSY' || Date.now()>deadline)throw error;await delay(50);}
  }
});
