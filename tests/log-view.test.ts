import { describe, expect, it } from 'vitest';
import { filterLogRows, logRows, logRowText } from '../apps/desktop/src/renderer/log-view.js';
import type { RunEvent } from '../packages/contracts/src/index.js';

const event = (type: RunEvent['type'], status: string | undefined, message: string | undefined, stepId?: string, runId = 'current'): RunEvent => ({
  type, status, message, stepId, runId, at: '2026-09-29T08:00:00.000Z',
});

describe('运行日志视图', () => {
  it('默认隐藏所有指令的执行中、完成和跳过信息，保留实际输出和失败', () => {
    const printEvent = (status: string, message: string): RunEvent => ({
      ...event('step', status, message, 'print'), data: { durationMs: 0 },
    });
    const rows = logRows([
      printEvent('running', '打印日志'),
      event('log', undefined, '第一行内容', 'print'),
      printEvent('succeeded', '打印日志'),
      printEvent('running', '打印日志'),
      event('log', undefined, '第二行内容', 'print'),
      printEvent('succeeded', '打印日志'),
      event('step', 'succeeded', '设置变量', 'set'),
      event('step', 'running', '遍历 XLSX', 'loop'),
      event('step', 'succeeded', '遍历 XLSX', 'loop'),
      event('step', 'skipped', '已注释：打开网页', 'open'),
      printEvent('running', '打印日志'),
      printEvent('failed', '找不到变量：missing'),
    ], 'current');
    expect(rows.map(row => [row.event.type, row.event.status, row.event.message])).toEqual([
      ['log', undefined, '第一行内容'], ['log', undefined, '第二行内容'],
      ['step', 'failed', '找不到变量：missing'],
    ]);
  });

  it('在步骤完成后替换进行中提示，循环中的下一次执行仍可见', () => {
    const events = [
      event('step', 'running', '打印', 'step'),
      event('log', undefined, '第一行', 'step'),
      event('step', 'succeeded', '打印', 'step'),
      event('step', 'running', '打印', 'step'),
      event('log', undefined, '第二行', 'step'),
      event('step', 'failed', '连接超时', 'step', 'other'),
    ];
    const rows = logRows(events, 'current', true);
    expect(rows.map(row => [row.event.type, row.event.status, row.event.message])).toEqual([
      ['log', undefined, '第一行'], ['step', 'succeeded', '打印'],
      ['step', 'running', '打印'], ['log', undefined, '第二行'],
    ]);
  });

  it('主动显示执行信息时包含所有指令的完成耗时和跳过信息', () => {
    const events: RunEvent[] = [
      event('step', 'running', '遍历 XLSX', 'loop'),
      { ...event('step', 'succeeded', '遍历 XLSX', 'loop'), data: { durationMs: 19 } },
      event('step', 'skipped', '已注释：打开网页', 'open'),
      { ...event('artifact', undefined, undefined, 'file'), data: { name: '结果.xlsx' } },
      event('run', 'interrupted', '任务进程意外退出'),
    ];
    const quiet = logRows(events, 'current');
    expect(quiet.map(row => row.event.type)).toEqual(['artifact', 'run']);
    const detailed = logRows(events, 'current', true);
    expect(detailed.map(row => [row.event.type, row.event.status])).toEqual([
      ['step', 'succeeded'], ['step', 'skipped'], ['artifact', undefined], ['run', 'interrupted'],
    ]);
    expect(logRowText(detailed[0]!.event)).toBe('已完成 · 19 毫秒');
    expect(filterLogRows(detailed, 'steps', '', new Map())).toHaveLength(2);
  });

  it('按步骤名和日志正文搜索，并能只看失败', () => {
    const rows = logRows([
      event('log', undefined, '订单 A001 已处理', 'print'),
      event('step', 'failed', '等待网页超时', 'open'),
      event('run', 'failed', undefined),
    ], 'current');
    const names = new Map([['print', '打印订单'], ['open', '打开网页']]);
    expect(filterLogRows(rows, 'all', '打印订单', names)).toHaveLength(1);
    expect(filterLogRows(rows, 'all', 'a001', names)).toHaveLength(1);
    expect(filterLogRows(rows, 'failed', '', names)).toHaveLength(2);
    expect(filterLogRows(rows, 'output', '', names)).toHaveLength(1);
    expect(logRowText(rows[2]!.event)).toBe('运行失败');
  });
});
