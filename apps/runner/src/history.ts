import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scheduleIdentifier } from '../../../packages/contracts/src/index.js';
export async function runMetadataFiles(dataDir:string,runId:string,artifacts:string[]=[]):Promise<string[]> {
  const root=join(dataDir,'runs',scheduleIdentifier.parse(runId)); const result:string[]=[];
  for(const name of ['run.json','workflow.json','events.jsonl']) { const path=join(root,name);try{if((await stat(path)).isFile()) result.push(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;} }
  const visit=async(path:string)=>{let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error;}for(const entry of entries){if(entry.isSymbolicLink()) continue;const target=join(path,entry.name);if(entry.isDirectory()) await visit(target);else if(entry.isFile() && /\.(json|jsonl)$/.test(entry.name)) result.push(target);}};
  for(const name of ['attempts','results']) await visit(join(root,name));
  const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const protectedPaths = new Set(artifacts.map(key));
  return result.filter(path => !protectedPaths.has(key(path)));
}
