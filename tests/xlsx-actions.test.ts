import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import xlsx from 'xlsx';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';

const { readFile: readWorkbook, utils: xlsxUtils, writeFile: writeWorkbook } = xlsx;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-xlsx-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

describe('XLSX file actions', () => {
  it('读取、遍历、处理并保存 JSON 行列表', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const input = join(dataDir, 'input.xlsx');
    const output = join(dataDir, 'output.xlsx');
    const sourceSheet = xlsxUtils.json_to_sheet([{ sku: 'A001', qty: 2 }, { sku: 'B002', qty: 3 }]);
    const sourceBook = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(sourceBook, sourceSheet, '订单');
    writeWorkbook(sourceBook, input);

    const workflow: WorkflowDefinition = {
      schemaVersion: 1,
      workflowId: 'xlsx-flow',
      name: 'XLSX 流程',
      revision: 1,
      variables: {},
      elements: {},
      settings: { downloadDir: dataDir, headless: true },
      steps: [
        { stepId: 'read', name: '读取', actionType: 'file.xlsxRead', params: { path: input, sheetName: '订单' }, output: 'workbook' },
        { stepId: 'each', name: '遍历', actionType: 'control.forEach', params: { items: '{{workbook.rows}}', itemVariable: 'row' }, children: [
          { stepId: 'last', name: '记录最后一行', actionType: 'variables.set', params: { name: 'lastSku', value: '{{row.sku}}' } },
        ] },
        { stepId: 'process', name: '处理', actionType: 'script.run', params: { language: 'javascript', code: `
          const rows = await rpa.get('workbook.rows');
          await rpa.set('processed', rows.map(row => ({ sku: row.sku, qty: row.qty, total: Number(row.qty) * 10 })));
        ` } },
        { stepId: 'write', name: '保存', actionType: 'file.xlsxWrite', params: { path: output, rows: '{{processed}}', sheetName: '结果' }, output: 'saved' },
      ],
    };
    const runner = new WorkflowEngine(workflow, { dataDir, runId: 'xlsx-run' });
    const result = await runner.run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables.lastSku).toBe('B002');
    expect(result.variables.saved).toMatchObject({ path: output, name: 'output.xlsx' });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ path: output, name: 'output.xlsx', stepId: 'write' });
    const written = readWorkbook(output);
    expect(written.SheetNames).toContain('结果');
    expect(xlsxUtils.sheet_to_json(written.Sheets['结果']!)).toEqual([
      { sku: 'A001', qty: 2, total: 20 },
      { sku: 'B002', qty: 3, total: 30 },
    ]);
  });
});
