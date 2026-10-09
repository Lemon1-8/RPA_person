import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopElementSnapshot } from '../packages/contracts/src/index.js';

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), validate: vi.fn(), close: vi.fn(), shortcuts: new Map<string, () => void>(), overlays: [] as any[], register: vi.fn() }));
vi.mock('../packages/windows/src/index.js', () => ({ WindowsSession: class { inspect = mocks.inspect; validate = mocks.validate; close = mocks.close; } }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    hide = vi.fn(); destroy = vi.fn(); showInactive = vi.fn(); setBounds = vi.fn(); setIgnoreMouseEvents = vi.fn(); loadURL = vi.fn(async () => {}); isDestroyed = () => false;
    constructor() { mocks.overlays.push(this); }
  },
  globalShortcut: { register: mocks.register, unregister: (key: string) => mocks.shortcuts.delete(key) },
  screen: { getCursorScreenPoint: () => ({ x: -500, y: 100 }), dipToScreenPoint: (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 }), screenToDipPoint: (point: { x: number; y: number }) => ({ x: point.x / 2, y: point.y / 2 }), getDisplayNearestPoint: () => ({ scaleFactor: 2 }) },
}));
import { DesktopElementService } from '../apps/desktop/src/desktop-elements.js';

const snapshot: DesktopElementSnapshot = { element: { backend: 'uia', window: { title: { value: '测试', match: 'exact' } }, path: [] }, attributes: { Name: '输入框' }, bounds: { x: -1000, y: 200, width: 400, height: 60 } };
const id = '12345678-1234-1234-1234-123456789012';
let service: DesktopElementService;
let window: { hide: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; isDestroyed(): boolean };
beforeEach(() => {
  vi.useFakeTimers(); mocks.shortcuts.clear(); mocks.overlays.length = 0;
  mocks.inspect.mockResolvedValue(snapshot); mocks.validate.mockResolvedValue({ count: 1, matches: [snapshot] });
  mocks.register.mockImplementation((key, callback) => { mocks.shortcuts.set(key, callback); return true; });
  window = { hide: vi.fn(), show: vi.fn(), focus: vi.fn(), isDestroyed: () => false };
  service = new DesktopElementService(() => window as any, () => false);
});
afterEach(() => { service.close(); vi.useRealTimers(); vi.clearAllMocks(); });
describe('桌面元素捕获生命周期', () => {
  it('F8 确认返回引用，转换负坐标和 DPI，结束后清理快捷键并恢复窗口', async () => {
    const pending = service.pick(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.hide).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledWith(-1000, 200, [process.pid], expect.any(AbortSignal));
    expect(mocks.overlays[0].setBounds).toHaveBeenCalledWith({ x: -500, y: 100, width: 200, height: 30 });
    mocks.shortcuts.get('F8')!();
    expect(await pending).toEqual(snapshot);
    expect(mocks.shortcuts.size).toBe(0); expect(service.isPicking()).toBe(false);
    expect(window.show).toHaveBeenCalledOnce(); expect(mocks.close).toHaveBeenCalled();
  });
  it.each(['Escape', 'timeout', 'cancel'])('%s 取消保留原引用且无快捷键残留', async source => {
    const pending = service.pick(id);
    if (source === 'Escape') mocks.shortcuts.get('Escape')!();
    else if (source === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
    else { service.cancel('不同请求'); expect(service.isPicking()).toBe(true); service.cancel(id); }
    expect(await pending).toBeNull(); expect(mocks.shortcuts.size).toBe(0); expect(window.show).toHaveBeenCalledOnce();
  });
  it('与屏幕取点互斥；快捷键注册失败和定位失败同样清理', async () => {
    const other = new DesktopElementService(() => window as any, () => true);
    await expect(other.pick(id)).rejects.toThrow('当前捕获或取点'); other.close();
    mocks.register.mockReturnValue(false);
    await expect(service.pick(id)).rejects.toThrow('已被占用'); expect(mocks.shortcuts.size).toBe(0);
    mocks.register.mockImplementation((key, callback) => { mocks.shortcuts.set(key, callback); return true; });
    mocks.inspect.mockRejectedValue(new Error('PERMISSION: 权限不足'));
    await expect(service.pick(id)).rejects.toThrow('权限不足'); expect(mocks.shortcuts.size).toBe(0);
  });
  it('取消后迟到的定位结果不显示高亮', async () => {
    let resolve!: (value: DesktopElementSnapshot) => void;
    mocks.inspect.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = service.pick(id); service.cancel(id); resolve(snapshot);
    await pending; await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.overlays.length).toBe(0); expect(mocks.shortcuts.size).toBe(0);
  });
  it('退出期间清理校验辅助进程，迟到的校验不能重建高亮窗口', async () => {
    let resolve!: (value: { count: number; matches: DesktopElementSnapshot[] }) => void;
    mocks.validate.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = service.validate(snapshot.element);
    service.close(); resolve({ count: 1, matches: [snapshot] });
    await expect(pending).rejects.toThrow('服务已关闭');
    expect(mocks.close).toHaveBeenCalled(); expect(mocks.overlays.length).toBe(0);
  });
});
