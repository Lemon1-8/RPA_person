import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Download, type FrameLocator, type Locator, type Page, type Request, type Response } from 'playwright';
import type { BrowserPageInfo, BrowserPoint } from '../../contracts/src/index.js';
import { coordinatePickerSource, disposeCoordinatePicker } from './coordinate-picker.js';
import { assertDebugPortAvailable, BrowserSessionError, killNativeBrowser, launchNativeBrowser, resolveBrowser, type BrowserChannel, type NativeBrowser } from './native-browser.js';
import { removeTemporaryDownloadHistory } from './download-history.js';
import { PopupGuard, type PopupPolicy } from './popup-guard.js';
import { acquireProfileLease, releaseProfileLease, type ProfileLease } from './profile-lease.js';

export { BrowserSessionError } from './native-browser.js';
export type { BrowserChannel } from './native-browser.js';
export type { PopupPolicy } from './popup-guard.js';

export interface BrowserSessionOptions {
  profileDir: string;
  downloadDir: string;
  headless?: boolean;
  browserChannel?: BrowserChannel;
  debugPort?: number;
  popupPolicy?: PopupPolicy;
  runId: string;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  if (typeof params[key] !== 'string' || !params[key]) throw new Error(`浏览器参数 ${key} 必须是非空文本`);
  return params[key];
}

function requiredNumber(params: Record<string, unknown>, key: string): number {
  if (typeof params[key] !== 'number' || !Number.isFinite(params[key])) throw new Error(`浏览器参数 ${key} 必须是有效数字`);
  return params[key];
}

function timeout(params: Record<string, unknown>): number {
  const value = params.timeoutMs ?? 15_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('timeoutMs 必须是正数');
  return value;
}

function clickMode(params: Record<string, unknown>): 'normal' | 'force' | 'dom' {
  if (params.clickMode === undefined || params.clickMode === '' || params.clickMode === 'normal') return 'normal';
  if (params.clickMode === 'force' || params.clickMode === 'dom') return params.clickMode;
  throw new Error('点击方式必须是 normal、force 或 dom');
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || /Timeout \d+ms exceeded|超时|timeout/i.test(error.message));
}

function withSelectorHint(error: unknown, selector: string): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (!selector.includes('\\"')) return error;
  return new Error(`选择器包含反斜杠转义的引号（\\\"）。如果是从 JSON 或日志里复制的 XPath，请把 \\\" 改成普通引号 " 后再运行。原始错误：${error.message}`, { cause: error });
}

