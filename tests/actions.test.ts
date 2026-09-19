import { describe, expect, it } from 'vitest';
import { actionDefinitions, validateActionParams } from '../packages/actions/src/index.js';

describe('action parameter validation boundary', () => {
  it('打开网页包含启动配置，校验端口和打开方式并保留旧启动动作', () => {
    const params = { url: 'https://example.com', pageId: '订单页', openMode: 'new', browserChannel: 'chrome', debugPort: 9223 };
    expect(validateActionParams('browser.open', params)).toEqual(params);
    for (const invalid of [{ debugPort: -1 }, { debugPort: 9223.5 }, { debugPort: 65536 }, { browserChannel: 'unknown' }, { openMode: 'unknown' }]) {
      expect(() => validateActionParams('browser.open', { ...params, ...invalid })).toThrow('参数错误');
    }
    expect(validateActionParams('browser.start', { browserChannel: 'auto', debugPort: 0 })).toEqual({ browserChannel: 'auto', debugPort: 0 });
    expect(validateActionParams('browser.switchPage', { pageId: '订单页' })).toEqual({ pageId: '订单页' });
    expect(validateActionParams('browser.switchPage', { pageId: '' })).toEqual({ pageId: '' });
    expect(() => validateActionParams('browser.switchPage', { pageId: 42 })).toThrow('参数错误');
    expect(validateActionParams('browser.closePage', {})).toEqual({});
  });

  it('旧点击动作的新网页选项不再参与校验或传给浏览器', () => {
    for (const newPageId of ['main', '{{missing.pageId}}', { pageId: 'detail' }, null]) {
      expect(validateActionParams('browser.click', { selector: '#open', pageId: 'main', waitForNewPage: true, newPageId }))
        .toEqual({ selector: '#open', pageId: 'main' });
    }
  });

  it('关闭所有网页只接受明确的关闭范围，并保留旧单页关闭参数', () => {
    expect(validateActionParams('browser.closePage', { pageId: 'detail' })).toEqual({ pageId: 'detail' });
    expect(validateActionParams('browser.closePage', { closeMode: 'page', pageId: '$current' })).toEqual({ closeMode: 'page', pageId: '$current' });
    for (const pageId of ['already-closed', '{{missing.pageId}}', { pageId: 'detail' }]) {
      expect(validateActionParams('browser.closePage', { closeMode: 'all', pageId })).toEqual({ closeMode: 'all' });
    }
    for (const closeMode of ['', 'ALL', 'allBrowsers', true, null]) {
      expect(() => validateActionParams('browser.closePage', { closeMode })).toThrow('参数错误');
    }
    expect(() => validateActionParams('browser.closePage', { closeMode: 'page', pageId: 42 })).toThrow('参数错误');
  });

  it('网页字段引用对象时指出具体字段和网页名称属性', () => {
    expect(() => validateActionParams('browser.click', { selector: '#open', pageId: { pageId: 'detail', url: 'https://example.com' } }))
      .toThrow('目标网页必须是文本，不能使用整个对象；请引用其中的网页名称，例如 {{变量.pageId}}');
  });

  it('rejects invalid download destinations and names while preserving the inherited directory option', () => {
    for (const directory of [25, null, {}, [], false, 'relative/downloads', '   ', ...(process.platform === 'win32' ? ['/downloads', '\\downloads', 'C:downloads', '\\\\server'] : [])]) {
      expect(() => validateActionParams('browser.download', { selector: '#download', directory })).toThrow('参数错误');
    }
    for (const filename of [25, null, {}, [], false]) {
      expect(() => validateActionParams('browser.download', { selector: '#download', filename })).toThrow('参数错误');
    }
    expect(validateActionParams('browser.download', { selector: '#download', directory: '', filename: '' })).toEqual({ selector: '#download', directory: '', filename: '' });
    const directory = process.platform === 'win32' ? 'C:\\RPA\\下载结果' : '/tmp/rpa-downloads';
    expect(validateActionParams('browser.download', { selector: '#download', directory, filename: 'orders.csv' })).toEqual({ selector: '#download', directory, filename: 'orders.csv' });
    if (process.platform === 'win32') {
      expect(validateActionParams('browser.download', { selector: '#download', directory: '\\\\server\\share' }).directory).toBe('\\\\server\\share');
    }
  });

  it('requires a usable selector or a structured element reference with valid frame selectors', () => {
    const invalidTargets = [
      {}, { element: 42 }, { element: 'target' }, { element: {} }, { element: [] },
      { element: { selector: '' } }, { element: { selector: '   ' } }, { element: { selector: '#customer', pageRef: 42 } },
      { element: { selector: '#customer', framePath: [''] } }, { element: { selector: '#customer', framePath: ['   '] } },
      { element: { selector: '#customer', framePath: [42] } }, { element: { selector: '#customer', expectedCount: 0 } },
      { element: { selector: '#customer', expectedCount: 1.5 } }, { selector: '   ' },
      { selector: '#customer', framePath: [''] }, { selector: '#customer', framePath: ['   '] },
    ];
    for (const params of invalidTargets) expect(() => validateActionParams('browser.click', params)).toThrow('参数错误');
    const element = { selector: '#frame-input', pageRef: 'main', framePath: ['#outer-frame', '#inner-frame'], expectedCount: 1 };
    expect(validateActionParams('browser.fill', { element, value: 'test' })).toEqual({ element, value: 'test' });
    expect(validateActionParams('browser.click', { selector: '#customer', framePath: [] })).toEqual({ selector: '#customer', framePath: [] });
    expect(validateActionParams('browser.click', { selector: '@customer' })).toEqual({ selector: '@customer' });
    expect(validateActionParams('browser.click', { selector: '#customer', clickMode: 'dom' })).toEqual({ selector: '#customer', clickMode: 'dom' });
    expect(validateActionParams('browser.click', { selector: '#customer', clickMode: '' })).toEqual({ selector: '#customer', clickMode: 'normal' });
    expect(() => validateActionParams('browser.click', { selector: '#customer', clickMode: 'script' })).toThrow('参数错误');
    expect(actionDefinitions.find(action => action.type === 'browser.click')?.fields.find(field => field.key === 'clickMode')?.required).toBe(true);
  });

  it('validates response filters and normalizes an optional HTTP method without changing request content', () => {
    const base = { selector: '#fetch-response', urlIncludes: '/api/orders' };
    for (const method of [25, null, {}, 'GET POST', 'GET\nPOST']) {
      expect(() => validateActionParams('browser.response', { ...base, method })).toThrow('参数错误');
    }
    for (const requestIncludes of [25, null, {}]) {
      expect(() => validateActionParams('browser.response', { ...base, requestIncludes })).toThrow('参数错误');
    }
    expect(() => validateActionParams('browser.response', { ...base, urlIncludes: '   ' })).toThrow('参数错误');
    expect(validateActionParams('browser.response', { ...base, method: ' get ', requestIncludes: 'customer=Alice' })).toEqual({ ...base, method: 'GET', requestIncludes: 'customer=Alice' });
    expect(validateActionParams('browser.response', { ...base, method: '', requestIncludes: '' })).toEqual({ ...base, method: '', requestIncludes: '' });
  });

  it('validates low-level mouse, keyboard, and XLSX file actions', () => {
    expect(validateActionParams('browser.mouseClick', { pageId: '$current', x: 12, y: 34, button: 'right', clickCount: 2, delayMs: 15 }))
      .toEqual({ pageId: '$current', x: 12, y: 34, button: 'right', clickCount: 2, delayMs: 15 });
    expect(validateActionParams('browser.mouseMove', { x: 1, y: 2, steps: 3 })).toEqual({ x: 1, y: 2, steps: 3 });
    expect(validateActionParams('browser.mouseWheel', { deltaX: -10, deltaY: 500 })).toEqual({ deltaX: -10, deltaY: 500 });
    expect(validateActionParams('browser.keyPress', { key: 'ControlOrMeta+A' })).toEqual({ key: 'ControlOrMeta+A' });
    expect(validateActionParams('browser.keyboardType', { text: '订单', delayMs: 0 })).toEqual({ text: '订单', delayMs: 0 });
    for (const params of [{ x: -1, y: 0 }, { x: 0, y: Number.NaN }, { x: 0, y: 0, button: 'primary' }, { x: 0, y: 0, clickCount: 0 }]) {
      expect(() => validateActionParams('browser.mouseClick', params)).toThrow('参数错误');
    }
    expect(() => validateActionParams('browser.keyPress', { key: '' })).toThrow('参数错误');
    expect(() => validateActionParams('browser.keyboardType', { text: 'ok', delayMs: -1 })).toThrow('参数错误');

    const file = process.platform === 'win32' ? 'C:\\RPA\\orders.xlsx' : '/tmp/orders.xlsx';
    expect(validateActionParams('file.xlsxRead', { path: file, sheetName: '' })).toEqual({ path: file, sheetName: '' });
    expect(validateActionParams('file.xlsxWrite', { path: file, rows: [{ id: 'A001', amount: 12 }], sheetName: '结果' }))
      .toEqual({ path: file, rows: [{ id: 'A001', amount: 12 }], sheetName: '结果' });
    for (const path of ['orders.xlsx', file.replace(/\.xlsx$/i, '.csv'), '', 42]) {
      expect(() => validateActionParams('file.xlsxRead', { path })).toThrow('参数错误');
    }
    for (const sheetName of [' bad', 'bad ', 'a:b', 'x'.repeat(32)]) {
      expect(() => validateActionParams('file.xlsxWrite', { path: file, rows: [], sheetName })).toThrow('参数错误');
    }
    expect(() => validateActionParams('file.xlsxWrite', { path: file, rows: [1] })).toThrow('参数错误');
  });
});
