import xlsx from 'xlsx';
import { readFileSync } from 'node:fs';

const { read, utils } = xlsx;

function loadSheet(path: string, requestedName?: string) {
  const bytes = readFileSync(path);
  const names = read(bytes, { type: 'buffer', bookSheets: true }).SheetNames;
  const sheetName = requestedName?.trim() || names[0];
  if (!sheetName || !names.includes(sheetName)) {
    throw new Error(requestedName ? `工作表不存在：${requestedName}` : 'XLSX 文件没有可读取的工作表');
  }
  const workbook = read(bytes, { type: 'buffer', sheets: sheetName, dense: true, cellHTML: false, cellText: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`工作表不存在：${sheetName}`);
  return { sheetName, sheet };
}

/** Load only the requested worksheet. Large accounting exports may contain hundreds of sheets. */
export function readXlsxRows(path: string, requestedName?: string): { sheetName: string; rows: Record<string, unknown>[] } {
  const { sheetName, sheet } = loadSheet(path, requestedName);
  const rows = utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  return { sheetName, rows };
}

/** The first row is a header; each following row stays an array of cell values. */
export function readXlsxArrayRows(path: string, requestedName?: string): { sheetName: string; rows: unknown[][]; columnCount: number } {
  const { sheetName, sheet } = loadSheet(path, requestedName);
  const matrix = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false });
  return { sheetName, rows: matrix.slice(1), columnCount: matrix[0]?.length ?? 0 };
}

/** Read one column as scalar values, keeping its zero-based position even when headers repeat. */
export function readXlsxColumnValues(path: string, requestedName: string, columnIndex: number): { sheetName: string; values: unknown[] } {
  const { sheetName, rows, columnCount } = readXlsxArrayRows(path, requestedName);
  if (columnIndex < 0 || columnIndex >= columnCount) throw new Error(`XLSX 列下标 ${columnIndex} 超出范围（0～${Math.max(0, columnCount - 1)}）`);
  return { sheetName, values: rows.map(row => row[columnIndex] ?? null) };
}
