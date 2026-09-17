import type { BrowserContext, Dialog, Disposable, Frame, Page } from 'playwright';

export type PopupPolicy = 'off' | 'smart' | 'strict';

/** Runs before page scripts, also in cross-origin frames. Keep this function self-contained. */
function installPopupGuard(mode: PopupPolicy): void {
  const key = '__personalRpaPopupGuard';
  const scope = window as unknown as Record<string, unknown>;
  const previous = scope[key] as { mode: PopupPolicy; dispose(): void } | undefined;
  if (previous?.mode === mode) return;
  previous?.dispose();
  if (mode === 'off') { delete scope[key]; return; }

  const originalOpen = window.open;
  const originalAttachShadow = Element.prototype.attachShadow;
  const observers = new Map<Document | ShadowRoot, MutationObserver>();
  const hidden = new Map<HTMLElement, { styles: Array<[string, string, string]>; modal: boolean }>();
  const scrollStyles = new Map<HTMLElement, [string, string]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let interactionAt = 0;
  let openedForInteraction = false;
  const candidates = [
    '[role="dialog"]', '[aria-modal="true"]', 'dialog[open]',
    '[class*="modal" i]', '[class*="popup" i]', '[class*="overlay" i]', '[class*="backdrop" i]',
    '[id*="modal" i]', '[id*="popup" i]', '[id*="overlay" i]',
    '[class*="cookie" i]', '[id*="cookie" i]', '[class*="consent" i]', '[id*="consent" i]',
    '[class*="newsletter" i]', '[id*="newsletter" i]', '[class*="advert" i]', '[id*="advert" i]',
    'iframe', '[style*="position: fixed"]', '[style*="position:fixed"]',
  ].join(',');
  const promotion = /cookie|consent|newsletter|subscribe|subscription|advertis|promotion|special offer|limited.time offer|sign up.*(?:offer|discount)|(?:^|[\s_-])(?:ads?|promo)(?:$|[\s_-])|广告|推广|营销|订阅|优惠|领券|领取红包|新人福利|隐私偏好|同意.*(?:隐私|追踪)|接受.*(?:饼干|cookie)/i;
  const business = /\b(?:log[ -]?in|sign[ -]?in|password|checkout|payment|authenticate|verification|confirm (?:order|delete|purchase|submit)|two.factor)\b|登录|登陆|密码|支付|付款|结算|身份验证|验证码|确认(?:订单|删除|提交|付款)|是否(?:删除|提交|支付)|未保存/i;
  const adUrl = /(?:^|[./_-])(?:doubleclick|googlesyndication|adservice|popads|popcash|adsterra|advertising)(?:[./_-]|$)/i;

  function hasBusinessContent(element: HTMLElement): boolean {
    const hint = `${element.id} ${element.className} ${element.getAttribute('aria-label') ?? ''} ${element.textContent?.slice(0, 4000) ?? ''}`;
    return business.test(hint)
      || !!element.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')
      || (!!element.querySelector('form,input,select,textarea') && !promotion.test(hint));
  }

  function isOverlay(element: HTMLElement): boolean {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || !element.getClientRects().length) return false;
    if (element.matches('dialog[open],[role="dialog"],[aria-modal="true"]')) return true;
    return style.position === 'fixed' || (style.position === 'absolute' && Number(style.zIndex) >= 10);
  }

  function isGenericModal(element: HTMLElement): boolean {
    if (element.matches('header,nav,main,footer,aside') || element.getAttribute('role') === 'navigation') return false;
    if (element.matches('dialog[open],[role="dialog"],[aria-modal="true"]')) return true;
    if (/(?:modal|popup|overlay|backdrop|mask)/i.test(`${element.id} ${element.className}`)) return true;
    const rect = element.getBoundingClientRect();
    return rect.width > innerWidth * 0.35 && rect.height > innerHeight * 0.35 && Number(getComputedStyle(element).zIndex) >= 100;
  }

  function restoreScroll(): void {
    for (const [element, [value, priority]] of scrollStyles) {
      if (element.style.getPropertyValue('overflow') === 'auto') {
        if (value) element.style.setProperty('overflow', value, priority);
        else element.style.removeProperty('overflow');
      }
    }
    scrollStyles.clear();
  }

  function hide(element: HTMLElement): void {
    if (hidden.has(element)) return;
    const styles = ['display', 'visibility', 'pointer-events'].map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)] as [string, string, string]);
    const modal = element instanceof HTMLDialogElement && element.open;
    hidden.set(element, { styles, modal });
    if (modal) (element as HTMLDialogElement).close();
    element.style.setProperty('display', 'none', 'important');
    element.style.setProperty('visibility', 'hidden', 'important');
    element.style.setProperty('pointer-events', 'none', 'important');
  }

  function restoreElement(element: HTMLElement, saved: { styles: Array<[string, string, string]>; modal: boolean }): void {
    for (const [name, value, priority] of saved.styles) {
      const blockedValue = name === 'visibility' ? 'hidden' : 'none';
      if (element.style.getPropertyValue(name) !== blockedValue || element.style.getPropertyPriority(name) !== 'important') continue;
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
    if (saved.modal && element instanceof HTMLDialogElement && element.isConnected && !element.open) {
      try { element.showModal(); } catch { element.setAttribute('open', ''); }
    }
  }

  function scan(): void {
    timer = undefined;
    if (disposed) return;
    let protectedOverlay = false;
    // SPAs sometimes reuse a marketing modal for sign-in or payment later.
    // Reassess retained nodes so the previous classification cannot hide it.
    for (const [element, saved] of hidden) {
      if (!element.isConnected) { hidden.delete(element); continue; }
      if (hasBusinessContent(element)) { restoreElement(element, saved); hidden.delete(element); continue; }
      for (const savedStyle of saved.styles) {
        const [name] = savedStyle;
        const value = name === 'visibility' ? 'hidden' : 'none';
        if (element.style.getPropertyValue(name) === value && element.style.getPropertyPriority(name) === 'important') continue;
        savedStyle[1] = element.style.getPropertyValue(name);
        savedStyle[2] = element.style.getPropertyPriority(name);
        element.style.setProperty(name, value, 'important');
      }
    }
    const unwanted: HTMLElement[] = [];
    const backdrops: HTMLElement[] = [];
    for (const [root, observer] of observers) {
      if (root instanceof ShadowRoot && !root.host.isConnected) { observer.disconnect(); observers.delete(root); continue; }
      const elements = Array.from(root.querySelectorAll<HTMLElement>(candidates)).slice(0, 500);
      for (const element of elements) {
        if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement || hidden.has(element) || !isOverlay(element)) continue;
        if (element.matches('header,nav,main,footer,aside,[role="navigation"]') || element.closest('header,nav,[role="navigation"]')) continue;
        if (/(?:loading|spinner|progress|skeleton)/i.test(`${element.id} ${element.className}`) || element.getAttribute('aria-busy') === 'true') continue;
        if (hasBusinessContent(element)) { protectedOverlay = true; continue; }
        const hint = `${element.id} ${element.className} ${element.getAttribute('aria-label') ?? ''} ${element.textContent?.slice(0, 4000) ?? ''} ${element.getAttribute('src') ?? ''}`;
        const emptyBackdrop = /(?:backdrop|overlay|mask)/i.test(`${element.id} ${element.className}`) && !element.textContent?.trim() && !element.children.length;
        if (emptyBackdrop) backdrops.push(element);
        if ((mode === 'strict' && isGenericModal(element)) || promotion.test(hint) || (element instanceof HTMLIFrameElement && adUrl.test(element.src))) unwanted.push(element);
        else if (!emptyBackdrop && isGenericModal(element)) protectedOverlay = true;
      }
    }
    for (const element of unwanted) hide(element);
    // Empty sibling backdrops are often direct children of body. Only remove
    // them when a popup was identified and no visible business modal owns one.
    if (unwanted.length && !protectedOverlay) for (const backdrop of backdrops) hide(backdrop);
    if (hidden.size && !protectedOverlay) {
      for (const element of [document.documentElement, document.body]) {
        if (element && ['hidden', 'clip'].includes(getComputedStyle(element).overflow) && !scrollStyles.has(element)) {
          scrollStyles.set(element, [element.style.getPropertyValue('overflow'), element.style.getPropertyPriority('overflow')]);
          element.style.setProperty('overflow', 'auto', 'important');
        }
      }
    } else restoreScroll();
  }

  function schedule(): void {
    if (!disposed && timer === undefined) timer = setTimeout(scan, 120);
  }

  function findShadowRoots(node: Node): void {
    if (!(node instanceof Element)) return;
    if (node.shadowRoot) observe(node.shadowRoot);
    // Shadow discovery is done on new subtrees, not on the whole document for
    // every mutation. Both work and retained roots are bounded.
    for (const element of Array.from(node.querySelectorAll('*')).slice(0, 1500)) if (element.shadowRoot) observe(element.shadowRoot);
  }

  function observe(root: Document | ShadowRoot): void {
    if (observers.has(root) || observers.size >= 100 || disposed) return;
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of Array.from(record.addedNodes)) findShadowRoots(node);
      schedule();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'role', 'aria-modal'] });
    observers.set(root, observer);
    schedule();
  }

  const patchedAttachShadow = function(this: Element, init: ShadowRootInit): ShadowRoot {
    const root = originalAttachShadow.call(this, init);
    observe(root);
    return root;
  };
  const patchedOpen: typeof window.open = function(url?: string | URL, target?: string, features?: string): WindowProxy | null {
    const samePage = ['_self', '_parent', '_top'].includes(target?.toLowerCase() ?? '');
    if (!samePage) {
      if (mode === 'strict' || adUrl.test(String(url ?? '')) || openedForInteraction || Date.now() - interactionAt > 1200 || !navigator.userActivation?.isActive) return null;
      openedForInteraction = true;
    }
    return originalOpen.call(window, url, target, features);
  };
  function onInteraction(event: Event): void {
    if (event.isTrusted) { interactionAt = Date.now(); openedForInteraction = false; }
    if (event.type !== 'click') return;
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    const target = link?.target || document.querySelector('base')?.target;
    if (!link || !target || ['_self', '_parent', '_top'].includes(target.toLowerCase())) return;
    if (mode === 'strict' || !event.isTrusted || adUrl.test(link.href)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }

  scope[key] = { mode, dispose() {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const observer of observers.values()) observer.disconnect();
    observers.clear();
    document.removeEventListener('click', onInteraction, true);
    document.removeEventListener('keydown', onInteraction, true);
    if (window.open === patchedOpen) window.open = originalOpen;
    if (Element.prototype.attachShadow === patchedAttachShadow) Element.prototype.attachShadow = originalAttachShadow;
    for (const [element, saved] of hidden) restoreElement(element, saved);
    hidden.clear();
    restoreScroll();
  } };
  window.open = patchedOpen;
  Element.prototype.attachShadow = patchedAttachShadow;
  document.addEventListener('click', onInteraction, true);
  document.addEventListener('keydown', onInteraction, true);
  observe(document);
  if (document.documentElement) findShadowRoots(document.documentElement);
}

