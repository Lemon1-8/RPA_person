import { spawn } from 'node:child_process';

const lockScript = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$mutex=New-Object System.Threading.Mutex($false,'Local\PersonalRpaDesktopInput')
$owned=$false
try {
  try { $owned=$mutex.WaitOne() } catch [System.Threading.AbandonedMutexException] { $owned=$true }
  [Console]::Out.WriteLine('ready')
  [void][Console]::In.ReadToEnd()
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
`;

/** One OS mutex covers activation and the complete physical input operation. */
export async function withDesktopInteraction<T>(timeoutMs: number, signal: AbortSignal | undefined, action: (remainingMs: number) => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') throw new Error('电脑操作仅支持 Windows');
  if (signal?.aborted) throw new Error('电脑交互操作已取消');
  const started = Date.now();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''; let error = ''; let finished = false;
      const finish = (cause?: Error) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); cause ? reject(cause) : resolve(); };
      const cancel = () => finish(new Error('电脑交互锁等待已取消'));
      const timer = setTimeout(() => { child.kill(); finish(new Error('电脑交互锁等待超时')); }, timeoutMs);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('ready')) finish(); });
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-1500); });
      child.once('error', cause => finish(cause));
      child.once('exit', () => finish(new Error(signal?.aborted ? '电脑交互锁等待已取消' : error || '电脑交互锁进程退出')));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    signal?.removeEventListener('abort', abort);
    signal?.throwIfAborted();
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error('电脑交互锁等待超时');
    return await action(remaining);
  } finally {
    signal?.removeEventListener('abort', abort);
    child.stdin.end();
    if (child.exitCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}
