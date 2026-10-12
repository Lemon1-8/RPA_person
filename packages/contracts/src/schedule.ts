import { z } from 'zod';

/** Daily times use the local time zone of the Windows workbench. */
export interface WorkflowSchedule {
  scheduleId: string; workflowId: string; name: string; enabled: boolean;
  kind: 'once' | 'daily' | 'interval' | 'weekly' | 'monthly' | 'intervalDays'; at?: string; time?: string; intervalMinutes?: number;
  weekdays?: number[]; day?: number; startDate?: string; intervalDays?: number;
  revision?: number; followLatest?: boolean;
  nextRunAt?: string; lastRunAt?: string; lastRunId?: string; lastError?: string;
}

export const scheduleIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, '标识只能使用字母、数字、短横线及下划线');
const timestamp = z.string().datetime({ offset: true });
export const scheduleSchema: z.ZodType<WorkflowSchedule> = z.object({
  scheduleId: scheduleIdentifier, workflowId: scheduleIdentifier, name: z.string().trim().min(1).max(120),
  enabled: z.boolean(), kind: z.enum(['once', 'daily', 'interval', 'weekly', 'monthly', 'intervalDays']),
  at: timestamp.optional(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式须为 HH:mm').optional(),
  intervalMinutes: z.number().int().min(1).max(525600).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), day: z.number().int().min(1).max(31).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00`); return Number.isFinite(date.getTime()) && `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` === value; }, '开始日期不存在').optional(),
  intervalDays: z.number().int().min(1).max(36500).optional(), revision: z.number().int().min(1).optional(), followLatest: z.boolean().optional(),
  nextRunAt: timestamp.optional(), lastRunAt: timestamp.optional(), lastRunId: scheduleIdentifier.optional(), lastError: z.string().optional(),
}).superRefine((schedule, ctx) => {
  if (schedule.kind === 'once' && !schedule.at) ctx.addIssue({ code: 'custom', path: ['at'], message: '请选择运行日期和时间' });
  if (['daily','weekly','monthly','intervalDays'].includes(schedule.kind) && !schedule.time) ctx.addIssue({ code: 'custom', path: ['time'], message: '请选择运行时间' });
  if (schedule.kind === 'weekly' && !schedule.weekdays?.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: '请选择每周日期' });
  if (schedule.kind === 'monthly' && !schedule.day) ctx.addIssue({ code: 'custom', path: ['day'], message: '请选择每月日期' });
  if (schedule.kind === 'intervalDays' && (!schedule.startDate || !schedule.intervalDays)) ctx.addIssue({ code: 'custom', path: ['startDate'], message: '请选择开始日期和间隔天数' });
  if (schedule.kind === 'interval' && !schedule.intervalMinutes) ctx.addIssue({ code: 'custom', path: ['intervalMinutes'], message: '请输入间隔分钟数' });
});
