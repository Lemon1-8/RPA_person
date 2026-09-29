import type { RunEvent } from "../../../../packages/contracts/src/index.js";

export function structuredLog(event: RunEvent): { prefix: string; value: Record<string, unknown> | unknown[] } | undefined {
  if (event.type !== "log" || !event.message) return undefined;
  const data = event.data && typeof event.data === "object" ? event.data as { value?: unknown } : undefined;
  if (data?.value && typeof data.value === "object") {
    return { prefix: "", value: data.value as Record<string, unknown> | unknown[] };
  }
  const message = event.message;
  for (const index of [message.indexOf("{"), message.indexOf("[")].filter(index => index >= 0).sort((a, b) => a - b)) {
    try {
      const value: unknown = JSON.parse(message.slice(index));
      if (value && typeof value === "object") return { prefix: message.slice(0, index).trim(), value: value as Record<string, unknown> | unknown[] };
    } catch { /* 普通日志按原文显示。 */ }
  }
  return undefined;
}

function display(value: unknown): string {
  if (value === null) return "空值";
  if (value === undefined) return "未设置";
  if (typeof value === "string") return value || "（空文本）";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function LogMessage({ event }: { event: RunEvent }) {
  const structured = structuredLog(event);
  if (!structured) {
    const message = event.message ?? "";
    if (message.length <= 240 && message.split("\n").length <= 3) return <span className="log-message">{message}</span>;
    return <div className="log-structured"><details><summary>{message.split("\n")[0]!.slice(0, 120)}… 展开完整内容</summary><pre>{message}</pre></details></div>;
  }
  if (Array.isArray(structured.value)) return <div className="log-structured">
    {structured.prefix && <span>{structured.prefix}</span>}
    <details><summary>数组 · {structured.value.length} 项</summary><pre>{JSON.stringify(structured.value, null, 2)}</pre></details>
  </div>;
  const entries = Object.entries(structured.value);
  return <div className="log-structured">
    {structured.prefix && <span>{structured.prefix}</span>}
    <details open={entries.length <= 4}>
      <summary>对象 · {entries.length} 个字段</summary>
      <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{display(value)}</dd></div>)}</dl>
    </details>
  </div>;
}
