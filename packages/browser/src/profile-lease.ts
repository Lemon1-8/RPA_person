import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BrowserSessionError } from './native-browser.js';
import { inspectProfileProcesses } from './profile-processes.js';

export interface ProfileLease { path: string; token: string }
interface LeaseRecord { token: string; pid: number; runId: string; createdAt: string }
const execute = promisify(execFile);

function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器启动已取消');
}

function occupied(profileDir: string, detail: string): BrowserSessionError {
  return new BrowserSessionError('PROFILE_IN_USE', `配置目录正在使用：${profileDir}。${detail}`);
}

function ownerMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function readLease(path: string): Promise<{ raw: string; record: LeaseRecord } | undefined> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 16_384) throw new Error('invalid lease file');
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new BrowserSessionError('PROFILE_CHECK_FAILED', `无法读取浏览器租约，未自动清理：${path}`);
  }
  try {
    const record = JSON.parse(raw) as LeaseRecord;
    if (!record || typeof record.token !== 'string' || !record.token || !Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > 0xffffffff
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('invalid lease');
    return { raw, record };
  } catch {
    throw new BrowserSessionError('PROFILE_CHECK_FAILED', `浏览器租约信息不完整或已损坏，无法确认原进程，未自动清理：${path}。若另一任务正在启动，请稍后重试。`);
  }
}

async function createLease(path: string, record: LeaseRecord): Promise<ProfileLease | undefined> {
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; }
  try {
    await handle.writeFile(JSON.stringify(record));
    return { path, token: record.token };
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  } finally { await handle.close(); }
}

// Keep comparison and replacement inside the process that owns the OS mutex.
// If this helper crashes, there is no parent-side unlink left to race a successor.
const recoveryScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$profileLeasePath = $env:RPA_LEASE_RECOVERY_PATH
$expectedLease = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RPA_LEASE_RECOVERY_EXPECTED))
$nextLease = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RPA_LEASE_RECOVERY_NEXT))
$temporaryLease = $profileLeasePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
$leaseMutex = $null
$ownsMutex = $false
try {
  if ($profileLeasePath.StartsWith('\\')) { [Console]::WriteLine('UNSUPPORTED'); exit 0 }
  $profileDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($profileLeasePath))
  if ($profileDrive.DriveType -eq [IO.DriveType]::Network) {
    [Console]::WriteLine('UNSUPPORTED'); exit 0
  }
  $leaseMutex = [Threading.Mutex]::new($false, $env:RPA_LEASE_RECOVERY_MUTEX)
  try { $ownsMutex = $leaseMutex.WaitOne(8000) }
  catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { [Console]::WriteLine('BUSY'); exit 0 }
  if (-not [IO.File]::Exists($profileLeasePath) -or [IO.File]::ReadAllText($profileLeasePath) -cne $expectedLease) {
    [Console]::WriteLine('CHANGED'); exit 0
  }
  $leaseBytes = [Text.Encoding]::UTF8.GetBytes($nextLease)
  $leaseStream = [IO.File]::Open($temporaryLease, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $leaseStream.Write($leaseBytes, 0, $leaseBytes.Length); $leaseStream.Flush($true) }
  finally { $leaseStream.Dispose() }
  if (-not [IO.File]::Exists($profileLeasePath) -or [IO.File]::ReadAllText($profileLeasePath) -cne $expectedLease) {
    [Console]::WriteLine('CHANGED'); exit 0
  }
  [IO.File]::Delete($profileLeasePath)
  try { [IO.File]::Move($temporaryLease, $profileLeasePath) }
  catch [IO.IOException] {
    if ([IO.File]::Exists($profileLeasePath)) { [Console]::WriteLine('OCCUPIED'); exit 0 }
    throw
  }
  [Console]::WriteLine('ACQUIRED')
} catch {
  [Console]::WriteLine('ERROR'); exit 1
} finally {
  if ([IO.File]::Exists($temporaryLease)) { [IO.File]::Delete($temporaryLease) }
  if ($ownsMutex) { $leaseMutex.ReleaseMutex() }
  if ($null -ne $leaseMutex) { $leaseMutex.Dispose() }
}
`;

async function replaceDeadLease(profileDir: string, old: string, record: LeaseRecord, signal?: AbortSignal): Promise<ProfileLease> {
  const candidate = { path: join(profileDir, '.rpa-profile.lock'), token: record.token };
  // Canonical paths are supplied by BrowserSession; Windows paths are case-insensitive.
  const mutexKey = createHash('sha256').update(profileDir.toLowerCase()).digest('hex');
  try {
    const operation = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(recoveryScript, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 12_000, maxBuffer: 64 * 1024, signal,
      env: { ...process.env,
        RPA_LEASE_RECOVERY_PATH: candidate.path,
        RPA_LEASE_RECOVERY_MUTEX: `Global\\PersonalRpaProfileRecovery-${mutexKey}`,
        RPA_LEASE_RECOVERY_EXPECTED: Buffer.from(old).toString('base64'),
        RPA_LEASE_RECOVERY_NEXT: Buffer.from(JSON.stringify(record)).toString('base64'),
      },
    });
    // Abort emits an error before process termination is confirmed. The helper
    // must be fully gone before candidate cleanup can safely inspect its result.
    const exited = new Promise<void>(resolve => operation.child.once('close', () => resolve()));
    let stdout: string;
    try { ({ stdout } = await operation); }
    finally { await exited; }
    const status = stdout.trim();
    if (status === 'ACQUIRED') return candidate;
    if (status === 'UNSUPPORTED') throw new BrowserSessionError('PROFILE_CHECK_FAILED', `网络配置目录无法确认其他计算机的占用状态，未自动清理租约：${profileDir}`);
    if (['CHANGED', 'OCCUPIED', 'BUSY'].includes(status)) throw occupied(profileDir, '另一任务正在使用或更新租约，请稍后重试。');
    throw new Error('Unexpected recovery response');
  } catch (error) {
    // The helper may have committed just before its response was interrupted.
    // Only our token can be cleaned up; a competing task's lease stays intact.
    await releaseProfileLease(candidate);
    cancelled(signal);
    if (error instanceof BrowserSessionError) throw error;
    throw new BrowserSessionError('PROFILE_CHECK_FAILED', `无法安全回收浏览器的失效租约，请稍后重试：${profileDir}`);
  }
}

export async function acquireProfileLease(profileDir: string, runId: string, signal?: AbortSignal): Promise<ProfileLease> {
  cancelled(signal);
  const path = join(profileDir, '.rpa-profile.lock');
  const record = { token: randomUUID(), pid: process.pid, runId, createdAt: new Date().toISOString() };
  const lease = await createLease(path, record);
  if (lease) return lease;
  const previous = await readLease(path);
  cancelled(signal);
  if (!previous) {
    const retry = await createLease(path, record);
    if (retry) return retry;
    throw occupied(profileDir, '另一任务正在启动浏览器，请稍后重试。');
  }
  if (ownerMayBeAlive(previous.record.pid)) throw occupied(profileDir, '原执行器仍在运行，请先关闭该运行保留的浏览器，或使用单条运行复用它。');
  const processes = await inspectProfileProcesses(profileDir, previous.record.pid);
  cancelled(signal);
  if (processes.ownerAlive || processes.profileInUse) throw occupied(profileDir, '原浏览器或执行器仍在运行，请先正常关闭该浏览器后重试。');
  return replaceDeadLease(profileDir, previous.raw, record, signal);
}

export async function releaseProfileLease(lease: ProfileLease): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(lease.path, 'utf8')) as { token?: string };
    if (owner.token === lease.token) await unlink(lease.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
