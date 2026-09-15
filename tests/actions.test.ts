import { describe, expect, it } from 'vitest';
import { validateActionParams } from '../packages/actions/src/index.js';

describe('action parameter validation boundary', () => {
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
});
