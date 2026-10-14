import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerWorkbenchIpc } from '../apps/desktop/src/workbench-ipc.js';
import type { RunManager } from '../apps/runner/src/manager.js';
import { runCommands } from '../packages/contracts/src/index.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
const exports = vi.hoisted(() => ({ dialog: vi.fn(), open: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
  globalShortcut: { register: () => true },
  Notification: { isSupported: () => false },
  dialog: { showSaveDialog: exports.dialog },
  shell: { openPath: exports.open },
}));
beforeEach(() => { handlers.clear(); vi.clearAllMocks(); });
it('导出到用户选择的任意目录后直接打开，取消、写入失败和不可信来源均不打开', async () => {
  const exportEvents = vi.fn().mockResolvedValue(undefined);
  const manager = Object.assign(new EventEmitter(), { store: { health: new EventEmitter(), issues: () => [], exportEvents } });
  const trusted = (event: { trusted: boolean }) => { if (!event.trusted) throw new Error('不受信任'); };
  registerWorkbenchIpc(manager as unknown as RunManager, () => undefined, trusted as never);
  const handler = handlers.get('rpa:events-export')!;
  const path = 'C:\\arbitrary-folder\\export.jsonl';
  exports.dialog.mockResolvedValue({ canceled: false, filePath: path }); exports.open.mockResolvedValue('');
  expect(await handler({ trusted: true }, 'run')).toBe(path);
  expect(exportEvents).toHaveBeenCalledWith('run', path); expect(exports.open).toHaveBeenCalledExactlyOnceWith(path);
  exports.open.mockClear(); exports.dialog.mockResolvedValue({ canceled: true });
  expect(await handler({ trusted: true }, 'run')).toBeNull(); expect(exports.open).not.toHaveBeenCalled();
  exports.dialog.mockResolvedValue({ canceled: false, filePath: path }); exportEvents.mockRejectedValue(new Error('磁盘满'));
  await expect(handler({ trusted: true }, 'run')).rejects.toThrow('磁盘满'); expect(exports.open).not.toHaveBeenCalled();
  exportEvents.mockResolvedValue(undefined); exports.open.mockResolvedValue('没有关联程序');
  await expect(handler({ trusted: true }, 'run')).rejects.toThrow('日志已导出，但无法打开：没有关联程序');
  expect(() => handler({ trusted: false }, 'run')).toThrow('不受信任');
});
it('桌面控制 IPC 转发全部共享命令，拒绝未知命令及不可信来源', async () => {
  const controlRun = vi.fn().mockResolvedValue(undefined);
  const manager = Object.assign(new EventEmitter(), { controlRun, store: { health: new EventEmitter(), issues: () => [] } });
  const trusted = vi.fn((event: { trusted: boolean }) => { if (!event.trusted) throw new Error('不受信任'); });
  registerWorkbenchIpc(manager as unknown as RunManager, () => undefined, trusted as never);
  const handler = handlers.get('rpa:control')!;
  for (const command of runCommands) {
    await handler({ trusted: true }, 'run', command);
    expect(controlRun).toHaveBeenLastCalledWith('run', command);
  }
  expect(() => handler({ trusted: true }, 'run', 'unknown')).toThrow('无效');
  expect(() => handler({ trusted: false }, 'run', 'retry')).toThrow('不受信任');
  expect(controlRun).toHaveBeenCalledTimes(runCommands.length);
});
