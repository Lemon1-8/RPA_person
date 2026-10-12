import { useEffect, useState } from "react";
import { CalendarClock, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import type { DesktopApi, RunSnapshot, WorkflowDefinition, WorkflowSchedule } from "../../../../packages/contracts/src/index.js";
import { previewSchedule } from "../../../../packages/contracts/src/schedule-calendar.js";

const localDateTime = (value: string) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const displayDate = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const describe = (plan: WorkflowSchedule) => plan.kind === "daily" ? `每天 ${plan.time}` : plan.kind === "weekly" ? `每周 ${plan.weekdays?.map(day => '日一二三四五六'[day]).join('、')} ${plan.time}` : plan.kind === "monthly" ? `每月 ${plan.day} 日 ${plan.time}（缺日按月末）` : plan.kind === "intervalDays" ? `从 ${plan.startDate} 起每 ${plan.intervalDays} 天 ${plan.time}` : plan.kind === "interval" ? `每 ${plan.intervalMinutes} 分钟` : `单次 · ${displayDate(plan.at)}`;

export function SchedulesPage({ api, workflows, runs, initial, onError }: { api: DesktopApi; workflows: WorkflowDefinition[]; runs: RunSnapshot[]; initial: WorkflowSchedule[]; onError(cause: unknown): void }) {
  const [plans, setPlans] = useState(initial);
  const [draft, setDraft] = useState<WorkflowSchedule>();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const [occurrences, setOccurrences] = useState<Awaited<ReturnType<DesktopApi['listOccurrences']>>>([]);
  const [historyId, setHistoryId] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => { void api.listSchedules().then(value => { if (alive) setPlans(value); }).catch(cause => { if (alive) onError(cause); }); };
    refresh(); const timer = setInterval(refresh, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);
  const savedFlows = workflows.filter(flow => flow.revision > 0);
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await operation(); setPlans(await api.listSchedules()); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };
  const create = () => {
    setError("");
    setDraft({ scheduleId: crypto.randomUUID(), workflowId: savedFlows[0]?.workflowId ?? "", revision: savedFlows[0]?.revision, name: "定时任务", enabled: true, kind: "daily", time: "09:00", weekdays: [1], day: 1, intervalDays: 1, startDate: localDateTime(new Date().toISOString()).slice(0,10), intervalMinutes: 60, at: new Date(Date.now() + 3600000).toISOString() });
  };
  return <main className="management-page" aria-label="定时运行管理">
    <div className="page-heading"><div><span className="eyebrow">工作空间 / 调度</span><h2>定时运行 <span className="count">{plans.length}</span></h2><p>按本机时间触发已保存的流程。收起到托盘后继续调度；退出程序后停止。</p></div><button className="primary" onClick={create} disabled={!savedFlows.length || busy}><Plus size={16} />新建定时任务</button></div>
    <div className="schedule-note"><CalendarClock size={17} /><span>新计划默认绑定固定修订。睡眠或停机后只补最近一次；同流程运行中或等待人工时主动跳过。重复任务建议自动关闭浏览器。</span></div>
    {!savedFlows.length && <p className="field-error">请先创建并保存一个流程，再添加定时任务。</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {draft && <form className="schedule-form" onSubmit={event => { event.preventDefault(); void mutate(() => api.saveSchedule(draft)).then(ok => { if (ok) setDraft(undefined); }); }}>
      <div className="form-heading"><h3>{plans.some(plan => plan.scheduleId === draft.scheduleId) ? "编辑定时任务" : "新建定时任务"}</h3><button type="button" aria-label="关闭定时任务编辑" onClick={() => setDraft(undefined)} disabled={busy}><X size={16} /></button></div>
      <div className="schedule-fields"><label className="field"><span>任务名称</span><input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field"><span>执行流程</span><select aria-label="执行流程" required value={draft.workflowId} onChange={event => setDraft({ ...draft, workflowId: event.target.value, revision: draft.followLatest ? undefined : savedFlows.find(flow => flow.workflowId === event.target.value)?.revision })}>{savedFlows.map(flow => <option key={flow.workflowId} value={flow.workflowId}>{flow.name}</option>)}</select></label>
      <label className="field"><span>触发方式</span><select aria-label="触发方式" value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as WorkflowSchedule["kind"], time: draft.time ?? "09:00", weekdays: draft.weekdays ?? [1], day: draft.day ?? 1, intervalDays: draft.intervalDays ?? 1, startDate: draft.startDate ?? localDateTime(new Date().toISOString()).slice(0,10), intervalMinutes: draft.intervalMinutes ?? 60, at: draft.at ?? new Date(Date.now() + 3600000).toISOString() })}><option value="once">单次运行</option><option value="daily">每天</option><option value="weekly">每周多日期</option><option value="monthly">每月指定日期</option><option value="intervalDays">间隔 N 天</option><option value="interval">固定间隔</option></select></label>
      {draft.kind === "once" && <label className="field"><span>运行时间</span><input type="datetime-local" required value={draft.at ? localDateTime(draft.at) : ""} onChange={event => setDraft({ ...draft, at: event.target.value ? new Date(event.target.value).toISOString() : undefined })} /></label>}
      {['daily','weekly','monthly','intervalDays'].includes(draft.kind) && <label className="field"><span>运行时间</span><input type="time" required value={draft.time ?? "09:00"} onChange={event => setDraft({ ...draft, time: event.target.value })} /></label>}
      {draft.kind === 'weekly' && <fieldset><legend>每周日期</legend>{[1,2,3,4,5,6,0].map(day => <label className="check-field" key={day}><input type="checkbox" checked={draft.weekdays?.includes(day) ?? false} onChange={event => setDraft({ ...draft, weekdays: event.target.checked ? [...draft.weekdays ?? [], day] : draft.weekdays?.filter(value => value !== day) })}/>周{'日一二三四五六'[day]}</label>)}</fieldset>}
      {draft.kind === 'monthly' && <label className="field"><span>每月日期（缺日按月末）</span><input type="number" min="1" max="31" required value={draft.day ?? 1} onChange={event => setDraft({ ...draft, day: Number(event.target.value) })}/></label>}
      {draft.kind === 'intervalDays' && <><label className="field"><span>开始日期</span><input type="date" required value={draft.startDate ?? ''} onChange={event => setDraft({ ...draft, startDate: event.target.value })}/></label><label className="field"><span>间隔天数</span><input type="number" min="1" max="36500" required value={draft.intervalDays ?? 1} onChange={event => setDraft({ ...draft, intervalDays: Number(event.target.value) })}/></label></>}
      {draft.kind === "interval" && <label className="field"><span>间隔（分钟）</span><input type="number" required min={1} max={525600} value={draft.intervalMinutes ?? 60} onChange={event => setDraft({ ...draft, intervalMinutes: Number(event.target.value) })} /></label>}</div>
      <div className="form-actions"><label className="check-field"><input type="checkbox" checked={!draft.revision || !!draft.followLatest} onChange={event => setDraft({ ...draft, followLatest: event.target.checked, revision: event.target.checked ? undefined : savedFlows.find(flow => flow.workflowId === draft.workflowId)?.revision })}/>跟随最新保存版本</label><span>{draft.revision ? `固定 v${draft.revision}` : '跟随最新'}</span>{draft.revision && <button type="button" onClick={() => setDraft({ ...draft, revision: savedFlows.find(flow => flow.workflowId === draft.workflowId)?.revision })}>更新使用版本</button>}</div>
      <details><summary>未来五次触发时间（本机时区）</summary><ol>{(() => { try { return previewSchedule(draft).map(date => <li key={date}>{displayDate(date)}</li>); } catch { return <li>请先完善规则</li>; } })()}</ol></details>
      <div className="form-actions"><label className="check-field"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />保存后启用</label><button type="button" onClick={() => setDraft(undefined)} disabled={busy}>取消</button><button className="primary" type="submit" disabled={busy}><Save size={15} />保存定时任务</button></div>
    </form>}
    <div className="management-table-wrap"><table className="management-table"><thead><tr><th>任务 / 流程</th><th>规则</th><th>下次运行</th><th>最近触发</th><th>操作</th></tr></thead><tbody>{plans.map(plan => <tr key={plan.scheduleId}><td><strong>{plan.name}</strong><small>{workflows.find(flow => flow.workflowId === plan.workflowId)?.name ?? "流程已删除"}</small>{plan.lastError && <small className="field-error">{plan.lastError}</small>}</td><td>{describe(plan)}<small>{plan.revision ? `固定 v${plan.revision}` : '跟随最新'}</small><small>{plan.enabled ? "已启用" : "已停用"}</small></td><td>{displayDate(plan.nextRunAt)}</td><td>{displayDate(plan.lastRunAt)}<small>{plan.lastRunId ? ({ queued: "排队中", running: "运行中", paused: "已暂停", waiting_manual: "等待人工", succeeded: "已完成", failed: "执行失败", stopped: "已停止", interrupted: "意外中断" }[runs.find(run => run.runId === plan.lastRunId)?.status ?? "queued"]) : plan.lastRunAt ? "已跳过" : "尚未触发"}</small></td><td><div className="row-actions"><button disabled={busy} onClick={() => void mutate(() => api.saveSchedule({ ...plan, enabled: !plan.enabled }))}>{plan.enabled ? "停用" : "启用"}</button><button disabled={busy} aria-label={`编辑定时任务 ${plan.name}`} onClick={() => { setError(""); setDraft({ ...plan }); }}><Pencil size={14} />编辑</button>{deleting === plan.scheduleId ? <><button className="danger" disabled={busy} onClick={() => void mutate(() => api.deleteSchedule(plan.scheduleId)).then(ok => { if (ok) setDeleting(""); })}>确认删除</button><button onClick={() => setDeleting("")}>取消</button></> : <button className="danger" disabled={busy} aria-label={`删除定时任务 ${plan.name}`} onClick={() => setDeleting(plan.scheduleId)}><Trash2 size={14} /></button>}</div></td></tr>)}</tbody></table>
    <details><summary>触发记录与主动跳过</summary><select aria-label="查看计划触发记录" value={historyId} onChange={event => { setHistoryId(event.target.value); void api.listOccurrences(event.target.value).then(setOccurrences).catch(onError); }}><option value="">选择计划</option>{plans.map(plan => <option key={plan.scheduleId} value={plan.scheduleId}>{plan.name}</option>)}</select><ol>{occurrences.map(entry => <li key={entry.scheduledFor}>{displayDate(entry.scheduledFor)} · {entry.outcome === 'started' ? `已创建运行 ${entry.runId.slice(0,8)}` : entry.outcome === 'skipped' ? '主动跳过' : '已领取，等待恢复'} {entry.reason}</li>)}</ol></details>
    {!plans.length && <div className="page-empty"><CalendarClock size={32} /><h3>还没有定时任务</h3><p>新建计划，让流程在指定时间自动运行。</p></div>}</div>
  </main>;
}
