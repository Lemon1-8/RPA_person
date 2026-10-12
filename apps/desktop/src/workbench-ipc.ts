import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import type { RunManager } from '../../runner/src/manager.js';
import { preflight } from '../../../packages/actions/src/preflight.js';

export function registerWorkbenchIpc(manager: RunManager, window: () => BrowserWindow | undefined, trusted: (event: IpcMainInvokeEvent) => void) {
  const handle = (channel: string, action: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => { trusted(event); return action(...args); });
  handle('rpa:drafts', () => manager.store.listDrafts());
  handle('rpa:preflight', flow => preflight(flow));
  handle('rpa:draft-save', draft => manager.store.saveDraft(draft));
  handle('rpa:draft-discard', id => manager.store.discardDraft(id));
  handle('rpa:revisions', id => manager.store.listRevisions(id));
  handle('rpa:revision', (id, revision) => manager.store.getRevision(id, revision));
  handle('rpa:revision-restore', (id, revision, expected) => manager.store.restoreRevision(id, revision, expected));
  handle('rpa:events', (id, query) => manager.store.getRunEvents(id, query));
  handle('rpa:attempts', id => manager.store.listAttempts(id));
  handle('rpa:storage-issues', () => manager.store.issues());
  handle('rpa:storage-retry', () => manager.store.retryFailed());
  handle('rpa:occurrences', id => manager.store.listOccurrences(id));
  handle('rpa:element-pick', (runId, pageId, requestId) => manager.queryBrowserTool(runId, 'pickElement', { pageId, requestId }));
  handle('rpa:element-cancel', (runId, requestId) => manager.queryBrowserTool(runId, 'cancelElement', { requestId }));
  handle('rpa:element-validate', (runId, element) => manager.queryBrowserTool(runId, 'validateElement', { element }));
  handle('rpa:events-export', async id => {
    const result = await dialog.showSaveDialog(window()!, { title: '导出运行日志', defaultPath: '运行日志.jsonl', filters: [{ name: 'JSONL 日志', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return null;
    await manager.store.exportEvents(id, result.filePath); return result.filePath;
  });
  manager.store.health.on('change', issues => window()?.webContents.send('rpa:storage-issues', issues));
}

export function flushRendererDrafts(window: BrowserWindow | undefined): Promise<void> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const token = randomUUID();
    const finish = (error?: string) => { clearTimeout(timer); ipcMain.removeListener('rpa:drafts-flushed', receive); error ? reject(new Error(error)) : resolve(); };
    const receive = (event: Electron.IpcMainEvent, responseToken: string, error?: string) => { if (event.sender === window.webContents && responseToken === token) finish(error); };
    const timer = setTimeout(() => finish('草稿保存未响应；工作台保持打开，请保存或恢复连接后重试退出。'), 5000);
    ipcMain.on('rpa:drafts-flushed', receive); window.webContents.send('rpa:flush-drafts', token);
  });
}
