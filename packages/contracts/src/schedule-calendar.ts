import type { WorkflowSchedule } from './schedule.js';

const timeAt = (date: Date, time: string) => { const [h,m] = time.split(':').map(Number); const result = new Date(date); result.setHours(h,m,0,0); return result; };
const monthAt = (year: number, month: number, day: number, time: string) => timeAt(new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())), time);
const ordinal = (date: Date) => Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
function calendarTime(schedule: WorkflowSchedule, now: Date, future: boolean): Date {
  const fits = (date: Date) => future ? date.getTime() > now.getTime() : date.getTime() <= now.getTime();
  if (schedule.kind === 'monthly') {
    const date = monthAt(now.getFullYear(), now.getMonth(), schedule.day!, schedule.time!);
    return fits(date) ? date : monthAt(now.getFullYear(), now.getMonth() + (future ? 1 : -1), schedule.day!, schedule.time!);
  }
  if (schedule.kind === 'intervalDays') {
    const start = timeAt(new Date(`${schedule.startDate}T00:00:00`), schedule.time!);
    const periods = Math.max(0, Math.floor((ordinal(now) - ordinal(start)) / schedule.intervalDays!));
    const date = new Date(start); date.setDate(start.getDate() + periods * schedule.intervalDays!);
    if (!fits(date)) date.setDate(date.getDate() + (future ? schedule.intervalDays! : -schedule.intervalDays!));
    return date;
  }
  const date = timeAt(now, schedule.time!);
  for (let i = 0; i < 8; i++) {
    if (fits(date) && (schedule.kind !== 'weekly' || schedule.weekdays!.includes(date.getDay()))) return date;
    date.setDate(date.getDate() + (future ? 1 : -1)); const [hours,minutes] = schedule.time!.split(':').map(Number); date.setHours(hours,minutes,0,0);
  }
  throw new Error('日历规则无法计算下一次时间');
}
export function nextScheduleTime(schedule: WorkflowSchedule, now: Date): string | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.kind === 'once') return schedule.at;
  if (schedule.kind === 'interval') {
    const anchor = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : now.getTime(); const interval = schedule.intervalMinutes! * 60000;
    return new Date(anchor + Math.max(1, Math.floor((now.getTime() - anchor) / interval) + 1) * interval).toISOString();
  }
  return calendarTime(schedule, now, true).toISOString();
}
export function latestScheduleTime(schedule: WorkflowSchedule, now: Date): string {
  const lower = Date.parse(schedule.nextRunAt!);
  if (schedule.kind === 'once') return schedule.nextRunAt!;
  const date = schedule.kind === 'interval' ? lower + Math.floor((now.getTime() - lower) / (schedule.intervalMinutes! * 60000)) * schedule.intervalMinutes! * 60000 : calendarTime(schedule, now, false).getTime();
  return new Date(Math.max(lower, date)).toISOString();
}
export function previewSchedule(schedule: WorkflowSchedule, now = new Date(), count = 5): string[] {
  const result: string[] = []; let cursor = now; let plan: WorkflowSchedule = { ...schedule, enabled: true, nextRunAt: undefined };
  for (let i = 0; i < count; i++) { const next = nextScheduleTime(plan, cursor); if (!next || Date.parse(next) <= cursor.getTime()) break; result.push(next); if (plan.kind === 'once') break; cursor = new Date(next); plan = { ...plan, nextRunAt: next }; }
  return result;
}
