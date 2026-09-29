import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import xlsx from 'xlsx';
import { WorkflowEngine } from '../packages/engine/src/index.js';
import { readXlsxColumnValues, readXlsxRows } from '../packages/engine/src/xlsx-file.js';
import type { WorkflowDefinition } from '../packages/contracts/src/index.js';

const { read: readWorkbook, utils: xlsxUtils, write: writeWorkbook } = xlsx;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('rpa-xlsx-')) throw new Error('拒绝清理测试目录之外的路径');
    await rm(target, { recursive: true, force: true });
  }));
});

describe('XLSX file actions', () => {
  it('读取 ZIP64 封装的 XLSX，不会按 4 GB 条目分配内存', () => {
    const file = fileURLToPath(new URL('./fixtures/zip64-sample.xlsx', import.meta.url));
    expect(readXlsxRows(file)).toEqual({ sheetName: '订单', rows: [{ sku: 'A001', qty: 2 }] });
    expect(() => readXlsxRows(file, '不存在')).toThrow('工作表不存在');
  });

  it('相同表头仍能按列下标区分两个单元格', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const file = join(dataDir, 'duplicate-headers.xlsx');
    const book = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(book, xlsxUtils.aoa_to_sheet([['相同', '相同'], ['甲', '乙']]), '数据');
    await writeFile(file, writeWorkbook(book, { type: 'buffer', bookType: 'xlsx' }));
    expect(readXlsxColumnValues(file, '数据', 0).values).toEqual(['甲']);
    expect(readXlsxColumnValues(file, '数据', 1).values).toEqual(['乙']);
  });

  it('把每一行作为数组遍历，循环体按下标直接取单元格', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const file = join(dataDir, 'indexed-rows.xlsx');
    const book = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(book, xlsxUtils.aoa_to_sheet([['相同', '相同'], ['甲', '乙'], ['丙', '丁']]), '数据');
    await writeFile(file, writeWorkbook(book, { type: 'buffer', bookType: 'xlsx' }));
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'xlsx-indexed-rows', name: '数组行遍历', revision: 1,
      variables: { row: '原值' }, elements: {}, settings: { downloadDir: dataDir, headless: true },
      steps: [{ stepId: 'each', name: '遍历数组行', actionType: 'control.forEachXlsx',
        params: { path: file, sheetName: '数据', valueMode: 'array', itemVariable: 'row' }, children: [
          { stepId: 'first', name: '取第一列', actionType: 'variables.set', params: { name: 'firstCell', value: '{{row}}[0]' } },
          { stepId: 'second', name: '取第二列', actionType: 'variables.set', params: { name: 'secondCell', value: '{{row}}[1]' } },
          { stepId: 'log', name: '打印两个值', actionType: 'core.log', params: { message: '当前行：{{row}}[0] / {{row}}[1]' } },
        ], output: 'loopResult' }],
    };
    const logs: string[] = [];
    const result = await new WorkflowEngine(workflow, { dataDir, runId: 'indexed-rows', onEvent: event => {
      if (event.type === 'log' && event.message) logs.push(event.message);
    } }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toMatchObject({ row: '原值', firstCell: '丙', secondCell: '丁', loopResult: { count: 2 } });
    expect(logs).toContain('当前行：甲 / 乙');
    expect(logs).toContain('当前行：丙 / 丁');
  });

  it('遍历 XLSX 的每一行并恢复循环变量', async () => {
    const file = fileURLToPath(new URL('./fixtures/zip64-sample.xlsx', import.meta.url));
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'xlsx-loop', name: '遍历 XLSX', revision: 1,
      variables: { row: '原值' }, elements: {}, settings: { downloadDir: dataDir, headless: true },
      steps: [{ stepId: 'each', name: '逐行', actionType: 'control.forEachXlsx',
        params: { path: file, sheetName: '', itemVariable: 'row' }, children: [
          { stepId: 'copy', name: '提取', actionType: 'variables.set', params: { name: 'sku', value: '{{row.sku}}' } },
        ], output: 'loopResult' }],
    };
    const result = await new WorkflowEngine(workflow, { dataDir, runId: 'zip64-loop' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toMatchObject({ row: '原值', sku: 'A001', loopResult: { count: 1 } });
  });

  it('按列下标逐行取得单个值，并在下标越界时给出错误', async () => {
    const file = fileURLToPath(new URL('./fixtures/zip64-sample.xlsx', import.meta.url));
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'xlsx-cell-loop', name: '遍历单列', revision: 1,
      variables: { item: '原值' }, elements: {}, settings: { downloadDir: dataDir, headless: true },
      steps: [{ stepId: 'each', name: '逐个值', actionType: 'control.forEachXlsx',
        params: { path: file, itemVariable: 'item', valueMode: 'column', columnIndex: 0 }, children: [
          { stepId: 'copy', name: '保存单值', actionType: 'variables.set', params: { name: 'last', value: '{{item}}' } },
        ] }],
    };
    const result = await new WorkflowEngine(workflow, { dataDir, runId: 'cell-loop' }).run();
    expect(result.status, result.error).toBe('succeeded');
    expect(result.variables).toMatchObject({ item: '原值', last: 'A001' });

    workflow.steps[0]!.params.columnIndex = 1;
    const numeric = await new WorkflowEngine(workflow, { dataDir, runId: 'numeric-column' }).run();
    expect(numeric.status, numeric.error).toBe('succeeded');
    expect(numeric.variables.last).toBe(2);

    workflow.steps[0]!.params.columnIndex = 99;
    const missing = await new WorkflowEngine(workflow, { dataDir, runId: 'missing-column' }).run();
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('列下标');
  });

  it('遍历时把当前行对象直接保存为单行 XLSX', async () => {
    const file = fileURLToPath(new URL('./fixtures/zip64-sample.xlsx', import.meta.url));
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const output = join(dataDir, 'single-row.xlsx');
    const workflow: WorkflowDefinition = {
      schemaVersion: 1, workflowId: 'xlsx-single-row', name: '导出当前行', revision: 1,
      variables: {}, elements: {}, settings: { downloadDir: dataDir, headless: true },
      steps: [{ stepId: 'each', name: '逐行', actionType: 'control.forEachXlsx', params: { path: file, itemVariable: 'row' }, children: [
        { stepId: 'write', name: '保存当前行', actionType: 'file.xlsxWrite', params: { path: output, rows: '{{row}}' } },
      ] }],
    };
    const result = await new WorkflowEngine(workflow, { dataDir, runId: 'single-row' }).run();
    expect(result.status, result.error).toBe('succeeded');
    const workbook = readWorkbook(readFileSync(output), { type: 'buffer' });
    expect(xlsxUtils.sheet_to_json(workbook.Sheets.Sheet1!)).toEqual([{ sku: 'A001', qty: 2 }]);
  });

  it('读取、遍历、处理并保存 JSON 行列表', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rpa-xlsx-'));
    directories.push(dataDir);
    const input = join(dataDir, 'input.xlsx');
    const output = join(dataDir, 'output.xlsx');
    const sourceSheet = xlsxUtils.json_to_sheet([{ sku: 'A001', qty: 2 }, { sku: 'B002', qty: 3 }]);
    const sourceBook = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(sourceBook, sourceSheet, '订单');
    await writeFile(input, writeWorkbook(sourceBook, { type: 'buffer', bookType: 'xlsx' }));

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
    const written = readWorkbook(readFileSync(output), { type: 'buffer' });
    expect(written.SheetNames).toContain('结果');
    expect(xlsxUtils.sheet_to_json(written.Sheets['结果']!)).toEqual([
      { sku: 'A001', qty: 2, total: 20 },
      { sku: 'B002', qty: 3, total: 30 },
    ]);
  });
});
