import type { RunEvent } from '../../../../packages/contracts/src/index.js';
/** The cache is a live tail; every older event remains accessible through disk pagination. */
export function cacheRunEvents(previous:RunEvent[],incoming:RunEvent[],selected:string):RunEvent[] {
  const keep=new Set<string>();if(selected)keep.add(selected);
  for(const event of [...incoming].reverse()) {if(keep.size<20)keep.add(event.runId);}
  for(let index=previous.length-1;index>=0 && keep.size<20;index--)keep.add(previous[index].runId);
  const groups=new Map<string,RunEvent[]>();for(const event of [...previous,...incoming]) if(keep.has(event.runId)){const rows=groups.get(event.runId) ?? [];rows.push({...event,...(event.run?{run:{...event.run,variables:{}},variableChanges:undefined}:{})});if(rows.length>200)rows.shift();groups.set(event.runId,rows);}
  return [...groups.values()].flat();
}
