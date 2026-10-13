import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerWorkbenchIpc } from '../apps/desktop/src/workbench-ipc.js';
import type { RunManager } from '../apps/runner/src/manager.js';
import { runCommands } from '../packages/contracts/src/index.js';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler) },
  globalShortcut: { register: () => true },
  Notification: { isSupported: () => false },
}));
beforeEach(() => handlers.clear());
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
