import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, RunEvent } from '../../../packages/contracts/src/index.js';
const api: DesktopApi = {
  listDrafts: () => ipcRenderer.invoke('rpa:drafts'),
  saveDraft: draft => ipcRenderer.invoke('rpa:draft-save', draft),
  discardDraft: id => ipcRenderer.invoke('rpa:draft-discard', id),
  listRevisions: id => ipcRenderer.invoke('rpa:revisions', id),
  getRevision: (id, revision) => ipcRenderer.invoke('rpa:revision', id, revision),
  restoreRevision: (id, revision, expected) => ipcRenderer.invoke('rpa:revision-restore', id, revision, expected),
  getRunEvents: (id, query) => ipcRenderer.invoke('rpa:events', id, query),
  exportRunEvents: id => ipcRenderer.invoke('rpa:events-export', id),
  listAttempts: id => ipcRenderer.invoke('rpa:attempts', id),
  getStorageIssues: () => ipcRenderer.invoke('rpa:storage-issues'),
  retryStorage: () => ipcRenderer.invoke('rpa:storage-retry'),
  onStorageIssues: listener => {
    const receive = (_event: Electron.IpcRendererEvent, issues: Parameters<typeof listener>[0]) => listener(issues);
    ipcRenderer.on('rpa:storage-issues', receive); return () => ipcRenderer.removeListener('rpa:storage-issues', receive);
  },
  onFlushDrafts: listener => {
    const receive = (_event: Electron.IpcRendererEvent, token: string) => { void listener().then(() => ipcRenderer.send('rpa:drafts-flushed', token), error => ipcRenderer.send('rpa:drafts-flushed', token, String(error))); };
    ipcRenderer.on('rpa:flush-drafts', receive); return () => ipcRenderer.removeListener('rpa:flush-drafts', receive);
  },
  onFocusRun: listener => { const receive = (_event: Electron.IpcRendererEvent, id: string) => listener(id); ipcRenderer.on('rpa:focus-run', receive); return () => ipcRenderer.removeListener('rpa:focus-run', receive); },
  preflight: flow => ipcRenderer.invoke('rpa:preflight', flow),
  pickBrowserElement: (runId, pageId, requestId) => ipcRenderer.invoke('rpa:element-pick', runId, pageId, requestId),
  cancelBrowserElement: (runId, requestId) => ipcRenderer.invoke('rpa:element-cancel', runId, requestId),
  validateBrowserElement: (runId, element) => ipcRenderer.invoke('rpa:element-validate', runId, element),
  debugRun: (workflow, breakpoints, fromStepId) => ipcRenderer.invoke('rpa:debug', workflow, breakpoints, fromStepId),
  recoverRun: id => ipcRenderer.invoke('rpa:recover', id),
  listOccurrences: id => ipcRenderer.invoke('rpa:occurrences', id),
  archiveRun: (id, archived) => ipcRenderer.invoke('rpa:archive', id, archived),
  getRunVariables: id => ipcRenderer.invoke('rpa:run-variables', id),
  getStepResult: (id, resultId) => ipcRenderer.invoke('rpa:step-result', id, resultId),
  bootstrap: () => ipcRenderer.invoke('rpa:bootstrap'),
  getRunWorkflow: runId => ipcRenderer.invoke('rpa:run-workflow', runId),
  saveWorkflow: workflow => ipcRenderer.invoke('rpa:save', workflow),
  deleteWorkflow: workflowId => ipcRenderer.invoke('rpa:delete-workflow', workflowId),
  listSchedules: () => ipcRenderer.invoke('rpa:list-schedules'),
  saveSchedule: schedule => ipcRenderer.invoke('rpa:save-schedule', schedule),
  deleteSchedule: scheduleId => ipcRenderer.invoke('rpa:delete-schedule', scheduleId),
  runWorkflow: workflow => ipcRenderer.invoke('rpa:run', workflow),
  runStep: (workflow, stepId, browserRunId) => ipcRenderer.invoke('rpa:run-step', workflow, stepId, browserRunId),
  listBrowserPages: runId => ipcRenderer.invoke('rpa:list-browser-pages', runId),
  pickBrowserPoint: (runId, pageId, requestId) => ipcRenderer.invoke('rpa:pick-browser-point', runId, pageId, requestId),
  cancelBrowserPoint: (runId, requestId) => ipcRenderer.invoke('rpa:cancel-browser-point', runId, requestId),
  pickDesktopPoint: requestId => ipcRenderer.invoke('rpa:pick-desktop-point', requestId),
  cancelDesktopPoint: requestId => ipcRenderer.invoke('rpa:cancel-desktop-point', requestId),
  pickDesktopElement: requestId => ipcRenderer.invoke('rpa:pick-desktop-element', requestId),
  cancelDesktopElement: requestId => ipcRenderer.invoke('rpa:cancel-desktop-element', requestId),
  validateDesktopElement: element => ipcRenderer.invoke('rpa:validate-desktop-element', element),
  controlRun: (runId, command) => ipcRenderer.invoke('rpa:control', runId, command),
  chooseDirectory: () => ipcRenderer.invoke('rpa:directory'),
  chooseXlsxPath: (mode, currentPath) => ipcRenderer.invoke('rpa:xlsx-path', mode, currentPath),
  openPath: path => ipcRenderer.invoke('rpa:open-path', path),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: RunEvent) => listener(event);
    ipcRenderer.on('rpa:event', handler); return () => { ipcRenderer.removeListener('rpa:event', handler); };
  },
};
contextBridge.exposeInMainWorld('rpa', api);
