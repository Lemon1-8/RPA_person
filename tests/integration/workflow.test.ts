import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoWorkflow } from '../../examples/demo.js';
import { startFixtureServer } from '../fixtures/server.js';
import { RunManager } from '../../apps/runner/src/manager.js';
import type { RunEvent } from '../../packages/contracts/src/index.js';
import { createServer, type ServerResponse } from 'node:http';

describe('D0/D1 真实下载闭环', () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let manager: RunManager;
  let directory: string;
  const events: RunEvent[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rpa-full-'));
    fixture = await startFixtureServer(); manager = new RunManager({ dataDir: directory }); await manager.initialize();
    manager.on('event', e => events.push(e));
  });
  afterAll(async () => { await manager?.shutdown(); await fixture?.close(); });
  it('可视化 → Python → JS → TS → 可视化共用状态，重复导出生成不同文件', async () => {
    const definition = createDemoWorkflow(fixture.url, join(directory, 'downloads'), true);
    definition.settings.keepBrowserOpen = false;
    const flow = await manager.saveWorkflow(definition);
    const first = await manager.waitForRun((await manager.runWorkflow(flow)).runId);
    expect(first.status, first.error).toBe('succeeded');
    expect(first.variables.pythonResult).toBe('跨语言订单');
    expect(first.variables.jsResult).toBe('跨语言订单');
    expect(first.variables.tsResult).toBe('跨语言订单');
    const csv = await readFile(first.artifacts[0].path, 'utf8');
    expect(csv).toContain('跨语言订单'); expect(csv).toContain('ORD-DEMO');
    expect(first.artifacts[0].size).toBe(Buffer.byteLength(csv));
    const second = await manager.waitForRun((await manager.runWorkflow(flow)).runId);
    expect(second.status, second.error).toBe('succeeded');
    expect(second.artifacts[0].path).not.toBe(first.artifacts[0].path);
    expect(await readFile(first.artifacts[0].path, 'utf8')).toBe(csv);
  });
  it('失败准确定位步骤，后续下载不触发', async () => {
    const flow = createDemoWorkflow(fixture.url, join(directory, 'failed-downloads'), true);
    flow.workflowId = 'failure-demo'; flow.steps = [flow.steps[0], { stepId: 'missing', name: '等待不存在元素', actionType: 'browser.wait', params: { selector: '#missing' }, timeoutMs: 300 }, flow.steps.at(-1)!];
    const saved = await manager.saveWorkflow(flow);
    const result = await manager.waitForRun((await manager.runWorkflow(saved)).runId);
    expect(result.status).toBe('failed'); expect(result.currentStepId).toBe('missing'); expect(result.artifacts).toEqual([]);
    expect(events.some(e => e.runId === result.runId && e.stepId === 'missing' && e.status === 'failed')).toBe(true);
  });
  it('读取失败暂停保留浏览器，人工处理后继续原步骤', async () => {
    let response: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.url === '/release') response = res;
      else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<body><script>fetch("/release").then(()=>{document.body.innerHTML="<p id=done>ready</p>"})</script></body>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const flow = createDemoWorkflow(`http://127.0.0.1:${port}`, directory, true);
      flow.workflowId = 'manual-resume';
      flow.steps = [flow.steps[0], { stepId: 'wait', name: '等待人工结果', actionType: 'browser.wait', params: { selector: '#done' }, timeoutMs: 500, onError: 'pause' }, { stepId: 'text', name: '读取恢复结果', actionType: 'browser.text', params: { selector: '#done' }, output: 'text' }];
      const saved = await manager.saveWorkflow(flow);
      const paused = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { manager.off('event', listener); reject(new Error('未进入等待人工状态')); }, 10000);
        const listener = (event: RunEvent) => { if (event.run?.workflowId === flow.workflowId && event.status === 'waiting_manual') { clearTimeout(timer); manager.off('event', listener); resolve(); } };
        manager.on('event', listener);
      });
      const run = await manager.runWorkflow(saved); await paused;
      expect(response).toBeTruthy(); response!.end('ok');
      await manager.controlRun(run.runId, 'resume');
      const result = await manager.waitForRun(run.runId);
      expect(result.status, result.error).toBe('succeeded'); expect(result.variables.text).toBe('ready');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
