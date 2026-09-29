import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { RunManager } from '../apps/runner/src/manager.js';

it('routes coordinate picks through the worker, prevents overlapping runs and cancels only the matching request', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rpa-point-manager-'));
  const manager = new RunManager({ dataDir, autoStartSchedules: false });
  let peer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await manager.initialize();
    const flow = await manager.saveWorkflow({ schemaVersion: 1, workflowId: 'point-manager', name: '坐标测试', revision: 0, variables: {}, elements: {},
      settings: { headless: false, downloadDir: dataDir, keepBrowserOpen: true }, steps: [
        { stepId: 'start', name: '准备浏览器', actionType: 'browser.start', params: {}, output: 'connection' },
        { stepId: 'click', name: '点击', actionType: 'browser.mouseClick', params: { x: 30, y: 30 } },
      ] });
    const started = await manager.waitForRun((await manager.runStep(flow, 'start')).runId);
    expect(started.status, started.error).toBe('succeeded');
    peer = await chromium.connectOverCDP(`http://127.0.0.1:${(started.variables.connection as { debugPort: number }).debugPort}`);
    const page = peer.contexts()[0]!.pages()[0]!;
    await page.setContent('<button style="position:fixed;left:20px;top:20px;width:100px;height:40px" onclick="document.body.dataset.clicked=1">test</button>');
    await expect(manager.pickBrowserPoint('missing', 'main', randomUUID())).rejects.toThrow('已关闭');
    const id = randomUUID();
    const pending = manager.pickBrowserPoint(started.runId, 'main', id);
    await page.locator('[data-rpa-coordinate-picker]').waitFor();
    await expect(manager.runStep(flow, 'click', started.runId)).rejects.toThrow('取消取点');
    await expect(manager.runWorkflow(flow)).rejects.toThrow('取消取点');
    await expect(manager.pickBrowserPoint(started.runId, 'main', randomUUID())).rejects.toThrow('获取坐标');
    await manager.cancelBrowserPoint(started.runId, randomUUID());
    expect(await page.locator('[data-rpa-coordinate-picker]').count()).toBe(1);
    await manager.cancelBrowserPoint(started.runId, id);
    expect(await pending).toBeNull();
    expect(await page.locator('[data-rpa-coordinate-picker]').count()).toBe(0);
    const next = manager.pickBrowserPoint(started.runId, 'main', randomUUID());
    await page.locator('[data-rpa-coordinate-picker]').waitFor();
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.mouse.click(30, 30);
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    expect(await next).toEqual({ pageId: 'main', x: 30, y: 30 });
    await manager.runStep(flow, 'click', started.runId);
    expect((await manager.waitForRun(started.runId)).status).toBe('succeeded');
    expect(await page.evaluate(() => document.body.dataset.clicked)).toBe('1');
    const last = manager.pickBrowserPoint(started.runId, 'main', randomUUID());
    await page.locator('[data-rpa-coordinate-picker]').waitFor();
    await manager.controlRun(started.runId, 'closeBrowser');
    expect(await last).toBeNull();
    expect(manager.listRuns()[0].browserOpen).toBe(false);
  } finally {
    await peer?.close(); await manager.shutdown();
    if (dirname(resolve(dataDir)) !== resolve(tmpdir()) || !basename(dataDir).startsWith('rpa-point-manager-')) throw new Error('Unsafe cleanup');
    await rm(dataDir, { recursive: true, force: true });
  }
});
