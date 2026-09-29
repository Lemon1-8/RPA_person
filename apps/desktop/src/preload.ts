import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, RunEvent } from '../../../packages/contracts/src/index.js';
const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('rpa:bootstrap'),
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