function popupGuardSource(mode: PopupPolicy): string {
  // tsx's keepNames transform inserts lexical __name calls into nested functions.
  // Playwright serializes only the callback, so provide that identity helper
  // inside this isolated closure rather than leaking a helper onto the page.
  return `(() => { const __name = (fn) => fn; (${installPopupGuard.toString()})(${JSON.stringify(mode)}); })()`;
}

/** A session-scoped guard. Disposable init scripts prevent stale policy on navigation. */
export class PopupGuard {
  private mode: PopupPolicy;
  private script?: Disposable;
  private disposed = false;
  private readonly watchedPages = new Map<Page, (frame: Frame) => void>();
  private readonly pendingDialogs = new Set<Dialog>();

  constructor(private readonly context: BrowserContext, mode: PopupPolicy) { this.mode = mode; }

  private readonly onDialog = (dialog: Dialog): void => {
    this.pendingDialogs.add(dialog);
    if (this.mode !== 'off') void dialog.dismiss().catch(() => undefined).finally(() => this.pendingDialogs.delete(dialog));
    // With off, the registered listener leaves the native dialog to the user.
    // Without a listener Playwright would automatically dismiss it itself.
  };
  private readonly onDialogClosed = (dialog: Dialog): void => { this.pendingDialogs.delete(dialog); };
  private readonly onPage = (page: Page): void => {
    if (this.disposed || this.watchedPages.has(page)) return;
    const onFrame = (frame: Frame) => { void this.applyFrame(frame); };
    this.watchedPages.set(page, onFrame);
    page.on('framenavigated', onFrame);
    page.once('close', () => this.watchedPages.delete(page));
    void (async () => {
      const opener = await page.opener();
      if (this.mode === 'strict' && opener) { await page.close(); return; }
      await Promise.all(page.frames().map(frame => this.applyFrame(frame)));
    })().catch(() => undefined);
  };

