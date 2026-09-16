import type { WorkflowSchedule } from '../../../packages/contracts/src/schedule.js';

/** Advance from now rather than replaying missed occurrences after sleep or restart. */
export function nextScheduleTime(schedule: WorkflowSchedule, now: Date): string | undefined {
  if (!schedule.enabled) return undefined;
  if (schedule.kind === 'once') return schedule.at;
  if (schedule.kind === 'interval') return new Date(now.getTime() + schedule.intervalMinutes! * 60_000).toISOString();
  const [hours, minutes] = schedule.time!.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hours, minutes, 0, 0);
  }
  return next.toISOString();
}
