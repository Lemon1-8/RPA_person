import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, RunEvent } from '../../../packages/contracts/src/index.js';
const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('rpa:bootstrap'),
  saveWorkflow: workflow => ipcRenderer.invoke('rpa:save', workflow),
  runWorkflow: workflow => ipcRenderer.invoke('rpa:run', workflow),
  controlRun: (runId, command) => ipcRenderer.invoke('rpa:control', runId, command),
  chooseDirectory: () => ipcRenderer.invoke('rpa:directory'),
  openPath: path => ipcRenderer.invoke('rpa:open-path', path),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: RunEvent) => listener(event);
    ipcRenderer.on('rpa:event', handler); return () => { ipcRenderer.removeListener('rpa:event', handler); };
  },
};
contextBridge.exposeInMainWorld('rpa', api);
