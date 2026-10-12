import { useEffect, useState } from 'react';
import type { DesktopApi, WorkflowDefinition, WorkflowRevision } from '../../../../packages/contracts/src/index.js';

export function RevisionHistory({ api, workflow, onRestore, onError,beforeRestore }: { api: DesktopApi; workflow: WorkflowDefinition; onRestore(flow: WorkflowDefinition): void; onError(error: unknown): void;beforeRestore():Promise<void> }) {
  const [revisions, setRevisions] = useState<WorkflowRevision[]>([]);
  const [preview, setPreview] = useState<WorkflowDefinition>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void api.listRevisions(workflow.workflowId).then(value => { if (alive) setRevisions(value); }).catch(onError); return () => { alive = false; setPreview(undefined); }; }, [workflow.workflowId, workflow.revision]);
  const changes = preview && Object.keys({ ...preview, ...workflow }).filter(key => key !== 'revision' && JSON.stringify(preview[key as keyof WorkflowDefinition]) !== JSON.stringify(workflow[key as keyof WorkflowDefinition]));
  return <details className="advanced"><summary>版本历史 · 当前 v{workflow.revision}</summary>
    <label className="field"><span>查看修订</span><select aria-label="查看流程修订" value={preview?.revision ?? ''} onChange={event => { if (!event.target.value) { setPreview(undefined); return; } void api.getRevision(workflow.workflowId, Number(event.target.value)).then(setPreview).catch(onError); }}><option value="">选择修订</option>{revisions.map(item => <option key={item.revision} value={item.revision}>v{item.revision} · {item.name}</option>)}</select></label>
    {preview && <><p>变化部分：{changes?.length ? changes.join('、') : '内容一致'}</p><div className="revision-diff"><details><summary>所选版本</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details><details><summary>当前草稿</summary><pre>{JSON.stringify(workflow, null, 2)}</pre></details></div>
      <button disabled={busy || preview.revision === workflow.revision} onClick={() => { setBusy(true); void beforeRestore().then(()=>api.restoreRevision(workflow.workflowId, preview.revision, workflow.revision)).then(onRestore).catch(onError).finally(() => setBusy(false)); }}>恢复为新修订（当前未保存编辑由草稿保留）</button></>}
    {!revisions.length && <p>保存流程后开始记录版本历史。</p>}
  </details>;
}
