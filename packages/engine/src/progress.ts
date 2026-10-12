import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { scheduleIdentifier } from '../../contracts/src/index.js';
import { writeJsonAtomic } from '../../persistence/src/index.js';
export interface BusinessProgress { items: unknown[]; keys: string[]; completed: string[]; pending: string[] }
export function progressPath(dataDir: string, runId: string, attemptId: string, scope: string[]): string {
  return join(dataDir, 'runs', scheduleIdentifier.parse(runId), 'attempts', scheduleIdentifier.parse(attemptId), 'progress', `${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.json`);
}
export async function readProgress(path: string): Promise<BusinessProgress | undefined> {
  try { const value = JSON.parse(await readFile(path, 'utf8')) as BusinessProgress; if (!Array.isArray(value.items) || !Array.isArray(value.keys) || !Array.isArray(value.completed) || !Array.isArray(value.pending)) throw new Error('业务进度损坏，不能自动续跑'); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function saveProgress(path: string, value: BusinessProgress) { await mkdir(join(path, '..'), { recursive: true }); await writeJsonAtomic(path, value); }
