import { memo,useState } from 'react';
import type { RunWarning,RunStatus } from '../../../../packages/contracts/src/index.js';
export const WarningRecords=memo(function WarningRecords({warnings,status,onSelect}:{warnings:RunWarning[];status:RunStatus;onSelect(id:string):void}){
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(100);
  return <details className="run-warning" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{status==='succeeded'?'完成但有警告':'已记录警告'} · {warnings.length} 项</summary>{open && <>{warnings.slice(0,limit).map((warning,index)=><p key={index}><button onClick={()=>onSelect(warning.stepId)}>{warning.stepName}</button>：{warning.message}</p>)}{warnings.length>limit && <button onClick={()=>setLimit(limit+100)}>加载更多警告</button>}</>}</details>;
});
