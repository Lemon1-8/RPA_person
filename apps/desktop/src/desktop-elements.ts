import { BrowserWindow, globalShortcut, screen } from 'electron';
import { WindowsSession } from '../../../packages/windows/src/index.js';
import { desktopElementSchema, type DesktopElementRef, type DesktopElementSnapshot, type DesktopElementValidation } from '../../../packages/contracts/src/index.js';

export class DesktopElementService {
  private session = new WindowsSession();
  private overlay?: BrowserWindow;
  private validations = new Set<WindowsSession>();
  private highlightTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private active?: { id: string; finish(value: DesktopElementSnapshot | null, error?: Error): void };
  constructor(private getWindow: () => BrowserWindow | undefined, private isPointPicking: () => boolean) {}
  isPicking() { return !!this.active; }
  private async highlight(snapshot: DesktopElementSnapshot) {
    if (this.closed) return;
    if (!this.overlay || this.overlay.isDestroyed()) {
      this.overlay = new BrowserWindow({ show: false, frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      this.overlay.setIgnoreMouseEvents(true);
      await this.overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:transparent;box-sizing:border-box;border:3px solid #f06528;height:100vh"></body></html>'));
    }
    if (this.closed) return;
    const rect = snapshot.bounds;
    if (rect.width <= 0 || rect.height <= 0) { this.overlay.hide(); return; }
    const origin = screen.screenToDipPoint({ x: Math.round(rect.x), y: Math.round(rect.y) });
    const scale = screen.getDisplayNearestPoint(origin).scaleFactor;
    this.overlay.setBounds({ ...origin, width: Math.max(3, Math.round(rect.width / scale)), height: Math.max(3, Math.round(rect.height / scale)) });
    this.overlay.showInactive();
  }
  pick(id: string): Promise<DesktopElementSnapshot | null> {
    if (this.closed) return Promise.reject(new Error('桌面元素捕获服务已关闭'));
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.reject(new Error('捕获请求无效'));
    if (this.active || this.isPointPicking()) return Promise.reject(new Error('请先完成或取消当前捕获或取点'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>; let pollTimer: ReturnType<typeof setTimeout>;
      const abort = new AbortController();
      let confirming = false;
      const finish = (value: DesktopElementSnapshot | null, error?: Error) => {
        if (this.active?.id !== id) return;
        this.active = undefined; abort.abort(); this.session.close();
        clearTimeout(timer); clearTimeout(pollTimer);
        globalShortcut.unregister('F8'); globalShortcut.unregister('Escape');
        this.overlay?.hide();
        const window = this.getWindow(); if (window && !window.isDestroyed()) { window.show(); window.focus(); }
        error ? reject(error) : resolve(value);
      };
      this.active = { id, finish };
      const inspect = async () => {
        this.overlay?.hide();
        const point = screen.dipToScreenPoint(screen.getCursorScreenPoint());
        return this.session.inspect(point.x, point.y, [process.pid], abort.signal);
      };
      const confirm = async () => {
        if (confirming) return;
        confirming = true;
        try {
          const snapshot = await inspect();
          if (!snapshot) throw new Error('没有捕获到目标软件控件，请移动鼠标后重试');
          finish(snapshot);
        } catch (error) { if (this.active?.id === id) finish(null, error instanceof Error ? error : new Error(String(error))); }
      };
      const f8 = globalShortcut.register('F8', () => { void confirm(); });
      const esc = globalShortcut.register('Escape', () => finish(null));
      if (!f8 || !esc) { finish(null, new Error('F8 或 Esc 已被占用，暂时无法捕获')); return; }
      timer = setTimeout(() => finish(null), 30_000);
      this.getWindow()?.hide();
      const poll = async () => {
        if (this.active?.id !== id || confirming) return;
        try { const snapshot = await inspect(); if (this.active?.id === id && !confirming && snapshot) { await this.highlight(snapshot); if (this.active?.id !== id || confirming) this.overlay?.hide(); } }
        catch (error) { if (this.active?.id === id) { finish(null, error instanceof Error ? error : new Error(String(error))); return; } }
        if (this.active?.id === id && !confirming) pollTimer = setTimeout(() => { void poll(); }, 180);
      };
      void poll();
    });
  }
  cancel(id: string) { if (this.active?.id === id) this.active.finish(null); }
  async validate(element: DesktopElementRef): Promise<DesktopElementValidation> {
    if (this.closed) throw new Error('桌面元素捕获服务已关闭');
    if (this.active || this.isPointPicking()) throw new Error('请先结束捕获或取点');
    const session = new WindowsSession();
    this.validations.add(session);
    try {
      const result = await session.validate(desktopElementSchema.parse(element));
      if (this.closed) throw new Error('桌面元素捕获服务已关闭');
      if (result.matches[0]) { await this.highlight(result.matches[0]); clearTimeout(this.highlightTimer); this.highlightTimer = setTimeout(() => { if (!this.active) this.overlay?.hide(); }, 1000); }
      return result;
    } finally { session.close(); this.validations.delete(session); }
  }
  close() { this.closed = true; this.active?.finish(null); this.session.close(); for (const session of this.validations) session.close(); this.validations.clear(); clearTimeout(this.highlightTimer); this.overlay?.destroy(); this.overlay = undefined; }
}
