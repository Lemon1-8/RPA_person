import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { transform } from 'esbuild';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertJson } from '../../sdk-js/src/index.js';

export interface RunScriptOptions {
  language: 'python' | 'javascript' | 'typescript';
  code?: string;
  filePath?: string;
  workingDirectory?: string;
  variables: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  onLog?: (message: string) => void;
  pythonExecutable?: string;
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const terminator = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      terminator.once('error', () => { child.kill('SIGKILL'); resolve(); });
      terminator.once('close', (code) => { if (code !== 0) child.kill('SIGKILL'); resolve(); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

function cancellationError(): Error {
  const error = new Error('Script cancelled');
  error.name = 'AbortError';
  return error;
}

export async function runScript(options: RunScriptOptions): Promise<unknown> {
  assertJson(options.variables);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new TypeError('Script timeoutMs must be positive');
  if (options.signal?.aborted) throw cancellationError();
  if ((options.code === undefined) === (options.filePath === undefined)) throw new TypeError('脚本必须且只能指定 code 或 filePath');
  const root = path.resolve(process.env.RPA_ROOT ?? process.cwd());
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'rpa-script-'));
  try {
    const token = randomUUID();
    const scriptPath = options.filePath ? path.resolve(options.filePath) : path.join(temporaryDirectory, options.language === 'python' ? 'script.py' : 'script.mjs');
    const configurationPath = path.join(temporaryDirectory, 'config.json');
    const code = !options.filePath && options.language === 'typescript'
      ? (await transform(options.code!, { loader: 'ts', format: 'esm', target: 'node22', sourcefile: 'user-script.ts', sourcemap: 'inline' })).code
      : options.code;
    if (!options.filePath) await writeFile(scriptPath, code!, 'utf8');
    await writeFile(configurationPath, JSON.stringify({ token, scriptPath, fileMode: !!options.filePath }), 'utf8');
    const childEntry = process.env.RPA_SCRIPT_CHILD ?? (typeof __filename !== 'undefined' && __filename.endsWith('.cjs')
      ? path.join(root, 'dist', 'scripts', 'child.cjs')
      : path.join(root, 'packages', 'scripts', 'src', 'child.ts'));
    const require = createRequire(path.join(root, 'package.json'));
    const nodeArguments = [...(childEntry.endsWith('.ts') || options.filePath ? ['--import', pathToFileURL(require.resolve('tsx')).href] : []), childEntry, configurationPath];
    const isPython = options.language === 'python';
    const executable = isPython ? options.pythonExecutable ?? 'python' : process.execPath;
    const childArguments = isPython ? ['-u', '-m', 'rpa_sdk', scriptPath, ...(options.filePath ? ['--file-mode'] : [])] : nodeArguments;
    if (options.signal?.aborted) throw cancellationError();
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(executable, childArguments, {
        cwd: options.filePath ? options.workingDirectory ?? root : root,
        env: {
          ...process.env, ELECTRON_RUN_AS_NODE: '1', RPA_RPC_TOKEN: token,
          PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: [path.join(root, 'python'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      });
      let result: unknown = null;
      let failure: Error | undefined;
      let receivedResult = false;
      let stopping = false;
      let childClosed = false;
      let termination: Promise<void> | undefined;
      const dispatching = new Set<Promise<void>>();
      let interruptDrain: (() => void) | undefined;
      const interrupted = new Promise<void>((resolve) => { interruptDrain = resolve; });
      const stop = (error: Error) => {
        if (stopping) return;
        stopping = true;
        failure = error;
        if (!childClosed) termination = terminateProcessTree(child);
        interruptDrain?.();
      };
      const timer = setTimeout(() => {
        const error = new Error(`Script timeout after ${options.timeoutMs} ms`);
        error.name = 'TimeoutError';
        stop(error);
      }, options.timeoutMs);
      const onAbort = () => stop(cancellationError());
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      let stderr = '';
      const output = createInterface({ input: child.stdout });
      const logs = createInterface({ input: child.stderr });
      logs.on('line', (line) => {
        stderr = `${stderr}\n${line}`.slice(-8192);
        options.onLog?.(line);
      });
      output.on('line', (line) => {
        if (stopping) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { options.onLog?.(line); return; }
        if (!message || typeof message !== 'object' || message.token !== token) { options.onLog?.(line); return; }
        if (message.kind === 'result') { result = message.result; receivedResult = true; return; }
        if (message.kind === 'error') { failure = new Error(String(message.error)); return; }
        if (message.kind !== 'request') return;
        const operation = (async () => {
          let response: Record<string, unknown>;
          try {
            const value = await options.dispatch(String(message.method), message.params as Record<string, unknown>);
            assertJson(value ?? null);
            response = { result: value ?? null };
          } catch (error) {
            const dispatchError = error instanceof Error ? error : new Error(String(error));
            // A final result means the child can no longer observe or handle this failure.
            if (receivedResult || childClosed) failure ??= dispatchError;
            response = { error: dispatchError.message };
          }
          if (!stopping && child.stdin.writable) child.stdin.write(`${JSON.stringify({ token, id: message.id, ...response })}\n`);
        })();
        dispatching.add(operation);
        void operation.then(() => dispatching.delete(operation), (error: unknown) => {
          dispatching.delete(operation);
          failure ??= error instanceof Error ? error : new Error(String(error));
        });
      });
      child.on('error', (error) => { failure = error; });
      child.stdin.on('error', () => { /* Closing children can close stdin before the final response. */ });
      child.on('close', async (code) => {
        childClosed = true;
        if (code === 0 && receivedResult && !failure) {
          // The child SDK normally drains first. Keep this boundary correct for other clients too.
          await Promise.race([Promise.allSettled([...dispatching]), interrupted]);
        }
        stopping = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        output.close(); logs.close();
        await termination;
        if (failure) reject(failure);
        else if (code !== 0 || !receivedResult) reject(new Error(`Script process exited (${code}): ${stderr.trim()}`));
        else resolve(result);
      });
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
