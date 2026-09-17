import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectProfileProcesses, normalizeWindowsProfilePath, parseWindowsCommandLine } from '../packages/browser/src/profile-processes.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), realpath: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: mocks.execFile }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), realpath: mocks.realpath }));

const profile = 'C:\\RPA data\\profiles\\orders';
const chrome = (commandLine: string | null, pid = 100) => ({ pid, name: 'chrome.exe', commandLine });
function queryResult(processes: unknown[]) {
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, JSON.stringify({ complete: true, processes }), ''));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.realpath.mockImplementation(async (path: string) => path);
  queryResult([]);
});

describe('Windows 浏览器配置目录路径与命令行', () => {
  it.each([
    ['C:\\RPA data\\profiles\\orders', profile],
    ['c:/rpa DATA/profiles/orders/', profile],
    ['C:\\RPA data\\profiles\\x\\..\\orders\\', profile],
    ['\\\\?\\C:\\RPA data\\profiles\\orders', profile],
    ['\\\\?\\UNC\\server\\share\\profile\\', '\\\\server\\share\\profile'],
  ])('规范化路径大小写、分隔符、尾斜杠与扩展路径：%s', (input, expected) => {
    expect(normalizeWindowsProfilePath(input)).toBe(normalizeWindowsProfilePath(expected));
  });

  it.each([
    ['chrome.exe --user-data-dir="C:\\RPA data\\profiles\\orders"', ['chrome.exe', `--user-data-dir=${profile}`]],
    ['"C:\\Program Files\\Chrome\\chrome.exe" --user-data-dir "C:\\RPA data\\profiles\\orders"', ['C:\\Program Files\\Chrome\\chrome.exe', '--user-data-dir', profile]],
    ['chrome.exe "--user-data-dir=C:\\RPA data\\profiles\\orders"', ['chrome.exe', `--user-data-dir=${profile}`]],
    ['chrome.exe --user-data-dir="C:\\RPA data\\profiles\\orders\\\\"', ['chrome.exe', `--user-data-dir=${profile}\\`]],
    ['chrome.exe --flag="a\\\"b" --empty=""', ['chrome.exe', '--flag=a"b', '--empty=']],
  ])('按 Windows 参数规则解析引号：%s', (line, expected) => {
    expect(parseWindowsCommandLine(line)).toEqual(expected);
  });

  it('不把相对路径、缺少共享名的UNC路径和未闭合引号当作已知目录', () => {
    for (const invalid of ['', 'profile', 'C:profile', '\\profile', '\\\\server', 'C:\\invalid"path']) {
      expect(() => normalizeWindowsProfilePath(invalid)).toThrow(expect.objectContaining({ code: 'PROFILE_CHECK_FAILED' }));
    }
    expect(() => parseWindowsCommandLine('chrome.exe --user-data-dir="C:\\unfinished')).toThrow(expect.objectContaining({ code: 'PROFILE_CHECK_FAILED' }));
  });

  it.skipIf(process.platform === 'win32')('其它平台明确拒绝自动检查，不将未知进程状态当成空闲', async () => {
    await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED', message: expect.stringContaining('当前平台不支持') });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== 'win32')('配置目录进程占用检查（受控快照）', () => {
  it('所有者仍存在时保守报告存活，包括PID被其它程序复用的情况', async () => {
    queryResult([{ pid: 42, name: 'notepad.exe', commandLine: null }]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: true, profileInUse: false });
  });

  it.each(['chrome.exe', 'msedge.exe', 'chromium.exe', 'headless_shell.exe', 'CHROME.EXE'])('所有者已死但%s仍使用同目录时保留租约', async name => {
    queryResult([{ ...chrome('chrome.exe --user-data-dir "c:/RPA data/profiles/orders/"'), name }]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: true });
  });

  it('所有者和使用该目录的浏览器均退出时才报告空闲', async () => {
    queryResult([chrome('chrome.exe --user-data-dir="C:\\RPA data\\profiles\\orders-other"'), chrome('chrome.exe --type=renderer', 101)]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: false });
    queryResult([]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: false });
  });

  it('解析整个参数而不是命令行子串，并保守识别重复profile参数', async () => {
    queryResult([chrome(`chrome.exe "https://example.test/--user-data-dir=${profile}" --user-data-dir=C:\\elsewhere`)]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: false });
    queryResult([chrome(`chrome.exe --user-data-dir=C:\\elsewhere "--user-data-dir=${profile}"`)]);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: true });
  });

  it('通过实际路径识别目录联接或DOS短路径对应的同一profile', async () => {
    queryResult([chrome('chrome.exe --user-data-dir=C:\\RPA~1\\PROFIL~1\\orders')]);
    mocks.realpath.mockResolvedValue(profile);
    await expect(inspectProfileProcesses(profile, 42)).resolves.toEqual({ ownerAlive: false, profileInUse: true });
  });

  it.each([null, '', 'chrome.exe --user-data-dir', 'chrome.exe --user-data-dir=', 'chrome.exe --user-data-dir=relative', 'chrome.exe --user-data-dir="unterminated'])('命令行不可读或不完整时拒绝回收：%s', async commandLine => {
    queryResult([chrome(commandLine)]);
    await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
  });

  it('进程查询失败、超时或返回部分状态时明确失败', async () => {
    for (const [error, stdout, stderr] of [[new Error('Access denied'), '', ''], [new Error('Timed out'), '', ''], [null, '{bad', ''], [null, '{}', ''], [null, '{"complete":false,"processes":[]}', ''], [null, '{"complete":true,"processes":[]}', 'Warning: incomplete']]) {
      mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(error, stdout, stderr));
      await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
    }
    queryResult([{ pid: 'unknown', name: 'chrome.exe', commandLine: 'chrome.exe' }]);
    await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
    mocks.execFile.mockImplementation(() => { throw new Error('Cannot spawn'); });
    await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
  });

  it('无法验证目录实际路径时不能将其视为空闲', async () => {
    mocks.realpath.mockRejectedValue(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
    await expect(inspectProfileProcesses(profile, 42)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
  });

  it('查询使用隐藏PowerShell且只通过环境传入用户路径与PID', async () => {
    const unusual = "C:\\RPA data\\literal-'$(Write-Output nope);`";
    await inspectProfileProcesses(unusual, 42);
    const [file, args, options] = mocks.execFile.mock.calls[0];
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).not.toContain(unusual);
    expect(options).toMatchObject({ windowsHide: true, timeout: 8_000, env: { RPA_PROFILE_CHECK_PATH: unusual, RPA_PROFILE_CHECK_OWNER_PID: '42' } });
  });

  it('无效所有者编号不会触发不可信查询', async () => {
    for (const pid of [0, -1, 1.5, NaN, 0x100000000]) await expect(inspectProfileProcesses(profile, pid)).rejects.toMatchObject({ code: 'PROFILE_CHECK_FAILED' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
