import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Search, X } from "lucide-react";
import type { RunEvent, DesktopApi, EventPage } from "../../../../packages/contracts/src/index.js";
import { LogMessage } from "./LogMessage.js";
import { LogHistoryMenu } from './LogHistoryMenu.js';
import { filterLogRows, logRows, logRowText, logStepName, type LogFilter } from "./log-view.js";

const labels: Record<string, string> = {
  running: "执行中", succeeded: "完成", failed: "失败", skipped: "跳过",
  stopped: "停止", interrupted: "中断", paused: "暂停", waiting_manual: "等待人工",
};
const filters: { id: LogFilter; label: string }[] = [
  { id: "all", label: "全部" }, { id: "steps", label: "步骤" },
  { id: "output", label: "输出与文件" }, { id: "failed", label: "失败" },
];
const stepDetailsPreference = "rpa.logStepDetails";
const api = (window as Window & { rpa?: DesktopApi }).rpa;

function eventPath(event: RunEvent): string | undefined {
  if (!event.data || typeof event.data !== "object" || !("path" in event.data)) return undefined;
  return typeof event.data.path === "string" ? event.data.path : undefined;
}

export function LogViewer({ events, runId, stepNames, emptyMessage, onSelectStep, onOpenPath,attempts=[] }: {
  events: RunEvent[];
  runId: string;
  stepNames: ReadonlyMap<string, string>;
  emptyMessage: string;
  onSelectStep: (stepId: string) => void;
  onOpenPath: (path: string) => void;
  attempts?:{attemptId:string;label:string}[];
}) {
  const [query, setQuery] = useState("");
  const [attemptId,setAttemptId]=useState('');const [result,setResult]=useState<unknown>();
  const terminalId=[...events].reverse().find(event=>event.runId===runId && event.type==='run' && ['succeeded','failed','stopped','interrupted'].includes(event.status ?? ''))?.eventId;
  const [filter, setFilter] = useState<LogFilter>("all");
  const [following, setFollowing] = useState(true);
  const [showStepDetails, setShowStepDetails] = useState(() => {
    try { return localStorage.getItem(stepDetailsPreference) === "true"; }
    catch { return false; }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<RunEvent[]>([]);
  const [page, setPage] = useState<EventPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    const generation = ++request.current; setHistory([]); setPage(undefined); setError('');
    if (!api || !runId) return;
    const timer = setTimeout(() => {
      setLoading(true);
      void api.getRunEvents(runId, { limit: 200, query,attemptId:attemptId || undefined }).then(value => { if (generation === request.current) { setHistory(value.events); setPage(value); } }).catch(cause => { if (generation === request.current) setError(String(cause)); }).finally(() => { if (generation === request.current) setLoading(false); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); request.current++; };
  }, [runId, query,attemptId,terminalId]);
  const loadEarlier = () => {
    if (!api || !page?.hasMore || loading) return;
    const generation = request.current; setLoading(true);
    void api.getRunEvents(runId, { before: page.before, limit: 200, query,attemptId:attemptId || undefined }).then(value => { if (generation === request.current) { setHistory(previous => [...value.events, ...previous]); setPage(value); setFollowing(false); } }).catch(cause => setError(String(cause))).finally(() => setLoading(false));
  };
  const merged = useMemo(() => {
    const unique = new Map<string, RunEvent>();
    for (const event of [...events.filter(event => event.runId === runId && (!attemptId || event.attemptId===attemptId)), ...history]) unique.set(event.eventId ?? JSON.stringify(event), event);
    return [...unique.values()].sort((a, b) => a.at.localeCompare(b.at) || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER));
  }, [events, history, runId,attemptId]);
  const allRows = useMemo(() => logRows(merged, runId, showStepDetails), [merged, runId, showStepDetails]);
  const rows = useMemo(() => filterLogRows(allRows, filter, query, stepNames), [allRows, filter, query, stepNames]);
  const heights=useRef(new Map<string,number>());const [layout,setLayout]=useState(0);const [viewport,setViewport]=useState({top:0,height:300});
  const rowKey=(row:typeof rows[number])=>row.event.eventId ?? `${row.event.at}:${row.index}`;
  const offsets=useMemo(()=>{const result=[0];for(const row of rows) result.push(result.at(-1)!+(heights.current.get(rowKey(row)) ?? 40));return result;},[rows,layout]);
  const virtual=rows.length>300;
  let first=0,last=rows.length;if(virtual){const start=offsets.findIndex(offset=>offset>=viewport.top),end=offsets.findIndex(offset=>offset>=viewport.top+viewport.height);first=Math.max(0,(start<0?rows.length:start)-15);last=Math.min(rows.length,Math.max(first+30,(end<0?rows.length:end)+15));}
  useLayoutEffect(()=>{let changed=false;scrollRef.current?.querySelectorAll<HTMLElement>('[data-log-key]').forEach(node=>{const key=node.dataset.logKey!;const height=node.getBoundingClientRect().height;if(height>0 && heights.current.get(key)!==height){heights.current.set(key,height);changed=true;}});if(changed)setLayout(value=>value+1);});
  useEffect(()=>{const node=scrollRef.current;if(!node)return;const observer=new ResizeObserver(()=>setViewport({top:node.scrollTop,height:node.clientHeight}));observer.observe(node);return()=>observer.disconnect();},[]);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setFollowing(true);
    setAttemptId('');setResult(undefined);heights.current.clear();
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
      <LogHistoryMenu><select aria-label="查看执行尝试日志" value={attemptId} onChange={event=>setAttemptId(event.target.value)}><option value="">全部尝试</option>{attempts.map(attempt=><option key={attempt.attemptId} value={attempt.attemptId}>{attempt.label}</option>)}</select><button disabled={!page?.hasMore || loading} onClick={loadEarlier}>{loading ? '读取中…' : '加载更早日志'}</button><button disabled={!runId} onClick={() => void api?.exportRunEvents(runId).then(path => { if (path) onOpenPath(path); }).catch(cause => setError(String(cause)))}>导出日志</button>{!!page?.damagedLines && <span role="status">有 {page.damagedLines} 条损坏记录，原文件已保留</span>}{error && <span role="alert">{error}</span>}</LogHistoryMenu>
      <label className="log-search">
        <Search size={15} aria-hidden="true" />
        <input aria-label="搜索运行日志" value={query} onChange={event => { setQuery(event.target.value); startInspecting(); }} placeholder="搜索步骤或内容" />
        {query && <button type="button" aria-label="清除日志搜索" onClick={() => { setQuery(""); startInspecting(); }}><X size={14} /></button>}
      </label>
      <div className="log-filters" role="group" aria-label="日志筛选">
        {filters.map(item => <button key={item.id} type="button" className={filter === item.id ? "active" : ""} aria-pressed={filter === item.id} onClick={() => { if (item.id === "steps") setShowStepDetails(true); setFilter(item.id); startInspecting(); }}>{item.label}</button>)}
      </div>
      <button type="button" className="log-details-toggle" role="switch" aria-label="显示指令执行信息" title="显示指令执行信息" aria-checked={showStepDetails} onClick={() => {
        setShowStepDetails(!showStepDetails);
        if (showStepDetails && filter === "steps") setFilter("all");
        startInspecting();
      }}><span className="log-details-track" aria-hidden="true" />执行详情</button>
      <span className="log-count">{rows.length}{rows.length !== allRows.length ? ` / ${allRows.length}` : ""} 条</span>
      {!following && rows.length > 0 && <button type="button" className="log-latest" onClick={() => { setFollowing(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}><ArrowDown size={14} />最新</button>}
    </div>
    <div className="log-scroll" ref={scrollRef} tabIndex={0} aria-label="滚动运行日志" onScroll={event => {
      const node = event.currentTarget;
      setViewport({top:node.scrollTop,height:node.clientHeight});
      const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      if (nearBottom !== following) setFollowing(nearBottom);
    }}>
      {rows.length ? <div className="log-lines" role="log" aria-label="运行日志" aria-live="off">
        {virtual && <div aria-hidden="true" style={{height:offsets[first]}}/>}
        {rows.slice(first,last).map(({ event, index }) => {
          const stepName = logStepName(event, stepNames);
          const path = eventPath(event);
          const isFailure = event.status === "failed" || event.status === "interrupted";
          const typeLabel = event.type === "step" ? labels[event.status ?? ""] ?? "步骤" : event.type === "run" ? labels[event.status ?? ""] ?? "运行" : event.type === "artifact" ? "文件" : "输出";
          const text = logRowText(event, stepName);
          const stepNumber = event.data && typeof event.data === "object" && "stepNumber" in event.data && typeof event.data.stepNumber === "number" ? event.data.stepNumber : undefined;
          return <div key={event.eventId ?? index} data-log-key={event.eventId ?? `${event.at}:${index}`} className={`log-line${isFailure ? " log-error" : ""}${event.type === "step" ? " log-line-step" : ""}`}>
            <time dateTime={event.at} title={new Date(event.at).toLocaleString("zh-CN")}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
            <span className={`log-type log-type-${isFailure ? "failed" : event.status ?? event.type}`}>{typeLabel}</span>
            <div className="log-body">
              {event.stepId && <span className="log-step-context">
                {stepNumber !== undefined && <span className="log-step-number">#{String(stepNumber).padStart(2, "0")}</span>}
                {stepName ? <button type="button" className="log-step" onClick={() => onSelectStep(event.callStepId ?? event.stepId!)}>{stepName}</button> : <span className="log-step-name">{event.stepId.slice(0, 8)}</span>}
              </span>}
              {event.type === "log" ? <LogMessage event={event} /> : <span className="log-message">{text}</span>}
              {path && <button type="button" className="log-file-action" onClick={() => onOpenPath(path)}>打开文件</button>}
              {!!event.data && typeof event.data==='object' && 'resultId' in event.data && <button onClick={()=>void api?.getStepResult(runId,String((event.data as {resultId:string}).resultId)).then(setResult).catch(cause=>setError(String(cause)))}>查看完整结果</button>}
            </div>
          </div>;
        })}
        {virtual && <div aria-hidden="true" style={{height:offsets[rows.length]-offsets[last]}}/>}
      </div> : <div className="console-empty"><span>{allRows.length ? "没有匹配的日志，试试其他关键词或筛选条件。" : emptyMessage}</span></div>}
    </div>
    {result!==undefined && <div className="result-preview" role="dialog" aria-label="完整步骤结果"><button onClick={()=>setResult(undefined)}>关闭结果</button><pre>{JSON.stringify(result,null,2)}</pre></div>}
  </div>;
}
