import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
const cleanupHistory = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../packages/browser/src/download-history.js', () => ({ removeTemporaryDownloadHistory: cleanupHistory }));
import { BrowserSession } from '../packages/browser/src/index.js';

it('releases the profile and notifies closure even if transient download history cleanup fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rpa-close-cleanup-'));
  const profileDir = join(directory, 'profile');
  const options = { profileDir, downloadDir: directory, headless: true, runId: 'cleanup-failure' };
  const browser = new BrowserSession(options);
  const next = new BrowserSession({ ...options, runId: 'after-cleanup-failure' });
  try {
    await browser.start();
    const closed = vi.fn();
    browser.onClosed(closed);
    cleanupHistory.mockRejectedValueOnce(new Error('history locked'));
    await expect(browser.close()).rejects.toThrow('history locked');
    expect(browser.isOpen()).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(stat(join(profileDir, '.rpa-profile.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await next.start();
    expect(next.isOpen()).toBe(true);
  } finally {
    await browser.close().catch(() => undefined);
    await next.close();
    await rm(directory, { recursive: true, force: true });
  }
});
