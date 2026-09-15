import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Download, type FrameLocator, type Locator, type Page, type Request, type Response } from 'playwright';

export interface BrowserSessionOptions {
  profileDir: string;
  downloadDir: string;
  headless?: boolean;
  runId: string;
}

export class BrowserSessionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

function requiredString(params: Record<string, unknown>, key: string): string {
  if (typeof params[key] !== 'string' || !params[key]) throw new Error(`浏览器参数 ${key} 必须是非空文本`);
  return params[key];
}

function timeout(params: Record<string, unknown>): number {
  const value = params.timeoutMs ?? 15_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('timeoutMs 必须是正数');
  return value;
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
  private readonly pages = new Map<string, Page>();
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private finishingClose?: Promise<void>;
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lease?: { path: string; token: string };

  constructor(private readonly options: BrowserSessionOptions) {}

  isOpen(): boolean {
    return !!this.context && !this.closed;
  }

  /** Reports closure only after the profile lease has been released. */
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
    const leasePath = join(profileDir, '.rpa-profile.lock');
    const token = randomUUID();
    let handle;
    try {
      handle = await open(leasePath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new BrowserSessionError('PROFILE_IN_USE', `配置目录正在使用：${profileDir}。租约文件：${leasePath}；异常退出后须确认原浏览器已退出再清理租约。`);
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, runId: this.options.runId, createdAt: new Date().toISOString() }));
      this.lease = { path: leasePath, token };
    } catch (error) {
      await handle.close();
      await unlink(leasePath);
      throw error;
    }
    await handle.close();
    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: this.options.headless ?? false,
        acceptDownloads: true,
        viewport: { width: 1280, height: 850 },
        timeout: 30_000,
      });
      this.context.once('close', () => {
        // This can run inside context.close(), including while start() is finishing.
        // Do not wait for either operation from the event handler.
        void this.finishClose().catch(() => undefined);
      });
      this.pages.set('main', this.context.pages()[0] ?? await this.context.newPage());
      if (!this.options.headless) await this.setWindowState('minimized', {});
    } catch (error) {
      await this.context?.close();
      await this.finishClose();
      throw error;
    }
  }

  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    // Only the successful owner may unlink. Failed/duplicate instances never get a token.
    try {
      const owner = JSON.parse(await readFile(lease.path, 'utf8')) as { token?: string };
      if (owner.token === lease.token) await unlink(lease.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.lease = undefined;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const result = this.queue.then(async () => {
      await this.start();
      return this.execute(method, params);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private page(params: Record<string, unknown>): Page {
    const element = params.element as { pageRef?: string } | undefined;
    const id = typeof params.pageId === 'string' ? params.pageId : element?.pageRef ?? 'main';
    const page = this.pages.get(id);
    if (!page || page.isClosed()) throw new Error(`浏览器标签页不存在或已关闭：${id}`);
    return page;
  }

  private async locator(params: Record<string, unknown>): Promise<Locator> {
    const element = params.element as { framePath?: string[]; selector?: string; expectedCount?: number } | undefined;
    if (element?.framePath && (!Array.isArray(element.framePath) || !element.framePath.every((part) => typeof part === 'string' && part))) throw new Error('framePath 必须是逐层 iframe 选择器列表');
    let scope: Page | FrameLocator = this.page(params);
    for (const frame of element?.framePath ?? []) {
      const match = scope.locator(frame);
      await match.first().waitFor({ state: 'attached', timeout: timeout(params) });
      if (await match.count() !== 1) throw new BrowserSessionError('AMBIGUOUS_ELEMENT', `iframe 定位歧义：${frame}`);
      scope = scope.frameLocator(frame);
    }
    const locator = scope.locator(requiredString(element ?? params, 'selector'));
    await locator.first().waitFor({ state: 'attached', timeout: timeout(params) });
    const count = await locator.count();
    const expected = element?.expectedCount ?? 1;
    if (count !== expected || count !== 1) throw new BrowserSessionError('AMBIGUOUS_ELEMENT', `元素定位歧义：动作要求唯一目标，配置预期 ${expected} 个，实际 ${count} 个`);
    return locator;
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'browser.show' || method === 'browser.hide') return this.setWindowState(method === 'browser.show' ? 'normal' : 'minimized', params);
    if (method === 'browser.open') {
      const pageId = typeof params.pageId === 'string' ? params.pageId : 'main';
      let page = this.pages.get(pageId);
      if (!page || page.isClosed()) {
        page = await this.context!.newPage();
        this.pages.set(pageId, page);
      }
      await page.goto(requiredString(params, 'url'), { waitUntil: 'domcontentloaded', timeout: timeout(params) });
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
      case 'browser.click':
        await locator.click(options);
        return { ok: true };
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
    const session = await this.context!.newCDPSession(this.page(params));
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
    const page = this.pages.get('main');
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
    await this.starting?.catch(() => undefined);
    await this.context?.close();
    await this.finishClose();
  }

  private finishClose(): Promise<void> {
    this.closed = true;
    this.context = undefined;
    this.pages.clear();
    if (!this.finishingClose) this.finishingClose = Promise.resolve().then(async () => {
      await this.releaseLease();
      const listeners = [...this.closeListeners];
      this.closeListeners.clear();
      for (const listener of listeners) listener();
    });
    return this.finishingClose;
  }
}
