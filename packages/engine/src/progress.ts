import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join,sep } from 'node:path';
import { scheduleIdentifier } from '../../contracts/src/index.js';
import { writeJsonAtomic } from '../../persistence/src/index.js';
export interface BusinessProgress { items: unknown[]; keys: string[]; completed: string[]; pending: string[] }
export function progressPath(dataDir: string, runId: string, attemptId: string, scope: string[]): string {
  return join(dataDir, 'runs', scheduleIdentifier.parse(runId), 'attempts', scheduleIdentifier.parse(attemptId), 'progress', `${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.json`);
}
export async function readProgress(path: string): Promise<BusinessProgress | undefined> {
  try {
    const value = JSON.parse(await readFile(path,'utf8')) as BusinessProgress;
    if (!value.items) Object.assign(value,JSON.parse(await readFile(`${path}.input.json`,'utf8')));
    if (!Array.isArray(value.items) || !Array.isArray(value.keys) || !Array.isArray(value.completed) || !Array.isArray(value.pending)) throw new Error('业务进度损坏，不能自动续跑');
    try { for (const line of (await readFile(`${path}.journal.jsonl`,'utf8')).split('\n').filter(Boolean)) { const event = JSON.parse(line); if (!value.keys.includes(event.key) || !['pending','completed'].includes(event.status)) throw new Error('业务进度事件损坏'); if(event.status==='completed') { if(!value.completed.includes(event.key)) value.completed.push(event.key); value.pending=value.pending.filter(key=>key!==event.key); } else if(!value.pending.includes(event.key) && !value.completed.includes(event.key)) value.pending.push(event.key); } } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    return value;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
const states = new Map<string,{completed:Set<string>;pending:Set<string>}>();
export function forgetProgress(prefix:string) {for(const path of states.keys())if(path.startsWith(prefix+sep))states.delete(path);}
export async function saveProgress(path: string, value: BusinessProgress) {
  await mkdir(join(path,'..'),{recursive:true});
  const previous = states.get(path);
  if (!previous) {
    await writeJsonAtomic(`${path}.input.json`,{items:value.items,keys:value.keys});
    await writeJsonAtomic(path,{completed:value.completed,pending:value.pending}); await writeFileEmptyJournal(path);
  } else {
    const events = [...value.pending.filter(key=>!previous.pending.has(key)).map(key=>({key,status:'pending'})),...value.completed.filter(key=>!previous.completed.has(key)).map(key=>({key,status:'completed'}))];
    if(events.length) await appendFile(`${path}.journal.jsonl`,events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  }
  states.set(path,{completed:new Set(value.completed),pending:new Set(value.pending)});
}
async function writeFileEmptyJournal(path:string) { const { writeFile } = await import('node:fs/promises'); await writeFile(`${path}.journal.jsonl`,''); }
