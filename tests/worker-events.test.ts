import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import xlsx from 'xlsx';
import type { RunEvent, RunSnapshot, WorkflowDefinition } from '../packages/contracts/src/index.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-worker-events-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('Electron 任务进程事件交付', () => {
  it.each(['succeeded', 'failed', 'stopped'] as const)('大变量造成 IPC 积压时，交付 XLSX 日志和最终 %s 状态后再退出', async status => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-worker-events-'));
    directories.push(dataDir);
    const file = join(dataDir, 'rows.xlsx');
    const rows = Array.from({ length: 16 }, (_, index) => [`店铺${index + 1}`, index + 1]);
    const book = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['店铺', '序号'], ...rows]), '数据');
    await writeFile(file, xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }));
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'worker-events', name: '事件交付', revision: 1,
      variables: { workbookData: '数据'.repeat(500_000), row: '外层值' }, elements: {},
      settings: { downloadDir: dataDir, headless: true, keepBrowserOpen: false },
      steps: [{ stepId: 'loop', name: '遍历 XLSX', actionType: 'control.forEachXlsx',
        params: { path: file, valueMode: 'array', itemVariable: 'row' }, output: 'loopResult', children: [
          { stepId: 'print', name: '打印日志', actionType: 'core.log', params: { message: '{{row}}[0], {{row}}[1]' } },
        ] }],
    };
    if (status === 'failed') workflow.steps.push({ stepId: 'fail', name: '失败校验', actionType: 'core.assert', params: { actual: 1, expected: 2 } });
    if (status === 'stopped') workflow.steps[0]!.children!.push({ stepId: 'wait', name: '等待停止', actionType: 'core.wait', params: { durationSeconds: 0.1 } });
    const root = fileURLToPath(new URL('../', import.meta.url));
    const child = spawn(createRequire(import.meta.url)('electron') as string,
      ['--import', 'tsx', join(root, 'apps/runner/src/worker.ts')], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RPA_ROOT: root },
      });
    const messages: string[] = [];
    const statuses: string[] = [];
    let final: RunSnapshot | undefined;
    let stderr = '';
    let stopRequested = false;
    let stopAcknowledged = false;
    child.stderr!.on('data', data => { stderr += String(data); });
    child.on('message', (message: { type: string; requestId?: string; error?: string; event?: RunEvent }) => {
      if (message.type === 'control-result' && message.requestId === 'stop') stopAcknowledged = !message.error;
      const event = message.event;
      if (event?.type === 'log' && event.stepId === 'print') messages.push(event.message!);
      if (status === 'stopped' && messages.length > 0 && !stopRequested) {
        stopRequested = true;
        child.send({ type: 'control', command: 'stop', requestId: 'stop' });
      }
      if (event?.run) {
        statuses.push(event.run.status);
        if (['succeeded', 'failed', 'stopped'].includes(event.run.status)) final = event.run;
      }
    });
    try {
      const timer = setTimeout(() => child.kill(), 15_000);
      const closed = new Promise<number | null>((resolveClosed, reject) => {
        child.once('error', reject);
        child.once('close', code => { clearTimeout(timer); resolveClosed(code); });
      });
      child.send({ type: 'start', workflow, options: { dataDir, runId: 'events-run' } });
      expect(await closed, stderr).toBe(0);
      if (status === 'stopped') {
        expect(stopAcknowledged).toBe(true);
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.length).toBeLessThan(rows.length);
        expect(messages).toEqual(rows.slice(0, messages.length).map(row => `${row[0]}, ${row[1]}`));
      } else expect(messages).toEqual(rows.map(row => `${row[0]}, ${row[1]}`));
      expect(statuses.at(-1), '退出前必须交付最终状态，避免完整执行被标成意外中断').toBe(status);
      expect(final?.variables.row).toBe('外层值');
      if (status === 'stopped') expect(final?.variables).not.toHaveProperty('loopResult');
      else expect(final?.variables.loopResult).toEqual({ count: rows.length });
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});
