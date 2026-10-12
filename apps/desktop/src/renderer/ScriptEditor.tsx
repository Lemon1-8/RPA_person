import { useState } from 'react';
import type { DesktopApi, WorkflowDefinition } from '../../../../packages/contracts/src/index.js';
export function ScriptEditor({ api, workflow, stepId, value, disabled, onChange }: { api?: DesktopApi; workflow: WorkflowDefinition; stepId: string; value: string; disabled: boolean; onChange(value: string): void }) {
  const [expanded, setExpanded] = useState(false); const [message, setMessage] = useState('');
  return <div className={`script-editor${expanded ? ' expanded' : ''}`} onKeyDown={event => { if (event.key === 'Escape') setExpanded(false); }}>
    <div className="script-tools"><button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起脚本' : '展开脚本'}</button><button type="button" disabled={disabled} onClick={() => void api?.preflight(workflow).then(issues => setMessage(issues.filter(issue => issue.stepId === stepId).map(issue => issue.message).join('\n') || '语法和解释器检查通过')).catch(error => setMessage(String(error)))}>检查语法与环境</button><span>{value.split('\n').length} 行</span></div>
    <div className="script-code"><pre aria-hidden="true">{value.split('\n').map((_, index) => index + 1).join('\n')}</pre><textarea id={`param-${stepId}-code`} aria-label="脚本代码" className="code-input script-input" spellCheck={false} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}/></div>
    <details><summary>SDK 示例（按语言选择）</summary><pre>{`JavaScript / TypeScript:\nconst context = await rpa.call('core.runContext');\nconst value = await rpa.get('变量名');\nawait rpa.output(value);\n\nPython:\ncontext = rpa.call('core.runContext')\nvalue = rpa.get('变量名')\nrpa.output(value)`}</pre></details>{message && <pre role="status">{message}</pre>}
  </div>;
}
