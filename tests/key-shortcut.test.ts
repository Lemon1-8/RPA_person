import { describe, expect, it } from 'vitest';
import { shortcutFromKeydown } from '../apps/desktop/src/renderer/key-shortcut.js';

function keydown(key: string, code: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {}) {
  return { key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

describe('快捷键录制', () => {
  it('等待修饰键并录制完整组合键', () => {
    expect(shortcutFromKeydown(keydown('Control', 'ControlLeft', { ctrlKey: true }))).toBeUndefined();
    expect(shortcutFromKeydown(keydown('k', 'KeyK', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+K');
  });

  it('支持功能键、空格和带 Shift 的字符', () => {
    expect(shortcutFromKeydown(keydown('F8', 'F8'))).toBe('F8');
    expect(shortcutFromKeydown(keydown(' ', 'Space'))).toBe('Space');
    expect(shortcutFromKeydown(keydown('!', 'Digit1', { shiftKey: true }))).toBe('Shift+1');
  });

  it('忽略输入法合成键和无法表示的按键', () => {
    expect(shortcutFromKeydown(keydown('Process', 'KeyA'))).toBeUndefined();
    expect(shortcutFromKeydown(keydown('+', 'NumpadAdd'))).toBeUndefined();
  });
});
