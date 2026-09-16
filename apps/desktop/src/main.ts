import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { actionDefinitions } from '../../../packages/actions/src/index.js';
import { RunManager } from '../../runner/src/manager.js';
import { createDemoWorkflow } from '../../../examples/demo.js';
import { startFixtureServer } from '../../../tests/fixtures/server.js';
import { refreshDemoUrls, seedDesktopWorkspace } from './workspace.js';
import type { RunCommand, RunEvent, WorkflowDefinition, WorkflowSchedule } from '../../../packages/contracts/src/index.js';

const root = process.env.RPA_ROOT ?? resolve(__dirname, '../..');
process.env.RPA_ROOT = root;
app.setName('Personal RPA');
if (process.env.RPA_DATA_DIR) app.setPath('userData', resolve(process.env.RPA_DATA_DIR));
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let manager: RunManager;
let fixture: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    Promise.all([manager?.shutdown(), fixture?.close()]).finally(() => { tray?.destroy(); app.quit(); });
  });
  app.whenReady().then(async () => {
    const dataDir = process.env.RPA_DATA_DIR ? resolve(process.env.RPA_DATA_DIR) : join(app.getPath('userData'), 'data');
    await mkdir(dataDir, { recursive: true });
    manager = new RunManager({ dataDir, rootDir: root, maxConcurrent: Number(process.env.RPA_MAX_CONCURRENT ?? 2), autoStartSchedules: false }); await manager.initialize();
    fixture = await startFixtureServer();
    const defaultDownloadDir = app.getPath('desktop');
    await seedDesktopWorkspace(manager, createDemoWorkflow(fixture.url, defaultDownloadDir));
    await refreshDemoUrls(manager, fixture.url);
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不受信任的调用来源');
    };
    ipcMain.handle('rpa:bootstrap', async event => {
      trusted(event);
      const workflows = await manager.listWorkflows();
      return { workflows, actions: actionDefinitions, runs: manager.listRuns(), schedules: manager.listSchedules(), demoUrl: fixture!.url, dataDir, defaultDownloadDir };
    });
    ipcMain.handle('rpa:save', (event, workflow: WorkflowDefinition) => { trusted(event); return manager.saveWorkflow(workflow); });
    ipcMain.handle('rpa:delete-workflow', (event, workflowId: string) => { trusted(event); return manager.deleteWorkflow(workflowId); });
    ipcMain.handle('rpa:list-schedules', event => { trusted(event); return manager.listSchedules(); });
    ipcMain.handle('rpa:save-schedule', (event, schedule: WorkflowSchedule) => { trusted(event); return manager.saveSchedule(schedule); });
    ipcMain.handle('rpa:delete-schedule', (event, scheduleId: string) => { trusted(event); return manager.deleteSchedule(scheduleId); });
    ipcMain.handle('rpa:run', (event, workflow: WorkflowDefinition) => { trusted(event); return manager.runWorkflow(workflow); });
    ipcMain.handle('rpa:control', async (event, runId: string, command: RunCommand) => {
      trusted(event);
      if (typeof runId !== 'string' || !['pause', 'resume', 'stop', 'show', 'hide', 'closeBrowser'].includes(command)) throw new Error('无效的任务操作');
      await manager.controlRun(runId, command);
    });
    ipcMain.handle('rpa:directory', async event => {
      trusted(event); const result = await dialog.showOpenDialog(window!, { title: '选择下载保存目录', properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('rpa:open-path', async (event, path: string) => {
      trusted(event);
      if (typeof path !== 'string') throw new Error('文件路径无效');
      const candidate = resolve(path);
      const artifacts = manager.listRuns().flatMap(run => run.artifacts).map(a => resolve(a.path));
      const allowedDirs = [dataDir, defaultDownloadDir, ...(await manager.listWorkflows()).map(w => w.settings.downloadDir)].map(p => resolve(p));
      const screenshot = manager.listRuns().some(run => dirname(candidate) === join(dataDir, 'runs', run.runId) && /^[a-zA-Z0-9_-]+\.png$/.test(basename(candidate)));
      if (!artifacts.includes(candidate) && !allowedDirs.includes(candidate) && !screenshot) throw new Error('只能打开流程目录或运行产物');
      const error = await shell.openPath(candidate); if (error) throw new Error(error);
    });
    manager.on('event', (event: RunEvent) => { if (window && !window.isDestroyed()) window.webContents.send('rpa:event', event); });
    manager.on('storage-error', error => { console.error('运行记录保存失败', error); });
    manager.startScheduling();
    window = new BrowserWindow({
      width: 1480, height: 940, minWidth: 1040, minHeight: 680, show: false, backgroundColor: '#f6f7f8',
      title: 'Personal RPA · 自动化工作台',
      webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    window.once('ready-to-show', () => window?.show());
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVQ4T2Nk+P//PwMlgImBQjDwHwwGjBoANQwYGBgAAHFtAx/iRA4gAAAAAElFTkSuQmCC');
    tray = new Tray(icon); tray.setToolTip('Personal RPA · 关闭窗口后继续运行');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开工作台', click: () => window?.show() }, { type: 'separator' }, { label: '退出并停止任务', click: () => app.quit() }]));
    tray.on('double-click', () => window?.show());
    if (process.env.RPA_DEV_URL) await window.loadURL(process.env.RPA_DEV_URL);
    else await window.loadFile(join(root, 'dist', 'renderer', 'index.html'));
  }).catch(error => { dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error)); quitting = true; app.quit(); });
}
