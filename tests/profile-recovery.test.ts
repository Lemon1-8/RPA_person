import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { afterEach, expect, it } from 'vitest';
import { BrowserSession } from '../packages/browser/src/index.js';
import { resolveBrowser } from '../packages/browser/src/native-browser.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setupProfile() {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-profile-recovery-'));
  cleanups.push(async () => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-profile-recovery-')) throw new Error('拒绝删除测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  });
  const profileDir = join(directory, 'profile'); await mkdir(profileDir);
  const lockPath = join(profileDir, '.rpa-profile.lock');
  const options = { profileDir, downloadDir: join(directory, 'downloads'), headless: true, browserChannel: 'chromium' as const };
  const session = (runId: string) => {
    const browser = new BrowserSession({ ...options, runId });
    cleanups.push(() => browser.close()); return browser;
  };
  return { directory, profileDir, lockPath, options, session };
}

async function exitedOwnerPid() {
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid));'], {
    windowsHide: true, timeout: 5_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const pid = Number(stdout);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('未取得测试子进程PID');
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
}

async function writeOldLease(lockPath: string, pid: number) {
  const lease = { token: randomUUID(), pid, runId: 'exited-owner', createdAt: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(lease)); return lease;
}

function waitMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('error', error); child.off('exit', exit); };
    const message = (value: unknown) => {
      if (value && typeof value === 'object' && (value as { type?: string }).type === type) { cleanup(); resolve(value as Record<string, unknown>); }
    };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const exit = (code: number | null) => error(new Error(`测试子进程提前退出：${code}`));
    const timer = setTimeout(() => error(new Error(`等待测试子进程 ${type} 消息超时`)), 30_000);
    child.on('message', message); child.once('error', error); child.once('exit', exit);
  });
}

function waitExit(child: ChildProcess, milliseconds = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off('exit', done); reject(new Error('测试子进程退出超时')); }, milliseconds);
    child.once('exit', done);
  });
}

function waitOutput(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const cleanup = () => { clearTimeout(timer); child.stdout?.off('data', receive); child.off('error', error); child.off('exit', exit); };
    const receive = (chunk: Buffer) => { output += chunk.toString(); if (output.includes(marker)) { cleanup(); resolve(); } };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const exit = (code: number | null) => error(new Error(`等待 ${marker} 时测试子进程提前退出：${code}`));
    const timer = setTimeout(() => error(new Error(`等待 ${marker} 输出超时`)), 20_000);
    child.stdout?.on('data', receive); child.once('error', error); child.once('exit', exit);
  });
}

async function stopOwnedProcess(pid: number) {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => {
      try { process.kill(pid, 0); } catch { return; } throw error;
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
  }
}

function childProcess(code: string, input: Record<string, unknown>) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(input)], {
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.stderr?.resume();
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) child.send({ type: 'release' });
    try { await waitExit(child, 8_000); }
    catch { if (child.pid) await stopOwnedProcess(child.pid); await waitExit(child); }
  });
  return child;
}