  private async applyFrame(frame: Frame): Promise<void> {
    if (this.disposed) return;
    await frame.evaluate(popupGuardSource(this.mode)).catch(() => undefined);
  }

  async start(): Promise<void> {
    this.context.on('dialog', this.onDialog);
    this.context.on('dialogclosed', this.onDialogClosed);
    this.context.on('page', this.onPage);
    await this.setMode(this.mode);
    for (const page of this.context.pages()) this.onPage(page);
  }

  async setMode(mode: PopupPolicy): Promise<{ mode: PopupPolicy }> {
    this.mode = mode;
    if (mode !== 'off') {
      await Promise.all([...this.pendingDialogs].map(dialog => dialog.dismiss().catch(() => undefined)));
      this.pendingDialogs.clear();
    }
    await this.script?.dispose();
    this.script = undefined;
    if (mode !== 'off') this.script = await this.context.addInitScript({ content: popupGuardSource(mode) });
    await Promise.all(this.context.pages().flatMap(page => page.frames()).map(frame => this.applyFrame(frame)));
    return { mode };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.mode = 'off';
    this.disposed = true;
    this.context.off('dialog', this.onDialog);
    this.context.off('dialogclosed', this.onDialogClosed);
    this.context.off('page', this.onPage);
    for (const [page, listener] of this.watchedPages) page.off('framenavigated', listener);
    this.watchedPages.clear();
    this.pendingDialogs.clear();
    await this.script?.dispose().catch(() => undefined);
    this.script = undefined;
    await Promise.all(this.context.pages().flatMap(page => page.frames()).map(frame => frame.evaluate(popupGuardSource('off')).catch(() => undefined)));
  }
}
