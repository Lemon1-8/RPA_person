import { readFile } from 'node:fs/promises';
import { Console } from 'node:console';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { createRpaClient } from '../../sdk-js/src/index.js';

interface Configuration { token: string; scriptPath: string; fileMode?: boolean }

async function main(): Promise<void> {
  const configuration = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Configuration;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ token: configuration.token, ...message })}\n`);
  let sequence = 0;
  let result: unknown = null;
  let pendingChanged: (() => void) | undefined;
  const unhandled = new Map<Promise<unknown>, unknown>();
  process.on('unhandledRejection', (error, promise) => { unhandled.set(promise, error); });
  process.on('rejectionHandled', (promise) => { unhandled.delete(promise); });
  // Ordinary console output has its own stream and cannot be mistaken for RPC.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const input = createInterface({ input: process.stdin });
  input.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.token !== configuration.token) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
      pendingChanged?.();
    } catch { /* Ignore unrelated input; the parent controls protocol messages. */ }
  });
  const rpa = createRpaClient((method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ kind: 'request', id, method, params });
  }), (value) => { result = value; });
  Object.assign(globalThis, { rpa });
  try {
    if (configuration.fileMode) process.argv = [process.execPath, configuration.scriptPath];
    const module = await import(pathToFileURL(configuration.scriptPath).href);
    if (configuration.fileMode) {
      const main = module.main ?? module.default?.main;
      if (typeof main !== 'function') throw new Error('JS/TS 文件必须导出 async function main(rpa)');
      await main(rpa);
    }
    // Wait independently of user Promises so awaiting/catching retains native semantics.
    do {
      while (pending.size) await new Promise<void>((resolve) => { pendingChanged = resolve; });
      await setImmediate();
    } while (pending.size);
    if (unhandled.size) throw unhandled.values().next().value;
    send({ kind: 'result', result });
    input.close();
    process.stdin.destroy();
    process.exit(0);
  } catch (error) {
    send({ kind: 'error', error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.exit(1);
  }
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
