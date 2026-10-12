import { dialog, globalShortcut, ipcMain, Notification, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import type { RunManager } from '../../runner/src/manager.js';

export function registerWorkbenchIpc(manager: RunManager, window: () => BrowserWindow | undefined, trusted: (event: IpcMainInvokeEvent) => void) {
  const handle = (channel: string, action: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => { trusted(event); return action(...args); });
  handle('rpa:drafts', () => manager.store.listDrafts());
  handle('rpa:preflight', flow => manager.preflightWorkflow(flow));
  handle('rpa:debug', (flow, breakpoints, fromStepId) => manager.debugRun(flow, breakpoints, fromStepId));
  handle('rpa:recover', id => manager.recoverRun(id));
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
  handle('rpa:run-variables', id => manager.getRunVariables(id));
  handle('rpa:step-result', (id,resultId) => manager.store.getStepResult(id,resultId));
  handle('rpa:archive', (id,archived) => manager.archiveRun(id,archived));
  handle('rpa:history', query => manager.queryRuns(query));
  handle('rpa:cleanup-preview', (ids,revisions) => manager.previewCleanup(ids,revisions));
  handle('rpa:cleanup-apply', token => manager.applyCleanup(token));
  handle('rpa:element-pick', (runId, pageId, requestId) => manager.queryBrowserTool(runId, 'pickElement', { pageId, requestId }));
  handle('rpa:element-cancel', (runId, requestId) => manager.queryBrowserTool(runId, 'cancelElement', { requestId }));
  handle('rpa:element-validate', (runId, element) => manager.queryBrowserTool(runId, 'validateElement', { element }));
  handle('rpa:events-export', async id => {
    const result = await dialog.showSaveDialog(window()!, { title: '导出运行日志', defaultPath: '运行日志.jsonl', filters: [{ name: 'JSONL 日志', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return null;
    await manager.store.exportEvents(id, result.filePath); return result.filePath;
  });
  manager.store.health.on('change', issues => window()?.webContents.send('rpa:storage-issues', issues));
  const lastStatus = new Map<string, string>();
  const notify = (title: string, body: string, runId?: string) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    notification.on('click', () => { window()?.show(); window()?.focus(); if (runId) window()?.webContents.send('rpa:focus-run', runId); }); notification.show();
  };
  manager.on('event', event => {
    if (!event.run) return;
    const key = `${event.run.attemptId ?? event.run.runId}:${event.run.status}:${event.run.currentStepId ?? ''}`;
    if (lastStatus.get(event.runId) === key) return; lastStatus.set(event.runId, key);
    if (['failed','waiting_manual','interrupted'].includes(event.run.status)) notify(`${event.run.workflowName} · ${event.run.status === 'waiting_manual' ? '等待人工' : '运行异常'}`, event.run.error ?? '请打开工作台查看运行记录', event.runId);
  });
  let notifiedIssues = new Set<string>();
  manager.store.health.on('change', issues => { for (const issue of issues) if (!notifiedIssues.has(issue.id)) notify('运行记录或草稿保存失败', issue.message); notifiedIssues = new Set(issues.map((issue: { id: string }) => issue.id)); });
  const emergency = () => { void manager.stopAll().catch(error => notify('紧急停止未完成', String(error))); };
  if (!globalShortcut.register('Control+Alt+F12', emergency)) {
    // A visible startup issue is retained without pretending this is a disk fault.
    const getIssues = manager.store.issues.bind(manager.store);
    manager.store.issues = () => [...getIssues(), ...(!globalShortcut.isRegistered('Control+Alt+F12') ? [{ id: 'emergency-shortcut', at: new Date().toISOString(), message: 'Ctrl+Alt+F12 紧急停止快捷键注册失败，请释放冲突后重新启动工作台。' }] : [])];
  }
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