function locatorSelector(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return `xpath=${trimmed}`;
  return selector;
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BrowserSessionError('BROWSER_TIMEOUT', `浏览器操作超过 ${milliseconds} 毫秒`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** One persistent browser owner. Calls from visual actions and scripts share this queue. */
export class BrowserSession {
  private context?: BrowserContext;
  private browser?: Browser;
  private popupGuard?: PopupGuard;
  private native?: NativeBrowser;
  private stoppingNative?: Promise<void>;
  private readonly launchAbort = new AbortController();
  private connectionInfo?: { pageId: string; browserChannel: Exclude<BrowserChannel, 'auto'>; debugPort: number };
  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly usedPageIds = new Set<string>();
  private readonly reservedPageIds = new Set<string>();
  private currentPageId = 'main';
  private nextPageNumber = 2;
  private readonly temporaryDownloadPaths = new Set<string>();
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private finishingClose?: Promise<void>;
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lease?: ProfileLease;
  private picking = false;

  constructor(private readonly options: BrowserSessionOptions) {}

  isOpen(): boolean {
    return !!this.context && !this.closed;
  }

  getInfo(): { pageId: string; browserChannel: Exclude<BrowserChannel, 'auto'>; debugPort: number } {
    if (!this.connectionInfo || !this.isOpen()) throw new BrowserSessionError('BROWSER_CLOSED', '浏览器会话尚未启动或已经关闭');
    return { ...this.connectionInfo, pageId: this.currentPageId };
  }

  /** Enumerating pages never starts a browser or changes the workflow's selected page. */
  async listPages(): Promise<BrowserPageInfo[]> {
    if (!this.isOpen()) return [];
    const result = await Promise.all([...this.pages].map(async ([pageId, page]) => {
      if (page.isClosed()) return undefined;
      const [title, opener] = await Promise.all([
        bounded(page.title(), 2_000).catch(() => ''),
        bounded(page.opener(), 2_000).catch(() => null),
      ]);
      if (page.isClosed() || this.pages.get(pageId) !== page) return undefined;
      const openerPageId = opener ? this.pageIds.get(opener) : undefined;
      return { pageId, title, url: page.url(), current: pageId === this.currentPageId, ...(openerPageId ? { openerPageId } : {}) };
    }));
    return result.filter((page): page is BrowserPageInfo => !!page);
  }

  private readonly registerPage = (page: Page): string => {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    let pageId = 'main';
    if (this.usedPageIds.has(pageId) || this.reservedPageIds.has(pageId)) {
      do { pageId = `page-${this.nextPageNumber++}`; }
      while (this.usedPageIds.has(pageId) || this.reservedPageIds.has(pageId));
    }
    this.pages.set(pageId, page);
    this.pageIds.set(page, pageId);
    this.usedPageIds.add(pageId);
    page.once('close', () => {
      const id = this.pageIds.get(page);
      if (id && this.pages.get(id) === page) this.pages.delete(id);
      // Keep the current alias unchanged so the next implicit command reports its closure.
      if (!this.options.headless && !this.pages.size) {
        // --no-startup-window may keep Chrome alive after its final window closes.
        queueMicrotask(() => { if (!this.pages.size) void this.close().catch(() => undefined); });
      }
    });
    return pageId;
  };

  private assertAliasAvailable(pageId: string, page?: Page): void {
    const existing = this.pages.get(pageId);
    if (existing && !existing.isClosed() && existing !== page) throw new Error(`网页别名已被打开的标签页占用：${pageId}`);
  }

  private bindPage(page: Page, pageId: string): void {
    if (page.isClosed()) throw new Error(`浏览器标签页不存在或已关闭：${pageId}`);
    this.assertAliasAvailable(pageId, page);
    const previous = this.registerPage(page);
    if (previous !== pageId) this.pages.delete(previous);
    this.pages.set(pageId, page);
    this.pageIds.set(page, pageId);
    this.usedPageIds.add(pageId);
  }

  /** Reports native closure after finishing profile cleanup and releasing its lease. */
  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('浏览器会话已经关闭');
    if (!this.starting) this.starting = this.startInternal();
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    await mkdir(this.options.profileDir, { recursive: true });
    await mkdir(this.options.downloadDir, { recursive: true });
    const profileDir = await realpath(resolve(this.options.profileDir));
    this.lease = await acquireProfileLease(profileDir, this.options.runId, this.launchAbort.signal);
    try {
      const installed = await resolveBrowser(this.options.browserChannel ?? 'auto', this.options.headless ?? false);
      await assertDebugPortAvailable(this.options.debugPort ?? 0);
      if (this.closed) throw new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器启动已取消');
      this.native = launchNativeBrowser(installed.executablePath, profileDir, this.options.debugPort ?? 0, this.options.headless ?? false, this.launchAbort.signal);
      const endpoint = await this.native.endpoint;
      // The WebSocket UUID comes from our own child, never from an unrelated port occupant.
      this.browser = await chromium.connectOverCDP(endpoint.url, { timeout: 30_000, isLocal: true });
      this.browser.once('disconnected', () => { void this.close().catch(() => undefined); });
      this.native.child.once('exit', () => { void this.close().catch(() => undefined); });
      if (this.closed) throw new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器启动已取消');
      this.context = this.browser.contexts()[0];
      if (!this.context) throw new BrowserSessionError('BROWSER_START_FAILED', '浏览器未提供默认页面上下文');
      this.context.on('page', this.registerPage);
      for (const page of this.context.pages()) this.registerPage(page);
      if (this.options.headless) {
        // Headless Chrome starts with about:blank; its page event may arrive late.
        if (!this.pages.size) await this.waitForStartupPage();
      } else {
        await this.createBackgroundPage(true);
      }
      this.popupGuard = new PopupGuard(this.context, this.options.popupPolicy ?? 'smart');
      await this.popupGuard.start();
      this.connectionInfo = { pageId: 'main', browserChannel: installed.channel, debugPort: endpoint.port };
    } catch (error) {
      await this.stopNativeBrowser();
      await this.finishClose();
      throw error;
    }
  }

  private async createBackgroundPage(initial = false): Promise<Page> {
    const context = this.context!;
    const session = await this.browser!.newBrowserCDPSession();
    try {
      const { targetId } = await bounded(session.send('Target.createTarget', {
        url: 'about:blank', background: true,
        ...(initial ? { newWindow: true, windowState: 'minimized' as const, width: 1280, height: 850 } : {}),
      }), 15_000);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (this.launchAbort.signal.aborted) throw new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器操作已取消');
        for (const page of context.pages()) {
          if (page.isClosed()) continue;
          const candidate = await context.newCDPSession(page);
          try {
            const { targetInfo } = await candidate.send('Target.getTargetInfo');
            if (targetInfo.targetId !== targetId) continue;
            if (initial) {
              const { bounds } = await candidate.send('Browser.getWindowForTarget');
              if (bounds.windowState !== 'minimized') throw new BrowserSessionError('BACKGROUND_START_FAILED', '浏览器未能在后台启动，请更新浏览器后重试');
            }
            this.registerPage(page);
            return page;
          } finally { await candidate.detach().catch(() => undefined); }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new BrowserSessionError('BROWSER_TIMEOUT', '等待后台网页创建超时');
    } finally { await session.detach().catch(() => undefined); }
  }

  async pickPoint(pageId: string, signal: AbortSignal, timeoutMs = 120_000): Promise<BrowserPoint | null> {
    if (!this.isOpen()) throw new Error('浏览器已关闭，请先打开网页');
    if (this.options.headless) throw new Error('无头浏览器无法取点，请使用有界面浏览器');
    if (this.picking) throw new Error('浏览器正在获取坐标');
    if (signal.aborted) return null;
    const page = this.page({ pageId });
    this.picking = true;
    const key = `__rpa_point_${randomUUID().replaceAll('-', '')}`;
    const abort = AbortSignal.any([signal, this.launchAbort.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    let closed!: () => void;
    let navigated!: (frame: import('playwright').Frame) => void;
    let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
    let previous: { windowId: number; state: 'normal' | 'minimized' | 'maximized' | 'fullscreen' } | undefined;
    let displayed = false;
    let ended = false;
    const stopped = new Promise<null>((resolve, reject) => {
      cancel = () => {
        ended = true;
        if (this.launchAbort.signal.aborted) reject(new Error('取点期间浏览器已关闭'));
        else resolve(null);
      };
      closed = () => { ended = true; reject(new Error('取点期间网页已关闭')); };
      navigated = frame => { if (frame === page.mainFrame()) { ended = true; reject(new Error('取点期间网页已跳转，请重新获取坐标')); } };
      abort.addEventListener('abort', cancel, { once: true });
      page.on('close', closed);
      page.on('framenavigated', navigated);
      timer = setTimeout(cancel, timeoutMs);
    });
    void stopped.catch(() => undefined);
    try {
      await this.queue;
      if (abort.aborted || ended) return await stopped;
      session = await this.context!.newCDPSession(page);
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
      previous = { windowId, state: bounds.windowState ?? 'normal' };
      await page.evaluate(coordinatePickerSource(key));
      if (abort.aborted || ended) return await stopped;
      displayed = true;
      await this.setWindowState('normal', { pageId });
      if (abort.aborted || ended) return await stopped;
      await page.bringToFront();
      const point = await Promise.race([
        page.evaluate(key => (window as unknown as Record<string, { result: Promise<{ x: number; y: number } | null> }>)[key].result, key),
        stopped,
      ]);
      return point ? { pageId: this.pageIds.get(page)!, ...point } : null;
    } finally {
      clearTimeout(timer);
      abort.removeEventListener('abort', cancel);
      page.off('close', closed);
      page.off('framenavigated', navigated);
      if (!page.isClosed()) await bounded(page.evaluate(disposeCoordinatePicker, key), 2_000).catch(() => undefined);
      if (displayed && previous && !this.closed) {
        await bounded(session!.send('Browser.setWindowBounds', { windowId: previous.windowId, bounds: { windowState: previous.state } }), 2_000).catch(() => undefined);
      }
      await session?.detach().catch(() => undefined);
      this.picking = false;
    }
  }

  private waitForStartupPage(): Promise<void> {
    const context = this.context!;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        context.off('page', ready);
        context.off('close', closed);
        this.launchAbort.signal.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const ready = (page: Page) => { this.registerPage(page); finish(); };
      const aborted = () => finish(new BrowserSessionError('BROWSER_START_CANCELLED', '浏览器启动已取消'));
      const closed = () => finish(new BrowserSessionError('BROWSER_CLOSED', '等待初始网页期间浏览器已关闭'));
      const timer = setTimeout(() => finish(new BrowserSessionError('BROWSER_START_TIMEOUT', '浏览器在 30 秒内未提供初始网页')), 30_000);
      context.on('page', ready);
      context.on('close', closed);
      this.launchAbort.signal.addEventListener('abort', aborted, { once: true });
      // Register first, then re-check to cover a page/abort arriving at the boundary.
      if (this.launchAbort.signal.aborted) aborted();
      else if (this.pages.size) finish();
    });
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    await releaseProfileLease(lease);
    this.lease = undefined;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'browser.listPages') return this.listPages();
    if (this.picking) throw new Error('浏览器正在获取坐标，请先完成或取消取点');
    if (method === 'browser.closePage' && params.closeMode !== undefined && params.closeMode !== 'page' && params.closeMode !== 'all') {
      throw new Error('关闭范围必须是 page 或 all');
    }
    const result = this.queue.then(async () => {
      if (method === 'browser.closePage' && params.closeMode === 'all') {
        const closedPageIds = [...this.pages].filter(([, page]) => !page.isClosed()).map(([pageId]) => pageId);
        // Close only this session's owned native browser, without launching one or
        // resolving its selected tab. close() does not wait for this action queue.
        await this.close();
        return { ok: true, closedPageIds };
      }
      await this.start();
      return this.execute(method, params);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private page(params: Record<string, unknown>): Page {
    const element = params.element as { pageRef?: string } | undefined;
    const value = params.pageId !== undefined ? params.pageId : element?.pageRef;
    if (value !== undefined && typeof value !== 'string') throw new Error('网页别名必须是文本');
    const alias = typeof value === 'string' ? value.trim() : '';
    const id = !alias || alias === '$current' ? this.currentPageId : alias;
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`浏览器标签页不存在或已关闭：${id}`);
    return page;
  }

  private async inputPage(params: Record<string, unknown>): Promise<Page> {
    const page = this.page(params);
    this.currentPageId = this.pageIds.get(page)!;
    return page;
  }

  private async locator(params: Record<string, unknown>): Promise<Locator> {
    const element = params.element as { framePath?: string[]; selector?: string; expectedCount?: number } | undefined;
    if (element?.framePath && (!Array.isArray(element.framePath) || !element.framePath.every((part) => typeof part === 'string' && part))) throw new Error('framePath 必须是逐层 iframe 选择器列表');
    let scope: Page | FrameLocator = this.page(params);
    for (const frame of element?.framePath ?? []) {
      const match = scope.locator(locatorSelector(frame));
      await match.first().waitFor({ state: 'attached', timeout: timeout(params) });
      if (await match.count() !== 1) throw new BrowserSessionError('AMBIGUOUS_ELEMENT', `iframe 定位歧义：${frame}`);
      scope = scope.frameLocator(locatorSelector(frame));
    }
    const selector = requiredString(element ?? params, 'selector');
    const locator = scope.locator(locatorSelector(selector));
    try {
      await locator.first().waitFor({ state: 'attached', timeout: timeout(params) });
      const count = await locator.count();
      const expected = element?.expectedCount ?? 1;
      if (count !== expected || count !== 1) throw new BrowserSessionError('AMBIGUOUS_ELEMENT', `元素定位歧义：动作要求唯一目标，配置预期 ${expected} 个，实际 ${count} 个`);
      return locator;
    } catch (error) { throw withSelectorHint(error, selector); }
  }

  private async click(locator: Locator, params: Record<string, unknown>, options: { timeout: number }): Promise<unknown> {
    const mode = clickMode(params);
    if (mode === 'dom') {
      await locator.evaluate((element) => {
        const clickable = element as HTMLElement & { click?: () => void };
        if (typeof clickable.click === 'function') clickable.click();
        else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }, undefined, options);
      return { ok: true };
    }
    try {
      await locator.click(mode === 'force' ? { ...options, force: true } : options);
      return { ok: true };
    } catch (error) {
      if (!isTimeoutLike(error)) throw error;
      const diagnostics = await this.clickDiagnostics(locator).catch(diagnosticError => `诊断信息读取失败：${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
      const modeHint = mode === 'force' ? '强制点击仍未完成' : '标准点击未完成';
      throw new Error(`元素已定位，但${modeHint}：${error instanceof Error ? error.message.split('\n')[0] : String(error)}。${diagnostics}。可尝试改点外层可点击节点，或在“点击方式”中选择“DOM 点击”；如果页面被弹层遮挡，请先关闭弹层。`, { cause: error });
    }
  }

  private async clickDiagnostics(locator: Locator): Promise<string> {
    const details = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const receiver = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(centerX, centerY) : null;
      const label = (node: Element | null) => node ? {
        tag: node.tagName.toLowerCase(),
        id: node.id,
        className: node.getAttribute('class') ?? '',
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      } : undefined;
      return {
        target: label(element),
        receiver: label(receiver),
        receivesPointer: !!receiver && (receiver === element || element.contains(receiver)),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        display: style.display,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      };
    }, undefined, { timeout: 1_000 });
    const describe = (node?: { tag: string; id: string; className: string; text: string }) => {
      if (!node) return '无';
      const id = node.id ? `#${node.id}` : '';
      const className = node.className ? `.${node.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')}` : '';
      const text = node.text ? ` 文本“${node.text}”` : '';
      return `<${node.tag}${id}${className}>${text}`;
    };
    const issues: string[] = [];
    if (details.display === 'none' || details.visibility === 'hidden' || details.visibility === 'collapse') issues.push('元素不可见');
    if (details.pointerEvents === 'none') issues.push('元素或其样式禁止接收鼠标事件');
    if (details.disabled) issues.push('元素处于禁用状态');
    if (details.rect.width <= 0 || details.rect.height <= 0) issues.push('元素没有可点击区域');
    if (details.receiver && !details.receivesPointer) issues.push(`中心点被 ${describe(details.receiver)} 接收`);
    if (!details.receiver) issues.push('元素中心点不在当前视口内');
    if (!issues.length) issues.push('元素可能仍在动画、布局变化或被浏览器动作性检查判定为不可点击');
    return `目标 ${describe(details.target)}，区域 ${details.rect.width}x${details.rect.height} @ (${details.rect.x}, ${details.rect.y})；${issues.join('；')}`;
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'browser.popupGuard') {
      if (params.mode !== 'off' && params.mode !== 'smart' && params.mode !== 'strict') throw new Error('弹窗屏蔽模式必须是 off、smart 或 strict');
      return this.popupGuard!.setMode(params.mode);
    }
    if (method === 'browser.show' || method === 'browser.hide') return this.setWindowState(method === 'browser.show' ? 'normal' : 'minimized', params);
    if (method === 'browser.mouseClick') {
      const page = await this.inputPage(params);
      await page.mouse.click(requiredNumber(params, 'x'), requiredNumber(params, 'y'), {
        button: params.button === 'middle' || params.button === 'right' ? params.button : 'left',
        clickCount: typeof params.clickCount === 'number' ? params.clickCount : 1,
        delay: typeof params.delayMs === 'number' ? params.delayMs : 0,
      });
      return { ok: true };
    }
    if (method === 'browser.mouseMove') {
      const page = await this.inputPage(params);
      await page.mouse.move(requiredNumber(params, 'x'), requiredNumber(params, 'y'), {
        steps: typeof params.steps === 'number' ? params.steps : 1,
      });
      return { ok: true };
    }
    if (method === 'browser.mouseWheel') {
      const page = await this.inputPage(params);
      await page.mouse.wheel(requiredNumber(params, 'deltaX'), requiredNumber(params, 'deltaY'));
      return { ok: true };
    }
    if (method === 'browser.keyPress') {
      const page = await this.inputPage(params);
      const holdMs = params.holdMs === undefined ? 70 + Math.round(Math.random() * 80) : requiredNumber(params, 'holdMs');
      if (!Number.isInteger(holdMs) || holdMs < 20 || holdMs > 1000) throw new Error('按键时长必须是 20–1000 毫秒的整数');
      await page.keyboard.press(requiredString(params, 'key'), { delay: holdMs });
      return { ok: true };
    }
    if (method === 'browser.keyboardType') {
      const page = await this.inputPage(params);
      if (typeof params.text !== 'string') throw new Error('输入文本必须是文本');
      await page.keyboard.type(params.text, { delay: typeof params.delayMs === 'number' ? params.delayMs : 0 });
      return { ok: true };
    }
    if (method === 'browser.switchPage') {
      const page = this.page(params);
      this.currentPageId = this.pageIds.get(page)!;
      return { pageId: this.currentPageId, url: page.url() };
    }
    if (method === 'browser.closePage') {
      const page = this.page(params);
      const pageId = this.pageIds.get(page)!;
      await page.close();
      return { ok: true, pageId };
    }
    if (method === 'browser.open') {
      const url = requiredString(params, 'url');
      const milliseconds = timeout(params);
      if (params.openMode !== undefined && params.openMode !== 'reuse' && params.openMode !== 'new') throw new Error('打开方式必须是 reuse 或 new');
      if (params.pageId !== undefined && typeof params.pageId !== 'string') throw new Error('网页别名必须是文本');
      const rawAlias = typeof params.pageId === 'string' ? params.pageId : '';
      const alias = rawAlias.trim();
      if (alias && (rawAlias !== alias || /[{}]/.test(alias))) throw new Error('网页别名不能包含首尾空格或花括号');
      const explicitAlias = alias && alias !== '$current' ? alias : undefined;
      const existing = explicitAlias ? this.pages.get(explicitAlias) : undefined;
      let page: Page;
      if (params.openMode !== 'new' && !explicitAlias) page = this.page(params);
      else if (params.openMode !== 'new' && existing && !existing.isClosed()) page = existing;
      else {
        if (explicitAlias) {
          this.assertAliasAvailable(explicitAlias);
          this.reservedPageIds.add(explicitAlias);
        }
        try {
          page = await this.createBackgroundPage();
          this.registerPage(page);
          if (explicitAlias) this.bindPage(page, explicitAlias);
        } finally { if (explicitAlias) this.reservedPageIds.delete(explicitAlias); }
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: milliseconds });
      const pageId = this.pageIds.get(page)!;
      this.currentPageId = pageId;
      return { pageId, url: page.url() };
    }
    if (method === 'browser.evaluate') {
      let result: unknown;
      try { result = await bounded(this.page(params).evaluate(requiredString(params, 'expression')), timeout(params)); }
      catch (error) {
        // Playwright cannot cancel an arbitrary page evaluation. Dispose the context so code
        // scheduled by a timed-out evaluation cannot mutate a subsequent workflow step.
        if (error instanceof BrowserSessionError && error.code === 'BROWSER_TIMEOUT') await this.close();
        throw error;
      }
      // Keep native handles and non-JSON values inside the browser boundary.
      try { return result === undefined ? null : JSON.parse(JSON.stringify(result)); }
      catch { throw new Error('浏览器表达式必须返回 JSON 可表达的值'); }
    }
    const locator = await this.locator(params);
    const options = { timeout: timeout(params) };
    switch (method) {
      case 'browser.response': return this.captureResponse(params, locator);
      case 'browser.download': return this.saveDownload(params, locator);
      case 'browser.click': return this.click(locator, params, options);
      case 'browser.fill':
        if (typeof params.value !== 'string') throw new Error('输入值必须是文本');
        await locator.fill(params.value, options);
        return { ok: true };
      case 'browser.wait':
        await locator.waitFor({ state: 'visible', ...options });
        return { ok: true };
      case 'browser.select':
        if (typeof params.value !== 'string' && !(Array.isArray(params.value) && params.value.every((value) => typeof value === 'string'))) throw new Error('下拉选项必须是文本或文本列表');
        return { ok: true, values: await locator.selectOption(params.value, options) };
      case 'browser.text': return locator.innerText(options);
      case 'browser.table': return locator.evaluate((table) => ({
        headers: Array.from(table.querySelectorAll('thead th')).map((cell) => cell.textContent?.trim() ?? ''),
        rows: Array.from(table.querySelectorAll('tbody tr')).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.trim() ?? '')),
      }), undefined, options);
      case 'browser.assertText': {
        const expected = requiredString(params, 'text');
        const deadline = Date.now() + options.timeout;
        let actual = '';
        do {
          actual = await locator.innerText(options);
          if (actual.includes(expected)) return { ok: true, text: actual };
          await new Promise((resolve) => setTimeout(resolve, 40));
        } while (Date.now() < deadline);
        throw new Error(`页面结果校验失败：预期包含“${expected}”，实际“${actual}”`);
      }
      default: throw new Error(`未实现的浏览器动作：${method}`);
    }
  }

  private async setWindowState(state: 'normal' | 'minimized', params: Record<string, unknown>): Promise<unknown> {
    if (this.options.headless) return { state, headless: true };
    let page: Page;
    try { page = this.page(params); }
    catch (error) {
      const alias = typeof params.pageId === 'string' ? params.pageId.trim() : params.pageId;
      if (alias !== undefined && alias !== '' && alias !== '$current') throw error;
      const remaining = [...this.pages.values()].find(candidate => !candidate.isClosed());
      if (!remaining) throw error;
      // Showing the browser must still work after closing its selected tab; this
      // window-only fallback never changes the workflow's current page target.
      page = remaining;
    }
    const session = await this.context!.newCDPSession(page);
    try {
      const { windowId } = await bounded(session.send('Browser.getWindowForTarget'), timeout(params));
      await bounded(session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } }), timeout(params));
      const deadline = Date.now() + timeout(params);
      do {
        const result = await bounded(session.send('Browser.getWindowBounds', { windowId }), timeout(params));
        if (result.bounds.windowState === state) return { state, headless: false };
        await new Promise((resolve) => setTimeout(resolve, 40));
      } while (Date.now() < deadline);
      throw new BrowserSessionError('WINDOW_STATE_FAILED', `浏览器窗口未切换为 ${state}`);
    } finally { await session.detach().catch(() => undefined); }
  }

  private async saveDownload(params: Record<string, unknown>, locator: Locator): Promise<unknown> {
    const page = this.page(params);
    let resolveDownload!: (download: Download) => void;
    let rejectDownload!: (error: Error) => void;
    const pending = new Promise<Download>((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; });
    const onClose = () => rejectDownload(new BrowserSessionError('BROWSER_CLOSED', '下载等待期间浏览器已关闭'));
    const timer = setTimeout(() => rejectDownload(new BrowserSessionError('DOWNLOAD_TIMEOUT', `未在 ${timeout(params)} 毫秒内触发下载`)), timeout(params));
    page.on('download', resolveDownload);
    page.on('close', onClose);
    try {
      const [download] = await Promise.all([pending, locator.click({ timeout: timeout(params) })]);
      const directory = resolve(typeof params.directory === 'string' ? params.directory : this.options.downloadDir);
      await mkdir(directory, { recursive: true });
      let name = basename(typeof params.filename === 'string' ? params.filename : download.suggestedFilename())
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
      if (!name) name = 'download';
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
      const extension = extname(name);
      const stem = name.slice(0, name.length - extension.length);
      let target: string | undefined;
      // Atomic reservation covers all processes and browser sessions sharing this destination.
      for (let index = 0; index < 10_000; index++) {
        const candidate = join(directory, index ? `${stem} (${index})${extension}` : name);
        try {
          const reservation = await open(candidate, 'wx');
          await reservation.close();
          target = candidate;
          break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      if (!target) throw new Error('下载目录内同名文件过多，无法分配文件名');
      try {
        const saving = download.saveAs(target);
        try { await bounded(saving, timeout(params)); }
        catch (error) {
          await download.cancel().catch(() => undefined);
          await saving.catch(() => undefined);
          throw error;
        }
        const failure = await download.failure();
        if (failure) throw new Error(`下载失败：${failure}`);
        const temporaryPath = await download.path();
        if (temporaryPath) this.temporaryDownloadPaths.add(temporaryPath);
        const file = await stat(target);
        if (!file.isFile()) throw new Error('下载产物不是文件');
        return { path: target, name: basename(target), size: file.size, sourceUrl: download.url() };
      } catch (error) {
        await unlink(target).catch(() => undefined);
        throw error;
      }
    } finally {
      clearTimeout(timer);
      page.off('download', resolveDownload);
      page.off('close', onClose);
    }
  }

  private async captureResponse(params: Record<string, unknown>, locator: Locator): Promise<unknown> {
    const page = this.page(params);
    const urlIncludes = requiredString(params, 'urlIncludes');
    const method = typeof params.method === 'string' ? params.method.toUpperCase() : undefined;
    const requestIncludes = typeof params.requestIncludes === 'string' ? params.requestIncludes : undefined;
    const started = new Set<Request>();
    const onRequest = (request: Request) => started.add(request);
    let resolveResponse!: (response: Response) => void;
    let rejectResponse!: (error: Error) => void;
    const pending = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const onResponse = (response: Response) => {
      const request = response.request();
      if (started.has(request) && response.url().includes(urlIncludes)
        && (!method || request.method() === method)
        && (!requestIncludes || `${request.url()}\n${request.postData() ?? ''}`.includes(requestIncludes))) resolveResponse(response);
    };
    const onClose = () => rejectResponse(new BrowserSessionError('BROWSER_CLOSED', '响应等待期间浏览器已关闭'));
    const timer = setTimeout(() => rejectResponse(new BrowserSessionError('RESPONSE_TIMEOUT', `未在 ${timeout(params)} 毫秒内收到匹配响应：${urlIncludes}`)), timeout(params));
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('close', onClose);
    try {
      // Both promises get handlers immediately; a failed click cannot leave an unhandled timeout.
      const [response] = await Promise.all([pending, locator.click({ timeout: timeout(params) })]);
      const text = await bounded(response.text(), timeout(params));
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* Text and empty responses remain text. */ }
      return { url: response.url(), status: response.status(), method: response.request().method(), requestBody: response.request().postData(), headers: response.headers(), body };
    } finally {
      clearTimeout(timer);
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('close', onClose);
    }
  }

  async screenshot(path: string): Promise<string | undefined> {
    const page = this.pages.get(this.currentPageId);
    if (!page || page.isClosed()) return undefined;
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: true, timeout: 5_000 });
    return target;
  }

  async close(): Promise<void> {
    if (!this.closing) this.closing = this.closeInternal();
    return this.closing;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.launchAbort.abort();
    // Abort a pending CDP connection by terminating its owned process immediately.
    if (this.native && !this.browser) await this.stopNativeBrowser();
    await this.starting?.catch(() => undefined);
    await this.stopNativeBrowser();
    await this.finishClose();
  }

  private stopNativeBrowser(): Promise<void> {
    if (!this.stoppingNative) this.stoppingNative = (async () => {
      if (this.browser?.isConnected()) {
        // browser.close() only disconnects a CDP client. Send the native close command first.
        await bounded((async () => {
          const session = await this.browser!.newBrowserCDPSession();
          await session.send('Browser.close');
        })(), 2_000).catch(() => undefined);
      }
      if (this.native) {
        if (!this.browser) await killNativeBrowser(this.native);
        else {
          await bounded(this.native.exited, 5_000).catch(() => killNativeBrowser(this.native!));
        }
      }
      await this.browser?.close().catch(() => undefined);
    })();
    return this.stoppingNative;
  }

  private finishClose(): Promise<void> {
    this.closed = true;
    this.context?.off('page', this.registerPage);
    this.context = undefined;
    this.pages.clear();
    this.usedPageIds.clear();
    this.reservedPageIds.clear();
    if (!this.finishingClose) this.finishingClose = Promise.resolve().then(async () => {
      try {
        await this.popupGuard?.dispose();
        this.popupGuard = undefined;
        if (this.lease) await removeTemporaryDownloadHistory(dirname(this.lease.path), this.temporaryDownloadPaths);
      } finally {
        try { await this.releaseLease(); }
        finally {
          const listeners = [...this.closeListeners];
          this.closeListeners.clear();
          for (const listener of listeners) listener();
        }
      }
    });
    return this.finishingClose;
  }
}
