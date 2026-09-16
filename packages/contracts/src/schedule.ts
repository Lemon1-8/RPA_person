import { z } from 'zod';

/** Daily times use the local time zone of the Windows workbench. */
export interface WorkflowSchedule {
  scheduleId: string; workflowId: string; name: string; enabled: boolean;
  kind: 'once' | 'daily' | 'interval'; at?: string; time?: string; intervalMinutes?: number;
  nextRunAt?: string; lastRunAt?: string; lastRunId?: string; lastError?: string;
}

export const scheduleIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/, '标识只能使用字母、数字、短横线及下划线');
const timestamp = z.string().datetime({ offset: true });
export const scheduleSchema: z.ZodType<WorkflowSchedule> = z.object({
  scheduleId: scheduleIdentifier, workflowId: scheduleIdentifier, name: z.string().trim().min(1).max(120),
  enabled: z.boolean(), kind: z.enum(['once', 'daily', 'interval']),
  at: timestamp.optional(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式须为 HH:mm').optional(),
  intervalMinutes: z.number().int().min(1).max(525600).optional(),
  nextRunAt: timestamp.optional(), lastRunAt: timestamp.optional(), lastRunId: scheduleIdentifier.optional(), lastError: z.string().optional(),
}).superRefine((schedule, ctx) => {
  if (schedule.kind === 'once' && !schedule.at) ctx.addIssue({ code: 'custom', path: ['at'], message: '请选择运行日期和时间' });
  if (schedule.kind === 'daily' && !schedule.time) ctx.addIssue({ code: 'custom', path: ['time'], message: '请选择每日运行时间' });
  if (schedule.kind === 'interval' && !schedule.intervalMinutes) ctx.addIssue({ code: 'custom', path: ['intervalMinutes'], message: '请输入间隔分钟数' });
});
