import type { RunEvent } from "../../../../packages/contracts/src/index.js";

export type LogFilter = "all" | "steps" | "output" | "failed";
export interface LogRow { event: RunEvent; index: number }

const terminalRunStatuses = new Set(["succeeded", "failed", "stopped", "interrupted"]);

export function logRows(events: RunEvent[], runId: string): LogRow[] {
  const rows: (LogRow | null)[] = [];
  const running = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.runId !== runId) return;
    if (event.type === "step" && event.stepId) {
      if (event.status === "running") {
        const previous = running.get(event.stepId);
        if (previous !== undefined) rows[previous] = null;
        running.set(event.stepId, rows.length);
        rows.push({ event, index });
        return;
      }
      if (event.status === "succeeded" || event.status === "failed") {
        const pending = running.get(event.stepId);
        if (pending !== undefined) rows[pending] = null;
        running.delete(event.stepId);
      }
      if (["succeeded", "failed", "skipped"].includes(event.status ?? "")) rows.push({ event, index });
      return;
    }
    if (event.type === "log" && event.message) rows.push({ event, index });
    if (event.type === "artifact" && event.data) rows.push({ event, index });
    if (event.type === "run" && (event.message || terminalRunStatuses.has(event.status ?? "") || ["paused", "waiting_manual"].includes(event.status ?? ""))) rows.push({ event, index });
  });
  return rows.filter((row): row is LogRow => row !== null);
}

export function logRowText(event: RunEvent, stepName?: string): string {
  if (event.type === "step") {
    if (event.status === "running") return "正在执行";
    if (event.status === "succeeded") {
      const duration = event.data && typeof event.data === "object" && "durationMs" in event.data ? event.data.durationMs : undefined;
      return typeof duration === "number" ? `已完成 · ${duration < 1000 ? `${duration} 毫秒` : `${(duration / 1000).toFixed(1)} 秒`}` : "已完成";
    }
    if (event.status === "skipped") return "已注释，跳过此步骤";
  }
  if (event.type === "artifact") {
    const data = event.data as { name?: unknown };
    return typeof data.name === "string" ? `已生成文件：${data.name}` : "已生成文件";
  }
  if (event.type === "run") return event.message ?? event.run?.error ?? (event.status === "succeeded" ? "运行完成" : event.status === "failed" ? "运行失败" : event.status === "stopped" ? "运行已停止" : event.status === "interrupted" ? "运行意外中断" : event.status === "paused" ? "运行已暂停" : "等待人工操作");
  return event.message ?? stepName ?? "";
}

export function filterLogRows(rows: LogRow[], filter: LogFilter, query: string, stepNames: ReadonlyMap<string, string>): LogRow[] {
  const term = query.trim().toLocaleLowerCase();
  return rows.filter(({ event }) => {
    if (filter === "steps" && event.type !== "step") return false;
    if (filter === "output" && event.type !== "log" && event.type !== "artifact") return false;
    if (filter === "failed" && event.status !== "failed" && event.status !== "interrupted") return false;
    if (!term) return true;
    const stepName = stepNames.get(event.stepId ?? "") ?? "";
    return `${stepName} ${event.message ?? ""} ${logRowText(event, stepName)}`.toLocaleLowerCase().includes(term);
  });
}