it.skipIf(process.platform !== 'win32')('旧租约所有者已退出且浏览器未占用配置目录时可自动恢复并启动', async () => {
  const { lockPath, session } = await setupProfile();
  await writeOldLease(lockPath, await exitedOwnerPid());
  const browser = session('recover-dead-owner');
  await browser.start();
  expect(browser.isOpen()).toBe(true);
  expect(browser.getInfo().browserChannel).toBe('chromium');
  await browser.close();
  await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('旧租约所有者仍存活时拒绝启动并保持原租约原文', async () => {
  const { lockPath, session } = await setupProfile();
  await writeOldLease(lockPath, process.pid);
  const before = await readFile(lockPath, 'utf8');
  const duplicate = session('do-not-steal-live-owner');
  await expect(duplicate.start()).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
  await duplicate.close();
  expect(await readFile(lockPath, 'utf8')).toBe(before);
});

it.each([
  ['损坏 JSON', '{broken'],
  ['空文件', ''],
  ['零 PID', JSON.stringify({ token: 'old-token', pid: 0, createdAt: '2026-09-17T00:00:00Z' })],
  ['负数 PID', JSON.stringify({ token: 'old-token', pid: -1, createdAt: '2026-09-17T00:00:00Z' })],
  ['字符串 PID', JSON.stringify({ token: 'old-token', pid: '123', createdAt: '2026-09-17T00:00:00Z' })],
  ['非整数 PID', JSON.stringify({ token: 'old-token', pid: 1.5, createdAt: '2026-09-17T00:00:00Z' })],
  ['超出 Windows PID 范围', JSON.stringify({ token: 'old-token', pid: 0x100000000, createdAt: '2026-09-17T00:00:00Z' })],
])('%s 的旧租约拒绝回收并保持原文', async (_label, raw) => {
  const { lockPath, session } = await setupProfile();
  await writeFile(lockPath, raw);
  const browser = session('invalid-lease');
  await expect(browser.start()).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
  await browser.close();
  expect(await readFile(lockPath, 'utf8')).toBe(raw);
});

it.skipIf(process.platform !== 'win32')('开始恢复旧租约前立即取消不改动原锁，之后仍可恢复', async () => {
  const { lockPath, session } = await setupProfile();
  await writeOldLease(lockPath, await exitedOwnerPid());
  const before = await readFile(lockPath, 'utf8');
  const cancelled = session('cancel-before-recovery');
  const result = expect(cancelled.start()).rejects.toMatchObject({ code: 'BROWSER_START_CANCELLED' });
  await cancelled.close(); await result;
  expect(cancelled.isOpen()).toBe(false);
  expect(await readFile(lockPath, 'utf8')).toBe(before);
  const recovered = session('after-immediate-cancel');
  await recovered.start(); expect(recovered.isOpen()).toBe(true);
  await recovered.close();
});

it.skipIf(process.platform !== 'win32').each([false, true])('恢复helper等待互斥锁期间取消不删除已有租约（并发替换=%s），释放后可重试', async replaceWhileWaiting => {
  const { profileDir, lockPath, session } = await setupProfile();
  await writeOldLease(lockPath, await exitedOwnerPid());
  const before = await readFile(lockPath, 'utf8');
  const canonical = await realpath(profileDir);
  const mutexName = `Global\\PersonalRpaProfileRecovery-${createHash('sha256').update(canonical.toLowerCase()).digest('hex')}`;
  const holderScript = String.raw`
$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, $env:RPA_TEST_RECOVERY_MUTEX)
$owns = $false
try {
  $owns = $mutex.WaitOne(1000)
  if (-not $owns) { throw 'Test mutex was unexpectedly held' }
  [Console]::WriteLine('MUTEX_HELD')
  [Console]::Out.Flush()
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $found = $false
  while (-not $found -and [DateTime]::UtcNow -lt $deadline) {
    $rows = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $env:RPA_TEST_PARENT_PID + " AND Name = 'powershell.exe'"))
    foreach ($row in $rows) {
      if ($row.ProcessId -eq $PID) { continue }
      if ([string]$row.CommandLine -match '-EncodedCommand\s+"?([A-Za-z0-9+/=]+)') {
        $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
        if ($source.Contains('RPA_LEASE_RECOVERY_PATH')) { $found = $true; break }
      }
    }
    if (-not $found) { [Threading.Thread]::Sleep(50) }
  }
  if (-not $found) { throw 'Recovery helper did not appear' }
  [Console]::WriteLine('RECOVERY_HELPER_SEEN')
  [Console]::Out.Flush()
  [void][Console]::ReadLine()
} finally {
  if ($owns) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(holderScript, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RPA_TEST_RECOVERY_MUTEX: mutexName, RPA_TEST_PARENT_PID: String(process.pid) },
  });
  holder.stderr?.resume();
  cleanups.push(async () => {
    if (holder.exitCode !== null || holder.signalCode !== null) return;
    holder.stdin?.end('\n');
    try { await waitExit(holder, 5_000); }
    catch { if (holder.pid) await stopOwnedProcess(holder.pid); await waitExit(holder); }
  });
  await waitOutput(holder, 'MUTEX_HELD');
  const helperSeen = waitOutput(holder, 'RECOVERY_HELPER_SEEN');
  const cancelled = session('cancel-during-recovery');
  const startOutcome = cancelled.start().then(() => undefined, (error: unknown) => error);
  await Promise.race([helperSeen, startOutcome.then(error => { throw error ?? new Error('恢复helper未等待测试互斥锁'); })]);
  let expectedLease = before;
  if (replaceWhileWaiting) {
    // A distinct live test owner wins while our recovery helper is blocked.
    // Cancellation cleanup must not unlink this different token.
    await writeOldLease(lockPath, holder.pid!);
    expectedLease = await readFile(lockPath, 'utf8');
  }
  await cancelled.close();
  expect(await startOutcome).toMatchObject({ code: 'BROWSER_START_CANCELLED' });
  expect(cancelled.isOpen()).toBe(false);
  expect(await readFile(lockPath, 'utf8')).toBe(expectedLease);
  holder.stdin?.end('\n'); await waitExit(holder);
  expect(holder.exitCode).toBe(0);
  const recovered = session('after-blocked-recovery-cancel');
  await recovered.start(); expect(recovered.isOpen()).toBe(true);
  await recovered.close();
  await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'win32')('执行器已死但孤儿Chromium仍占用配置目录时拒绝回收，浏览器自行关闭后可恢复', async () => {
  const { lockPath, options, profileDir, session } = await setupProfile();
  const installed = await resolveBrowser('chromium', true);
  const owner = childProcess(`
    import { readFile, writeFile } from 'node:fs/promises';
    import { randomUUID } from 'node:crypto';
    import { spawn } from 'node:child_process';
    import { join } from 'node:path';
    const input = JSON.parse(process.argv[1]);
    await writeFile(input.lockPath, JSON.stringify({ token: randomUUID(), pid: process.pid, runId: 'orphan-owner', createdAt: new Date().toISOString() }));
    const native = spawn(input.executablePath, [
      '--user-data-dir=' + input.profileDir, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--headless=new', 'about:blank',
    ], { windowsHide: true, detached: true, stdio: 'ignore' });
    native.unref();
    process.send({ type: 'spawned', pid: native.pid });
    const deadline = Date.now() + 20000;
    let port;
    while (!port) {
      try { port = Number((await readFile(join(input.profileDir, 'DevToolsActivePort'), 'utf8')).split('\\n')[0]); }
      catch {}
      if (Date.now() >= deadline) throw new Error('测试孤儿浏览器未启动');
      if (!port) await new Promise(resolve => setTimeout(resolve, 50));
    }
    process.send({ type: 'ready', endpoint: 'http://127.0.0.1:' + port, pid: native.pid }, () => process.exit(0));
  `, { ...options, lockPath, executablePath: installed.executablePath });
  const spawned = waitMessage(owner, 'spawned');
  const ready = waitMessage(owner, 'ready');
  const nativePid = Number((await spawned).pid);
  let ownedBrowserExited = false;
  cleanups.push(async () => {
    if (ownedBrowserExited) return;
    await stopOwnedProcess(nativePid); ownedBrowserExited = true;
  });
  const endpoint = String((await ready).endpoint);
  await waitExit(owner);
  expect(() => process.kill(owner.pid!, 0)).toThrow();
  expect(() => process.kill(nativePid, 0)).not.toThrow();
  const before = await readFile(lockPath, 'utf8');
  const duplicate = session('do-not-steal-orphan-browser');
  await expect(duplicate.start()).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
  await duplicate.close();
  expect(await readFile(lockPath, 'utf8')).toBe(before);
  const connected = await chromium.connectOverCDP(endpoint);
  const protocol = await connected.newBrowserCDPSession();
  await protocol.send('Browser.close').catch(() => {});
  await connected.close();
  const deadline = Date.now() + 10_000;
  while (true) {
    try { process.kill(nativePid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      ownedBrowserExited = true; break;
    }
    if (Date.now() >= deadline) throw new Error('测试浏览器未正常关闭');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const recovered = session('recover-after-orphan-close');
  await recovered.start();
  expect(recovered.isOpen()).toBe(true);
  expect((await recovered.listPages())[0].url).toBe('about:blank');
  await recovered.close();
  await expect(readFile(join(profileDir, '.rpa-profile.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'win32')('两个独立进程同时争抢死租约时仅一个取得所有权，成功会话在断言前保持打开', async () => {
  const { lockPath, options } = await setupProfile();
  await writeOldLease(lockPath, await exitedOwnerPid());
  const browserModule = pathToFileURL(join(process.cwd(), 'packages/browser/src/index.ts')).href;
  const source = `
    import { BrowserSession } from ${JSON.stringify(browserModule)};
    const input = JSON.parse(process.argv[1]);
    const session = new BrowserSession(input);
    process.on('message', async message => {
      if (message.type === 'go') {
        try { await session.start(); process.send({ type: 'result', succeeded: true, open: session.isOpen() }); }
        catch (error) { process.send({ type: 'result', succeeded: false, code: error.code, message: error.message }); }
      }
      if (message.type === 'release') { await session.close(); process.disconnect(); }
    });
    process.send({ type: 'ready' });
  `;
  const children = [childProcess(source, { ...options, runId: 'race-a' }), childProcess(source, { ...options, runId: 'race-b' })];
  await Promise.all(children.map(child => waitMessage(child, 'ready')));
  const results = children.map(child => waitMessage(child, 'result'));
  for (const child of children) child.send({ type: 'go' });
  const outcomes = await Promise.all(results);
  expect(outcomes.filter(result => result.succeeded)).toHaveLength(1);
  expect(outcomes.find(result => result.succeeded)?.open).toBe(true);
  expect(outcomes.find(result => !result.succeeded)?.code).toBe('PROFILE_IN_USE');
  const lease = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
  expect(children.map(child => child.pid)).toContain(lease.pid);
  expect(() => process.kill(lease.pid, 0)).not.toThrow();
  for (const child of children) child.send({ type: 'release' });
  await Promise.all(children.map(child => waitExit(child)));
  await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
