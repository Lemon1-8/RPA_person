/** Executed in the main frame. A top-layer surface also covers cross-origin frames. */
export function installCoordinatePicker(key: string): void {
  const state = window as unknown as Record<string, { result: Promise<{ x: number; y: number } | null>; cancel(): void }>;
  if (document.querySelector('[data-rpa-coordinate-picker]')) throw new Error('此网页已在获取坐标');
  const previousFocus = document.activeElement;
  const surface = document.createElement('div');
  surface.setAttribute('data-rpa-coordinate-picker', key);
  surface.setAttribute('popover', 'manual');
  surface.style.cssText = 'all:initial;position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;background:transparent;cursor:crosshair;z-index:2147483647;';
  const shadow = surface.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:16px;right:16px;padding:14px 16px;border-radius:10px;background:#182238;color:#fff;font:14px/1.6 system-ui,sans-serif;box-shadow:0 4px 24px #0003;cursor:default;';
  const hint = document.createElement('div');
  hint.textContent = 'Ctrl + Alt + 左键单击获取坐标';
  const help = document.createElement('div');
  help.textContent = '普通点击已拦截 · 可滚动页面 · Esc 取消';
  help.style.cssText = 'font-size:12px;color:#d0d8e8;margin:4px 0 10px;';
  const cancel = document.createElement('button');
  cancel.textContent = '取消取点';
  cancel.style.cssText = 'font:inherit;padding:5px 12px;border:1px solid #b6c4dd;border-radius:6px;background:#fff;color:#182238;cursor:pointer;';
  panel.append(hint, help, cancel);
  const coordinates = document.createElement('div');
  coordinates.style.cssText = 'position:fixed;left:16px;bottom:16px;padding:6px 12px;border-radius:6px;background:#182238;color:#fff;font:14px/1.6 ui-monospace,monospace;pointer-events:none;';
  coordinates.textContent = '移动鼠标查看 X、Y';
  shadow.append(panel, coordinates);
  let resolve!: (point: { x: number; y: number } | null) => void;
  let finished = false;
  const result = new Promise<{ x: number; y: number } | null>(done => { resolve = done; });
  const clicks = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  const finish = (point: { x: number; y: number } | null) => {
    if (finished) return;
    finished = true;
    for (const type of clicks) window.removeEventListener(type, intercept, true);
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('keydown', keyboard, true);
    surface.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    resolve(point);
  };
  const intercept = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    // Outside the shadow root, hit-testing distinguishes the toolbar from the page.
    const mouse = event as MouseEvent;
    const element = shadow.elementFromPoint(mouse.clientX, mouse.clientY);
    if (element === cancel || (mouse.detail === 0 && shadow.activeElement === cancel)) { finish(null); return; }
    if (element === panel || element === hint || element === help) return;
    if (mouse.button === 0 && mouse.ctrlKey && mouse.altKey && !mouse.shiftKey && !mouse.metaKey) {
      finish({ x: mouse.clientX, y: mouse.clientY });
    }
  };
  const move = (event: MouseEvent) => {
    coordinates.textContent = `X: ${event.clientX}   Y: ${event.clientY}`;
  };
  const keyboard = (event: KeyboardEvent) => {
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Tab') { cancel.focus({ preventScroll: true }); return; }
    if (event.key === 'Escape' || (event.key === 'Enter' && shadow.activeElement === cancel)) finish(null);
  };
  state[key] = { result, cancel: () => finish(null) };
  document.documentElement.append(surface);
  try {
    surface.showPopover();
    for (const type of clicks) window.addEventListener(type, intercept, true);
    window.addEventListener('mousemove', move, true);
    window.addEventListener('keydown', keyboard, true);
    cancel.focus({ preventScroll: true });
  } catch (error) { finish(null); delete state[key]; throw error; }
}

export function disposeCoordinatePicker(key: string): void {
  const state = window as unknown as Record<string, { cancel(): void }>;
  state[key]?.cancel();
  delete state[key];
}

export function coordinatePickerSource(key: string): string {
  // tsx adds lexical keepNames helpers that are not part of a serialized callback.
  return `(() => { const __name = (fn) => fn; (${installCoordinatePicker.toString()})(${JSON.stringify(key)}); })()`;
}
