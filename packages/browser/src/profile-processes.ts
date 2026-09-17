import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { BrowserSessionError } from './native-browser.js';

export interface ProfileProcessState { ownerAlive: boolean; profileInUse: boolean }

const browserNames = new Set(['chrome.exe', 'msedge.exe', 'chromium.exe', 'headless_shell.exe', 'chrome-headless-shell.exe']);
const queryScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ([string]::IsNullOrWhiteSpace($env:RPA_PROFILE_CHECK_PATH)) { throw 'Missing profile path' }
$profileOwnerId = [uint32]::Parse($env:RPA_PROFILE_CHECK_OWNER_PID)
$processFilter = "ProcessId = $profileOwnerId OR Name = 'chrome.exe' OR Name = 'msedge.exe' OR Name = 'chromium.exe' OR Name = 'headless_shell.exe' OR Name = 'chrome-headless-shell.exe'"
$processRows = @(Get-CimInstance -ClassName Win32_Process -Filter $processFilter -ErrorAction Stop | ForEach-Object {
  @{ pid = [long]$_.ProcessId; name = [string]$_.Name; commandLine = $_.CommandLine }
})
@{ complete = $true; processes = $processRows } | ConvertTo-Json -Depth 4 -Compress
`.trim();

function checkFailed(reason: string): BrowserSessionError {
  return new BrowserSessionError('PROFILE_CHECK_FAILED', `无法确认浏览器配置目录是否空闲：${reason}。为保护现有浏览器，未清理配置目录租约。`);
}

/** Windows command-line quoting, including backslashes immediately before quotes. */
export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/[\t ]/.test(commandLine[index] ?? '\0')) index++;
    if (index >= commandLine.length) break;
    let value = '';
    let quoted = false;
    while (index < commandLine.length && (quoted || !/[\t ]/.test(commandLine[index]))) {
      if (commandLine[index] === '\\') {
        let count = 0;
        while (commandLine[index] === '\\') { count++; index++; }
        if (commandLine[index] !== '"') { value += '\\'.repeat(count); continue; }
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) { value += '"'; index++; continue; }
      }
      if (commandLine[index] === '"') {
        if (quoted && commandLine[index + 1] === '"') { value += '"'; index += 2; }
        else { quoted = !quoted; index++; }
      } else value += commandLine[index++];
    }
    if (quoted) throw checkFailed('浏览器进程命令行引号不完整');
    args.push(value);
  }
  return args;
}

/** Canonicalizes Windows path spelling; production checks also resolve filesystem aliases. */
export function normalizeWindowsProfilePath(profileDir: string): string {
  if (!profileDir || /[\0"<>|]/.test(profileDir)) throw checkFailed('浏览器配置目录路径无效');
  let path = profileDir.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(path)) path = `\\\\${path.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);
  if (!/^[a-z]:\\/i.test(path) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)) throw checkFailed('浏览器配置目录不是可确认的绝对路径');
  path = win32.normalize(path);
  const root = win32.parse(path).root;
  while (path.length > root.length && path.endsWith('\\')) path = path.slice(0, -1);
  return path.toLowerCase();
}

function readSnapshot(snapshot: unknown, ownerPid: number): { ownerAlive: boolean; directories: string[] } {
  if (!snapshot || typeof snapshot !== 'object' || !('complete' in snapshot) || snapshot.complete !== true
    || !('processes' in snapshot) || !Array.isArray(snapshot.processes)) throw checkFailed('Windows 进程查询未返回完整结果');
  let ownerAlive = false;
  const directories: string[] = [];
  for (const entry of snapshot.processes) {
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.pid) || entry.pid <= 0
      || typeof entry.name !== 'string' || !entry.name) throw checkFailed('Windows 进程查询返回了无效记录');
    if (entry.pid === ownerPid) ownerAlive = true;
    if (!browserNames.has(entry.name.toLowerCase())) continue;
    if (typeof entry.commandLine !== 'string' || !entry.commandLine.trim()) throw checkFailed('无法读取某个浏览器进程的命令行，可能缺少查询权限');
    const args = parseWindowsCommandLine(entry.commandLine);
    for (let index = 1; index < args.length; index++) {
      const argument = args[index];
      let profile: string | undefined;
      if (argument.toLowerCase() === '--user-data-dir') profile = args[++index] ?? '';
      else if (argument.toLowerCase().startsWith('--user-data-dir=')) profile = argument.slice('--user-data-dir='.length);
      if (profile === undefined) continue;
      // Missing, relative and malformed paths cannot prove that the profile is unused.
      normalizeWindowsProfilePath(profile);
      directories.push(profile);
    }
  }
  return { ownerAlive, directories };
}

/** Read-only Windows inspection. Unsupported platforms and uncertain results never authorize recovery. */
export async function inspectProfileProcesses(profileDir: string, ownerPid: number): Promise<ProfileProcessState> {
  if (process.platform !== 'win32') throw checkFailed('当前平台不支持自动核查 Windows 浏览器进程');
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid > 0xffffffff) throw checkFailed('租约中的进程编号无效');
  normalizeWindowsProfilePath(profileDir);
  const output = await new Promise<string>((resolve, reject) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', queryScript], {
        windowsHide: true, encoding: 'utf8', timeout: 8_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, RPA_PROFILE_CHECK_PATH: profileDir, RPA_PROFILE_CHECK_OWNER_PID: String(ownerPid) },
      }, (error, stdout, stderr) => {
        if (error || stderr.trim()) reject(checkFailed('Windows 进程查询失败或超时'));
        else resolve(stdout);
      });
    } catch { reject(checkFailed('无法启动 Windows 进程查询')); }
  });
  let snapshot: unknown;
  try { snapshot = JSON.parse(output.replace(/^\uFEFF/, '')); }
  catch { throw checkFailed('Windows 进程查询结果无法解析'); }
  const { ownerAlive, directories } = readSnapshot(snapshot, ownerPid);
  try {
    const target = normalizeWindowsProfilePath(await realpath(profileDir));
    for (const directory of directories) {
      // Resolve junctions and DOS short paths before comparison, not just text prefixes.
      if (normalizeWindowsProfilePath(await realpath(directory)) === target) return { ownerAlive, profileInUse: true };
    }
    return { ownerAlive, profileInUse: false };
  } catch (error) {
    if (error instanceof BrowserSessionError) throw error;
    throw checkFailed('无法核实浏览器配置目录的实际路径');
  }
}
