import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDebugPortAvailable, killNativeBrowser, launchNativeBrowser, resolveBrowser } from '../packages/browser/src/native-browser.js';
import { validateActionParams } from '../packages/actions/src/index.js';

afterEach(() => vi.unstubAllEnvs());

describe('native browser startup', () => {
  it('validates browser action options and debug port boundaries', async () => {
    expect(validateActionParams('browser.start', {})).toEqual({});
    expect(validateActionParams('browser.start', { browserChannel: 'chrome', debugPort: 9222 })).toEqual({ browserChannel: 'chrome', debugPort: 9222 });
    for (const debugPort of [-1, 80, 65536, 1.5]) {
      expect(() => validateActionParams('browser.start', { debugPort })).toThrow('调试端口');
      await expect(assertDebugPortAvailable(debugPort)).rejects.toMatchObject({ code: 'INVALID_DEBUG_PORT' });
    }
    expect(() => validateActionParams('browser.start', { browserChannel: 'firefox' })).toThrow();
  });

  it.skipIf(process.platform !== 'win32')('reports a missing explicitly selected browser without silently changing channels', async () => {
    vi.stubEnv('LOCALAPPDATA', '');
    vi.stubEnv('PROGRAMFILES', '');
    vi.stubEnv('PROGRAMFILES(X86)', '');
    await expect(resolveBrowser('chrome', false)).rejects.toMatchObject({ code: 'BROWSER_NOT_INSTALLED', message: expect.stringContaining('Google Chrome') });
    await expect(resolveBrowser('msedge', false)).rejects.toMatchObject({ code: 'BROWSER_NOT_INSTALLED', message: expect.stringContaining('Microsoft Edge') });
    await expect(resolveBrowser('auto', false)).rejects.toMatchObject({ code: 'BROWSER_NOT_INSTALLED' });
    await expect(resolveBrowser('auto', true)).resolves.toMatchObject({ channel: 'chromium' });
  });

  it('reports early process exit instead of waiting for the whole startup timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-native-failure-'));
    // Node is deliberately not a browser and rejects Chrome command-line switches.
    const native = launchNativeBrowser(process.execPath, directory, 0, true, new AbortController().signal);
    try {
      await expect(native.endpoint).rejects.toMatchObject({ code: 'BROWSER_START_FAILED' });
      await native.exited;
    } finally {
      await killNativeBrowser(native);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cancels a spawned browser before its endpoint is ready and terminates that process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rpa-native-cancel-'));
    const installed = await resolveBrowser('chromium', true);
    const controller = new AbortController();
    const native = launchNativeBrowser(installed.executablePath, directory, 0, true, controller.signal);
    try {
      controller.abort();
      await expect(native.endpoint).rejects.toMatchObject({ code: 'BROWSER_START_CANCELLED' });
      await killNativeBrowser(native);
      expect(native.child.exitCode !== null || native.child.signalCode !== null).toBe(true);
    } finally {
      await killNativeBrowser(native);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
