import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Search, X } from "lucide-react";
import type { RunEvent } from "../../../../packages/contracts/src/index.js";
import { LogMessage } from "./LogMessage.js";
import { filterLogRows, logRows, logRowText, type LogFilter } from "./log-view.js";

const labels: Record<string, string> = {
  running: "执行中", succeeded: "完成", failed: "失败", skipped: "跳过",
  stopped: "停止", interrupted: "中断", paused: "暂停", waiting_manual: "等待人工",
};
const filters: { id: LogFilter; label: string }[] = [
  { id: "all", label: "全部" }, { id: "steps", label: "步骤" },
  { id: "output", label: "输出与文件" }, { id: "failed", label: "失败" },
];
const stepDetailsPreference = "rpa.logStepDetails";

function eventPath(event: RunEvent): string | undefined {
  if (!event.data || typeof event.data !== "object" || !("path" in event.data)) return undefined;
  return typeof event.data.path === "string" ? event.data.path : undefined;
}

export function LogViewer({ events, runId, stepNames, emptyMessage, onSelectStep, onOpenPath }: {
  events: RunEvent[];
  runId: string;
  stepNames: ReadonlyMap<string, string>;
  emptyMessage: string;
  onSelectStep: (stepId: string) => void;
  onOpenPath: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LogFilter>("all");
  const [following, setFollowing] = useState(true);
  const [showStepDetails, setShowStepDetails] = useState(() => {
    try { return localStorage.getItem(stepDetailsPreference) === "true"; }
    catch { return false; }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const allRows = useMemo(() => logRows(events, runId, showStepDetails), [events, runId, showStepDetails]);
  const rows = useMemo(() => filterLogRows(allRows, filter, query, stepNames), [allRows, filter, query, stepNames]);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setFollowing(true);
  }, [runId]);
  useEffect(() => {
    try { localStorage.setItem(stepDetailsPreference, String(showStepDetails)); }
    catch { /* Log display still works when browser storage is unavailable. */ }
  }, [showStepDetails]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && following) scroller.scrollTop = scroller.scrollHeight;
  }, [rows, runId, following]);

  const startInspecting = () => {
    setFollowing(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  return <div className="log-viewer">
    <div className="log-toolbar">
      <label className="log-search">
        <Search size={15} aria-hidden="true" />
        <input aria-label="搜索运行日志" value={query} onChange={event => { setQuery(event.target.value); startInspecting(); }} placeholder="搜索步骤或内容" />
        {query && <button type="button" aria-label="清除日志搜索" onClick={() => { setQuery(""); startInspecting(); }}><X size={14} /></button>}
      </label>
      <div className="log-filters" role="group" aria-label="日志筛选">
        {filters.map(item => <button key={item.id} type="button" className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => { if (item.id === "steps") setShowStepDetails(true); setFilter(item.id); startInspecting(); }}>{item.label}</button>)}
      </div>
      <button type="button" className="log-details-toggle" role="switch" aria-checked={showStepDetails} onClick={() => {
        setShowStepDetails(!showStepDetails);
        if (showStepDetails && filter === "steps") setFilter("all");
        startInspecting();
      }}><span className="log-details-track" aria-hidden="true" />显示指令执行信息</button>
      <span className="log-count">{rows.length}{rows.length !== allRows.length ? ` / ${allRows.length}` : ""} 条</span>
      {!following && rows.length > 0 && <button type="button" className="log-latest" onClick={() => { setFollowing(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown size={14} />最新</button>}
    </div>
    <div className="log-scroll" ref={scrollRef} tabIndex={0} aria-label="滚动运行日志" onScroll={event => {
      const node = event.currentTarget;
      const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      if (nearBottom !== following) setFollowing(nearBottom);
    }}>
      {rows.length ? <div className="log-lines" role="log" aria-label="运行日志" aria-live="off">
        {rows.map(({ event, index }) => {
          const stepName = stepNames.get(event.stepId ?? "");
          const path = eventPath(event);
          const isFailure = event.status === "failed" || event.status === "interrupted";
          const typeLabel = event.type === "step" ? labels[event.status ?? ""] ?? "步骤" : event.type === "run" ? labels[event.status ?? ""] ?? "运行" : event.type === "artifact" ? "文件" : "输出";
          const text = logRowText(event, stepName);
          const stepNumber = event.data && typeof event.data === "object" && "stepNumber" in event.data && typeof event.data.stepNumber === "number" ? event.data.stepNumber : undefined;
          return <div key={index} className={`log-line${isFailure ? " log-error" : ""}${event.type === "step" ? " log-line-step" : ""}`}>
            <time dateTime={event.at} title={new Date(event.at).toLocaleString("zh-CN")}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
            <span className={`log-type log-type-${isFailure ? "failed" : event.status ?? event.type}`}>{typeLabel}</span>
            <div className="log-body">
              {event.stepId && <span className="log-step-context">
                {stepNumber !== undefined && <span className="log-step-number">#{String(stepNumber).padStart(2, "0")}</span>}
                {stepName ? <button type="button" className="log-step" onClick={() => onSelectStep(event.stepId!)}>{stepName}</button> : <span className="log-step-name">{event.stepId.slice(0, 8)}</span>}
              </span>}
              {event.type === "log" ? <LogMessage event={event} /> : <span className="log-message">{text}</span>}
              {path && <button type="button" className="log-file-action" onClick={() => onOpenPath(path)}>打开文件</button>}
            </div>
          </div>;
        })}
      </div> : <div className="console-empty"><span>{allRows.length ? "没有匹配的日志，试试其他关键词或筛选条件。" : emptyMessage}</span></div>}
    </div>
  </div>;
}
