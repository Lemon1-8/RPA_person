import { useMemo, useState } from "react";
import { Copy, FolderOpen, Plus, Search, Settings2, Trash2, Workflow } from "lucide-react";
import type { WorkflowDefinition } from "../../../../packages/contracts/src/index.js";

interface Props {
  workflows: WorkflowDefinition[];
  saved: Record<string, string>;
  busy: boolean;
  onCreate(): void;
  onOpen(id: string): void;
  onSettings(id: string): void;
  onCopy(flow: WorkflowDefinition): void;
  onDelete(flow: WorkflowDefinition): Promise<void>;
}

export function WorkflowsPage({ workflows, saved, busy, onCreate, onOpen, onSettings, onCopy, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name");
  const [deleting, setDeleting] = useState("");
  const visible = useMemo(() => workflows.filter(flow =>
    `${flow.name} ${flow.workflowId}`.toLowerCase().includes(query.trim().toLowerCase()),
  ).sort((a, b) => sort === "revision" ? b.revision - a.revision : a.name.localeCompare(b.name, "zh-CN")), [workflows, query, sort]);
  return <main className="management-page" aria-label="流程管理">
    <div className="page-heading"><div><span className="eyebrow">工作空间 / 流程</span><h2>我的流程 <span className="count">{workflows.length}</span></h2><p>查找、编辑和管理流程，未保存的草稿会在切换页面时保留。</p></div>
      <button className="primary" disabled={busy} onClick={onCreate}><Plus size={16} />新建流程</button></div>
    <div className="management-filters"><label className="search"><Search size={16} /><input aria-label="搜索流程" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索流程名称或标识" /></label>
      <select aria-label="流程排序" value={sort} onChange={event => setSort(event.target.value)}><option value="name">按名称排序</option><option value="revision">按修订版本排序</option></select></div>
    <div className="management-table-wrap"><table className="management-table"><thead><tr><th>流程名称</th><th>步骤</th><th>版本 / 状态</th><th>操作</th></tr></thead><tbody>
      {visible.map(flow => <tr key={flow.workflowId}><td><button className="flow-name" onClick={() => onOpen(flow.workflowId)}><Workflow size={18} /><span><strong>{flow.name}</strong><small>{flow.workflowId}</small></span></button></td>
        <td>{countSteps(flow.steps)}</td><td><span className="revision">v{flow.revision}</span> <span className={saved[flow.workflowId] !== JSON.stringify(flow) ? "unsaved" : "muted"}>{saved[flow.workflowId] !== JSON.stringify(flow) ? "未保存" : "已保存"}</span></td>
        <td><div className="row-actions"><button disabled={busy} onClick={() => onOpen(flow.workflowId)}><FolderOpen size={14} />编辑</button><button disabled={busy} aria-label={`设置 ${flow.name}`} onClick={() => onSettings(flow.workflowId)}><Settings2 size={14} />设置 / 重命名</button><button disabled={busy} aria-label={`复制流程 ${flow.name}`} onClick={() => onCopy(flow)}><Copy size={14} />复制</button>
          {deleting === flow.workflowId ? <span className="delete-confirm"><span>删除流程及关联计划？</span><button className="danger" disabled={busy} onClick={() => void onDelete(flow).then(() => setDeleting(""))}>确认删除</button><button onClick={() => setDeleting("")}>取消</button></span> : <button className="danger" disabled={busy} aria-label={`删除流程 ${flow.name}`} onClick={() => setDeleting(flow.workflowId)}><Trash2 size={14} />删除</button>}</div></td></tr>)}
    </tbody></table>{!visible.length && <div className="page-empty"><Workflow size={32} /><h3>{query ? "没有匹配的流程" : "创建你的第一个流程"}</h3><p>{query ? "尝试其他名称或清空搜索。" : "新建流程后，从指令库添加步骤。"}</p>{!query && <button onClick={onCreate}><Plus size={16} />新建流程</button>}</div>}</div>
  </main>;
}

function countSteps(steps: WorkflowDefinition["steps"]): number {
  return steps.reduce((sum, step) => sum + 1 + countSteps(step.children ?? []) + countSteps(step.elseSteps ?? []), 0);
}
