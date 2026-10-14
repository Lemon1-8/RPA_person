import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

export type BrowserChannel = 'auto' | 'chrome' | 'msedge' | 'chromium';

export class BrowserSessionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(file => file.isFile(), () => false);
}

function installedPaths(channel: 'chrome' | 'msedge'): string[] {
  if (process.platform === 'win32') {
    const relative = channel === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
    return [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
      .filter((root): root is string => !!root).map(root => join(root, ...relative));
  }
  if (process.platform === 'darwin') return [channel === 'chrome'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return channel === 'chrome' ? ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] : ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
}

export async function resolveBrowser(channel: BrowserChannel, headless: boolean): Promise<{ channel: Exclude<BrowserChannel, 'auto'>; executablePath: string }> {
  const channels: Exclude<BrowserChannel, 'auto'>[] = channel === 'auto' ? (headless ? ['chromium'] : ['chrome', 'msedge']) : [channel];
  for (const candidate of channels) {
    const paths = candidate === 'chromium' ? [chromium.executablePath()] : installedPaths(candidate);
    for (const path of paths) if (await exists(path)) return { channel: candidate, executablePath: path };
  }
  const label = channel === 'auto' ? (headless ? 'Chromium' : 'Google Chrome 或 Microsoft Edge') : { chrome: 'Google Chrome', msedge: 'Microsoft Edge', chromium: 'Chromium' }[channel];
  throw new BrowserSessionError('BROWSER_NOT_INSTALLED', `未找到已安装的 ${label}。${channel === 'chromium' || (channel === 'auto' && headless) ? `请运行 ${process.env.RPA_AGENT_MODE === '1' ? 'rpa-agent setup-browser' : 'npm run browser:install'}。` : '请先安装浏览器，或在启动浏览器指令中选择已安装的浏览器。'}`);
}

export async function assertDebugPortAvailable(port: number): Promise<void> {
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new BrowserSessionError('INVALID_DEBUG_PORT', '调试端口必须为 0（自动分配）或 1024–65535 的整数');
  if (port === 0) return;
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new BrowserSessionError('DEBUG_PORT_IN_USE', `调试端口 ${port} 已被占用或无法监听，请选择其它端口或将浏览器端口分配改为“自动分配”。`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

export interface NativeBrowser {
  child: ChildProcess;
  exited: Promise<void>;
  endpoint: Promise<{ url: string; port: number }>;
}

export function launchNativeBrowser(executablePath: string, profileDir: string, port: number, headless: boolean, signal: AbortSignal): NativeBrowser {
  const args = [
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-popup-blocking',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-size=1280,850',
    // Edge's regular startup can show a delayed auxiliary window despite a minimized target.
    ...(executablePath.toLowerCase().endsWith('msedge.exe') ? ['--edge-skip-compat-layer-relaunch', '--enable-automation'] : []),
    ...(headless ? ['--headless=new', 'about:blank'] : ['--no-startup-window']),
  ];
  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  const endpoint = new Promise<{ url: string; port: number }>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error?: Error, result?: { url: string; port: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      child.stderr?.off('data', received);
      // Keep draining stderr so a long-lived browser cannot block on a full pipe.
      child.stderr?.resume();
      if (error) reject(error); else resolve(result!);
    };
    const aborted = () => finish(new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器启动已取消'));
    const received = (data: Buffer) => {
      output = `${output}${data.toString()}`.slice(-8192);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[\w-]+)/.exec(output);
      if (match) finish(undefined, { url: match[1]!, port: Number(match[2]) });
    };
    const timer = setTimeout(() => finish(new BrowserSessionError('BROWSER_START_TIMEOUT', '浏览器在 30 秒内未开放调试端口，请检查浏览器启动或端口设置。')), 30_000);
    child.stderr?.on('data', received);
    child.once('error', error => finish(new BrowserSessionError('BROWSER_START_FAILED', `浏览器启动失败：${error.message}`)));
    child.once('exit', code => finish(new BrowserSessionError('BROWSER_START_FAILED', `浏览器在建立连接前退出（退出码 ${code ?? '未知'}），请检查配置目录是否被其它浏览器占用。`)));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
  return { child, exited, endpoint };
}

export async function killNativeBrowser(native: NativeBrowser): Promise<void> {
  const pid = native.child.pid;
  if (!pid || native.child.exitCode !== null || native.child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => {
      if (native.child.exitCode === null && native.child.signalCode === null) throw error;
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await native.exited;
}
