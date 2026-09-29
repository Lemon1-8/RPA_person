import { describe, expect, it } from 'vitest';
import { structuredLog } from '../apps/desktop/src/renderer/LogMessage.js';
import type { RunEvent } from '../packages/contracts/src/index.js';

const event = (message: string, value?: unknown): RunEvent => ({ type: 'log', runId: 'run', at: '', message, ...(value === undefined ? {} : { data: { value } }) });

describe('结构化运行日志', () => {
  it('将 XLSX 当前行的 JSON 提取成字段，保留前面的说明文字', () => {
    expect(structuredLog(event('当前行：{"订单号":"A001","金额":42,"备注":null}'))).toEqual({
      prefix: '当前行：', value: { 订单号: 'A001', 金额: 42, 备注: null },
    });
  });
  it('保留原始对象值，普通文本不强行转换', () => {
    expect(structuredLog(event('{"id":1}', { id: 1 }))).toEqual({ prefix: '', value: { id: 1 } });
    expect(structuredLog(event('订单已完成'))).toBeUndefined();
  });
});
