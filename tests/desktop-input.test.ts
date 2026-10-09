import { describe, expect, it } from 'vitest';
import { runDesktopInput, runDesktopInputUnlocked } from '../packages/engine/src/desktop-input.js';

describe.skipIf(process.platform !== 'win32')('Windows desktop input bridge', () => {
  it('starts the native input bridge and rejects unsupported shortcuts without sending input', async () => {
    await expect(runDesktopInput('probe', {})).resolves.toEqual({ ok: true });
    await expect(runDesktopInput('desktop.keyPress', { key: 'NotAKey' })).rejects.toThrow('不支持的按键');
  });

  it('honors a stopped run before sending input', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runDesktopInput('desktop.keyboardType', { text: '不应输入' }, 30_000, abort.signal))
      .rejects.toThrow('已取消');
  });
  it('refuses element simulation after losing the expected foreground window, without sending input', async () => {
    await expect(runDesktopInputUnlocked('desktop.elementFill', { x: 0, y: 0, text: '不应输入', expectedWindow: -1 })).rejects.toThrow('目标窗口已失去前台焦点');
  });
});
