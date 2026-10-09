import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowsSession } from '../packages/windows/src/index.js';
import { withDesktopInteraction } from '../packages/windows/src/interaction-lock.js';
import { desktopInteractionAvailable, startWindowsFixture, type WindowsFixture } from './fixtures/windows.js';

describe.skipIf(process.platform !== 'win32')('真实 Windows UIA 控件', () => {
  let fixture: WindowsFixture; let session: WindowsSession;
  beforeEach(async () => { fixture = await startWindowsFixture(); session = new WindowsSession(); });
  afterEach(async () => { session?.close(); await fixture?.close(); });
  it('获取窗口、捕获和读取；移动窗口及重建控件后按保存条件重新定位', async () => {
    const capture = await session.inspect(fixture.x, fixture.y);
    expect(capture?.attributes).toMatchObject({ Name: '输入', ControlType: 'Edit', AutomationId: 'input' });
    const window = await session.call('windows.findWindow', { window: { title: { value: fixture.title, match: 'exact' } } }) as { attributes: { Name: string } };
    expect(window.attributes.Name).toBe(fixture.title);
    expect(await session.validate(capture!.element)).toMatchObject({ count: 1 });
    expect(await session.call('windows.text', { element: capture!.element })).toBe('初始');
    const first = await session.call('windows.bounds', { element: capture!.element }) as { x: number };
    await fixture.call('move');
    const moved = await session.call('windows.bounds', { element: capture!.element }) as { x: number };
    expect(moved.x).toBeGreaterThan(first.x);
    await fixture.call('recreate');
    expect(await session.call('windows.text', { element: capture!.element })).toBe('重建');
    expect(await session.call('windows.getAttribute', { element: capture!.element, name: 'IsEnabled' })).toBe(true);
    const parent = await session.call('windows.related', { element: capture!.element, relation: 'parent' });
    expect(parent).toMatchObject({ backend: 'uia', path: [] });
    const children = await session.call('windows.related', { element: parent, relation: 'children' }) as unknown[];
    expect(children.length).toBeGreaterThanOrEqual(8);
    expect(await session.call('windows.related', { element: parent, relation: 'child', index: 0 })).toMatchObject({ backend: 'uia' });
  });
  it('通过 UIA 填写、追加、点击、勾选和选择下拉选项', async () => {
    await session.call('windows.fill', { element: fixture.element('输入'), value: '中文输入', append: false });
    await session.call('windows.fill', { element: fixture.element('输入'), value: '追加', append: true });
    await session.call('windows.click', { element: fixture.element('提交') });
    await session.call('windows.check', { element: fixture.element('同意'), checked: true });
    await session.call('windows.select', { element: fixture.element('城市'), item: { value: '上海', match: 'exact' } });
    expect(await fixture.call('state')).toMatchObject({ text: '中文输入追加', clicks: 1, checked: true, selected: '上海' });
    await session.call('windows.check', { element: fixture.element('同意'), checked: false });
    expect((await fixture.call('state')).checked).toBe(false);
  });
  it('明确报告不存在、歧义、禁用和接口不支持；等待超时后可重新启动', async () => {
    expect(await session.call('windows.exists', { element: fixture.element('不存在') })).toBe(false);
    await expect(session.call('windows.click', { element: fixture.element('重复') })).rejects.toThrow('AMBIGUOUS');
    expect(await session.validate(fixture.element('重复'))).toMatchObject({ count: 2 });
    await expect(session.call('windows.click', { element: fixture.element('禁用') })).rejects.toThrow('UNAVAILABLE');
    await expect(session.call('windows.click', { element: fixture.element('结果') })).rejects.toThrow('UNSUPPORTED');
    expect(await session.call('windows.wait', { element: fixture.element('不存在'), state: 'gone' })).toBe(true);
    await expect(session.call('windows.wait', { element: fixture.element('不存在'), state: 'exists' }, 800)).rejects.toThrow(/超时/);
    expect(await session.call('windows.exists', { element: fixture.element('输入') })).toBe(true);
  });
  it('模拟操作激活真实窗口并输入；已取消的调用不产生操作', async context => {
    if (!await desktopInteractionAvailable()) { console.warn('跳过真实键鼠：当前桌面拒绝 SetCursorPos（锁屏或管控环境）'); context.skip(); }
    await fixture.call('activate');
    await session.call('windows.fill', { element: fixture.element('输入'), mode: 'simulate', value: '真实键盘', append: false });
    await session.call('windows.click', { element: fixture.element('提交'), mode: 'simulate' });
    expect(await fixture.call('state')).toMatchObject({ text: '真实键盘', clicks: 1 });
    await session.call('windows.fill', { element: fixture.element('输入'), mode: 'simulate', value: '', append: false });
    expect((await fixture.call('state')).text).toBe('');
    await session.call('windows.fill', { element: fixture.element('输入'), mode: 'simulate', value: '追加', append: true });
    expect((await fixture.call('state')).text).toBe('追加');
    const abort = new AbortController(); abort.abort(new Error('已取消'));
    await expect(session.call('windows.click', { element: fixture.element('提交') }, 30_000, abort.signal)).rejects.toThrow('已取消');
    expect((await fixture.call('state')).clicks).toBe(1);
  });
  it('停止等待和关闭辅助进程会拒绝请求，后续调用能够恢复', async () => {
    await session.call('windows.exists', { element: fixture.element('输入') });
    const abort = new AbortController();
    const waiting = session.call('windows.wait', { element: fixture.element('不存在'), state: 'exists' }, 20_000, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(waiting).rejects.toThrow('已取消');
    expect(await session.call('windows.exists', { element: fixture.element('输入') })).toBe(true);
    const pending = session.call('windows.wait', { element: fixture.element('不存在'), state: 'exists' });
    setTimeout(() => session.close(), 100);
    await expect(pending).rejects.toThrow('已关闭');
  });
  it('排队的请求及时超时或取消，不执行迟到的点击；辅助进程意外退出后可恢复', async () => {
    await session.call('windows.exists', { element: fixture.element('输入') });
    const abort = new AbortController();
    const hold = session.call('windows.wait', { element: fixture.element('不存在'), state: 'exists' }, 20_000, abort.signal);
    const timed = session.call('windows.click', { element: fixture.element('提交') }, 100);
    await expect(timed).rejects.toThrow('超时');
    const cancelled = new AbortController();
    const queued = session.call('windows.click', { element: fixture.element('提交') }, 20_000, cancelled.signal);
    cancelled.abort(); await expect(queued).rejects.toThrow('已取消');
    abort.abort(); await expect(hold).rejects.toThrow('已取消');
    expect((await fixture.call('state')).clicks).toBe(0);
    await session.call('windows.exists', { element: fixture.element('输入') });
    const waiting = session.call('windows.wait', { element: fixture.element('不存在'), state: 'exists' }, 20_000);
    await new Promise(resolve => setTimeout(resolve, 100));
    (session as unknown as { child: { kill(): void } }).child.kill();
    await expect(waiting).rejects.toThrow('辅助进程退出');
    expect(await session.call('windows.exists', { element: fixture.element('输入') })).toBe(true);
  });
  it('交互锁等待计入超时，并可取消而不进入临界区', async () => {
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = withDesktopInteraction(10_000, undefined, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await started;
    try {
      await expect(withDesktopInteraction(100, undefined, async () => { throw new Error('不能进入'); })).rejects.toThrow('超时');
      const abort = new AbortController();
      const pending = withDesktopInteraction(10_000, abort.signal, async () => { throw new Error('不能进入'); });
      setTimeout(() => abort.abort(), 100);
      await expect(pending).rejects.toThrow('已取消');
    } finally { release(); await hold; }
  });
});
