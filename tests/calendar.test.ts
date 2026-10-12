import { describe, it, expect } from 'vitest';
import { nextScheduleTime, latestScheduleTime, previewSchedule } from '../packages/contracts/src/schedule-calendar.js';
import { scheduleSchema, type WorkflowSchedule } from '../packages/contracts/src/index.js';
const plan: WorkflowSchedule = { scheduleId: 'calendar', workflowId: 'flow', name: '日历', enabled: true, kind: 'monthly', day: 31, time: '09:30' };
const fields = (value: string) => { const date = new Date(value); return [date.getFullYear(), date.getMonth()+1, date.getDate(), date.getHours(), date.getMinutes()]; };
describe('本机日历调度', () => {
  it('闰年和非闰年缺少日期时使用月末，随后回到指定日期', () => {
    expect(previewSchedule(plan, new Date(2024,0,31,10),2).map(fields)).toEqual([[2024,2,29,9,30],[2024,3,31,9,30]]);
    expect(fields(nextScheduleTime(plan,new Date(2025,0,31,10))!)).toEqual([2025,2,28,9,30]);
  });
  it('每周多日期按本机时区跨周计算，睡眠只补最近一次', () => {
    const weekly = { ...plan, kind: 'weekly' as const, weekdays: [1,3,5] };
    expect(previewSchedule(weekly,new Date(2026,9,12,10),3).map(fields)).toEqual([[2026,10,14,9,30],[2026,10,16,9,30],[2026,10,19,9,30]]);
    expect(fields(latestScheduleTime({ ...weekly, nextRunAt: new Date(2026,9,12,9,30).toISOString() },new Date(2026,9,20,10)))).toEqual([2026,10,19,9,30]);
  });
  it('间隔天数保留开始日期时间基准，不按检查时刻漂移', () => {
    const days = { ...plan, kind:'intervalDays' as const,startDate:'2026-10-12',intervalDays:3 };
    expect(fields(nextScheduleTime(days,new Date(2026,9,20,17))!)).toEqual([2026,10,21,9,30]);
    expect(fields(nextScheduleTime(days,new Date(2026,9,1))!)).toEqual([2026,10,12,9,30]);
    expect(fields(latestScheduleTime({ ...days,nextRunAt:new Date(2026,9,12,9,30).toISOString() },new Date(2026,9,20,17)))).toEqual([2026,10,18,9,30]);
  });
  it('拒绝不存在的开始日期及空每周日期，分钟间隔保留原触发基准', () => {
    expect(() => scheduleSchema.parse({ ...plan,kind:'intervalDays',startDate:'2026-02-30',intervalDays:2 })).toThrow();
    expect(() => scheduleSchema.parse({ ...plan,kind:'weekly',weekdays:[] })).toThrow();
    const interval = { ...plan,kind:'interval' as const,intervalMinutes:10,nextRunAt:'2030-01-01T00:10:00.000Z' };
    expect(latestScheduleTime(interval,new Date('2030-01-01T12:03:00Z'))).toBe('2030-01-01T12:00:00.000Z');
    expect(nextScheduleTime(interval,new Date('2030-01-01T12:03:00Z'))).toBe('2030-01-01T12:10:00.000Z');
  });
});
