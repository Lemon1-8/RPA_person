import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export async function acquireDataLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const canonical = await realpath(directory);
  const busy = () => Object.assign(new Error(`运行数据目录正被其他运行器占用：${canonical}`), { code: 'DATA_DIR_BUSY' });
  if (process.platform !== 'win32') {
    const path = join(canonical, '.runner.lock');
    const file = await open(path, 'wx').catch(error => { if (error.code === 'EEXIST') throw busy(); throw error; });
    return async () => { await file.close(); await unlink(path); };
  }
  const name = `Global\\PersonalRpaData-${createHash('sha256').update(canonical.toLowerCase()).digest('hex')}`;
  const script = `$ErrorActionPreference='Stop';$mutex=New-Object System.Threading.Mutex($false,'${name}');$owned=$false
try {try {$owned=$mutex.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$owned=$true}
if(!$owned){[Console]::Out.WriteLine('busy');exit 2}
[Console]::Out.WriteLine('ready');[void][Console]::In.ReadToEnd()
} finally {if($owned){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  child.stdin.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''; let error = '';
      const timer = setTimeout(() => reject(new Error('获取运行数据目录锁超时')), 10_000);
      const finish = (cause?: Error) => { clearTimeout(timer); cause ? reject(cause) : resolve(); };
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('busy')) finish(busy()); else if (output.includes('ready')) finish(); });
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
      child.once('error', finish);
      child.once('exit', () => finish(new Error(error || '运行数据目录锁进程退出')));
    });
  } catch (error) { child.kill(); await exited; throw error; }
  return async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000);
    await exited; clearTimeout(timer);
  };
}
