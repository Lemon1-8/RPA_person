import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { desktopElementSchema, type DesktopElementRef, type DesktopElementSnapshot, type DesktopElementValidation } from '../../contracts/src/index.js';
import { runDesktopInputUnlocked } from '../../engine/src/desktop-input.js';
import { withDesktopInteraction } from './interaction-lock.js';
import { windowsHostScript } from './host.js';

export class WindowsSession {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private operations = new Set<AbortController>();
  private start() {
    if (this.child) return this.child;
    if (process.platform !== 'win32') throw new Error('Windows 元素自动化仅支持 Windows');
    const loader = "[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false); Invoke-Expression ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-MTA', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', error => { if (this.child === child) this.close(error); });
    child.stdin.write(Buffer.from(windowsHostScript, 'utf16le').toString('base64') + '\n');
    this.child = child;
    let error = '';
    child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const response = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const item = this.pending.get(response.id);
        if (!item) return;
        this.pending.delete(response.id);
        if (response.error) item.reject(new Error(response.error)); else item.resolve(response.result ?? null);
      } catch { if (this.child === child) this.close(new Error('Windows 辅助进程返回了无效数据')); else child.kill(); }
    });
    child.once('error', cause => { if (this.child === child) this.close(cause); });
    child.once('exit', () => { reader.close(); if (this.child === child) this.close(new Error(`Windows 辅助进程退出：${error || '连接关闭'}`)); });
    return child;
  }
  private fail(error: Error) { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const child = this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const finish = (cause: Error | undefined, value?: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); cause ? reject(cause) : resolve(value); };
      const terminate = (error: Error) => { this.close(error); finish(error); };
      const abort = () => terminate(new Error('Windows 元素操作已取消'));
      const timer = setTimeout(() => terminate(new Error(`Windows 元素操作超时（${timeoutMs} ms）`)), timeoutMs);
      this.pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else child.stdin.write(JSON.stringify({ id, method, params: { ...params, timeoutMs: Math.max(1, timeoutMs - 100) } }) + '\n', error => { if (error) terminate(error); });
    });
  }
  call(method: string, params: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    const abort = new AbortController();
    this.operations.add(abort);
    const cancel = () => abort.abort(new Error('Windows 元素操作已取消'));
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(abort.signal.reason); abort.signal.addEventListener('abort', rejectAbort, { once: true }); });
    const timer = setTimeout(() => abort.abort(new Error(`Windows 元素操作超时（${timeoutMs} ms）`)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const operation = this.queue.then(async () => {
      abort.signal.throwIfAborted();
      const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error('Windows 元素操作排队超时'); return value; };
      if (['windows.click', 'windows.fill'].includes(method) && params.mode === 'simulate') {
        return withDesktopInteraction(remaining(), abort.signal, async () => {
          const point = await this.request('prepare', { element: params.element, focus: method === 'windows.fill' }, remaining(), abort.signal) as { x: number; y: number; expectedWindow: number };
          if (method === 'windows.fill') {
            await runDesktopInputUnlocked('desktop.elementFill', { ...point, text: params.value, append: params.append }, remaining(), abort.signal);
          } else await runDesktopInputUnlocked('desktop.mouseClick', { ...point, button: 'left', clickCount: 1, humanLike: true }, remaining(), abort.signal);
          return { ok: true };
        });
      }
      return this.request(method, params, remaining(), abort.signal);
    });
    this.queue = operation.catch(() => {});
    return Promise.race([operation, cancelled]).finally(() => { this.operations.delete(abort); clearTimeout(timer); signal?.removeEventListener('abort', cancel); abort.signal.removeEventListener('abort', rejectAbort); });
  }
  inspect(x: number, y: number, excludeProcessIds: number[] = [], signal?: AbortSignal): Promise<DesktopElementSnapshot | null> {
    return this.call('inspect', { x, y, excludeProcessIds }, 30_000, signal) as Promise<DesktopElementSnapshot | null>;
  }
  validate(element: DesktopElementRef): Promise<DesktopElementValidation> {
    return this.call('validate', { element: desktopElementSchema.parse(element) }) as Promise<DesktopElementValidation>;
  }
  close(error = new Error('Windows 元素会话已关闭')) {
    const child = this.child; this.child = undefined;
    this.fail(error); child?.kill();
    const operations = [...this.operations]; this.operations.clear();
    for (const operation of operations) operation.abort(error);
  }
}
