import { useState } from 'react';
function Value({ value, path, depth = 0 }: { value: unknown; path: string; depth?: number }) {
  const [message, setMessage] = useState('');
  const copy = () => void navigator.clipboard.writeText(`{{${path}}}`).then(() => setMessage('已复制引用'), () => setMessage('无法访问剪贴板'));
  if (!value || typeof value !== 'object') return <span className="value-scalar"><code>{typeof value === 'string' ? value : JSON.stringify(value)}</code><button onClick={copy} aria-label={`复制 ${path} 引用`}>复制引用</button>{message}</span>;
  const entries = Object.entries(value).slice(0, 100);
  return <details className="value-tree"><summary>{Array.isArray(value) ? `列表 · ${value.length} 项` : `对象 · ${Object.keys(value).length} 个属性`}<button onClick={event => { event.preventDefault(); copy(); }}>复制引用</button>{message}</summary>{depth < 10 ? entries.map(([key, child]) => <div key={key}><code>{key}</code><Value value={child} path={`${path}.${key}`} depth={depth + 1}/></div>) : <p>嵌套超过显示上限，可通过引用访问。</p>}{Object.keys(value).length > 100 && <small>仅预览前 100 项</small>}</details>;
}
export function ValueViewer({ variables }: { variables: Record<string, unknown> }) {
  const [query, setQuery] = useState(''); const [tableName, setTableName] = useState('');
  const tables = Object.keys(variables).filter(key => Array.isArray(variables[key]) || variables[key] && typeof variables[key] === 'object' && Array.isArray((variables[key] as Record<string, unknown>).rows));
  const table = variables[tableName]; const rows = (Array.isArray(table) ? table : table && typeof table === 'object' ? (table as Record<string, unknown>).rows : []) as unknown[];
  const records = (rows ?? []).slice(0, 100).map(row => row && typeof row === 'object' ? row as Record<string, unknown> : { value: row });
  const columns = [...new Set(records.flatMap(Object.keys))].slice(0, 30);
  return <div className="value-viewer"><label className="field"><span>搜索变量</span><input value={query} onChange={event => setQuery(event.target.value)}/></label>{tables.length > 0 && <><label className="field"><span>表格预览（前 100 行）</span><select value={tableName} onChange={event => setTableName(event.target.value)}><option value="">选择列表</option>{tables.map(key => <option key={key}>{key}</option>)}</select></label>{tableName && <div className="data-table-wrap"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{records.map((record, index) => <tr key={index}>{columns.map(column => <td key={column}>{typeof record[column] === 'object' ? JSON.stringify(record[column]) : String(record[column] ?? '')}</td>)}</tr>)}</tbody></table></div>}</>}{Object.entries(variables).filter(([key]) => key.toLowerCase().includes(query.toLowerCase())).map(([key, value]) => <section key={key}><strong>{key}</strong><Value value={value} path={key}/></section>)}</div>;
}
