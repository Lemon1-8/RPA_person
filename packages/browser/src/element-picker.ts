export function describeElement(element: Element): { selector: string; text: string; stable: boolean } {
  const root = element.getRootNode() as Document | ShadowRoot;
  const candidates: string[] = [];
  if (element.id) candidates.push(`#${CSS.escape(element.id)}`);
  for (const name of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
    const value = element.getAttribute(name); if (value) candidates.push(`${element.tagName.toLowerCase()}[${name}=${JSON.stringify(value)}]`);
  }
  for (const selector of candidates) if (root.querySelectorAll(selector).length === 1) return { selector, text: (element.textContent ?? '').trim().slice(0, 160), stable: true };
  const path: string[] = []; let current: Element | null = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    const siblings: Element[] = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current!.tagName) : [current];
    path.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
    current = current.parentElement;
  }
  return { selector: path.join(' > '), text: (element.textContent ?? '').trim().slice(0, 160), stable: false };
}

export function installElementPicker(key: string) {
  const state = window as unknown as Record<string, { result: Promise<ReturnType<typeof describeElement> | null>; cancel(): void }>;
  if (state[key]) return;
  const hint = document.createElement('div'); hint.textContent = 'Ctrl + Alt + 单击拾取元素 · Esc 取消 · 普通点击已拦截';
  hint.setAttribute('data-rpa-element-picker', key);
  hint.style.cssText = 'position:fixed;inset:12px 12px auto auto;padding:10px;background:#182238;color:white;font:13px/1.5 sans-serif;z-index:2147483647;pointer-events:none;';
  document.documentElement.append(hint);
  let resolve!: (value: ReturnType<typeof describeElement> | null) => void;
  const result = new Promise<ReturnType<typeof describeElement> | null>(done => { resolve = done; });
  let finished = false;
  const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  const finish = (value: ReturnType<typeof describeElement> | null) => {
    if (finished) return; finished = true;
    for (const type of types) window.removeEventListener(type, click, true);
    window.removeEventListener('keydown', keyboard, true); hint.remove(); resolve(value);
  };
  const click = (event: Event) => {
    event.preventDefault(); event.stopImmediatePropagation();
    const mouse = event as MouseEvent; if (event.type !== 'click' || !mouse.ctrlKey || !mouse.altKey || mouse.button !== 0) return;
    const target = event.composedPath()[0]; if (target instanceof Element) finish(describeElement(target));
  };
  const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(null); } };
  for (const type of types) window.addEventListener(type, click, true);
  window.addEventListener('keydown', keyboard, true);
  state[key] = { result, cancel: () => finish(null) };
}
export function elementPickerSource(key: string) {
  return `(() => { const __name = fn => fn; const describeElement = ${describeElement.toString()}; (${installElementPicker.toString()})(${JSON.stringify(key)}); })()`;
}
export function disposeElementPicker(key: string) {
  const state = window as unknown as Record<string, { cancel(): void }>;
  state[key]?.cancel(); delete state[key];
}
